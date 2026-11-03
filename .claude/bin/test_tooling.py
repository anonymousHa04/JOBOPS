"""Graders for agent-tooling tasks (written by the manager; coders must not edit this file).
Run from the repo root: python3 .claude/bin/test_tooling.py [TestClass]
Prints node-style "ℹ pass N" / "ℹ fail N" lines so check.sh can use it as TEST_CMD."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True)


def temp_repo():
    d = tempfile.mkdtemp(prefix="jobops-tooling-")
    git(d, "init", "-q")
    git(d, "config", "user.email", "t@example.com")
    git(d, "config", "user.name", "t")
    return d


class SnapshotGuard(unittest.TestCase):
    """T3: the boundary guard undoes files outside the task, including staged new files."""

    def run_guard(self, d, *args):
        return subprocess.run(["sh", os.path.join(HERE, "tree-snapshot.sh"), *args], cwd=d, capture_output=True, text=True)

    def test_staged_new_file_outside_task_is_removed_and_unstaged(self):
        d = temp_repo()
        open(os.path.join(d, "task.ts"), "w").write("a\n")
        git(d, "add", "task.ts"); git(d, "commit", "-qm", "init")
        self.run_guard(d, "snap", "before.json")
        open(os.path.join(d, "task.ts"), "w").write("b\n")
        os.makedirs(os.path.join(d, "api/src"))
        open(os.path.join(d, "api/src/reports.ts"), "w").write("")
        git(d, "add", "api/src/reports.ts")  # like aider staging a wrongly named new file
        self.run_guard(d, "snap", "after.json")
        out = self.run_guard(d, "revert", "before.json", "after.json", "task.ts").stdout
        self.assertFalse(os.path.exists(os.path.join(d, "api/src/reports.ts")), out)
        self.assertEqual(git(d, "ls-files", "api/src/reports.ts").stdout, "", "still staged")
        self.assertEqual(open(os.path.join(d, "task.ts")).read(), "b\n", "the task's own file is kept")

    def test_untracked_new_and_tracked_changed_files_still_handled(self):
        d = temp_repo()
        for f in ("task.ts", "other.ts"):
            open(os.path.join(d, f), "w").write("a\n")
        git(d, "add", "."); git(d, "commit", "-qm", "init")
        self.run_guard(d, "snap", "before.json")
        open(os.path.join(d, "other.ts"), "w").write("changed\n")
        open(os.path.join(d, "stray.ts"), "w").write("x\n")
        self.run_guard(d, "snap", "after.json")
        self.run_guard(d, "revert", "before.json", "after.json", "task.ts")
        self.assertEqual(open(os.path.join(d, "other.ts")).read(), "a\n")
        self.assertFalse(os.path.exists(os.path.join(d, "stray.ts")))


class CheckExtension(unittest.TestCase):
    """T2: check.sh runs extension/tools/check-ext.sh on changed extension files by itself."""

    def make(self):
        d = temp_repo()
        os.makedirs(os.path.join(d, ".claude/bin")); os.makedirs(os.path.join(d, ".claude/agents"))
        for f in ("check.sh", "hints.sh"):
            shutil.copy(os.path.join(HERE, f), os.path.join(d, ".claude/bin", f))
        shutil.copy(os.path.join(ROOT, ".claude/agents/fix-hints.yaml"), os.path.join(d, ".claude/agents/fix-hints.yaml"))
        os.makedirs(os.path.join(d, "extension/tools"))
        # A stand-in grader: fails for any named file that contains BROKEN.
        open(os.path.join(d, "extension/tools/check-ext.sh"), "w").write(
            'cd "$(git rev-parse --show-toplevel)/extension"\nf=0\nfor x in "$@"; do grep -q BROKEN "$x" && { echo "FAIL: $x"; f=$((f+1)); }; done\n'
            'echo "ℹ pass 1"; echo "ℹ fail $f"; [ "$f" = 0 ]\n')
        open(os.path.join(d, "extension/a.js"), "w").write("ok\n")
        open(os.path.join(d, "extension/b.js"), "w").write("BROKEN\n")  # unchanged: must not be checked
        git(d, "add", "."); git(d, "commit", "-qm", "init")
        return d

    def check(self, d):
        env = dict(os.environ, TSC_CMD="true", TEST_CMD="echo 'ℹ pass 1'; echo 'ℹ fail 0'")
        r = subprocess.run(["sh", ".claude/bin/check.sh", "t"], cwd=d, capture_output=True, text=True, env=env)
        return r.returncode, json.load(open(os.path.join(d, ".agent-logs/t.check.json")))

    def test_broken_changed_extension_file_fails_the_check(self):
        d = self.make()
        open(os.path.join(d, "extension/a.js"), "w").write("BROKEN\n")
        rc, j = self.check(d)
        self.assertNotEqual(rc, 0)
        self.assertEqual(j["status"], "failed")
        self.assertEqual(j["steps"]["extension"]["status"], "failed", j)

    def test_only_changed_extension_files_are_checked(self):
        d = self.make()
        open(os.path.join(d, "extension/a.js"), "w").write("fine\n")  # b.js (BROKEN) is unchanged
        rc, j = self.check(d)
        self.assertEqual(rc, 0, j)
        self.assertEqual(j["steps"]["extension"]["status"], "passed")

    def test_no_extension_change_means_not_run(self):
        d = self.make()
        rc, j = self.check(d)
        self.assertEqual(rc, 0, j)
        self.assertEqual(j["steps"]["extension"]["status"], "not_run")


class LessonPrecision(unittest.TestCase):
    """T1: the coder edits .claude/knowledge/lesson-terms.json (a small view of the lessons' terms).
    Its terms are merged into a temporary copy of fixes.jsonl, and the eval runs on that copy: recall
    stays >= 40/46, no forbidden look-alike is supplied, and lesson precision reaches 50%."""

    @classmethod
    def setUpClass(cls):
        cls.copy = os.path.join(tempfile.mkdtemp(prefix="jobops-terms-"), "fixes.jsonl")
        cls.applied = subprocess.run([sys.executable, os.path.join(HERE, "lesson-terms.py"), "apply",
                                      os.path.join(ROOT, ".claude/knowledge/lesson-terms.json"), cls.copy],
                                     capture_output=True, text=True)

    def test_terms_file_merges(self):
        self.assertEqual(self.applied.returncode, 0, self.applied.stderr[-400:])

    def test_eval(self):
        out = subprocess.run([sys.executable, os.path.join(ROOT, ".claude/knowledge/retrieve.py"), "eval", "--budget", "3000"],
                             cwd=ROOT, capture_output=True, text=True, env=dict(os.environ, FIXES_FILE=self.copy)).stdout
        recall = re.search(r"overall recall: (\d+)/(\d+)", out)
        prec = re.search(r"lesson precision: (\d+)/(\d+) .*forbidden supplied: (\d+)", out)
        self.assertTrue(recall and prec, out[-500:])
        # 40, not 42 (2026-11-03): observation lessons are no longer handed to coders (promotion rule),
        # so two expectations that named observations are withheld on purpose.
        self.assertGreaterEqual(int(recall.group(1)), 40, "recall dropped below 40/46")
        self.assertEqual(int(prec.group(3)), 0, "a forbidden look-alike lesson was supplied")
        wanted, supplied = int(prec.group(1)), int(prec.group(2))
        self.assertGreaterEqual(wanted / max(1, supplied), 0.5, "lesson precision %d/%d is below 50%%" % (wanted, supplied))

    def test_lessons_are_valid_and_none_lost(self):
        terms = json.load(open(os.path.join(ROOT, ".claude/knowledge/lesson-terms.json")))
        ids = [json.loads(l)["id"] for l in open(os.path.join(ROOT, ".claude/knowledge/fixes.jsonl")) if l.strip()]
        self.assertEqual(sorted(terms), sorted(ids), "every lesson id must stay, and no new ones")
        for i, t in terms.items():
            self.assertTrue(isinstance(t, list) and t and all(isinstance(x, str) and x for x in t), i)


if __name__ == "__main__":
    names = sys.argv[1:] or None
    suite = unittest.defaultTestLoader.loadTestsFromNames(names, sys.modules[__name__]) if names else \
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    res = unittest.TextTestRunner(verbosity=1).run(suite)
    bad = len(res.failures) + len(res.errors)
    print("ℹ pass %d" % (res.testsRun - bad))
    print("ℹ fail %d" % bad)
    sys.exit(1 if bad else 0)

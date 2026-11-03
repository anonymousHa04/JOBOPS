"""Tests for lesson matching, demotion, and one end-to-end lesson use (feedback.py, autofix.sh).
Run from the repo root: python3 .claude/bin/test_lessons.py
The end-to-end test runs the real autofix.sh with the fake coder (run-fake.sh) in this tree, on a
throwaway file, with a temporary lesson file: no local model, no real lessons or logs touched."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="jobops-lessons-")
os.environ["FEEDBACK_FIXES"] = os.path.join(TMP, "fixes.jsonl")
os.environ["FEEDBACK_MAIN_LOGS"] = os.path.join(TMP, "main-logs")
sys.path.insert(0, HERE)
import feedback  # noqa: E402  (reads FEEDBACK_FIXES at import)

# A lesson shaped like param-after-opts (TS2353), and its near-miss look-alike.
# A hypothesis: root cause, corrective action (resolution) and a repro test, so it may be supplied.
PARAM = {"id": "param-after-opts", "status": "hypothesis", "title": "New optional parameters go after existing ones",
         "root_cause": "the coder inserted the new parameter before opts", "repro_test": "tailor.test.ts notes case",
         "signature": "TS2353: Object literal may only specify known properties", "terms": ["parameter", "opts", "baseUrl"],
         "files": ["api/src/tailor/*.ts"], "not_when": r"z\.(object|string)\(|Schema\b", "resolution": "append after opts"}


def write_fixes(*rows):
    with open(os.environ["FEEDBACK_FIXES"], "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class Matching(unittest.TestCase):
    def test_an_observation_is_never_supplied(self):
        # Promotion rule (user, 2026-11-03): a manual fix alone does not make a reusable instruction.
        write_fixes(dict(PARAM, status="observation"))
        errs = "api/src/tailor/tailor.ts(125): error TS2353: Object literal may only specify known properties, and 'baseUrl' does not exist"
        self.assertEqual(feedback.matching_fixes(errs, ["api/src/tailor/reword.ts"], "add an optional notes parameter to rewordContent"), [])

    def test_a_hypothesis_without_a_repro_test_is_not_supplied(self):
        write_fixes(dict(PARAM, repro_test=""))
        errs = "api/src/tailor/tailor.ts(125): error TS2353: Object literal may only specify known properties, and 'baseUrl' does not exist"
        self.assertEqual(feedback.matching_fixes(errs, ["api/src/tailor/reword.ts"], "add an optional notes parameter to rewordContent"), [])

    def test_signature_and_task_fit_is_supplied_with_reasons(self):
        write_fixes(PARAM)
        errs = "api/src/tailor/tailor.ts(125): error TS2353: Object literal may only specify known properties, and 'baseUrl' does not exist"
        hits = feedback.matching_fixes(errs, ["api/src/tailor/reword.ts"], "add an optional notes parameter to rewordContent")
        self.assertEqual([fx["id"] for fx, _ in hits], ["param-after-opts"])
        why = hits[0][1]
        self.assertIn("signature", why)
        self.assertIn("file:api/src/tailor/*.ts", why)

    def test_near_miss_same_error_code_other_cause_is_excluded(self):
        # Same TS2353 text, but a wrong field in an unrelated object: no file or term fits.
        write_fixes(PARAM)
        errs = "api/src/jobs/repo.ts(40): error TS2353: Object literal may only specify known properties, and 'naem' does not exist in type 'JobInput'"
        hits = feedback.matching_fixes(errs, ["api/src/jobs/repo.ts"], "store the job's name when it is saved")
        self.assertEqual(hits, [])

    def test_not_when_excludes_a_known_look_alike(self):
        # Files and terms fit, but the task is a zod schema change: the lesson's not_when says no.
        write_fixes(PARAM)
        errs = "api/src/tailor/x.ts(3): error TS2353: Object literal may only specify known properties, and 'opts' does not exist"
        hits = feedback.matching_fixes(errs, ["api/src/tailor/x.ts"], "add opts: z.object({ round: z.number() }) to the Schema")
        self.assertEqual(hits, [])

    def test_signature_alone_is_not_enough(self):
        write_fixes(dict(PARAM, files=[], terms=["nothing-here"]))
        errs = "a.ts(1): error TS2353: Object literal may only specify known properties"
        self.assertEqual(feedback.matching_fixes(errs, ["a.ts"], "some task"), [])


class GraderFailures(unittest.TestCase):
    def test_grader_fail_lines_reach_the_feedback_loop(self):
        # check-ext.sh / unittest report "FAIL: ..." lines; they must count as failures with a cause.
        os.makedirs(".agent-logs", exist_ok=True)
        with open(".agent-logs/gf-test.check.log", "w") as f:
            f.write("== flags\n== typecheck (exit 0)\n== tests (exit 1)\n"
                    "FAIL: background.js must stop after round 5\nℹ pass 17\nℹ fail 1\n== go (exit 0)\n")
        try:
            errs, tests = feedback.errors_of("gf-test")
            self.assertIn("FAIL: background.js must stop after round 5", tests)
        finally:
            os.remove(".agent-logs/gf-test.check.log")


class Demotion(unittest.TestCase):
    def test_two_failed_uses_drop_a_lesson_to_hypothesis(self):
        write_fixes(dict(PARAM, status="verified"))
        err = {"file": "a.ts", "line": 1, "code": "TS2353", "message": "Object literal may only specify known properties"}
        atts = [{"attempt": "t", "verdict": "failed", "errors": [err], "flags": [], "fixes_supplied": []},
                {"attempt": "t-fix1", "verdict": "failed", "errors": [err], "flags": [], "fixes_supplied": ["param-after-opts"]},
                {"attempt": "t-fix2", "verdict": "failed", "errors": [err], "flags": [], "fixes_supplied": ["param-after-opts"]}]
        changed = feedback._promote("t", atts, "failed")
        fx = feedback.load_fixes()[0]
        self.assertEqual(fx["status"], "hypothesis")
        self.assertEqual(fx["applications"], {"supplied": 2, "passed": 0, "failed": 2})
        self.assertIn({"id": "param-after-opts", "to": "hypothesis", "note": "failed twice"}, changed)


class EndToEnd(unittest.TestCase):
    """A lesson is retrieved for the repair round, supplied in its spec, followed by the (fake)
    coder, validated by check.sh, and the pass reaches _promote: hypothesis -> verified.
    FIX_CLASSES=all: by default only edit failures get a fix round; this exercises the lesson path."""
    FILE = "api/src/selftest-lesson.ts"
    LESSON = {"id": "e2e-number-literal", "status": "hypothesis", "title": "E2E: a number field takes a number literal",
              "repro_test": "selftest-lesson.ts with a string literal",
              "signature": "TS2322: Type 'string' is not assignable to type 'number'", "terms": ["selftest"],
              "files": ["api/src/selftest-*.ts"], "resolution": "E2E-LESSON: write the number 1, not the string",
              "root_cause": "test lesson"}

    def run_autofix(self, task, lesson):
        write_fixes(lesson)
        spec = os.path.join(TMP, task + ".md")
        with open(spec, "w") as f:
            f.write("# Task %s\nIn %s export const x: number set to one (selftest).\n" % (task, self.FILE))
        bad = "printf 'export const x: number = \"a\";\\n' > %s" % self.FILE
        # The fake coder follows the lesson only if its resolution is in the repair spec.
        fix = ("grep -q E2E-LESSON .agent-logs/%s-fix1.spec.md && printf 'export const x: number = 1;\\n' > %s || %s"
               % (task, self.FILE, bad))
        env = dict(os.environ, FIRST_RUNNER="fake", FIX_RUNNER="fake", MAX_FIXES="1", CODER_TIMEOUT="60", FIX_CLASSES="all",
                   FEEDBACK_SELF_REVIEW="0", FAKE_ACTION=bad, FAKE_ACTION_FIX=fix)
        r = subprocess.run([os.path.join(HERE, "autofix.sh"), task, spec, self.FILE], cwd=ROOT,
                           capture_output=True, text=True, env=env, timeout=600)
        atts = [json.loads(l) for l in open(os.path.join(ROOT, ".agent-logs", task + ".attempts.jsonl")) if l.strip()]
        return r, atts, feedback.load_fixes()[0]

    def tearDown(self):
        if os.path.exists(os.path.join(ROOT, self.FILE)):
            os.remove(os.path.join(ROOT, self.FILE))
        logs = os.path.join(ROOT, ".agent-logs")
        for f in os.listdir(logs):
            if f.startswith("e2e-lesson"):
                p = os.path.join(logs, f)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)  # <attempt>.orig/ is a folder

    def test_lesson_is_supplied_followed_validated_and_promoted(self):
        r, atts, fx = self.run_autofix("e2e-lesson-use", self.LESSON)
        self.assertEqual(r.returncode, 0, r.stdout[-800:] + r.stderr[-800:])
        self.assertEqual([a["verdict"] for a in atts], ["failed", "passed"])
        fix1 = atts[1]
        self.assertEqual(fix1["fixes_supplied"], ["e2e-number-literal"])
        why = fix1["lessons"]["repair_spec"]["e2e-number-literal"]
        self.assertIn("signature", why)
        self.assertIn("file:api/src/selftest-*.ts", why)
        self.assertIsNotNone(fix1["duration_s"])
        self.assertEqual(fx["status"], "verified")
        self.assertEqual(fx["applications"], {"supplied": 1, "passed": 1, "failed": 0})

    def test_blocked_lesson_is_not_supplied_and_not_promoted(self):
        r, atts, fx = self.run_autofix("e2e-lesson-blocked", dict(self.LESSON, not_when="selftest"))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual([a["verdict"] for a in atts], ["failed", "failed"])
        self.assertEqual(atts[1]["fixes_supplied"], [])
        self.assertEqual(fx["status"], "hypothesis")
        self.assertNotIn("applications", fx)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)

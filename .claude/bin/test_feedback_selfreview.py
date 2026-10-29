"""Tests for the coder self-review in feedback.py (self-review.md): repair specs carry the
checklist and the previous diff, the SELF-REVIEW line is recorded, and escalations get a local
model review or say why they did not.
Run: python3 .claude/bin/test_feedback_selfreview.py
Each test runs in a temp git repo with its own logs; the real fix records and logs are untouched."""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FEEDBACK = os.path.join(HERE, "feedback.py")


def attempt(task, files, **over):
    rec = {"attempt": task, "runner": "aider", "verdict": "failed", "reason": "check failed", "category": "incorrect_implementation",
           "category_basis": "test", "strategy": "initial", "error_count": 1, "signature": "abc", "fixes_supplied": [],
           "flags": [], "failing_tests": [], "files": files, "agent_claim": {"source": "aider", "found": False},
           "errors": [{"file": "a.ts", "line": 3, "code": "TS2305", "message": "Module has no exported member 'Db'"}]}
    rec.update(over)
    return rec


class SelfReview(unittest.TestCase):
    def setUp(self):
        self.old = os.getcwd()
        self.dir = tempfile.mkdtemp(prefix="jobops-selfreview-")
        os.chdir(self.dir)
        for d in (".agent-logs", ".claude/specs", "main-logs"):
            os.makedirs(d, exist_ok=True)
        run = lambda *a: subprocess.run(a, check=True, capture_output=True)
        run("git", "init", "-q")
        run("git", "config", "user.email", "t@example.com")
        run("git", "config", "user.name", "t")
        with open("a.ts", "w") as f:
            f.write("export const a = 1;\n")
        run("git", "add", "a.ts")
        run("git", "commit", "-qm", "init")
        with open("a.ts", "a") as f:
            f.write("export const added = 2;\n")
        with open(".claude/specs/t1.md", "w") as f:
            f.write("# Task t1\n1. Add `added` to a.ts.\n")
        self.env = dict(os.environ, FEEDBACK_MAIN_LOGS=os.path.join(self.dir, "main-logs"),
                        FEEDBACK_FIXES=os.path.join(self.dir, "fixes.jsonl"))

    def tearDown(self):
        os.chdir(self.old)

    def feedback(self, *args, env=None):
        return subprocess.run([sys.executable, FEEDBACK, *args], capture_output=True, text=True, env=env or self.env)

    def write_attempts(self, *recs):
        with open(".agent-logs/t1.attempts.jsonl", "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")

    def test_repair_spec_has_checklist_and_previous_diff(self):
        self.write_attempts(attempt("t1", ["a.ts"]))
        r = self.feedback("repair-spec", "t1", "t1", ".claude/specs/t1.md", "repair.md", "--", "a.ts")
        self.assertEqual(r.returncode, 0, r.stderr)
        spec = open("repair.md").read()
        self.assertIn("## Self-review first", spec)
        self.assertIn("Callers", spec)
        self.assertIn("## Your previous change", spec)
        self.assertIn("+export const added = 2;", spec)

    def test_self_review_line_is_recorded(self):
        sys.path.insert(0, HERE)
        import feedback
        with open(".agent-logs/t1.log", "w") as f:
            f.write("edits...\nSELF-REVIEW: item 2 missing; imported Db from the wrong module\nSTATUS: blocked\nBLOCKERS: none\n")
        claim = feedback.agent_claim("t1", "aider")
        self.assertEqual(claim["self_review"], "item 2 missing; imported Db from the wrong module")
        self.assertEqual(claim["status"], "blocked")

    def test_escalation_gets_model_self_review(self):
        reply = {"spec_items": [{"item": "1", "status": "wrong"}], "likely_cause": "Db imported from reports.ts",
                 "outside_files": [], "broken_callers": [], "suggestion": "import Db from ../db.ts"}

        class Fake(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"choices": [{"message": {"content": "Here:\n" + json.dumps(reply)}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.write_attempts(attempt("t1", ["a.ts"]))
            env = dict(self.env, FEEDBACK_REVIEW_URL="http://127.0.0.1:%d/v1/chat/completions" % server.server_port)
            r = self.feedback("finish", "t1", "failed", "check failed", env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            server.shutdown()
        esc = json.load(open(".agent-logs/t1.escalation.json"))
        self.assertEqual(esc["self_review"]["likely_cause"], "Db imported from reports.ts")
        self.assertEqual(esc["self_review"]["spec_items"][0]["status"], "wrong")
        self.assertIn("a claim", esc["self_review"]["source"])

    def test_escalation_written_when_model_is_down(self):
        self.write_attempts(attempt("t1", ["a.ts"]))
        env = dict(self.env, FEEDBACK_REVIEW_URL="http://127.0.0.1:9/v1/chat/completions", FEEDBACK_REVIEW_TIMEOUT="3")
        r = self.feedback("finish", "t1", "failed", "check failed", env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        esc = json.load(open(".agent-logs/t1.escalation.json"))
        self.assertTrue(esc["self_review"]["skipped"].startswith("model unavailable"))
        self.assertEqual(esc["task"], "t1")


if __name__ == "__main__":
    unittest.main()

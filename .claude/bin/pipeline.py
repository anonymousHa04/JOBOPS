#!/usr/bin/env python3
"""The coder pipeline's two high-level steps, one process each. autofix.sh is the single entry
point for a task and calls them in this order:

    ready.sh                                     environment ready? (else nothing is dispatched)
    pipeline.py prepare <task> <spec> <files>    complexity route + context bundle
    <runner>                                     patch runner, or aider for new files
    pipeline.py verify <attempt> <spec> <orig-dir> <files>   edit gate (+ dependency preflight)
    check.sh                                     typecheck, tests, Go

prepare  writes .agent-logs/<task>.prep.json and <task>.bundle.md; prints "PREP route=.. runner=..".
         Exit 2 when the task is refused (new subsystem, cross-language without a contract,
         multi-file edit, new dependency): the manager splits it first.
verify   writes .agent-logs/<attempt>.gate.json; exit 1 when the edit gate fails.
The steps live in classify_task.py, context_bundle.py and verify_edit.py (each runnable alone).
"""
import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_task  # noqa: E402
import context_bundle  # noqa: E402
import verify_edit  # noqa: E402

LOGS = os.path.join(verify_edit.ROOT, ".agent-logs")


def quiet(fn, argv):
    """Run a step's main(argv), returning (exit code, its stdout)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = fn(argv)
    return rc or 0, buf.getvalue()


def prepare(task, spec, files):
    rc, out = quiet(classify_task.main, ["classify", spec, *files])
    route = json.loads(out.strip().splitlines()[-1])
    bundle = os.path.join(LOGS, task + ".bundle.md")
    _, bout = quiet(context_bundle.main, ["bundle", spec, bundle, *files])
    route["bundle"] = json.loads(bout.strip().splitlines()[-1]) if bout.strip() else None
    with open(os.path.join(LOGS, task + ".prep.json"), "w") as f:
        json.dump(route, f, indent=1)
    print(f"PREP route={route['route']} runner={route['runner'] or 'refused'} score={route['score']}"
          + "".join(f"\nPREP note: {r}" for r in route["reasons"]))
    return 0 if route["runner"] else 2


def verify(attempt, spec, orig, files):
    rc, out = quiet(verify_edit.main, ["verify", attempt, spec, orig, *files])
    print(out, end="")
    return rc


def main(argv):
    if len(argv) >= 4 and argv[1] == "prepare":
        return prepare(argv[2], argv[3], argv[4:])
    if len(argv) >= 5 and argv[1] == "verify":
        return verify(argv[2], argv[3], argv[4], argv[5:])
    raise SystemExit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

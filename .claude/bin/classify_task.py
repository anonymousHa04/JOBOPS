#!/usr/bin/env python3
"""Task-complexity gate before dispatch: choose the execution strategy, or refuse the task.

Usage: classify_task.py <spec> <file>...
Prints one JSON line: {"route": ..., "runner": ..., "score": n, "dimensions": {...}, "reasons": [...]}
Exit 0 = dispatch with that runner; 2 = refused (the manager splits the task or adds a contract).

Dimensions (low -> high complexity):
  files        one -> several
  language     already in the target's folder -> new to it (first .go file of a new module)
  dependencies none -> a new package (a "new-dependency:" line, or an install command not under a "no"/"never")
  api_surface  existing names -> new exported interfaces (new file)
  tests        none -> new test infrastructure (a test file in a folder with no tests yet)
  change_type  local modification -> new subsystem (new folder)

Routes:
  small_edit       one existing file                    -> patch runner (search/replace, checked)
  extension        new file(s) in an existing folder    -> aider with the context bundle
  new_subsystem    new folder, or 3+ new files          -> refused: plan it as smaller verifiable stages
  cross_language   files in two languages               -> refused unless the spec has a "contract:" line
Edit tasks should change one function: an edit task over several existing files is refused too.
"""
import json
import os
import re
import subprocess
import sys

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
LANG = {".ts": "ts", ".mts": "ts", ".js": "js", ".mjs": "js", ".go": "go", ".py": "py", ".sh": "sh", ".html": "html"}


def lang(p):
    return LANG.get(os.path.splitext(p)[1], "other")


def new_dependency(spec):
    """An explicit "new-dependency:" line, or an install command on a line that is not a prohibition
    ("No new dependencies", "never npm install") - plain wording is not guessed at."""
    if re.search(r"^new-dependency:", spec, re.M | re.I):
        return True
    return any(re.search(r"\b(go get|npm install|uv tool install|pip install)\b", l, re.I)
               and not re.search(r"\b(no|never|not|don't|do not|without)\b", l, re.I) for l in spec.splitlines())


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    spec = open(argv[1], encoding="utf-8").read()
    files = argv[2:]
    exists = {f: os.path.exists(os.path.join(ROOT, f)) and os.path.getsize(os.path.join(ROOT, f)) > 0 for f in files}
    new = [f for f in files if not exists[f]]
    old = [f for f in files if exists[f]]
    langs = sorted({lang(f) for f in files})
    new_dirs = sorted({os.path.dirname(f) for f in new if not os.path.isdir(os.path.join(ROOT, os.path.dirname(f)))
                       or not [x for x in os.listdir(os.path.join(ROOT, os.path.dirname(f))) if lang(x) == lang(f)]})
    tests_new = [f for f in new if re.search(r"(_test\.go|\.test\.ts)$", f)
                 and not [x for x in os.listdir(os.path.join(ROOT, os.path.dirname(f)) if os.path.isdir(os.path.join(ROOT, os.path.dirname(f))) else ".")
                          if re.search(r"(_test\.go|\.test\.ts)$", x) and x != os.path.basename(f)]]
    dims = {
        "files": "several" if len(files) > 1 else "one",
        "language": "new" if new_dirs and any(lang(f) == "go" for f in new) else "existing",
        "dependencies": "new" if new_dependency(spec) else "none",
        "api_surface": "new" if new else "existing",
        "tests": "new infrastructure" if tests_new else ("tests" if any("test" in f for f in files) else "none"),
        "change_type": "new subsystem" if new_dirs or len(new) >= 3 else ("new file" if new else "local modification"),
    }
    score = sum([dims["files"] == "several", dims["language"] == "new", dims["dependencies"] == "new",
                 dims["api_surface"] == "new", dims["tests"] == "new infrastructure", dims["change_type"] == "new subsystem"])
    reasons, contract = [], re.search(r"^contract:", spec, re.M)
    if len([l for l in langs if l != "other"]) > 1 and not contract:
        route, runner = "cross_language", None
        reasons.append("files in %s: write an explicit interface contract (a contract: line) first" % " and ".join(langs))
    elif dims["change_type"] == "new subsystem":
        route, runner = "new_subsystem", None
        reasons.append("new folder or 3+ new files (%s): split into smaller, independently verifiable stages"
                       % ", ".join(new_dirs or new))
    elif dims["dependencies"] == "new":
        route, runner = "new_dependency", None
        reasons.append("the task adds a dependency: the manager installs it (user approval) before dispatch")
    elif not new and len(old) > 1:
        route, runner = "multi_file_edit", None
        reasons.append("an edit task over %d existing files: split it into one task per file (one function each)" % len(old))
    elif not new:
        route, runner = "small_edit", "patch"
        if not re.search(r"^expect:", spec, re.M):
            reasons.append("warning: no expect: line, so the edit gate cannot check that the diff addresses the request")
    else:
        route, runner = "extension", "aider"
        if old:
            reasons.append("mixes new and existing files: aider gets every file whole; prefer separate tasks")
    print(json.dumps({"route": route, "runner": runner, "score": score, "dimensions": dims, "reasons": reasons}))
    return 0 if runner else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

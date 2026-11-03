#!/usr/bin/env python3
"""Patch runner: the coder writes search/replace blocks; this controller checks and applies them.

Usage: patch_coder.py <task> <spec> <file>...      (run by run-patch.sh in a tmux window)
       patch-coder.py --apply <patch-file> <spec> <file>...   (apply a saved patch; self-test)

The model never writes a whole file (milestone 5: aider cut routes.ts from 129 lines to 1). It
answers with blocks like

    FILE: api/src/model/registry.ts
    <<<<<<< SEARCH
      return { up: r.ok, spec };
    =======
      return { up: r.ok, spec, status: r.status };
    >>>>>>> REPLACE

and the controller:
  - accepts only the task's files;
  - requires each SEARCH text to occur exactly once in the file as it is at that point (exact, or
    exact after trailing spaces are ignored on each line);
  - applies every block in memory, then runs the deletion check (removed lines over
    "allow-delete: N" from the spec, default max(15, 25% of the file), or a file shrunk by >40%);
  - writes nothing unless every block and check passed, then replaces each file atomically.
A rejected patch is logged as "RUN-PATCH: PATCH REJECTED: <reason>" (an EDIT_FAILURE).
"""
import difflib
import json
import os
import re
import sys
import tempfile
import time
import urllib.request

ROOT = os.popen("git rev-parse --show-toplevel").read().strip()
BLOCK = re.compile(r"^FILE:\s*(\S+)\s*\n<<<<<<< SEARCH\n(.*?)\n?=======\n(.*?)\n?>>>>>>> REPLACE", re.M | re.S)

RULES = """You edit existing files by writing search/replace blocks. Answer with blocks only, in this exact form:

FILE: <path of a file listed below>
<<<<<<< SEARCH
<lines copied exactly from the file, enough to be unique: usually 2 to 6 lines>
=======
<the new lines that replace them>
>>>>>>> REPLACE

Rules:
- SEARCH must be copied character for character from the current file and occur in it exactly once.
- Change only what the task asks. Never rewrite a whole file. Keep every other line as it is.
- To add code, SEARCH the line just before the new code and repeat it in REPLACE followed by the new code.
- Use only the names and imports listed in the context bundle; do not invent packages or functions.
- One block per change; several blocks are fine. No explanations, no code fences."""


class Rejected(Exception):
    pass


def spec_int(spec, name):
    m = re.search(r"^%s:\s*(\d+)" % re.escape(name), spec, re.M)
    return int(m.group(1)) if m else None


def find_once(text, search):
    """Start/end of the single occurrence of search in text (exact, then ignoring trailing spaces)."""
    n = text.count(search)
    if n == 1:
        i = text.index(search)
        return i, i + len(search)
    if n > 1:
        raise Rejected(f"SEARCH occurs {n} times; add lines to make it unique: {search.splitlines()[0][:80]!r}")
    # Ignore trailing whitespace on each line.
    lines = text.split("\n")
    want = [l.rstrip() for l in search.split("\n")]
    hits = [i for i in range(len(lines) - len(want) + 1) if [l.rstrip() for l in lines[i:i + len(want)]] == want]
    if len(hits) == 1:
        start = sum(len(l) + 1 for l in lines[:hits[0]])
        end = start + sum(len(l) + 1 for l in lines[hits[0]:hits[0] + len(want)]) - 1
        return start, end
    if len(hits) > 1:
        raise Rejected(f"SEARCH occurs {len(hits)} times; add lines to make it unique: {want[0][:80]!r}")
    raise Rejected(f"SEARCH not found in the file: {search.splitlines()[0][:80] if search else '(empty)'!r}")


def apply_patch(answer, spec, targets):
    blocks = BLOCK.findall(answer)
    if not blocks:
        raise Rejected("no search/replace block in the answer")
    current = {}
    for path, search, replace in blocks:
        path = path.strip().strip("`")
        if path not in targets:
            raise Rejected(f"block for {path}, which is not a task file ({', '.join(targets)})")
        if path not in current:
            full = os.path.join(ROOT, path)
            if not os.path.exists(full):
                raise Rejected(f"{path} does not exist (the patch runner edits existing files only)")
            current[path] = open(full, encoding="utf-8").read()
        if not search.strip():
            raise Rejected("an empty SEARCH; quote the line before the new code instead")
        start, end = find_once(current[path], search)
        current[path] = current[path][:start] + replace + current[path][end:]
    allow = spec_int(spec, "allow-delete")
    stats = {}
    for path, new in current.items():
        old = open(os.path.join(ROOT, path), encoding="utf-8").read()
        if new == old:
            raise Rejected(f"the blocks leave {path} unchanged")
        o, n = old.splitlines(), new.splitlines()
        removed = sum(1 for l in difflib.unified_diff(o, n, lineterm="", n=0) if l.startswith("-") and not l.startswith("---"))
        limit = allow if allow is not None else max(15, len(o) // 4)
        if removed > limit or len(n) < len(o) * 0.6:
            raise Rejected(f"{path}: {len(o)} -> {len(n)} lines, {removed} removed (limit {limit}); edit only what the task asks")
        stats[path] = {"before": len(o), "after": len(n), "removed": removed}
    # Every block and check passed: write each file atomically.
    for path, new in current.items():
        full = os.path.join(ROOT, path)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(full), prefix=".patch-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new)
        os.chmod(tmp, os.stat(full).st_mode)
        os.replace(tmp, full)
    return len(blocks), stats


def ask_model(prompt):
    url = os.environ.get("CODER_URL", "http://127.0.0.1:8081/v1") + "/chat/completions"
    body = json.dumps({"model": os.environ.get("CODER_ALIAS", "qwen2.5-coder-14b"), "temperature": 0,
                       "max_tokens": int(os.environ.get("PATCH_MAX_TOKENS", "3000")),
                       "messages": [{"role": "system", "content": RULES}, {"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=int(os.environ.get("CODER_TIMEOUT", "1200"))) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"], data.get("usage", {})


def main(argv):
    if len(argv) >= 4 and argv[1] == "--apply":
        patch, spec_path, targets = argv[2], argv[3], argv[4:]
        try:
            n, stats = apply_patch(open(patch).read(), open(spec_path).read(), targets)
            print(f"Applied edit: {n} block(s) {json.dumps(stats)}")
            return 0
        except Rejected as e:
            print(f"RUN-PATCH: PATCH REJECTED: {e}")
            return 1
    task, spec_path, targets = argv[1], argv[2], argv[3:]
    logs = os.path.join(ROOT, ".agent-logs")
    spec = open(spec_path, encoding="utf-8").read()
    bundle_path = os.path.join(logs, task + ".bundle.md")
    bundle = open(bundle_path, encoding="utf-8").read() if os.path.exists(bundle_path) else ""
    files = "\n\n".join(f"FILE: {t}\n{open(os.path.join(ROOT, t), encoding='utf-8').read()}" for t in targets)
    prompt = f"TASK\n{spec}\n\n{bundle}\n\nCURRENT FILES (edit these with search/replace blocks)\n\n{files}\n"
    started = time.time()
    try:
        answer, usage = ask_model(prompt)
    except Exception as e:
        print(f"RUN-PATCH: MODEL SERVER ERROR: {e}")
        return 3
    with open(os.path.join(logs, task + ".patch.txt"), "w", encoding="utf-8") as f:
        f.write(answer)
    print(f"model answered in {time.time() - started:.0f}s, tokens {usage}")
    try:
        n, stats = apply_patch(answer, spec, targets)
    except Rejected as e:
        print(f"RUN-PATCH: PATCH REJECTED: {e}")
        return 1
    print(f"Applied edit: {n} block(s) {json.dumps(stats)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Edit-verification gate: the orchestrator, not the model, decides whether an edit happened.

Usage: verify_edit.py <attempt> <spec> <orig-dir> <file>...
  orig-dir holds each target as it was before the attempt (autofix.sh copies them there;
  a target missing there is a new file). OUTSIDE (env) lists files changed outside the task.

Checks, in order (milestone 5: a coder answered "done" with no edit; aider cut routes.ts from
129 lines to 1; coders imported node:undici, abort-controller and testify):
  1. expected files changed (each target differs from before; a new file exists and is not empty)
  2. the diff is not empty
  3. the diff addresses the request: every "expect:" token in the spec appears in the added lines
  4. no file outside the task changed
  5. no substantial deletion: removed lines over "allow-delete: N" (default max(15, 25% of the
     file)), or a file shrunk by more than 40%
  6. each target passes a syntax check (TypeScript: tsc, syntax errors TS1xxx only; JS: node --check;
     Go: gofmt -e; Python: py_compile)
  7. dependency preflight: every import is a relative file that exists, a package.json
     dependency, a Node built-in, the Go standard library, the module itself or a go.mod require
Writes .agent-logs/<attempt>.gate.json; prints one line per check. Exit 0 = passed.
Failure class: EDIT_FAILURE (1-6) or DEPENDENCY_FAILURE (7).
"""
import difflib
import json
import os
import re
import subprocess
import sys

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
LOGS = os.path.join(ROOT, ".agent-logs")


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def spec_field(spec, name):
    """Values of every "<name>: ..." line in the spec, comma-separated, quotes optional."""
    vals = []
    for m in re.finditer(r"^%s:\s*(.+)$" % re.escape(name), spec, re.M):
        vals += [v.strip().strip("'\"`") for v in m.group(1).split(",") if v.strip()]
    return vals


def node_builtins():
    try:
        out = subprocess.run(["node", "-p", "JSON.stringify(require('module').builtinModules)"],
                             capture_output=True, text=True, timeout=20).stdout
        return set(json.loads(out))
    except Exception:
        return set()


def npm_deps():
    pkg = json.loads(read(os.path.join(ROOT, "package.json")) or "{}")
    return {*pkg.get("dependencies", {}), *pkg.get("devDependencies", {})}


def go_module_of(path):
    d = os.path.dirname(path)
    while d and not os.path.exists(os.path.join(ROOT, d, "go.mod")):
        d = os.path.dirname(d)
    if not d:
        return None, set()
    gomod = read(os.path.join(ROOT, d, "go.mod")) or ""
    module = (re.search(r"^module (\S+)", gomod, re.M) or [None, ""])[1]
    reqs = set(re.findall(r"^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]+/\S+) v\S+", gomod, re.M))
    return module, reqs


def ts_imports(text):
    return re.findall(r"""(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)""", text, re.M)


def bad_ts_imports(path, text, deps, builtins):
    bad = []
    for groups in ts_imports(text):
        spec = next(g for g in groups if g)
        if spec.startswith("."):
            target = os.path.normpath(os.path.join(ROOT, os.path.dirname(path), spec))
            if not os.path.exists(target):
                bad.append(f"{spec} (no such file: {os.path.relpath(target, ROOT)})")
        elif spec.startswith("node:"):
            if spec[5:].split("/")[0] not in builtins and spec[5:] not in builtins:
                bad.append(f"{spec} (not a Node built-in)")
        else:
            name = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
            if name not in deps and spec not in builtins:
                bad.append(f"{spec} (not in package.json)")
    return bad


def bad_go_imports(path, text):
    module, reqs = go_module_of(path)
    block = re.search(r"^import \((.*?)^\)", text, re.M | re.S)
    lines = block.group(1).splitlines() if block else []
    lines += re.findall(r'^import\s+(?:\w+\s+)?("[^"]+")', text, re.M)
    bad = []
    for line in lines:
        m = re.search(r'"([^"]+)"', line)
        if not m:
            continue
        imp = m.group(1)
        first = imp.split("/")[0]
        if "." not in first:
            continue  # standard library
        if module and (imp == module or imp.startswith(module + "/")):
            continue
        if any(imp == r or imp.startswith(r + "/") for r in reqs):
            continue
        bad.append(f"{imp} (not the standard library, {module or 'the module'}, or a go.mod require)")
    return bad


def syntax_error(path):
    full = os.path.join(ROOT, path)
    if path.endswith((".ts", ".mts")):
        # node --check ignores TypeScript. tsc on this one file, keeping only syntax errors
        # (TS1xxx); type errors need the whole project and are check.sh's job.
        r = subprocess.run(["npx", "--no-install", "tsc", "--ignoreConfig", "--noEmit", "--noResolve", "--skipLibCheck", "--target", "esnext",
                            "--module", "nodenext", "--allowImportingTsExtensions", "--pretty", "false", full],
                           capture_output=True, text=True, timeout=120, cwd=ROOT)
        syn = [l for l in r.stdout.splitlines() if re.search(r"error TS1\d{3}:", l)]
        return " | ".join(syn[:3])[:300] if syn else None
    elif path.endswith((".js", ".mjs", ".cjs")):
        r = subprocess.run(["node", "--check", full], capture_output=True, text=True, timeout=60)
    elif path.endswith(".go"):
        r = subprocess.run(["gofmt", "-e", "-l", full], capture_output=True, text=True, timeout=60)
    elif path.endswith(".py"):
        r = subprocess.run([sys.executable, "-m", "py_compile", full], capture_output=True, text=True, timeout=60)
    else:
        return None
    if r.returncode != 0:
        lines = [l for l in (r.stderr or r.stdout).splitlines() if l.strip()]
        return " | ".join(lines[:3])[:300] or "syntax check failed"
    return None


def main(argv):
    if len(argv) < 5:
        raise SystemExit(__doc__)
    attempt, spec_path, orig_dir, targets = argv[1], argv[2], argv[3], argv[4:]
    spec = read(spec_path) or ""
    expect = spec_field(spec, "expect")
    allow = spec_field(spec, "allow-delete")
    allow_n = int(allow[0]) if allow and allow[0].isdigit() else None
    outside = [o for o in os.environ.get("OUTSIDE", "").split() if o]

    checks, fail_class = [], None

    def add(name, ok, detail="", cls="EDIT_FAILURE"):
        nonlocal fail_class
        checks.append({"check": name, "status": "passed" if ok is True else ("skipped" if ok is None else "failed"),
                       "detail": detail})
        if ok is False and fail_class is None:
            fail_class = cls

    added_all, removed_total, per_file = [], 0, {}
    unchanged, missing_new = [], []
    for t in targets:
        before = read(os.path.join(orig_dir, t))
        after = read(os.path.join(ROOT, t))
        if after is None or (before is None and not after.strip()):
            missing_new.append(t)
            per_file[t] = {"added": 0, "removed": 0}
            continue
        if before is not None and before == after:
            unchanged.append(t)
        old = (before or "").splitlines()
        new = after.splitlines()
        diff = list(difflib.unified_diff(old, new, lineterm="", n=0))
        added = [l[1:] for l in diff if l.startswith("+") and not l.startswith("+++")]
        removed = [l[1:] for l in diff if l.startswith("-") and not l.startswith("---")]
        added_all += added
        removed_total += len(removed)
        per_file[t] = {"before_lines": len(old), "after_lines": len(new), "added": len(added), "removed": len(removed)}

    changed = [t for t in targets if t not in unchanged and t not in missing_new]
    add("1 expected files changed", not unchanged and not missing_new,
        "; ".join(filter(None, [("unchanged: " + ", ".join(unchanged)) if unchanged else "",
                                ("missing or empty: " + ", ".join(missing_new)) if missing_new else ""])) or
        "changed: " + ", ".join(changed))
    add("2 diff not empty", bool(added_all) or removed_total > 0,
        f"{len(added_all)} lines added, {removed_total} removed")
    if expect:
        blob = "\n".join(added_all)
        missing = [e for e in expect if e not in blob]
        add("3 diff addresses the request", not missing,
            ("expected text not in the added lines: " + ", ".join(missing)) if missing else "found: " + ", ".join(expect))
    else:
        add("3 diff addresses the request", None, "spec has no expect: line")
    add("4 scope", not outside, ("changed outside the task: " + ", ".join(outside)) if outside else "only task files")
    big = []
    for t, s in per_file.items():
        if not s.get("before_lines"):
            continue
        limit = allow_n if allow_n is not None else max(15, s["before_lines"] // 4)
        if s["removed"] > limit or s["after_lines"] < s["before_lines"] * 0.6:
            big.append(f"{t}: {s['before_lines']} -> {s['after_lines']} lines, {s['removed']} removed (limit {limit})")
    add("5 no large deletion", not big, "; ".join(big) or "ok")
    errs = [f"{t}: {e}" for t in targets if os.path.exists(os.path.join(ROOT, t)) for e in [syntax_error(t)] if e]
    add("6 syntax", not errs, "; ".join(errs) or "ok")
    deps, builtins = npm_deps(), node_builtins()
    bad = []
    for t in targets:
        text = read(os.path.join(ROOT, t))
        if text is None:
            continue
        if t.endswith((".ts", ".mts", ".js", ".mjs")):
            bad += [f"{t}: {b}" for b in bad_ts_imports(t, text, deps, builtins)]
        elif t.endswith(".go"):
            bad += [f"{t}: {b}" for b in bad_go_imports(t, text)]
    add("7 dependencies exist", not bad, "; ".join(bad) or "ok", cls="DEPENDENCY_FAILURE")

    status = "passed" if fail_class is None else "failed"
    out = {"attempt": attempt, "status": status, "class": fail_class, "checks": checks, "files": per_file}
    with open(os.path.join(LOGS, attempt + ".gate.json"), "w") as f:
        json.dump(out, f, indent=1)
    for c in checks:
        print(f"GATE {c['status'].upper():7} {c['check']}: {c['detail']}")
    print(f"GATE RESULT: {status}" + (f" ({fail_class})" if fail_class else ""))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

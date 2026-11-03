#!/usr/bin/env python3
"""Dependency context bundle for one coder task: what the coder cannot see but must not guess.

Usage: context_bundle.py <spec> <out.md> <file>...

Sections (plain text, no code fences, aider reads it with --read):
  1. Allowed dependencies: package.json dependencies, Node built-ins, Go standard library note,
     go.mod requires and module path. Anything else is a made-up package (milestone 5: node:undici,
     abort-controller, testify).
  2. Names that already exist in each target's package (Go: every top-level func, method, type,
     var and const in the directory; TypeScript: every export of the sibling modules). A new file
     must not declare them again (milestone 5: Store, MaxAttempts and ErrNotLeased redeclared).
  3. Signatures of names the spec mentions, wherever they are declared (milestone 5: the coder
     called store.CreateBatch and store.NewStore; the real names were StartBatch and Open).
Also writes <out>.json with the names, for the edit gate's dependency preflight.
"""
import json
import os
import re
import subprocess
import sys

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
SRC_DIRS = ["api/src", "queue", "jd-search"]
GO_DECL = re.compile(r"^(func(?: \([^)]*\))? ([A-Za-z_]\w*)\(.*|type ([A-Za-z_]\w*) .*|(?:var|const) ([A-Za-z_]\w*)\b.*)$")
GO_BLOCK = re.compile(r"^(var|const) \($")
TS_EXPORT = re.compile(r"^export (?:async )?(?:function\*? |const |let |class |type |interface |enum )([A-Za-z_]\w*)(.*)$")
MAX_CHARS = 9000


def rel(p):
    return os.path.relpath(p, ROOT)


def read(p):
    try:
        with open(os.path.join(ROOT, p), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def go_decls(path):
    """(name, line) for every top-level Go declaration, including names inside var/const blocks."""
    out, block = [], False
    for line in read(path).splitlines():
        if GO_BLOCK.match(line):
            block = True
            continue
        if block:
            if line.startswith(")"):
                block = False
            else:
                m = re.match(r"^\t([A-Za-z_]\w*)\b", line)
                if m:
                    out.append((m.group(1), line.strip()))
            continue
        m = GO_DECL.match(line)
        if m:
            name = m.group(2) or m.group(3) or m.group(4)
            out.append((name, line.rstrip(" {")))
    return out


def ts_exports(path):
    out = []
    for line in read(path).splitlines():
        m = TS_EXPORT.match(line)
        if m:
            sig = line.rstrip(" {")
            out.append((m.group(1), sig[:200]))
    return out


def decls(path):
    if path.endswith("_test.go"):
        return go_decls(path)
    if path.endswith(".go"):
        return go_decls(path)
    if path.endswith(".ts") and not path.endswith(".d.ts"):
        return ts_exports(path)
    return []


def source_files():
    files = []
    for d in SRC_DIRS:
        for base, dirs, names in os.walk(os.path.join(ROOT, d)):
            dirs[:] = [x for x in dirs if x not in ("node_modules", ".git", "testdata")]
            for n in names:
                if n.endswith((".go", ".ts")):
                    files.append(rel(os.path.join(base, n)))
    return sorted(files)


def allowed_deps(targets):
    lines, names = [], {"npm": [], "node": [], "go_modules": {}}
    pkg = json.loads(read("package.json") or "{}")
    npm = sorted({*pkg.get("dependencies", {}), *pkg.get("devDependencies", {})})
    names["npm"] = npm
    try:
        builtins = json.loads(subprocess.run(["node", "-p", "JSON.stringify(require('module').builtinModules)"],
                                             capture_output=True, text=True, timeout=20).stdout)
    except Exception:
        builtins = []
    names["node"] = builtins
    if any(t.endswith((".ts", ".js", ".mjs")) for t in targets):
        lines.append("- npm packages (package.json): " + ", ".join(npm))
        lines.append("- Node built-ins, imported as node:<name> (node:fs, node:http, node:crypto, ...). Global fetch and AbortSignal.timeout need no import.")
        lines.append("- Relative imports end in .ts and must point to a file that exists (from api/test use ./fixtures.ts and ../src/...).")
        lines.append("- import type for names that are only types (verbatimModuleSyntax).")
    for t in targets:
        if not t.endswith(".go"):
            continue
        d = os.path.dirname(t)
        while d and not os.path.exists(os.path.join(ROOT, d, "go.mod")):
            d = os.path.dirname(d)
        if not d or d in names["go_modules"]:
            continue
        gomod = read(os.path.join(d, "go.mod"))
        module = (re.search(r"^module (\S+)", gomod, re.M) or [None, ""])[1]
        reqs = sorted(set(re.findall(r"^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]+/\S+) v\S+", gomod, re.M)))
        names["go_modules"][d] = {"module": module, "requires": reqs}
        lines.append(f"- Go module {d}/ is {module}: import its packages as {module}/<dir>; go.mod requires: "
                     + (", ".join(reqs) if reqs else "nothing") + ". Otherwise only the Go standard library (no testify, no new modules).")
    return lines, names


def main(argv):
    if len(argv) < 4:
        raise SystemExit(__doc__)
    spec_path, out, targets = argv[1], argv[2], [rel(os.path.abspath(t)) if os.path.isabs(t) else t for t in argv[3:]]
    spec = read(spec_path) if not os.path.isabs(spec_path) else open(spec_path, encoding="utf-8").read()
    parts = ["# Context bundle (read only): use these names exactly; do not guess others", ""]

    dep_lines, dep_names = allowed_deps(targets)
    parts += ["## 1. Allowed dependencies (anything else does not exist here)", *dep_lines, ""]

    parts.append("## 2. Names that already exist in each target's package (never declare them again)")
    seen_dirs = set()
    package_names = {}
    for t in targets:
        d = os.path.dirname(t)
        if d in seen_dirs:
            continue
        seen_dirs.add(d)
        siblings = [f for f in source_files() if os.path.dirname(f) == d and f not in targets]
        if not siblings:
            parts.append(f"- {d}/: no other files yet")
            continue
        parts.append(f"- {d}/ (" + ("package " + (re.search(r"^package (\w+)", read(siblings[0]), re.M) or [None, "?"])[1]
                                   if t.endswith(".go") else "modules") + "):")
        for f in siblings:
            ds = decls(f)
            package_names[f] = [n for n, _ in ds]
            if ds:
                parts.append(f"  {os.path.basename(f)}:")
                parts += [f"    {line}" for _, line in ds]
    parts.append("")

    # 3. Names the spec mentions that are declared somewhere in the sources.
    index = {}
    for f in source_files():
        if f in targets:
            continue
        for n, line in decls(f):
            index.setdefault(n, []).append((f, line))
    words = set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]{3,})\b", spec))
    hits = [(n, index[n]) for n in sorted(words) if n in index]
    parts.append("## 3. Signatures of names the spec mentions (exact names and parameters)")
    if hits:
        for n, places in hits:
            for f, line in places[:3]:
                parts.append(f"- {f}: {line}")
    else:
        parts.append("- (none found)")
    text = "\n".join(parts) + "\n"
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rsplit("\n", 1)[0] + "\n(cut to fit the context window)\n"
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    with open(out.rsplit(".", 1)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump({"deps": dep_names, "package_names": package_names, "spec_names": [n for n, _ in hits]}, f, indent=1)
    print(json.dumps({"bundle": out, "chars": len(text), "spec_names": len(hits)}))


if __name__ == "__main__":
    main(sys.argv)

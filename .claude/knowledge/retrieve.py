#!/usr/bin/env python3
"""Agent Knowledge Layer, Phase 1: exact + structural retrieval.

Answers: given a coding task, which requirements, source, dependencies,
consumers, tests, and verified fixes should the coding agent see?

  retrieve.py context --spec FILE [--files F...] [--budget N] [--format json|md] [--out FILE]
  retrieve.py search QUERY [--limit N]      exact search (FTS5, BM25)
  retrieve.py deps FILE | rdeps FILE        import graph
  retrieve.py index                         corpus stats
  retrieve.py eval                          run eval.json and report recall

Design (agentManagementAndFeedbackSystem.md §4):
- Corpus: git-tracked and untracked, not-ignored files, minus a denylist
  (profile/, data/, secrets, dependencies, generated output). Rebuilt on every
  call, so it is never stale. Source files stay the source of truth.
- Exact search: SQLite FTS5 over chunks (one per top-level declaration in
  code, one per heading in Markdown) plus an exact symbol table of exports.
- Structural: TypeScript/Go import graph (deps, reverse deps), consumers'
  usage lines, tests that import a module.
- Semantic search: Phase 2, plugged in as another method; it never overrides
  hard constraints.
- Every item carries path, line range, kind, method, rank, and an evidence
  class: requirement | source_fact | verified_fix | hypothesis | outdated.
Standard library only (Python 3.9+).
"""
import argparse
import fnmatch
import json
import os
import re
import sqlite3
import hashlib
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
FIXES = os.path.join(HERE, "fixes.jsonl")
EVAL = os.path.join(HERE, "eval.json")

# .claude/skills/ mirrors .agents/skills/ (the shared copy agents use), so only one is indexed.
DENY_PREFIX = ("profile/", "data/", "node_modules/", "graphify-out/", ".scout/", ".agent-logs/",
               ".claude/specs/", ".claude/skills/", ".git/")
DENY_GLOB = (".env", ".env.*", "*.pem", "*.key", "*secret*", "*token*", "package-lock.json", "go.sum")
ALLOW_EXT = (".ts", ".go", ".md", ".yaml", ".yml", ".json", ".sh", ".py", ".toml")
REQUIREMENT_DOCS = ("README.md", "requierements/", ".agents/skills/")
DECISIONS = ".agents/skills/m3-notes/references/decisions.md"
MAX_FILE_BYTES = 200_000

# Settings from the repo .env (see .env.example); variables already set win.
_ENV = os.path.join(HERE, "..", "..", ".env")
if os.path.exists(_ENV):
    for _line in open(_ENV, encoding="utf-8"):
        _k, _sep, _v = _line.strip().partition("=")
        if _sep and not _k.startswith("#"):
            os.environ.setdefault(_k.strip(), _v.strip())

# Semantic search (Phase 2): local embeddings from llama.cpp (llama-server --embeddings,
# started by .claude/bin/llm.sh), vectors in Qdrant (Docker).
EMBED_URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8082")
QDRANT = os.environ.get("QDRANT_URL", "http://localhost:6333")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "mxbai-embed-large")
COLLECTION = os.environ.get("KNOWLEDGE_COLLECTION", "jobops_knowledge")
EMBED_CHARS = 1800          # first cut by characters ...
EMBED_TOKENS = 500          # ... then by tokens: mxbai-embed-large reads at most 512
SEMANTIC_MIN_SCORE = 0.55
POINT_NS = uuid.UUID("6f1c7a52-2c0e-4c1e-9d4e-1b0a7c3e9f10")

TS_DECL = re.compile(r"^(export\s+)?(async\s+)?(function|const|let|type|interface|class)\s+([A-Za-z_][\w]*)")
GO_DECL = re.compile(r"^(func|type|var|const)\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)")
MD_HEAD = re.compile(r"^#{1,3}\s+\S")
TS_IMPORT = re.compile(
    r"^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+[\"']([^\"']+)[\"']", re.M)
GO_IMPORT = re.compile(r"\"(jobops/jd-search/[^\"]+)\"")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PATH_REF = re.compile(r"[\w.\-]+(?:/[\w.\-]+)+\.(?:ts|go|md|yaml|yml|json|sh|py)\b")
STOP = set("""the and for with that this from into only each then when must should will have has are
was were not you your any all can use used uses one two new file files task code return returns
string number boolean array object true false null undefined export import const function type
default spec edit change make add""".split())


def tokens(text):
    return max(1, len(text) // 4)


# ---------------------------------------------------------------- corpus

def repo_root():
    return subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()


def allowed(path):
    if path.startswith(DENY_PREFIX):
        return False
    name = os.path.basename(path)
    if any(fnmatch.fnmatch(name, g) for g in DENY_GLOB):
        return False
    return path.endswith(ALLOW_EXT)


def list_files(root):
    out = subprocess.check_output(["git", "-C", root, "ls-files", "-co", "--exclude-standard"], text=True)
    files = []
    for p in out.splitlines():
        full = os.path.join(root, p)
        if allowed(p) and os.path.isfile(full) and os.path.getsize(full) <= MAX_FILE_BYTES:
            files.append(p)
    return sorted(set(files))


def kind_of(path):
    if path.startswith("api/test/") or path.endswith("_test.go") or ".test." in path:
        return "test"
    if path.endswith(".md") or path.endswith("knowledge/status.yaml"):
        return "doc"
    if path.endswith((".ts", ".go")):
        return "source"
    return "config"


def evidence_of(path, kind):
    # Requirements: product scope, the user's design docs, and the shared skills
    # (e.g. m3-notes: the engine spec and bullet rules).
    if path == "README.md" or path.startswith(("requierements/", ".agents/skills/")):
        return "requirement"
    return "source_fact"


def chunk_file(path, lines):
    """Split into chunks: code by top-level declaration, Markdown by heading."""
    starts, symbols = [0], {}
    if path.endswith(".ts"):
        for i, l in enumerate(lines):
            m = TS_DECL.match(l)
            if m:
                starts.append(i)
                if m.group(1):
                    symbols[i] = m.group(4)
    elif path.endswith(".go"):
        for i, l in enumerate(lines):
            m = GO_DECL.match(l)
            if m:
                starts.append(i)
                if m.group(3)[0].isupper():
                    symbols[i] = m.group(3)
    elif path.endswith(".md"):
        starts += [i for i, l in enumerate(lines) if MD_HEAD.match(l)]
    elif path.endswith((".yaml", ".yml")):
        # One chunk per top-level key and per list item ("  - id: ..."), so a
        # status record is retrieved item by item.
        starts += [i for i, l in enumerate(lines) if re.match(r"^[A-Za-z_]|^  - ", l)]
    else:
        starts += list(range(120, len(lines), 120))
    starts = sorted(set(s for s in starts if s < len(lines)))
    chunks = []
    for n, s in enumerate(starts):
        e = (starts[n + 1] if n + 1 < len(starts) else len(lines)) - 1
        while e > s and not lines[e].strip():
            e -= 1
        text = "\n".join(lines[s:e + 1])
        if not text.strip():
            continue
        chunks.append({"path": path, "start": s + 1, "end": e + 1, "text": text,
                       "symbol": symbols.get(s)})
    return chunks


class Index:
    def __init__(self, root):
        self.root = root
        self.files = list_files(root)
        self.lines, self.chunks, self.exports = {}, [], {}
        for p in self.files:
            with open(os.path.join(root, p), encoding="utf-8", errors="replace") as f:
                self.lines[p] = f.read().split("\n")
            for c in chunk_file(p, self.lines[p]):
                c["id"] = len(self.chunks)
                c["kind"] = kind_of(p)
                self.chunks.append(c)
                if c["symbol"]:
                    self.exports.setdefault(c["symbol"], []).append(c["id"])
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE VIRTUAL TABLE fts USING fts5(path, text, symbol, tokenize='unicode61')")
        self.db.executemany("INSERT INTO fts(rowid, path, text, symbol) VALUES (?,?,?,?)",
                            [(c["id"], c["path"], c["text"], c["symbol"] or "") for c in self.chunks])
        self._graph()

    # -- structure ------------------------------------------------------

    def _resolve(self, src, spec):
        if spec.startswith("."):
            p = os.path.normpath(os.path.join(os.path.dirname(src), spec))
            return p if p in self.lines else None
        return None

    def _graph(self):
        self.deps, self.rdeps = {}, {}
        go_pkgs = {}
        for p in self.files:
            if p.endswith(".go"):
                go_pkgs.setdefault(os.path.dirname(p), []).append(p)
        for p in self.files:
            text = "\n".join(self.lines[p])
            edges = []
            if p.endswith(".ts"):
                for m in TS_IMPORT.finditer(text):
                    target = self._resolve(p, m.group(3))
                    if target:
                        names = WORD.findall(re.sub(r"\bas\s+\w+", "", m.group(2).replace("type", " ")))
                        edges.append((target, sorted(set(names) - {"type", "as"})))
            elif p.endswith(".go"):
                for m in GO_IMPORT.finditer(text):
                    d = "jd-search/" + m.group(1)[len("jobops/jd-search/"):]
                    for t in go_pkgs.get(d, []):
                        if not t.endswith("_test.go"):
                            edges.append((t, []))
            self.deps[p] = edges
            for t, names in edges:
                self.rdeps.setdefault(t, []).append((p, names))

    def chunk_for(self, path, line):
        for c in self.chunks:
            if c["path"] == path and c["start"] <= line <= c["end"]:
                return c
        return None

    def symbol_chunks(self, name, path=None):
        return [self.chunks[i] for i in self.exports.get(name, []) if path is None or self.chunks[i]["path"] == path]

    def search(self, words, limit=10, kinds=None):
        terms = [w for w in dict.fromkeys(words) if len(w) >= 3 and w.lower() not in STOP]
        if not terms:
            return []
        q = " OR ".join('"%s"' % t.replace('"', "") for t in terms[:40])
        rows = self.db.execute(
            "SELECT rowid, bm25(fts) FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?", (q, limit * 4)).fetchall()
        out = []
        for rowid, score in rows:
            c = self.chunks[rowid]
            if kinds and c["kind"] not in kinds:
                continue
            out.append((c, -score))
            if len(out) >= limit:
                break
        return out


# ---------------------------------------------------------------- semantic

def http(method, url, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fit_tokens(text):
    """Trim to EMBED_TOKENS with the server's own tokenizer (llama-server rejects
    longer input instead of truncating it silently)."""
    toks = http("POST", EMBED_URL + "/tokenize", {"content": text})["tokens"]
    if len(toks) <= EMBED_TOKENS:
        return text
    return http("POST", EMBED_URL + "/detokenize", {"tokens": toks[:EMBED_TOKENS]})["content"]


def embed(texts):
    """Embedding vectors for texts, in order. (Queries carry mxbai's search prefix;
    documents don't: see semantic_search.)"""
    data = http("POST", EMBED_URL + "/v1/embeddings",
                {"model": EMBED_MODEL, "input": [fit_tokens(t) for t in texts]})["data"]
    return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]


def chunk_point_id(c):
    digest = hashlib.sha1(c["text"].encode()).hexdigest()
    return str(uuid.uuid5(POINT_NS, "%s:%d:%s" % (c["path"], c["start"], digest))), digest


def embed_index(ix, batch=16):
    """Sync the Qdrant collection with the current corpus: embed new or changed
    chunks, delete points for chunks that no longer exist. Idempotent.
    Only the main checkout writes: the index describes the main tree, and a
    worktree (an agent sandbox, often at an older commit) would add stale
    versions of files. Worktrees still search the index read-only."""
    if not is_main_checkout(ix.root):
        return {"skipped": "not the main checkout; the shared index is written only from the main tree"}
    coll = QDRANT + "/collections/" + COLLECTION
    try:
        http("GET", coll)
    except urllib.error.HTTPError:
        dim = len(embed(["dimension probe"])[0])
        http("PUT", coll, {"vectors": {"size": dim, "distance": "Cosine"}})
    existing, offset = set(), None
    while True:
        body = {"limit": 512, "with_payload": False, "with_vector": False}
        if offset:
            body["offset"] = offset
        r = http("POST", coll + "/points/scroll", body)["result"]
        existing.update(str(p["id"]) for p in r["points"])
        offset = r.get("next_page_offset")
        if not offset:
            break
    want = {}
    for c in ix.chunks:
        pid, digest = chunk_point_id(c)
        want[pid] = (c, digest)
    todo = [pid for pid in want if pid not in existing]
    for i in range(0, len(todo), batch):
        ids = todo[i:i + batch]
        vecs = embed([want[pid][0]["text"][:EMBED_CHARS] for pid in ids])
        points = []
        for pid, v in zip(ids, vecs):
            c, digest = want[pid]
            points.append({"id": pid, "vector": v, "payload": {
                "path": c["path"], "start": c["start"], "end": c["end"], "kind": c["kind"],
                "symbol": c["symbol"], "sha1": digest}})
        http("PUT", coll + "/points?wait=true", {"points": points})
    # The collection is shared by every checkout of this repo. Only the main
    # checkout prunes; a linked worktree (e.g. an agent's sandbox at an older
    # commit) only adds, so it can never delete the main tree's vectors.
    stale = [pid for pid in existing if pid not in want]
    if stale:
        http("POST", coll + "/points/delete?wait=true", {"points": stale})
    return {"chunks": len(want), "embedded": len(todo), "deleted": len(stale), "kept": len(want) - len(todo)}


def is_main_checkout(root):
    git = lambda *a: subprocess.check_output(["git", "-C", root, "rev-parse"] + list(a), text=True).strip()
    return os.path.realpath(os.path.join(root, git("--git-dir"))) == os.path.realpath(os.path.join(root, git("--git-common-dir")))


def semantic_search(ix, query, limit=6):
    """Nearest chunks by meaning. Only chunks that still match the current
    files are returned (stale vectors are ignored, not trusted)."""
    vec = embed(["Represent this sentence for searching relevant passages: " + query[:EMBED_CHARS]])[0]
    r = http("POST", QDRANT + "/collections/" + COLLECTION + "/points/query",
             {"query": vec, "limit": limit * 3, "with_payload": True}, timeout=30)["result"]["points"]
    by_id = {}
    for c in ix.chunks:
        by_id[chunk_point_id(c)[0]] = c
    out = []
    for p in r:
        c = by_id.get(str(p["id"]))
        if c is not None and p["score"] >= SEMANTIC_MIN_SCORE:
            out.append((c, p["score"]))
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- fixes

def load_fixes():
    fixes = []
    if os.path.exists(FIXES):
        with open(FIXES) as f:
            for line in f:
                if line.strip():
                    fixes.append(json.loads(line))
    return fixes


STATUS_EVIDENCE = {"verified": "verified_fix", "regression-tested": "verified_fix", "observed": "hypothesis",
                   "hypothesis": "hypothesis", "rejected": "outdated", "outdated": "outdated"}
STATUS_RANK = {"regression-tested": 0, "verified": 1, "observed": 2, "hypothesis": 3}


def match_fixes(task_text, files):
    """Lessons for a task. A lesson needs at least one of its terms in the task text itself
    (not just in retrieved source, which mentions everything); a file-glob match only ranks it
    higher. A lesson without terms needs a file match. `not_when` (a regex) excludes known
    look-alikes. Returns (lesson, reasons)."""
    hay = task_text.lower()
    hits = []
    for fx in load_fixes():
        if fx.get("status") in ("rejected", "outdated"):
            continue
        try:
            if fx.get("not_when") and re.search(fx["not_when"], task_text, re.I):
                continue
        except re.error:
            pass
        by_term = [t for t in fx.get("terms", [])
                   if re.search(r"(?<![\w])%s(?![\w])" % re.escape(t.lower()), hay)]
        by_file = [g for g in fx.get("files", []) if any(fnmatch.fnmatch(f, g) for f in files)]
        if by_term or (by_file and not fx.get("terms")):
            hits.append((fx, by_term + by_file, bool(by_file)))
    # Most matching terms first, then a file match, then status.
    hits.sort(key=lambda h: (-len([w for w in h[1] if w in h[0].get("terms", [])]), not h[2],
                             STATUS_RANK.get(h[0].get("status"), 9)))
    return [(fx, why) for fx, why, _ in hits]


# ---------------------------------------------------------------- context

class Package:
    """Collects items in priority order within a token budget."""

    def __init__(self, budget):
        self.budget, self.used = budget, 0
        self.sections, self.dropped, self.seen = [], [], set()

    def section(self, name):
        s = {"name": name, "status": "empty", "items": []}
        self.sections.append(s)
        return s

    def add(self, sec, path, start, end, text, kind, method, evidence, why, score=None, force=False):
        key = (path, start, end)
        if key in self.seen or any(p == path and a <= start and end <= b for p, a, b in self.seen if (p, a, b) != key):
            return False
        cost = tokens(text)
        if not force and self.used + cost > self.budget:
            self.dropped.append({"section": sec["name"], "path": path, "start": start, "end": end,
                                 "tokens": cost, "reason": "budget"})
            return False
        self.seen.add(key)
        self.used += cost
        sec["items"].append({"path": path, "start": start, "end": end, "kind": kind, "method": method,
                             "evidence": evidence, "why": why, "rank": len(sec["items"]) + 1,
                             "score": round(score, 3) if score is not None else None, "content": text})
        sec["status"] = "ok"
        return True


def module_api(ix, path):
    """One line per export: the module's public surface (like the API map)."""
    out = []
    for c in ix.chunks:
        if c["path"] == path and c["symbol"]:
            first = c["text"].split("\n")[0]
            out.append(re.sub(r"\s*(\{|=)\s*$", "", first)[:160])
    return "\n".join(out)


def same_file_closure(ix, chunk, depth=3):
    """Same-file symbols a definition uses, transitively (BankSchema -> EntrySchema -> BulletSchema)."""
    found, frontier = [], [chunk]
    seen = {chunk["id"]}
    for _ in range(depth):
        nxt = []
        for c in frontier:
            for w in set(WORD.findall(c["text"])):
                for c2 in ix.symbol_chunks(w, c["path"]):
                    if c2["id"] not in seen:
                        seen.add(c2["id"]); found.append(c2); nxt.append(c2)
        frontier = nxt
    return found


def code_like(word, text):
    """Is this word used as code in the text, not as English? Mixed case, digits
    or underscores count; a plain lowercase word needs a code context."""
    if re.search(r"[A-Z_0-9]", word):
        return True
    w = re.escape(word)
    return bool(re.search(r"\b%s\s*\(|`%s`|\b(?:calls?|call|uses?|using|via|from|import)\s+%s\b|^\s*[-*]\s*%s\b"
                          % (w, w, w, w), text, re.M))


def snippet(ix, path, line, around=2):
    ls = ix.lines[path]
    a, b = max(1, line - around), min(len(ls), line + around)
    return a, b, "\n".join(ls[a - 1:b])


def build_context(ix, spec_text, files, budget, new_files=None, semantic=True):
    """retrieve_context(task, repository, limits) -> package dict."""
    pkg = Package(budget)
    new_files = set(new_files or [])
    targets = [f for f in files if f in ix.lines and f not in new_files and "\n".join(ix.lines[f]).strip()]
    for f in files:
        if f not in targets:
            new_files.add(f)

    # 1. Task: always included.
    s = pkg.section("task")
    pkg.add(s, "(task spec)", 1, spec_text.count("\n") + 1, spec_text, "task", "task", "requirement",
            "the task itself", force=True)

    # 2. Hard constraints: edit boundary and the dependency list (source facts).
    s = pkg.section("constraints")
    deps = {}
    if "package.json" in ix.lines:
        try:
            deps = json.loads("\n".join(ix.lines["package.json"])).get("dependencies", {})
        except ValueError:
            pass
    rule = ("Edit only: %s\nDo not edit any other file. Do not add dependencies.\n"
            "Installed packages: %s; plus Node built-ins.") % (", ".join(files) or "(none)", ", ".join(sorted(deps)) or "?")
    pkg.add(s, "(constraints)", 1, 3, rule, "constraint", "task", "requirement", "edit boundary + package.json",
            force=True)

    # 2b. Decisions digest: every agreed product decision, always included in full for
    #     product code (api/, jd-search/), so a local coder cannot miss one.
    s = pkg.section("decisions")
    if any(f.startswith(("api/", "jd-search/")) for f in files) and DECISIONS in ix.lines:
        ls = ix.lines[DECISIONS]
        pkg.add(s, DECISIONS, 1, len(ls), "\n".join(ls), "doc", "task", "requirement",
                "agreed decisions (always included for product code)", force=True)

    # 3. Exact references: target files, paths and exported symbols named in the spec.
    s = pkg.section("targets_and_references")
    for f in targets:
        pkg.add(s, f, 1, len(ix.lines[f]), "\n".join(ix.lines[f]), kind_of(f), "exact", "source_fact",
                "target file (current content)")
    for f in new_files:
        pkg.add(s, f, 0, 0, "(new file: does not exist yet)", "source", "exact", "source_fact", "target file", force=True)
    ref_paths = [p for p in dict.fromkeys(PATH_REF.findall(spec_text)) if p in ix.lines and p not in files]
    spec_words = set(WORD.findall(spec_text))
    ref_symbols = [w for w in sorted(spec_words) if w in ix.exports and code_like(w, spec_text)]
    for name in ref_symbols:
        for c in ix.symbol_chunks(name):
            if c["path"] in files:
                continue
            pkg.add(s, c["path"], c["start"], c["end"], c["text"], c["kind"], "exact", "source_fact",
                    "defines %s (named in the task)" % name)
    for p in ref_paths:
        ls = ix.lines[p]
        if len(ls) <= 60:
            pkg.add(s, p, 1, len(ls), "\n".join(ls), kind_of(p), "exact", evidence_of(p, kind_of(p)),
                    "path named in the task")

    # 4. Dependencies of the targets: definitions of every imported name,
    #    plus same-file symbols those definitions use (one level).
    s = pkg.section("dependencies")
    for f in targets:
        for dep, names in ix.deps.get(f, []):
            for n in names:
                for c in ix.symbol_chunks(n, dep):
                    pkg.add(s, c["path"], c["start"], c["end"], c["text"], c["kind"], "structural", "source_fact",
                            "%s imports %s from here" % (f, n))
                    for c2 in same_file_closure(ix, c):
                        pkg.add(s, c2["path"], c2["start"], c2["end"], c2["text"], c2["kind"], "structural",
                                "source_fact", "used by %s" % n)
    # Same-file helpers of symbols named in the task (e.g. BulletSchema inside BankSchema).
    for name in ref_symbols:
        for c in ix.symbol_chunks(name):
            if c["path"] in files:
                continue
            for c2 in same_file_closure(ix, c):
                pkg.add(s, c2["path"], c2["start"], c2["end"], c2["text"], c2["kind"], "structural",
                        "source_fact", "used by %s" % name)
    # Public surface of every module the task touches, so unnamed helpers
    # (loadPrompt next to fill, loadBank next to vocabulary) are visible.
    modules = [d for f in targets for d, _ in ix.deps.get(f, [])]
    modules += [c["path"] for n in ref_symbols for c in ix.symbol_chunks(n)]
    for m in dict.fromkeys(modules):
        if m in files or kind_of(m) != "source":
            continue
        api = module_api(ix, m)
        if api:
            pkg.add(s, m, 0, 0, api, "source", "structural", "source_fact", "exports of %s" % m)
            pkg.seen.discard((m, 0, 0))

    # 5. Consumers of the targets: usage lines of each imported name.
    s = pkg.section("consumers")
    for f in targets:
        for user, names in ix.rdeps.get(f, []):
            if kind_of(user) == "test":
                continue
            for i, l in enumerate(ix.lines[user], 1):
                if any(re.search(r"\b%s\b" % re.escape(n), l) for n in names) and not l.lstrip().startswith(("import", "export {")):
                    a, b, text = snippet(ix, user, i, 1)
                    pkg.add(s, user, a, b, text, "source", "structural", "source_fact",
                            "%s uses %s from %s" % (user, ", ".join(names), f))
                    break

    # 6. Tests that import a target or a referenced module, and how to validate.
    s = pkg.section("tests")
    related = set(targets) | set(ref_paths) | {c["path"] for n in ref_symbols for c in ix.symbol_chunks(n)}
    for f in sorted(related):
        for user, _ in ix.rdeps.get(f, []):
            if kind_of(user) == "test":
                names = [l.strip() for l in ix.lines[user] if re.match(r"\s*(test|it|describe)\(", l)][:8]
                pkg.add(s, user, 1, len(ix.lines[user]), "\n".join(names) or "(no test names found)", "test",
                        "structural", "source_fact", "tests that import %s" % f)
    pkg.add(s, "(validation)", 1, 1, "Validation: .claude/bin/check.sh <task> (typecheck, npm test, go vet/test)",
            "constraint", "task", "requirement", "how the result is checked", force=True)

    # 7. Known fixes whose terms appear in the task text (match_fixes).
    s = pkg.section("known_fixes")
    for rank, (fx, why) in enumerate(match_fixes(spec_text, files)[:4]):
        text = "[%s] %s\nResolution: %s" % (fx["status"], fx["title"], fx["resolution"])
        if fx.get("limitations"):
            text += "\nLimitations: " + fx["limitations"]
        n = len(s["items"])
        # The top 3 lessons are kept even when the budget is spent: short, and the one
        # thing a past failure taught (they were dropped behind source excerpts before).
        pkg.add(s, ".claude/knowledge/fixes.jsonl", 0, 0, text, "fix", "fixes",
                STATUS_EVIDENCE.get(fx["status"], "hypothesis"), "matched: " + ", ".join(why[:3]), force=rank < 3)
        if len(s["items"]) > n:  # added (not dropped for the budget)
            s["items"][-1]["fix_id"] = fx["id"]  # provenance: which lesson reached the coder
        pkg.seen.discard((".claude/knowledge/fixes.jsonl", 0, 0))  # several fixes share the file

    # 8. Playbook: the shared skill sections (.agents/skills/) that best match the
    #    task, e.g. m3-notes' scoring rules for a scoring task. Exact search only, so
    #    it needs no index write. Local coders cannot load skills; this is how they see them.
    s = pkg.section("playbook")
    words = [w for w in WORD.findall(spec_text) if len(w) >= 4]
    words += [w for f in files for w in WORD.findall(os.path.basename(f).split(".")[0])]
    for c, score in ix.search(words, limit=40):
        if not c["path"].startswith(".agents/skills/") or c["path"] == DECISIONS or len(s["items"]) >= 2:
            continue
        pkg.add(s, c["path"], c["start"], c["end"], c["text"], "doc", "exact", "requirement",
                "skill section matching the task (BM25)", score=score)

    # 9. Related source by exact search (BM25) over the task's words.
    s = pkg.section("related_source")
    words = [w for w in WORD.findall(spec_text) if len(w) >= 4]
    for c, score in ix.search(words, limit=8, kinds=("source",)):
        if c["path"] in files or len(s["items"]) >= 3:
            continue
        api = module_api(ix, c["path"])
        if api and pkg.add(s, c["path"], 0, 0, api, "source", "exact", "source_fact",
                           "exact search (BM25) hit at line %d" % c["start"], score=score):
            pkg.seen.discard((c["path"], 0, 0))

    # 10. Semantic matches (Phase 2): related by meaning, never above the task,
    #    constraints, or exact/structural evidence. A failure is reported, not hidden.
    s = pkg.section("semantic")
    if semantic:
        try:
            for c, score in semantic_search(ix, spec_text, limit=8):
                if c["path"] in files or len(s["items"]) >= 3:
                    continue
                pkg.add(s, c["path"], c["start"], c["end"], c["text"], c["kind"], "semantic",
                        evidence_of(c["path"], c["kind"]), "similar in meaning (cosine %.2f)" % score, score=score)
        except Exception as e:
            s["status"] = "error"
            s["error"] = "%s: %s" % (type(e).__name__, e)
    else:
        s["status"] = "disabled"

    # 11. Docs: exact search over requirements and project docs.
    s = pkg.section("docs")
    words = [w for w in WORD.findall(spec_text) if len(w) >= 4]
    for c, score in ix.search(words, limit=4, kinds=("doc",)):
        pkg.add(s, c["path"], c["start"], c["end"], c["text"], "doc", "exact", evidence_of(c["path"], "doc"),
                "exact search (BM25)", score=score)

    return {"budget": budget, "used_tokens": pkg.used, "files": files, "new_files": sorted(new_files),
            "sections": pkg.sections, "dropped": pkg.dropped}


def render_md(p):
    """Agent-facing text. Indented blocks only: aider breaks on code fences."""
    out = ["# Context package (%d of %d tokens)" % (p["used_tokens"], p["budget"]),
           "Retrieved evidence for this task. The task and constraints come first and win over anything below."]
    for s in p["sections"]:
        if not s["items"]:
            continue
        out.append("\n## %s" % s["name"].replace("_", " "))
        for it in s["items"]:
            loc = it["path"] if not it["start"] else "%s:%d-%d" % (it["path"], it["start"], it["end"])
            out.append("\n%s  [%s, %s] %s" % (loc, it["method"], it["evidence"], it["why"]))
            out.append("\n".join("    " + l for l in it["content"].split("\n")))
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- commands

def cmd_context(ix, a):
    try:
        spec = open(a.spec).read() if a.spec else a.task
        pkg = build_context(ix, spec, a.files or [], a.budget, a.new or [], semantic=not a.no_semantic)
        pkg["status"] = "ok"
    except Exception as e:  # retrieval failure is reported, never hidden (§5.5)
        pkg = {"status": "error", "error": "%s: %s" % (type(e).__name__, e)}
    if a.log:
        with open(a.log, "w") as f:
            json.dump(pkg, f, indent=2)
    text = render_md(pkg) if a.format == "md" and pkg["status"] == "ok" else json.dumps(pkg, indent=2)
    if a.out:
        open(a.out, "w").write(text)
    else:
        sys.stdout.write(text)
    return 0 if pkg["status"] == "ok" else 1


def cmd_eval(ix, a):
    cases = json.load(open(EVAL))
    total_hit = total = total_supplied = total_unwanted = total_forbidden = 0
    rows = []
    for case in cases:
        pkg = build_context(ix, case["task"], case["files"], case.get("budget", a.budget), case.get("new", []))
        items = [i for s in pkg["sections"] for i in s["items"]]
        paths = {i["path"] for i in items}
        text = "\n".join(i["content"] for i in items)
        want_p = case.get("expect_paths", [])
        want_s = case.get("expect_symbols", [])
        want_f = case.get("expect_fixes", [])
        hit_p = [p for p in want_p if p in paths]
        hit_s = [s for s in want_s if re.search(r"\b(export\s+)?(const|function|type|async function)\s+%s\b" % s, text)]
        supplied = [i["content"] for s in pkg["sections"] if s["name"] == "known_fixes" for i in s["items"]]
        fix_titles = "\n".join(supplied)
        hit_f = [f for f in want_f if f in fix_titles]
        # Precision: lessons supplied that the case did not ask for, and lessons it forbids
        # (near-miss look-alikes that must never be supplied).
        unwanted = [t for t in supplied if not any(w in t for w in want_f)]
        forbidden = [f for f in case.get("expect_no_fixes", []) if f in fix_titles]
        total_supplied += len(supplied); total_unwanted += len(unwanted); total_forbidden += len(forbidden)
        leaked = [p for p in paths if p.startswith(("profile/", "data/", "node_modules/", ".env"))]
        n = len(want_p) + len(want_s) + len(want_f)
        h = len(hit_p) + len(hit_s) + len(hit_f)
        total += n; total_hit += h
        sem = next(s for s in pkg["sections"] if s["name"] == "semantic")
        rows.append({"case": case["id"], "recall": "%d/%d" % (h, n), "tokens": pkg["used_tokens"],
                     "semantic": sem["status"] if sem["status"] != "ok" else "+%d" % len(sem["items"]),
                     "budget_ok": pkg["used_tokens"] <= pkg["budget"] + 600, "leaked": leaked,
                     "missed": sorted(set(want_p) - set(hit_p)) + sorted(set(want_s) - set(hit_s)) +
                               sorted(set(want_f) - set(hit_f)),
                     "fixes": "%d/%d" % (len(supplied) - len(unwanted), len(supplied)),
                     "forbidden": forbidden})
    for r in rows:
        print("%-24s recall %-6s fixes wanted %-5s tokens %-5d budget %-3s semantic %-8s leaked %s%s%s" % (
            r["case"], r["recall"], r["fixes"], r["tokens"], "ok" if r["budget_ok"] else "NO", r["semantic"],
            r["leaked"] or "none", ("  missed: " + ", ".join(r["missed"])) if r["missed"] else "",
            ("  FORBIDDEN: " + ", ".join(r["forbidden"])) if r["forbidden"] else ""))
    print("overall recall: %d/%d (%.0f%%)" % (total_hit, total, 100.0 * total_hit / max(1, total)))
    print("lesson precision: %d/%d supplied lessons were wanted (%.0f%%); forbidden supplied: %d" % (
        total_supplied - total_unwanted, total_supplied, 100.0 * (total_supplied - total_unwanted) / max(1, total_supplied),
        total_forbidden))
    bad = any(r["leaked"] or not r["budget_ok"] or r["forbidden"] for r in rows)
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("context")
    g = c.add_mutually_exclusive_group(required=True)
    g.add_argument("--spec")
    g.add_argument("--task")
    c.add_argument("--files", nargs="*")
    c.add_argument("--new", nargs="*", help="treat these targets as not yet written")
    c.add_argument("--budget", type=int, default=3000)
    c.add_argument("--format", choices=("json", "md"), default="json")
    c.add_argument("--out")
    c.add_argument("--no-semantic", action="store_true")
    c.add_argument("--log", help="also write the full package as JSON here (for the run's evidence)")
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=8)
    for name in ("deps", "rdeps"):
        sub.add_parser(name).add_argument("file")
    sub.add_parser("index")
    sub.add_parser("embed-index", help="sync Qdrant with the corpus (embeds new/changed chunks)")
    se = sub.add_parser("semantic")
    se.add_argument("query")
    se.add_argument("--limit", type=int, default=6)
    e = sub.add_parser("eval")
    e.add_argument("--budget", type=int, default=4500)  # same as run-coder.sh (CONTEXT_BUDGET)
    a = ap.parse_args()

    root = repo_root()
    os.chdir(root)
    ix = Index(root)
    if a.cmd == "context":
        return cmd_context(ix, a)
    if a.cmd == "search":
        for c, score in ix.search(WORD.findall(a.query), a.limit):
            print("%.2f  %s:%d-%d  %s" % (score, c["path"], c["start"], c["end"], c["symbol"] or ""))
        return 0
    if a.cmd == "deps":
        for t, names in ix.deps.get(a.file, []):
            print("%s  %s" % (t, ", ".join(names)))
        return 0
    if a.cmd == "rdeps":
        for u, names in ix.rdeps.get(a.file, []):
            print("%s  %s" % (u, ", ".join(names)))
        return 0
    if a.cmd == "index":
        kinds = {}
        for c in ix.chunks:
            kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
        print(json.dumps({"files": len(ix.files), "chunks": len(ix.chunks), "by_kind": kinds,
                          "exports": len(ix.exports), "edges": sum(len(v) for v in ix.deps.values()),
                          "fixes": len(load_fixes())}, indent=2))
        return 0
    if a.cmd == "eval":
        return cmd_eval(ix, a)
    if a.cmd == "embed-index":
        print(json.dumps(embed_index(ix), indent=2))
        return 0
    if a.cmd == "semantic":
        for c, score in semantic_search(ix, a.query, a.limit):
            print("%.3f  %s:%d-%d  %s" % (score, c["path"], c["start"], c["end"], c["symbol"] or ""))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())

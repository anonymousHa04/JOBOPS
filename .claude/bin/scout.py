"""Local GitHub scout: facts from `gh`, relevance judged by a local model.

  search  Run several `gh search repos` queries, drop archived, unlicensed, and
          stale repos, attach a README excerpt, and save candidates as JSON.
  rank    Ask a local judge how well each candidate fits the need (high /
          medium / low) and print a ranked table.

Judges: "laya" (Laya typed-decisions classifier, ~1 GB) or "qwen"
(qwen2.5:7b via Ollama with a JSON schema). Facts (stars, activity, license)
always come from GitHub, never from the model.

Run with Laya's interpreter so `import laya` works:
  ~/.local/share/uv/tools/laya/bin/python .claude/bin/scout.py search ...
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

FIELDS = "fullName,description,stargazersCount,pushedAt,license,isArchived,language,url"
FITS = ["high", "medium", "low"]
README_CHARS = 2000  # Laya sees ~768 tokens of state; keep the excerpt short


def gh_json(args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def readme_excerpt(full_name):
    try:
        data = gh_json(["api", f"repos/{full_name}/readme"])
        text = base64.b64decode(data["content"]).decode("utf-8", "replace")
    except (subprocess.CalledProcessError, KeyError, ValueError):
        return ""
    text = re.sub(r"<[^>]+>|!\[[^\]]*\]\([^)]*\)", " ", text)  # html, images
    text = re.sub(r"\s+", " ", text)
    return text[:README_CHARS]


def search(need, queries, language, limit, max_age_days, out_path):
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    seen = {}
    for q in queries:
        args = ["search", "repos", q, "--sort", "stars", "--limit", str(limit), "--json", FIELDS]
        if language:
            args += ["--language", language]
        for repo in gh_json(args):
            seen.setdefault(repo["fullName"], repo)

    kept, dropped = [], []
    for repo in seen.values():
        pushed = datetime.fromisoformat(repo["pushedAt"].replace("Z", "+00:00"))
        reason = ("archived" if repo["isArchived"]
                  else "no license" if not repo.get("license")
                  else f"no push since {pushed.date()}" if pushed < cutoff
                  else None)
        (dropped if reason else kept).append((repo, reason))
    kept.sort(key=lambda r: -r[0]["stargazersCount"])

    candidates = []
    for repo, _ in kept[:limit]:
        candidates.append({
            "repo": repo["fullName"], "url": repo["url"], "stars": repo["stargazersCount"],
            "pushed": repo["pushedAt"][:10], "license": repo["license"].get("key"),
            "language": repo.get("language"), "description": repo.get("description") or "",
            "readme": readme_excerpt(repo["fullName"]),
        })
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({"need": need, "candidates": candidates}, indent=2))
    print(f"{len(candidates)} candidates saved to {out_path} "
          f"({len(dropped)} dropped: {', '.join(sorted({r for _, r in dropped if r.startswith('no l') or r == 'archived'})) or 'stale'})")


def state_text(need, c):
    return f"Need: {need}\nRepository: {c['repo']}\nDescription: {c['description']}\nREADME: {c['readme']}"


class LayaJudge:
    def __init__(self):
        os.environ.setdefault("USE_TF", "0")
        import laya
        self.agent = laya.load("convaiinnovations/laya", subfolder="typed-decisions")

    def judge(self, need, c):
        q = {"fit": {"type": "choice",
                     "instructions": "How well does this repository fit the need?",
                     "criteria": {"high": "directly solves the need; a strong, ready-to-use match",
                                  "medium": "related and partly useful, but not a direct match",
                                  "low": "unrelated or only loosely connected to the need"}}}
        ans = self.agent.predict(state_text(need, c), q)["answers"]["fit"]
        return ans["choice"], ans.get("confidence"), ""


class QwenJudge:
    SCHEMA = {"type": "object", "required": ["fit", "reason"],
              "properties": {"fit": {"type": "string", "enum": FITS},
                             "reason": {"type": "string"}}}

    def __init__(self, model="qwen2.5:7b"):
        self.model = model

    def judge(self, need, c):
        prompt = (state_text(need, c) + "\n\nHow well does this repository fit the need? "
                  "high = directly solves it; medium = related, partly useful; low = unrelated. "
                  "Give fit and a one-sentence reason.")
        body = json.dumps({"model": self.model, "stream": False, "format": self.SCHEMA,
                           "messages": [{"role": "user", "content": prompt}],
                           "options": {"temperature": 0, "num_ctx": 4096}}).encode()
        req = urllib.request.Request("http://localhost:11434/api/chat", body,
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.loads(json.loads(r.read())["message"]["content"])
        return out["fit"], None, out.get("reason", "")


def make_judge(name):
    return LayaJudge() if name == "laya" else QwenJudge()


def rank(path, judge_name, top):
    data = json.loads(Path(path).read_text())
    judge = make_judge(judge_name)
    rows = []
    for c in data["candidates"]:
        fit, conf, reason = judge.judge(data["need"], c)
        rows.append((FITS.index(fit), -c["stars"], c, fit, conf, reason))
    rows.sort(key=lambda r: (r[0], r[1]))
    print(f"Need: {data['need']}  (judge: {judge_name})\n")
    print("| repo | fit | stars | last push | license | why |\n|---|---|---|---|---|---|")
    for _, _, c, fit, conf, reason in rows[:top]:
        why = reason or c["description"][:80]
        conf_s = f" ({conf:.2f})" if isinstance(conf, (int, float)) else ""
        print(f"| [{c['repo']}]({c['url']}) | {fit}{conf_s} | {c['stars']} | {c['pushed']} | {c['license']} | {why} |")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("need")
    s.add_argument("--query", action="append", required=True, help="repeat 2-4 times")
    s.add_argument("--language")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--max-age-days", type=int, default=365)
    s.add_argument("--out", required=True)
    r = sub.add_parser("rank")
    r.add_argument("candidates")
    r.add_argument("--judge", choices=["laya", "qwen"], default="laya")
    r.add_argument("--top", type=int, default=3)
    a = p.parse_args()
    if a.cmd == "search":
        search(a.need, a.query, a.language, a.limit, a.max_age_days, a.out)
    else:
        rank(a.candidates, a.judge, a.top)


if __name__ == "__main__":
    main()

"""Compare scout judges (Laya vs qwen) on repos with known answers.

Run: ~/.local/share/uv/tools/laya/bin/python .claude/bin/scout_eval.py [laya|qwen ...]
Prints per-judge accuracy, exact and within-one-step (high<->medium,
medium<->low), timing, and every disagreement with the expected label.
"""

import json
import resource
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scout import FITS, make_judge, readme_excerpt  # noqa: E402

CASES = {
    "TypeScript runtime schema validation for API request bodies": {
        "colinhacks/zod": "high", "jquense/yup": "high", "sinclairzx81/typebox": "high",
        "ajv-validator/ajv": "high", "expressjs/express": "low", "lodash/lodash": "low",
    },
    "Local LLM inference server to run models like Qwen on a Mac": {
        "ollama/ollama": "high", "ggml-org/llama.cpp": "high", "vllm-project/vllm": "medium",
        "huggingface/transformers": "medium", "facebook/react": "low", "fastify/fastify": "low",
    },
    "Fuzzy deduplication of near-identical text documents such as job postings": {
        "ekzhu/datasketch": "high", "rapidfuzz/RapidFuzz": "medium", "seatgeek/thefuzz": "medium",
        "nodejs/node": "low", "tailwindlabs/tailwindcss": "low",
    },
}
CACHE = Path(".scout/eval_candidates.json")


def load_candidates():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    out = []
    for need, repos in CASES.items():
        for repo, label in repos.items():
            info = json.loads(subprocess.run(
                ["gh", "repo", "view", repo, "--json", "description,url,stargazerCount"],
                capture_output=True, text=True, check=True).stdout)
            out.append({"need": need, "label": label, "repo": repo, "url": info["url"],
                        "stars": info["stargazerCount"], "description": info.get("description") or "",
                        "readme": readme_excerpt(repo)})
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(out, indent=2))
    return out


def evaluate(name, cases):
    t0 = time.time()
    judge = make_judge(name)
    load_s = time.time() - t0
    exact = near = 0
    misses = []
    t1 = time.time()
    for c in cases:
        fit, conf, _ = judge.judge(c["need"], c)
        d = abs(FITS.index(fit) - FITS.index(c["label"]))
        exact += d == 0
        near += d <= 1
        if d:
            misses.append(f"    {c['repo']}: got {fit}{f' ({conf:.2f})' if isinstance(conf, float) else ''}, expected {c['label']}")
    per = (time.time() - t1) / len(cases)
    n = len(cases)
    print(f"{name}: exact {exact}/{n}, within one step {near}/{n}, load {load_s:.1f}s, {per:.2f}s per repo")
    print("\n".join(misses) or "    no misses")


def main():
    cases = load_candidates()
    judges = sys.argv[1:] or ["laya", "qwen"]
    for name in judges:
        evaluate(name, cases)
    rss_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9  # bytes on macOS
    print(f"peak memory of this process: {rss_gb:.2f} GB (includes Laya if it ran; qwen runs inside Ollama)")


if __name__ == "__main__":
    main()

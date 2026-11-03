#!/usr/bin/env python3
"""Prefill scaling on general7 (qwen2.5-7b Q4_K_M, 3 slots, unified 16k KV, continuous batching):
prompt-processing throughput at concurrency 1, 2, 3 for prompts of 1000, 4000, 8000 tokens.

  python3 bench/prefill/prefill.py [--reps 3] [--url http://127.0.0.1:8084]

Each request is a unique random token-id sequence of exactly N tokens (no cache hits possible),
sent to /completion with cache_prompt false, n_predict 1, streamed. All slots are erased before
each run. KV in use is computed (the requests of one run are all in the pool at once); /slots is not
polled during a run, because those requests go through the server loop and slowed prefill by ~25%
(2 x 1000 tokens: 178 tok/s polled vs 238 not). Pool pressure shows as errors, requests_deferred,
or "no free space" lines in the server log.
Raw rows: results/runs.jsonl; medians: results/summary.md. Stdlib only."""
import json
import os
import random
import re
import statistics
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
LOG = os.path.join(os.path.dirname(os.path.dirname(HERE)), ".agent-logs/llm-general7.log")
SIZES = [1000, 4000, 8000]
CONCURRENCY = [1, 2, 3]
KV_POOL = 16384
VOCAB = (1000, 150000)  # plain tokens; Qwen2.5 special tokens start at 151643


def http(url, body=None):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=600)


def erase_slots(base):
    for s in json.load(http(base + "/slots")):
        try:
            http(base + "/slots/%d?action=erase" % s["id"], {}).read()
        except Exception:
            pass  # older builds need --slot-save-path; cache_prompt false still forces full prefill


def metric(base, name):
    m = re.search(r"^llamacpp:%s ([\d.e+-]+)$" % name, http(base + "/metrics").read().decode(), re.M)
    return float(m.group(1)) if m else 0.0


def one_request(base, tokens, t0, out, i):
    """Streamed /completion; records time to first token and the server's prompt timings."""
    row = {"i": i, "sent_tokens": len(tokens)}
    try:
        resp = http(base + "/completion", {"prompt": tokens, "n_predict": 1, "cache_prompt": False,
                                           "stream": True, "temperature": 0})
        for raw in resp:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            d = json.loads(line[5:])
            if "ttft_s" not in row:
                row["ttft_s"] = time.time() - t0
            if d.get("stop"):
                t = d.get("timings", {})
                row.update(prompt_n=t.get("prompt_n"), prompt_ms=t.get("prompt_ms"),
                           prompt_tps=t.get("prompt_per_second"), cached_n=t.get("cache_n"))
        row["done_s"] = time.time() - t0
    except Exception as e:
        row["error"] = "%s: %s" % (type(e).__name__, e)
    out[i] = row


def run_config(base, size, conc, rep, rng):
    erase_slots(base)
    prompts = [[rng.randrange(*VOCAB) for _ in range(size)] for _ in range(conc)]
    log_off = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    deferred0 = metric(base, "requests_deferred")
    out = [None] * conc
    t0 = time.time()
    threads = [threading.Thread(target=one_request, args=(base, p, t0, out, i)) for i, p in enumerate(prompts)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    log = open(LOG, errors="replace").read()[log_off:] if os.path.exists(LOG) else ""
    ok = [r for r in out if "error" not in r and r.get("prompt_n")]
    prefill_end = max((r["ttft_s"] for r in ok), default=None)
    total_prompt = sum(r["prompt_n"] for r in ok)
    return {
        "size": size, "conc": conc, "rep": rep, "requests": out, "errors": conc - len(ok),
        "total_prompt_tokens": total_prompt,
        "prefill_end_s": prefill_end,  # batch start until the last request's first token
        "aggregate_tps": total_prompt / prefill_end if prefill_end else None,
        "median_request_prompt_ms": statistics.median([r["prompt_ms"] for r in ok]) if ok else None,
        "max_ttft_s": prefill_end,
        "median_ttft_s": statistics.median([r["ttft_s"] for r in ok]) if ok else None,
        "peak_kv_tokens": sum(r["prompt_n"] + 1 for r in ok),  # computed: all of a run's requests overlap
        "deferred": metric(base, "requests_deferred") - deferred0,
        "kv_full_log_lines": len(re.findall(r"failed to find (a )?free space|kv cache is full|no free slot|context shift",
                                            log, re.I)),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


def summarize(rows):
    med = lambda xs: statistics.median(xs) if xs else None
    lines = ["# Prefill scaling: qwen2.5-7b Q4_K_M, general7 (3 slots, unified 16k KV, continuous batching)", "",
             "Medians of %d runs per cell. Prompts: unique random tokens, cache_prompt false, n_predict 1." %
             max(r["rep"] for r in rows), "",
             "| Prompt | Concurrency | Prompt tokens (total) | Prefill end (s) | Aggregate prefill tok/s | "
             "Scaling vs 1 | Per-request prompt time (ms) | TTFT median / max (s) | Peak KV tokens (% of 16k) | Errors / deferred |",
             "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    base_tps = {}
    for size in SIZES:
        for conc in CONCURRENCY:
            cell = [r for r in rows if r["size"] == size and r["conc"] == conc]
            if not cell:
                continue
            agg = med([r["aggregate_tps"] for r in cell if r["aggregate_tps"]])
            if conc == 1:
                base_tps[size] = agg
            peak = max(r["peak_kv_tokens"] for r in cell)
            lines.append("| %d | %d | %s | %s | %s | %s | %s | %s / %s | %d (%.0f%%) | %d / %d |" % (
                size, conc, med([r["total_prompt_tokens"] for r in cell]),
                "%.2f" % med([r["prefill_end_s"] for r in cell if r["prefill_end_s"]]),
                "%.0f" % agg if agg else "-",
                "%.2fx" % (agg / base_tps[size]) if agg and base_tps.get(size) else "-",
                "%.0f" % med([r["median_request_prompt_ms"] for r in cell if r["median_request_prompt_ms"]]),
                "%.2f" % med([r["median_ttft_s"] for r in cell if r["median_ttft_s"]]),
                "%.2f" % med([r["max_ttft_s"] for r in cell if r["max_ttft_s"]]),
                peak, 100 * peak / KV_POOL, sum(r["errors"] for r in cell), sum(r["deferred"] for r in cell)))
    lines += ["", "Aggregate prefill tok/s = total prompt tokens / time from batch start until the last request's "
              "first token (client side, includes one decode step and HTTP).",
              "Per-request prompt time = the server's prompt_ms for each request (median over requests, then runs).",
              "Peak KV tokens = computed, prompt tokens + 1 output token for every request in the run (they overlap); "
              "pressure shows in Errors / deferred and in kv_full_log_lines in runs.jsonl."]
    return "\n".join(lines) + "\n"


def main(args):
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d
    base, reps = opt("--url", "http://127.0.0.1:8084"), int(opt("--reps", "3"))
    props = json.load(http(base + "/props"))
    print("server: slots %s, n_ctx %s" % (props.get("total_slots"), props.get("default_generation_settings", {}).get("n_ctx")))
    rng = random.Random(20261031)
    os.makedirs(RESULTS, exist_ok=True)
    run_config(base, 1000, 1, 0, rng)  # warm-up, not recorded
    rows = []
    with open(os.path.join(RESULTS, "runs.jsonl"), "w") as f:
        for rep in range(1, reps + 1):  # sizes and concurrency interleaved inside each rep, so drift spreads evenly
            for size in SIZES:
                for conc in CONCURRENCY:
                    r = run_config(base, size, conc, rep, rng)
                    rows.append(r)
                    f.write(json.dumps(r) + "\n")
                    f.flush()
                    print("rep %d size %5d conc %d: agg %s tok/s, prefill end %ss, peak KV %d, errors %d, deferred %d" % (
                        rep, size, conc, r["aggregate_tps"] and round(r["aggregate_tps"]),
                        r["prefill_end_s"] and round(r["prefill_end_s"], 2), r["peak_kv_tokens"], r["errors"], r["deferred"]),
                        flush=True)
    s = summarize(rows)
    open(os.path.join(RESULTS, "summary.md"), "w").write(s)
    print(s)


if __name__ == "__main__":
    main(sys.argv[1:])

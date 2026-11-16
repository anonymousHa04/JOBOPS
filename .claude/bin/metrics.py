#!/usr/bin/env python3
"""Phase 4 metrics: score the runs in .agent-logs/phase4/runs.jsonl against the
criteria in .claude/knowledge/phase4.yaml (doc §7). Uses only recorded evidence
(each run's result.json). Writes .agent-logs/phase4/report.json.
Usage: metrics.py [--latest]   (--latest: only the newest run per run id)"""
import json, os, statistics, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P4 = os.path.join(ROOT, ".agent-logs", "phase4")
RUNS = os.path.join(ROOT, ".agent-logs", "runs", "phase4")


def load_runs():
    rows = [json.loads(l) for l in open(os.path.join(P4, "runs.jsonl")) if l.strip()]
    latest = {}
    for r in rows:
        latest[r["run"]] = r            # a re-run of the same id replaces the old one
    out = []
    for r in latest.values():
        path = os.path.join(RUNS, r["run"], r["run"] + ".result.json")
        r["result"] = json.load(open(path)) if os.path.exists(path) else None
        out.append(r)
    return sorted(out, key=lambda r: (r["task"], r["rep"]))


def ratio(n, d):
    return round(n / d, 2) if d else None


def main():
    runs = load_runs()
    done = [r for r in runs if r["result"] and r["status"] != "harness_error"]
    atts = [a for r in done for a in r["result"]["attempts"]]
    repairs = [a for a in atts if a["strategy"].startswith("repair")]
    repeated = [r for r in done if "repeated failure signature" in (r["result"]["reason"] or "")]
    sig_twice = [r for r in done
                 if any(a["signature"] and i and a["signature"] == r["result"]["attempts"][i - 1]["signature"]
                        for i, a in enumerate(r["result"]["attempts"]))]
    tokens = [a["context_tokens"] for a in atts if a.get("context_tokens")]
    selftest = open(os.path.join(P4, "selftest.txt")).read().strip().splitlines()[-1] if os.path.exists(os.path.join(P4, "selftest.txt")) else "not run"
    # Only real promotions (observed/hypothesis -> verified); "note" entries are evidence on existing records.
    promoted = [f for r in done for f in r["result"].get("fixes_updated", []) if f.get("to") == "verified" and "note" not in f]
    m = {
        "runs": len(done),
        "first_attempt_acceptance": ratio(sum(r["result"]["first_attempt_passed"] for r in done), len(done)),
        "final_acceptance": ratio(sum(r["result"]["status"] == "passed" for r in done), len(done)),
        "escalation_rate": ratio(sum(bool(r["result"]["escalation"]) for r in done), len(done)),
        "repair_success": "%d/%d" % (sum(a["verdict"] == "passed" for a in repairs), len(repairs)),
        "repeated_failure_stop": "%d/%d" % (len(repeated), len(sig_twice)),
        "regression_rate": ratio(sum(a["category"] == "regression" for a in atts), len(atts)),
        "validation_reliability": selftest,
        "context_overflow": ratio(sum(any("CONTEXT OVERFLOW" in f for f in a["flags"]) for a in atts), len(atts)),
        "context_size_median": statistics.median(tokens) if tokens else None,
        "runtime_median_min": round(statistics.median(r["wall_s"] for r in done) / 60, 1) if done else None,
        "fixes_promoted": [f["id"] for f in promoted],
    }
    criteria = {
        "first_attempt_acceptance": lambda v: v is not None and v >= 0.40,
        "final_acceptance": lambda v: v is not None and v >= 0.60,
        "escalation_rate": lambda v: v is not None and v <= 0.40,
        "regression_rate": lambda v: v == 0,
        "context_overflow": lambda v: v == 0,
        "context_size_median": lambda v: v is not None and v <= 3500,
        "runtime_median_min": lambda v: v is not None and v <= 15,
        "repeated_failure_stop": lambda v: v.split("/")[0] == v.split("/")[1],
        "validation_reliability": lambda v: "25 ok, 0 wrong" in v,
    }
    print("%-26s %-22s %s" % ("metric", "value", "criterion met"))
    for k, v in m.items():
        ok = criteria[k](v) if k in criteria else None
        print("%-26s %-22s %s" % (k, v, "-" if ok is None else ("yes" if ok else "NO")))
    print("\nper task (status per repetition, errors per attempt, category, minutes):")
    for r in done:
        res = r["result"]
        print("  %-6s r%d  %-9s errors %-10s %-24s %.1f min" % (
            r["task"], r["rep"], res["status"], [a["error_count"] for a in res["attempts"]],
            res["category"] or "-", r["wall_s"] / 60))
    report = {"metrics": m, "runs": [{k: r[k] for k in ("run", "task", "rep", "wall_s", "status")} for r in runs]}
    json.dump(report, open(os.path.join(P4, "report.json"), "w"), indent=2)
    print("\nwritten .agent-logs/phase4/report.json")


if __name__ == "__main__":
    main()

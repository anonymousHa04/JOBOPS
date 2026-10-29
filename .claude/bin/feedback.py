#!/usr/bin/env python3
"""Phase 3: feedback loop (agentManagementAndFeedbackSystem.md §6).

Called by autofix.sh. Works only from recorded evidence in .agent-logs/:
<attempt>.log, .check.log, .check.json, .exit, .context.json, .traj.json.

  feedback.py attempt  <attempt> <runner> <verdict> <reason> <timed_out> -- <files>...
        Analyze one attempt; append it to <task>.attempts.jsonl (task = env TASK).
  feedback.py decide   <task> <max_fixes>
        Next step after a failed attempt: "repair" or "escalate: <why>".
  feedback.py repair-spec <task> <attempt> <original-spec> <out> -- <files>...
        Write a fresh repair spec from the evidence (new information, not the
        same prompt again). Records which known fixes were supplied.
  feedback.py resolve  <escalation.json> --id ID --resolution TEXT [--title T]
                       [--signature REGEX] [--terms a,b] [--files glob,glob] [--existing]
        Close an escalation after the manager fixed it: write (or, with --existing,
        link) a fix record so the next agent gets it in its context package, its
        repair spec, and aider's lint hints; mark the escalation resolved.
  feedback.py stats    [<logs-dir>]
        First-try pass rate, fix rounds and minutes per task, and fix-round pass rate with
        versus without a lesson, per lesson (attempt records in .agent-logs/).
  feedback.py finish   <task> <status> <reason>
        Write <task>.result.json, an escalation record when not passed, append
        to the main repo's .agent-logs/outcomes.jsonl, and update fix records.

Raw evidence and our interpretation are kept apart: "agent_claim" is what the
agent said about itself; "category" and "signature" are derived from checks.
Standard library only (Python 3.9+).
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN_ROOT = os.path.dirname(os.path.dirname(HERE))
# Overridable so the self-test never touches the real fix records or outcome log.
FIXES = os.environ.get("FEEDBACK_FIXES") or os.path.join(MAIN_ROOT, ".claude", "knowledge", "fixes.jsonl")
LOGS = ".agent-logs"  # of the tree autofix runs in (cwd)
MAIN_LOGS = os.environ.get("FEEDBACK_MAIN_LOGS") or os.path.join(MAIN_ROOT, ".agent-logs")
# The coder's self-review checklist: in every repair spec, and the basis of the review before
# escalation (.claude/agents/self-review.md).
SELF_REVIEW = os.path.join(HERE, "..", "agents", "self-review.md")

TS_ERR = re.compile(r"^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.*)$")
TEST_FAIL = re.compile(r"^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$")

# The categories of §6.4. "unknown" is allowed and preferred to a forced guess.
CATEGORIES = ("missing_context", "instruction_violation", "incorrect_implementation", "regression",
              "unreliable_validation", "environment", "ambiguous_requirements", "model_limitation", "unknown")
SUGGESTION = {
    "missing_context": "Check the context package (budget, dropped items) and the overflow flag; then re-run.",
    "instruction_violation": "The agent touched files outside the task or ignored the spec; tighten the spec or escalate.",
    "incorrect_implementation": "Manager fixes the code; record the fix in fixes.jsonl so the next task gets it.",
    "regression": "A change broke other files or tests; review the consumers listed in the context package.",
    "unreliable_validation": "Validation did not run or gave no result; fix the check before trusting any outcome.",
    "environment": "Fix the environment (model server, spec path, dependencies); the code was not the problem.",
    "ambiguous_requirements": "Clarify the spec with the user before another attempt.",
    "model_limitation": "Manager takes over or a stronger model is used; the local model did not produce a change.",
    "unknown": "Manager reviews the attempt logs; no rule explained the failure.",
}


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_jsonl(path):
    out = []
    for line in read(path).splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def load_fixes():
    return load_jsonl(FIXES)


class FixesLock:
    """Two runs in parallel may update fixes.jsonl: serialize read-modify-write."""
    def __enter__(self):
        import time
        self.path = FIXES + ".lock"
        for _ in range(200):
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL)); return self
            except FileExistsError:
                time.sleep(0.1)
        return self  # stale lock after 20 s: proceed rather than hang
    def __exit__(self, *a):
        try:
            os.remove(self.path)
        except OSError:
            pass


def save_fixes(fixes):
    tmp = FIXES + ".tmp"
    with open(tmp, "w") as f:
        for fx in fixes:
            f.write(json.dumps(fx) + "\n")
    os.replace(tmp, FIXES)


# ---------------------------------------------------------------- evidence

def section(log, name):
    m = re.search(r"^== %s.*?$(.*?)(?=^== |\Z)" % re.escape(name), log, re.M | re.S)
    return m.group(1) if m else ""


def errors_of(attempt):
    """Type errors and failing tests from the independent check (not the agent)."""
    log = read(os.path.join(LOGS, attempt + ".check.log"))
    errs = []
    for line in section(log, "typecheck").splitlines():
        m = TS_ERR.match(line.strip())
        if m:
            errs.append({"file": m.group(1), "line": int(m.group(2)), "code": m.group(4), "message": m.group(5)})
    tests = []
    out = section(log, "tests")
    if "failing tests:" in out:
        for line in out.split("failing tests:", 1)[1].splitlines():
            m = TEST_FAIL.match(line)
            if m and not m.group(1).startswith(("test at", "Error")):
                tests.append(m.group(1).strip())
    return errs, sorted(set(tests))


def normalize(msg):
    """Same mistake -> same text: drop long type dumps, numbers, and spacing."""
    msg = re.sub(r"'[^']{30,}'", "'<type>'", msg)
    msg = re.sub(r"\d+", "N", msg)
    return re.sub(r"\s+", " ", msg).strip()[:120]


def signature(errs, tests, extra=""):
    parts = sorted({"%s|%s|%s" % (e["file"], e["code"], normalize(e["message"])) for e in errs})
    parts += ["test|" + t for t in tests]
    if extra:
        parts.append("other|" + extra)
    if not parts:
        return None, []
    return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:12], parts


def agent_claim(attempt, runner):
    """What the agent says about its own work. A claim, never evidence of success."""
    if runner == "mini":
        traj = load_json(os.path.join(LOGS, attempt + ".traj.json"), {}) or {}
        info = traj.get("info", {}) if isinstance(traj, dict) else {}
        last = ""
        for m in reversed(traj.get("messages", []) if isinstance(traj, dict) else []):
            if isinstance(m, dict) and m.get("role") == "assistant":
                c = m.get("content")
                last = c if isinstance(c, str) else json.dumps(c)
                break
        if not traj:
            return {"source": "mini", "found": False}
        return {"source": "mini", "found": True, "exit_status": info.get("exit_status"),
                "submission": (info.get("submission") or "")[:300], "last_message": last[-400:],
                **self_review_line(last)}
    log = read(os.path.join(LOGS, attempt + ".log"))
    hits = list(re.finditer(r"^\s*STATUS:\s*(done|blocked)\b.*$", log, re.M | re.I))
    if not hits:
        return {"source": "aider", "found": False, **self_review_line(log)}
    tail = log[hits[-1].end():]
    blockers = []
    m = re.search(r"^\s*BLOCKERS:\s*(.*)$", tail, re.M | re.I)
    if m:
        first = m.group(1).strip()
        if first and first.lower() not in ("none", "-", "n/a"):
            blockers.append(first)
        for line in tail[m.end():].splitlines()[:8]:
            line = line.strip()
            if not line or not line.startswith("-"):
                break
            blockers.append(line.lstrip("- ").strip())
    return {"source": "aider", "found": True, "status": hits[-1].group(1).lower(), "blockers": blockers[:8],
            **self_review_line(log)}


def self_review_line(text):
    """The agent's last "SELF-REVIEW: ..." line (self-review.md), when it wrote one."""
    hits = re.findall(r"^\s*SELF-REVIEW:\s*(.+?)\s*$", text or "", re.M | re.I)
    return {"self_review": hits[-1][:300]} if hits else {}


def diff_of(files, limit=150):
    """The previous attempt's change to the task files: git diff for tracked files, the whole
    file for new ones. Cut to `limit` lines so the repair spec fits the model window."""
    out = []
    for f in files:
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", f], capture_output=True).returncode == 0
        if tracked:
            out.append(subprocess.run(["git", "diff", "--", f], capture_output=True, text=True).stdout.rstrip())
        elif os.path.exists(f):
            out.append("new file " + f + "\n" + "\n".join("+" + l for l in read(f).splitlines()))
        else:
            out.append("(missing) " + f)
    lines = "\n".join(x for x in out if x).splitlines()
    if len(lines) > limit:
        lines = lines[:limit] + ["... (%d more lines not shown)" % (len(lines) - limit)]
    return "\n".join(lines) or "(no change)"


def categorize(verdict, reason, timed_out, files, errs, tests, flags, context_status, check):
    """Rules over evidence -> (category, basis). Ordered from most to least certain."""
    targets = set(files)
    if check is None and verdict not in ("timed_out",) and "outside" not in reason:
        return "unreliable_validation", "no check result recorded"
    if any("CONTEXT OVERFLOW" in f for f in flags) or context_status.startswith("failed"):
        return "missing_context", "context overflow or retrieval failure"
    if any(k in reason for k in ("MODEL SERVER", "SPEC MISSING")) or any(
            k in f for f in flags for k in ("MODEL SERVER", "SPEC MISSING", "APPLY TO MAIN TREE FAILED")):
        return "environment", "runner could not start or apply"
    if "outside the task" in reason or any("TOUCHED FILE OUTSIDE" in f for f in flags):
        stray = reason.split("outside the task:", 1)[-1].split()
        if any(f.endswith(t) and f != t for f in stray for t in targets):
            return "environment", "the tool wrote the target to a wrong path (e.g. a doubled directory)"
        return "instruction_violation", "changed files outside the task"
    if verdict == "unknown":
        return "unreliable_validation", "coder exit status not recorded"
    steps = (check or {}).get("steps", {})
    tc, ts = steps.get("typecheck", {}), steps.get("tests", {})
    if (tc.get("status") == "failed" and not tc.get("errors")) or ts.get("reason") == "no test summary":
        return "unreliable_validation", "a check failed without any error output (crash or no summary)"
    if timed_out:
        return "model_limitation", "no result within the time limit (hypothesis)"
    if "no task file changed" in reason and not errs:
        return "model_limitation", "no change produced (hypothesis)"
    if errs:
        outside = [e for e in errs if e["file"] not in targets]
        if outside:
            return "regression", "type errors in files outside the task: " + ", ".join(sorted({e["file"] for e in outside}))[:120]
        return "incorrect_implementation", "type errors in the task's own files"
    if tests:
        if any("test" in f for f in targets):
            return "incorrect_implementation", "failing tests in the task's tests"
        return "regression", "existing tests fail"
    if verdict == "failed":
        return "unknown", reason or "failed without a matching rule"
    return "unknown", "no rule matched"


# ---------------------------------------------------------------- commands

def cmd_attempt(task, attempt, runner, verdict, reason, timed_out, files):
    errs, tests = errors_of(attempt)
    flags = re.findall(r"^RUN-(?:CODER|MINI): .*$", read(os.path.join(LOGS, attempt + ".log")), re.M)
    ctx_status = read(os.path.join(LOGS, attempt + ".context.status"), "none").strip() or "none"
    check = load_json(os.path.join(LOGS, attempt + ".check.json"))
    ex = read(os.path.join(LOGS, attempt + ".exit"), "unknown").strip() or "unknown"
    extra = "" if (errs or tests or verdict == "passed") else (reason or verdict)
    sig, parts = signature(errs, tests, extra) if verdict != "passed" else (None, [])
    if verdict == "passed":
        category, basis = None, None
    else:
        category, basis = categorize(verdict, reason, timed_out == "1", files, errs, tests, flags, ctx_status, check)
    ctx = load_json(os.path.join(LOGS, attempt + ".context.json"), {}) or {}
    supplied = load_json(os.path.join(LOGS, attempt + ".fixes-supplied.json"), []) or []
    # Timing: autofix writes <attempt>.started (epoch seconds) when the coder starts.
    started = read(os.path.join(LOGS, attempt + ".started")).strip()
    ended = datetime.datetime.now()
    start_dt = datetime.datetime.fromtimestamp(int(started)) if started.isdigit() else None
    # Provenance: which lessons reached the coder, through which channel, and why.
    lessons = {"repair_spec": load_json(os.path.join(LOGS, attempt + ".fixes-why.json"), {}) or {},
               "context_pack": [i.get("fix_id") for sec in ctx.get("sections", []) if sec.get("name") == "known_fixes"
                                for i in sec.get("items", []) if i.get("fix_id")]}
    rec = {
        "attempt": attempt, "runner": runner, "at": now(),
        "strategy": "repair: fresh session with errors, hints, known fixes" if "-fix" in attempt else "initial",
        "coder_exit": int(ex) if ex.lstrip("-").isdigit() else ex,
        "timed_out": timed_out == "1", "verdict": verdict, "reason": reason or None,
        "check": (check or {}).get("status"), "context": ctx_status,
        "context_tokens": ctx.get("used_tokens"), "fixes_supplied": supplied,
        "flags": flags[:6], "errors": [dict(e, message=e["message"][:160]) for e in errs[:15]],
        "failing_tests": tests[:10], "error_count": len(errs),
        "signature": sig, "signature_parts": parts[:15],
        "category": category, "category_basis": basis,
        "agent_claim": agent_claim(attempt, runner), "files": list(files),
        "started_at": start_dt.isoformat(timespec="seconds") if start_dt else None,
        "ended_at": ended.isoformat(timespec="seconds"),
        "duration_s": round((ended - start_dt).total_seconds()) if start_dt else None,
        "lessons": lessons,
    }
    with open(os.path.join(LOGS, task + ".attempts.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps({"category": category, "signature": sig, "errors": len(errs)}))


def cmd_decide(task, max_fixes):
    atts = load_jsonl(os.path.join(LOGS, task + ".attempts.jsonl"))
    last = atts[-1]
    rounds = len(atts) - 1
    if last["timed_out"]:
        return "escalate: timed out"
    if last["category"] in ("environment", "unreliable_validation", "missing_context"):
        return "escalate: %s (a retry with the same setup cannot fix this)" % last["category"]
    if len(atts) >= 2 and last["signature"] and last["signature"] == atts[-2]["signature"]:
        return "escalate: repeated failure signature %s (the changed strategy did not change the outcome)" % last["signature"]
    if rounds >= max_fixes:
        return "escalate: retry limit reached (%d fix rounds)" % rounds
    return "repair"


def matching_fixes(errs_text, files=(), task_text=""):
    """Lessons for a repair round. The error signature must match the check's errors AND the
    lesson must fit the task: one of its file globs matches a task file, or one of its terms
    appears in the errors or the task. `not_when` (a regex over errors + task) excludes known
    look-alikes. Returns (lesson, reasons), proven lessons first."""
    import fnmatch
    hay = errs_text + "\n" + task_text
    hits = []
    for fx in load_fixes():
        if fx.get("status") in ("rejected", "outdated") or not fx.get("signature"):
            continue
        try:
            if not re.search(fx["signature"], errs_text):
                continue
            if fx.get("not_when") and re.search(fx["not_when"], hay, re.I):
                continue
        except re.error:
            continue
        by_file = [g for g in fx.get("files", []) if any(fnmatch.fnmatch(f, g) for f in files)]
        by_term = [t for t in fx.get("terms", []) if re.search(r"(?<![\w])%s(?![\w])" % re.escape(t), hay, re.I)]
        if by_file or by_term:
            hits.append((fx, ["signature"] + ["file:" + g for g in by_file] + ["term:" + t for t in by_term]))
    order = {"regression-tested": 0, "verified": 1, "observed": 2, "hypothesis": 3}
    return sorted(hits, key=lambda h: order.get(h[0].get("status"), 9))


def cmd_repair_spec(task, attempt, orig_spec, out, files):
    atts = load_jsonl(os.path.join(LOGS, task + ".attempts.jsonl"))
    last = next(a for a in reversed(atts) if a["attempt"] == attempt)
    n = len(atts)
    errs_text = "\n".join("%s(%d): error %s: %s" % (e["file"], e["line"], e["code"], e["message"]) for e in last["errors"])
    errs_text += "".join("\nfailing test: " + t for t in last["failing_tests"])
    if not errs_text.strip():
        errs_text = "(no type or test errors recorded; failure: %s)" % (last["reason"] or last["category"])
    matched = matching_fixes(errs_text + "\n" + "\n".join(last["flags"]), files, read(orig_spec))[:4]
    fixes = [fx for fx, _ in matched]
    hints = os.popen("printf '%%s' %s | %s/hints.sh" % (json.dumps(errs_text).replace("$", "\\$"), HERE)).read().strip()
    claim = last["agent_claim"]
    ind = lambda s: "\n".join("    " + l for l in s.splitlines())
    lines = [
        "# Repair attempt %d for task %s" % (n, task), "",
        "Strategy for this attempt: a fresh session with only the evidence below. Fix exactly these",
        "errors in the existing file(s); keep everything that already works. Do not rewrite unrelated code.",
        "Edit only: " + " ".join(files), "",
        "## Errors to fix (from the independent check, not from you)", ind(errs_text), "",
    ]
    if hints:
        lines += ["## Hints for these errors", ind(hints), ""]
    if fixes:
        lines += ["## Known fixes that match these errors (status shows how proven each is)"]
        for fx in fixes:
            lines += ["- [%s] %s" % (fx["status"], fx["title"]), "  Resolution: " + fx["resolution"]]
        lines.append("")
    lines += ["## Self-review first (before you edit)", read(SELF_REVIEW).strip(), "",
              "## Your previous change", ind(diff_of(files)), ""]
    if claim.get("found"):
        lines += ["## Your previous report (a claim; the check above is what counts)",
                  ind(json.dumps({k: v for k, v in claim.items() if k not in ("source", "found")}, indent=1)), ""]
    lines += ["## Original task", read(orig_spec)]
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    nxt = "%s-fix%d" % (task, n)
    with open(os.path.join(LOGS, nxt + ".fixes-supplied.json"), "w") as f:
        json.dump([fx["id"] for fx in fixes], f)
    # Provenance: why each lesson was supplied (read into the next attempt's record).
    with open(os.path.join(LOGS, nxt + ".fixes-why.json"), "w") as f:
        json.dump({fx["id"]: why for fx, why in matched}, f)
    print(out)


def promote(task, atts, status):
    with FixesLock():
        return _promote(task, atts, status)


def _promote(task, atts, status):
    """§6.6: a fix supplied in a repair round that then passed, and whose signature
    matched the errors it was given for, becomes verified. A fix that did not help
    gets evidence noted; rejecting it is left to the manager."""
    fixes = load_fixes()
    by_id = {fx["id"]: fx for fx in fixes}
    changed = []
    for i, a in enumerate(atts):
        if not a.get("fixes_supplied") or i == 0:
            continue
        prev = atts[i - 1]
        prev_text = "\n".join("%s: %s" % (e["code"], e["message"]) for e in prev["errors"]) + "\n" + "\n".join(prev["flags"])
        for fid in a["fixes_supplied"]:
            fx = by_id.get(fid)
            if not fx:
                continue
            try:
                matched = bool(fx.get("signature")) and re.search(fx["signature"], prev_text)
            except re.error:
                matched = False
            apps = fx.setdefault("applications", {"supplied": 0, "passed": 0, "failed": 0})
            apps["supplied"] += 1
            if a["verdict"] == "passed" and matched:
                apps["passed"] += 1
                if fx.get("status") in ("observed", "hypothesis"):
                    fx["status"] = "verified"
                    changed.append({"id": fid, "to": "verified"})
                else:
                    changed.append({"id": fid, "to": fx.get("status"), "note": "more evidence"})
                fx["evidence"] = (fx.get("evidence", "") + " | %s: supplied in %s, attempt passed (%s)." % (task, a["attempt"], now()[:10])).strip(" |")
            elif a["verdict"] != "passed":
                apps["failed"] += 1
                fx["evidence"] = (fx.get("evidence", "") + " | %s: supplied in %s, did not resolve (%s)." % (task, a["attempt"], now()[:10])).strip(" |")
                # Two failed uses: no longer trusted as proven; it ranks last until it helps again.
                if apps["failed"] >= 2 and fx.get("status") in ("observed", "verified"):
                    fx["status"] = "hypothesis"
                    changed.append({"id": fid, "to": "hypothesis", "note": "failed twice"})
                else:
                    changed.append({"id": fid, "to": fx.get("status"), "note": "did not resolve"})
    if changed:
        save_fixes(fixes)
    return changed


REVIEW_KEYS = ("spec_items", "likely_cause", "outside_files", "broken_callers", "suggestion")


def final_self_review(task, last):
    """Before escalating: the local coder model reviews the last attempt against self-review.md
    and returns short JSON. A claim, like agent_claim; skipped (never fatal) when the model
    server is down or the reply is not JSON. FEEDBACK_SELF_REVIEW=0 turns it off."""
    if os.environ.get("FEEDBACK_SELF_REVIEW") == "0":
        return {"skipped": "disabled"}
    url = os.environ.get("FEEDBACK_REVIEW_URL") or \
        "http://127.0.0.1:%s/v1/chat/completions" % os.environ.get("CODER_PORT", "8081")
    errs = "\n".join("%s(%d): %s" % (e["file"], e["line"], e["message"]) for e in last.get("errors", [])[:10])
    errs += "".join("\nfailing test: " + t for t in last.get("failing_tests", [])[:5])
    prompt = "\n\n".join([
        "You are reviewing a failed coding attempt before it is escalated. Use this checklist:",
        read(SELF_REVIEW).strip(),
        "## Task spec", read(os.path.join(".claude", "specs", task + ".md"))[:6000],
        "## The attempt's change", diff_of(last.get("files") or []),
        "## Errors from the independent check", errs or (last.get("reason") or "(none recorded)"),
        "Reply with ONLY one JSON object, no other text: {\"spec_items\": [{\"item\": \"<spec item>\", "
        "\"status\": \"done|missing|wrong\"}], \"likely_cause\": \"<one sentence>\", \"outside_files\": "
        "[\"<files changed or created that the task does not list>\"], \"broken_callers\": [\"<callers that no "
        "longer match>\"], \"suggestion\": \"<one sentence: what the manager should do>\"}"])
    body = json.dumps({"model": os.environ.get("CODER_MODEL", "local").replace("openai/", ""),
                       "messages": [{"role": "user", "content": prompt}], "temperature": 0, "max_tokens": 700})
    try:
        req = urllib.request.Request(url, data=body.encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=int(os.environ.get("FEEDBACK_REVIEW_TIMEOUT", "180"))) as r:
            text = json.load(r)["choices"][0]["message"]["content"]
    except Exception as e:
        return {"skipped": "model unavailable: %s" % e.__class__.__name__}
    m = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(m.group(0)) if m else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return {"skipped": "reply was not JSON", "raw": text[:400]}
    return {k: data.get(k) for k in REVIEW_KEYS} | {"source": "local model self-review (a claim)"}


def cmd_finish(task, status, reason):
    atts = load_jsonl(os.path.join(LOGS, task + ".attempts.jsonl"))
    last = atts[-1] if atts else {}
    promoted = promote(task, atts, status) if atts else []
    result = {
        "task": task, "status": status, "reason": reason or None, "finished": now(),
        "attempts_count": len(atts), "repair_rounds": max(0, len(atts) - 1),
        "first_attempt_passed": bool(atts) and atts[0]["verdict"] == "passed",
        "category": None if status == "passed" else last.get("category"),
        "fixes_updated": promoted, "escalation": None, "attempts": atts,
    }
    if status != "passed":
        esc = {
            "task": task, "created": now(), "status": status, "reason": reason,
            "category": last.get("category"), "category_basis": last.get("category_basis"),
            "what_was_tried": [{"attempt": a["attempt"], "runner": a["runner"], "strategy": a["strategy"],
                                "verdict": a["verdict"], "errors": a["error_count"], "signature": a["signature"],
                                "fixes_supplied": a["fixes_supplied"]} for a in atts],
            "last_errors": last.get("errors", [])[:10], "last_flags": last.get("flags", []),
            "agent_claim": last.get("agent_claim"),
            "self_review": final_self_review(task, last),
            "next_owner": "manager (Claude)",
            "suggested_next": SUGGESTION.get(last.get("category") or "unknown"),
            "evidence_files": sorted(f for f in os.listdir(LOGS) if f.startswith(task)) if os.path.isdir(LOGS) else [],
            "tree": os.getcwd(),
        }
        path = os.path.join(LOGS, task + ".escalation.json")
        with open(path, "w") as f:
            json.dump(esc, f, indent=2)
        result["escalation"] = path
        os.makedirs(MAIN_LOGS, exist_ok=True)
        with open(os.path.join(MAIN_LOGS, "escalations.jsonl"), "a") as f:
            f.write(json.dumps({"task": task, "created": esc["created"], "category": esc["category"],
                                "reason": reason, "file": os.path.abspath(path)}) + "\n")
    with open(os.path.join(LOGS, task + ".result.json"), "w") as f:
        json.dump(result, f, indent=2)
    os.makedirs(MAIN_LOGS, exist_ok=True)
    with open(os.path.join(MAIN_LOGS, "outcomes.jsonl"), "a") as f:
        f.write(json.dumps({k: result[k] for k in ("task", "status", "reason", "finished", "attempts_count",
                                                    "repair_rounds", "first_attempt_passed", "category")} |
                           {"tree": os.getcwd(), "context_tokens": [a.get("context_tokens") for a in atts],
                            "errors_per_attempt": [a["error_count"] for a in atts]}) + "\n")
    print(json.dumps({"status": status, "escalation": result["escalation"], "fixes_updated": promoted}))


def cmd_resolve(path, opts):
    with FixesLock():
        _resolve(path, opts)


def _resolve(path, opts):
    esc = load_json(path)
    if not esc:
        raise SystemExit("not an escalation record: %s" % path)
    fixes = load_fixes()
    by_id = {fx["id"]: fx for fx in fixes}
    link = "escalation %s (%s, %s): %s" % (esc["task"], esc.get("created", "")[:10], esc.get("category"), esc.get("reason"))
    fid = opts["id"]
    if opts.get("existing"):
        if fid not in by_id:
            raise SystemExit("no fix record with id %s" % fid)
        by_id[fid]["evidence"] = (by_id[fid].get("evidence", "") + " | resolves " + link).strip(" |")
    else:
        if fid in by_id:
            raise SystemExit("fix id %s exists; use --existing to link it" % fid)
        sig = opts.get("signature")
        if not sig and esc.get("last_errors"):
            e = esc["last_errors"][0]
            sig = re.escape("%s: %s" % (e["code"], normalize(e["message"]).split("'<type>'")[0]))[:160]
        fixes.append({
            "id": fid, "status": "observed", "title": opts.get("title") or ("Fix for " + esc["task"]),
            "signature": sig or "", "terms": [t for t in opts.get("terms", "").split(",") if t],
            "files": [f for f in opts.get("files", "").split(",") if f],
            "conditions": esc.get("category_basis") or "", "root_cause": "Manager diagnosis after escalation.",
            "resolution": opts["resolution"], "evidence": "resolves " + link,
            "limitations": "Observed; verified when a repair round given this fix passes.", "recorded": now()[:10]})
    save_fixes(fixes)
    esc["resolved"] = {"at": now(), "by": "manager", "fix_id": fid}
    with open(path, "w") as f:
        json.dump(esc, f, indent=2)
    os.makedirs(MAIN_LOGS, exist_ok=True)
    with open(os.path.join(MAIN_LOGS, "escalations.jsonl"), "a") as f:
        f.write(json.dumps({"task": esc["task"], "resolved": now(), "fix_id": fid, "file": os.path.abspath(path)}) + "\n")
    print(json.dumps({"resolved": esc["task"], "fix_id": fid, "new_record": not opts.get("existing")}))


def cmd_stats(logs_dir):
    """Retries, time, and lesson use across every recorded task in logs_dir."""
    tasks = {}
    for p in sorted(os.listdir(logs_dir)):
        if p.endswith(".attempts.jsonl"):
            atts = load_jsonl(os.path.join(logs_dir, p))
            if atts:
                tasks[p[:-len(".attempts.jsonl")]] = atts
    if not tasks:
        print("no attempt records in %s" % logs_dir)
        return
    n = len(tasks)
    first = sum(1 for a in tasks.values() if a[0]["verdict"] == "passed")
    passed = sum(1 for a in tasks.values() if a[-1]["verdict"] == "passed")
    rounds = sum(len(a) - 1 for a in tasks.values())
    timed = [sum(x.get("duration_s") or 0 for x in a) for a in tasks.values() if all(x.get("duration_s") is not None for x in a)]
    print("tasks: %d | first-try pass: %d (%.0f%%) | passed in the end: %d | fix rounds per task: %.2f" % (
        n, first, 100.0 * first / n, passed, rounds / n))
    print("minutes per task: %s" % ("%.1f (over %d timed tasks)" % (sum(timed) / 60.0 / len(timed), len(timed)) if timed
                                    else "n/a (no timed attempts yet; timing started 2026-10-29)"))
    fix = [x for a in tasks.values() for x in a[1:]]
    with_l = [x for x in fix if x.get("fixes_supplied")]
    without = [x for x in fix if not x.get("fixes_supplied")]
    rate = lambda xs: "%d/%d passed" % (sum(1 for x in xs if x["verdict"] == "passed"), len(xs)) if xs else "none"
    print("fix rounds with a lesson: %s | without: %s" % (rate(with_l), rate(without)))
    per = {}
    for x in with_l:
        for fid in x["fixes_supplied"]:
            per.setdefault(fid, []).append(x["verdict"])
    for fid, vs in sorted(per.items()):
        print("  lesson %-32s supplied %d, passed %d" % (fid, len(vs), vs.count("passed")))
    for fx in load_fixes():
        if fx.get("applications"):
            print("  record %-32s %s %s" % (fx["id"], fx["status"], fx["applications"]))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    files = argv[argv.index("--") + 1:] if "--" in argv else []
    args = argv[2:argv.index("--")] if "--" in argv else argv[2:]
    if cmd == "attempt":
        attempt, runner, verdict, reason, timed_out = args
        cmd_attempt(os.environ["TASK"], attempt, runner, verdict, reason, timed_out, files)
    elif cmd == "decide":
        print(cmd_decide(args[0], int(args[1])))
    elif cmd == "repair-spec":
        cmd_repair_spec(args[0], args[1], args[2], args[3], files)
    elif cmd == "resolve":
        opts, rest, i = {}, [], 0
        while i < len(args):
            a = args[i]
            if a == "--existing":
                opts["existing"] = True; i += 1
            elif a.startswith("--"):
                opts[a[2:]] = args[i + 1]; i += 2
            else:
                rest.append(a); i += 1
        if not rest or "id" not in opts or ("resolution" not in opts and not opts.get("existing")):
            raise SystemExit("usage: feedback.py resolve <escalation.json> --id ID --resolution TEXT [...]")
        cmd_resolve(rest[0], opts)
    elif cmd == "finish":
        cmd_finish(args[0], args[1], args[2] if len(args) > 2 else "")
    elif cmd == "stats":
        cmd_stats(args[0] if args else MAIN_LOGS)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

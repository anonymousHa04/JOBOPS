#!/bin/sh
# Claude Code hook (PostToolUse / PostToolUseFailure on Bash): append each
# command Claude ran, and the first lines of its output, to
# .agent-logs/claude-commands.log. Watch it live: tail -f .agent-logs/claude-commands.log
# (or the VS Code task "Claude live log"). The log is git-ignored.
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$root/.agent-logs"
python3 -c '
import json, sys, time
try:
    e = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
ti, tr = e.get("tool_input") or {}, e.get("tool_response") or {}
failed = e.get("hook_event_name") == "PostToolUseFailure"
out = ""
if isinstance(tr, dict):
    out = (tr.get("stdout") or "") + (("\n" + tr["stderr"]) if tr.get("stderr") else "")
elif isinstance(tr, str):
    out = tr
if failed:
    out = (out + "\n" + str(e.get("error") or "")).strip()
lines = out.strip().split("\n") if out.strip() else []
keep = 30
print("\n%s %s %s" % ("=" * 8, time.strftime("%H:%M:%S"), "FAILED " if failed else ""))
if ti.get("description"):
    print("# " + ti["description"])
print("$ " + (ti.get("command") or "").strip().replace("\n", "\n  "))
if ti.get("run_in_background"):
    print("  (running in background)")
for l in lines[:keep]:
    print("  " + l[:200])
if len(lines) > keep:
    print("  ... %d more lines" % (len(lines) - keep))
' >> "$root/.agent-logs/claude-commands.log"
exit 0

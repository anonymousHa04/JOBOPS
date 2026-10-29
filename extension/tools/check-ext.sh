#!/bin/sh
# Checks for the extension, used as check.sh's test step:
#   TEST_CMD="sh extension/tools/check-ext.sh chat.js" .claude/bin/autofix.sh <task> <spec> extension/chat.js
# Arguments: the files a task owns (default: all). Syntax is checked for every file;
# the other checks only for the named files, so a task is never failed for another's file.
# Prints one "FAIL:" line per problem, then "ℹ pass N" / "ℹ fail N" (the summary
# check.sh reads). Exit 1 on any failure. Selectors come from extension/selectors.md.
set -u
cd "$(git rev-parse --show-toplevel)/extension" || exit 1
files=${*:-background.js chat.js popup.js}
pass=0; fail=0
owns() { case " $files " in *" $1 "*) return 0;; esac; return 1; }
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $*"; }
has() { grep -qF -- "$2" "$1" && ok || bad "$1 must contain: $2 ($3)"; }
hasnt() { grep -qF -- "$2" "$1" && bad "$1 must not contain: $2 ($3)" || ok; }

# 1. Syntax and manifest.
for f in *.js tools/*.mjs; do
  out=$(node --check "$f" 2>&1) && ok || bad "$f syntax error: $(echo "$out" | grep -m1 -E 'Error')"
done
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))' 2>/dev/null && ok || bad "manifest.json is not valid JSON"

# 2. No file emptied or cut down.
for spec in background.js:120 chat.js:120 popup.js:60; do
  f=${spec%%:*}; min=${spec##*:}; owns "$f" || continue; n=$(wc -l < "$f" | tr -d ' ')
  [ "$n" -ge "$min" ] && ok || bad "$f has $n lines, expected at least $min (do not delete existing code)"
done

# 3. No top-level function defined twice.
for f in $files; do
  d=$(grep -oE '^(async )?function [A-Za-z0-9_]+' "$f" | sed 's/^async //' | sort | uniq -d | tr '\n' ' ')
  [ -z "$d" ] && ok || bad "$f defines these functions more than once: $d"
done

# 4. chat.js uses the confirmed selectors and none of the dead ones.
if owns chat.js; then
for s in "div.ProseMirror[contenteditable='true']" "button[data-testid='chat-input-send']" \
         "[data-is-streaming='true']" "button[data-testid='chat-input-stop']" "div[data-is-streaming]" \
         "div[contenteditable='true']" "button[aria-label='Send']" \
         "[data-talvt-turn-state='in_progress']" "button[aria-label='Stop']" \
         "[data-content-search-unit-key\$=':assistant']"; do
  has chat.js "$s" "confirmed selector"
done
for s in ".answer1" "font-claude-" "data-message-author-role" "#prompt-textarea" "stop-button"; do
  hasnt chat.js "$s" "dead selector or placeholder"
done
has chat.js 'join(", ")' "pass selector lists to querySelector as one string"
has chat.js "function countAnswers" "count answers before sending"
grep -qE '\.at\(-1\)|length - 1\]' chat.js && ok || bad "chat.js must take the LAST answer (querySelectorAll(...) then .at(-1)), not querySelector's first"
grep -qE '(> *before|<= *before)\b' chat.js && ok || bad "chat.js waitForAnswer must do nothing until countAnswers(...) > before"
grep -A4 'function clickSendButton' chat.js | grep -qF 'join(", ")' && ok || bad "chat.js clickSendButton must join its selector list with join(\", \")"
grep -qE 'querySelector\(answeringIndicatorSelector\)' chat.js && bad "chat.js passes the answering selector list to querySelector without join(\", \")" || ok
fi

# 5. background.js and popup.js fixes.
if owns background.js; then
has background.js "updatedId === tabId" "only the chat tab's load counts"
grep -qE 'tabs\.update\([^)]*newUrl' background.js && ok || bad "background.js must send an existing chat tab to CHAT[target].newUrl with chrome.tabs.update"
[ "$(grep -cE '^async function saveReport' background.js)" = 1 ] && ok || bad "background.js must define saveReport once, at the top level"
[ "$(grep -c 'saveReport(' background.js)" -ge 3 ] && ok || bad "background.js must call saveReport from both the answer and saveSelection branches"
# Report loop (plan-report-loop.md, loop-04): one chat per job and site, up to 5 rounds.
has background.js '"chats"' "remember one chat URL per job and site in chrome.storage.local \"chats\""
has background.js "/x/fix/" "after each saved answer, ask the API to fix and get the next prompt"
has background.js '"fixing"' "status step \"fixing\" while the local models work"
has background.js '"done"' "final status step \"done\""
grep -qE '(round|r) *< *5' background.js && ok || bad "background.js must stop after round 5"
fi
if owns popup.js; then
has popup.js "job.score != null" "untailored jobs have no score; do not show null"
has popup.js "status.step" "show step/error/path, not the whole object"
has popup.js "chrome.storage.local.get" "show the saved status when the popup opens"
has popup.js "chrome.runtime.lastError" "handle a failed background reply"
has popup.js "did not answer" "message for an undefined reply"
grep -q 'Round ' popup.js && grep -q '/5' popup.js && ok || bad "popup.js must show \"Round <n>/5\" while the loop runs"
has popup.js "needs_facts" "the done line says how many gaps need the user's facts"
fi

echo "ℹ pass $pass"
echo "ℹ fail $fail"
[ "$fail" = 0 ]

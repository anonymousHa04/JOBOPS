#!/bin/zsh
# Load general14 on demand: llama-server unloads the model after LLM_GENERAL14_SLEEP idle
# seconds (default 300) and loads it again on the next request. This checks:
# 1. llm.sh starts general14 with --sleep-idle-seconds;
# 2. a server started that way frees its memory when idle, still answers /health and
#    /v1/models (JobOps' "is the model up?" check), and wakes on a request.
# Part 2 uses the small 0.5B draft model on port 8099 with a 3 s idle time, never general14.
set -u
root=${0:A:h:h:h}
fail() { print "FAIL: $1"; exit 1; }

grep -q 'general14).*--sleep-idle-seconds \${LLM_GENERAL14_SLEEP:-300}' "$root/.claude/bin/llm.sh" \
  || fail "llm.sh does not start general14 with --sleep-idle-seconds \${LLM_GENERAL14_SLEEP:-300}"
print "ok: llm.sh starts general14 with an idle sleep (default 300 s)"

model=~/models/jobops/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf
[ -f $model ] || fail "no $model"
port=8099
curl -sf 127.0.0.1:$port/health >/dev/null 2>&1 && fail "port $port is in use"
log=$(mktemp)
llama-server -m $model --host 127.0.0.1 --port $port -c 2048 -np 1 --sleep-idle-seconds 3 > $log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -f $log' EXIT
for i in {1..60}; do curl -sf 127.0.0.1:$port/health >/dev/null && break; sleep 0.5; done
footprint() { vmmap --summary $pid 2>/dev/null | awk '/Physical footprint:/{v=$3; u=substr(v,length(v)); n=v+0; if(u=="G")n*=1024; if(u=="K")n/=1024; print int(n)}'; }
ask() { curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:$port/v1/chat/completions -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":4}'; }

[ "$(ask)" = 200 ] || fail "the first request failed"
loaded=$(footprint)
sleep 6
grep -q "entering sleeping state" $log || fail "the server did not go to sleep after 3 idle seconds"
asleep=$(footprint)
[ "$asleep" -lt "$loaded" ] || fail "memory was not freed while asleep ($loaded MB -> $asleep MB)"
print "ok: asleep after 3 idle seconds, memory $loaded MB -> $asleep MB"
[ "$(curl -s -o /dev/null -w %{http_code} 127.0.0.1:$port/v1/models)" = 200 ] || fail "/v1/models is not 200 while asleep (JobOps would think it is down)"
print "ok: /v1/models still answers 200 while asleep"
[ "$(ask)" = 200 ] || fail "a request did not wake it"
grep -q "exiting sleeping state" $log || fail "no wake-up in the log"
print "ok: a request woke it and was answered"
print "PASS"

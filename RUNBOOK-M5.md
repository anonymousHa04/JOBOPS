# Milestone 5 runbook: watch, start, and run a batch

How to see everything and run a batch on the split setup: JD parse and judge on the laptop,
tailoring on the Mac. All commands run from the repo root on the Mac unless they say otherwise.

## The machines

| What | Where | Address |
|---|---|---|
| general7 (JD parse, judge) | Lenovo laptop, RTX 3050 | http://10.10.10.1:8084/v1 (direct cable) |
| general14 (rewording) | Mac | http://127.0.0.1:8085/v1 |
| coder (local coding agent) | Mac | http://127.0.0.1:8081/v1 |
| Qdrant (Docker) | Mac | http://localhost:6333 |
| Queue server | Mac | http://127.0.0.1:8090 |
| API | Mac | http://localhost:3000 |

- The Mac holds one heavy model at a time: the coder or general14, never both. Never load
  general7 on the Mac next to general14.
- `.env` needs `LLM_GENERAL7_URL=http://10.10.10.1:8084/v1` and `LLM_GENERAL7_KEY=<key>`
  (the key is in `~/.ssh/jobops_laptop_llm_key`, the same as `C:\llama\api-key.txt`).
- Do not create or edit files in the repo while a coder runs: autofix.sh reverts every change
  outside the task's files, new untracked files included.

## After a restart

1. Laptop: double-click `C:\llama\start-server.cmd` and leave its window open. Never register it
   as a logon or auto-start task.
2. Mac: start Docker Desktop, then Qdrant:

       open -a Docker
       docker compose -f infra/qdrant/docker-compose.yml up -d

   Without Qdrant, coder runs stop at once (the log says "coder window gone").
3. Check:

       curl http://10.10.10.1:8084/health        # {"status":"ok"}
       curl -s localhost:6333/collections         # lists jobops_knowledge
       .claude/bin/llm.sh status

## Watch everything (tmux)

    tmux attach -t jobops

Switch windows with `Ctrl-b` then the number; leave with `Ctrl-b d` (everything keeps running).

| Window | Shows |
|---|---|
| status | local model servers and `git status`, every 5 s |
| `<task id>` | a coder at work (one window per task) |
| laptop-health | laptop general7, Qdrant, queue and API, every 5 s |
| laptop-log | the laptop's `C:\llama\logs\server.log`, live over SSH |
| model-calls | one line per model call: task, model, outcome, time |

If the session is gone, recreate it and the watch windows:

    R=$PWD
    tmux new-session -d -s jobops -n status -c "$R" "while true; do clear; date; echo; '$R/.claude/bin/llm.sh' status; echo; git -C '$R' status --short; sleep 5; done"
    tmux new-window -d -t jobops -n laptop-health -c "$R" "while true; do clear; date; printf 'laptop general7: '; curl -s -m3 http://10.10.10.1:8084/health || echo DOWN; echo; printf 'qdrant: '; curl -s -m3 -o /dev/null -w '%{http_code}\n' localhost:6333/collections; printf 'queue:  '; curl -s -m2 localhost:8090/health || echo 'not running'; echo; printf 'api:    '; curl -s -m2 -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/jobs?limit=1'; sleep 5; done"
    tmux new-window -d -t jobops -n laptop-log -c "$R" "ssh jobops-laptop 'Get-Content C:\\llama\\logs\\server.log -Wait -Tail 30'"
    tmux new-window -d -t jobops -n model-calls -c "$R" "tail -n 20 -F data/model-calls.jsonl"

## The laptop by itself

    curl http://10.10.10.1:8084/health
    ssh jobops-laptop 'Get-Content C:\llama\logs\server.log -Wait -Tail 50'
    ssh jobops-laptop 'nvidia-smi'
    ssh jobops-laptop 'tasklist /FI "IMAGENAME eq llama-server.exe"'

The laptop's shell is PowerShell: use `;` between commands, not `&`.

## Run a batch

One command brings everything up (laptop check, Docker and Qdrant, general14 instead of the
coder, and tmux windows api, queue, worker-laptop, worker-mac); it never starts a batch:

    .claude/bin/batch-up.sh

Or by hand, one terminal each:

    # 1. API (jd-search posts new jobs to it)
    node api/src/server.ts

    # 2. Queue server (tables queue_batches and queue_tasks in data/jobops.db)
    go run -C queue ./cmd/queue

    # 3. Laptop worker: parse and score on general7 (3 at a time)
    node api/src/cli.ts worker laptop

    # 4. Mac worker: tailor on general14 (3 at a time). Stop the coder first.
    .claude/bin/llm.sh stop coder && .claude/bin/llm.sh start general14
    node api/src/cli.ts worker mac

Then:

    node api/src/cli.ts batch start --limit 3     # 1-100, default 100
    node api/src/cli.ts batch status              # recent batches
    node api/src/cli.ts batch status 1            # one batch: counts per stage, failures
    node api/src/cli.ts batch retry 1             # queue that batch's failed tasks again

How a batch runs:

- `batch start` searches the job boards (fetch), then takes up to the limit of jobs, newest first.
  Finished jobs are skipped, so the next batch takes the next jobs.
- Each job goes parse -> score -> tailor (only when the decision is reuse or adapt). A job moves to
  its next stage the moment its task finishes.
- A timeout or a server that does not answer is retried after 30 s and 60 s (3 attempts); invalid
  output fails at once. A worker that dies returns its task to the queue when the lease runs out.
- A worker only leases work whose model answers. When a model is down it prints what to start,
  once a minute.
- When a batch ends with no tailored resume, start another.

Stop a worker with `Ctrl-C`: it finishes its current task first.

## Report loop (Chrome extension)

The extension's report loop now has to raise the score. Each fix round is re-scored by the engine.
The loop stops at the first round that does not raise the engine score, at most 5 rounds, and the
best version stays the job's current resume. The popup shows the engine score per round, the
chat's `fit_score`, why it stopped, and how many gaps need your facts. The per-round record is in
`profile/reports/<job>.<source>.loop.json`.

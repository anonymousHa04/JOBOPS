# general14 concurrency and isolation: results (2026-10-31)

Plan: `bench/prefill/results/general14_concurrency_and_isolation_experiments.md`.
Setup: Mac mini M4 16 GB; Homebrew llama.cpp build 11669; general7 = qwen2.5-7b Q4_K_M, 3 slots, unified
16k KV (unchanged); general14 = qwen2.5-14b Q4_K_M, 16k KV q8_0, flash attention, `-kvu` when it has 2 or 3
slots. Embedding server running throughout; coder stopped. Background swap was already ~7–8 GB from other apps.

Resume request = the production reword phase (`rewordContent`: select-and-tailor template, JSON schema,
guard and retries) for 6 bullets of a fake bank against a real JD's stored requirements. Three requests
(Terraform platform, SRE, Fullstack JDs). The real bank in `profile/` was never read.

## Experiment 1: general14 alone, 1 / 2 / 3 requests at once

general7 stopped (with general7 loaded, see Experiment 2). 3 repetitions per level, order rotated.
Medians; runs agreed within ~5%.

| Concurrency | Time for 3 resumes | R1 / R2 / R3 latency | R3 queue wait | Output tok/s (all) | Gen tok/s per request | Prefill tok/s per request | Swap change | Peak pressure | Failed calls / OOM / KV |
|---:|---:|---|---:|---:|---:|---:|---|---|---|
| 1 | 545 s | 182 / 166 / 193 s | 353 s | 9.6 | 11.0 | 103 | +1.0–2.1 GB | warn | 0 / 0 / 0 |
| 2 | 413 s (−24%) | 286 / 196 / 217 s | 196 s | 12.3 (1.3x) | 8.2 | 90 | +1.4–1.8 GB | warn | 0 / 0 / 0 |
| 3 | 307 s (−44%) | 307 / 254 / 297 s | 0 s | 17.1 (1.8x) | 6.9 | 68 | +0.05–1.6 GB | warn | 0 / 0 / 0 |

Work per batch was the same at every level: 27 model calls, ~6.4k prompt and ~5.2k output tokens.

Quality (54 bullets per level, 3 reps x 18):

| Concurrency | Accepted | Accepted on retry | Guard fallback (original kept) | Bullets differing from concurrency 1 |
|---:|---:|---:|---:|---|
| 1 | 27 | 9 | 18 | 0 of 18 in every rep |
| 2 | 27 | 12 | 15 | 1 of 18 |
| 3 | 27 | 11 | 16 | 0–1 of 18 |

All outputs passed the JSON schema. The one differing bullet is batching drift at temperature 0, not a
quality change. Server start with the weights in page cache: 2–3 s.

## Experiment 2: general14 next to general7

| Check | Result |
|---|---|
| Both loaded at once | Loads, but swap went 8.2 → 12.8 GB and pressure went critical |
| general7 request with general14 loaded | Failed: Metal `kIOGPUCommandBufferCallbackErrorOutOfMemory`, then "Compute error" on every request |
| Restart general7 beside general14, retry | Both servers failed every request (20 OOM lines in general14's log, 68 in general7's) |
| general14 before the failure | 39 tok/s prefill, 11 tok/s generation (prefill ~60% slower than alone) |

The two models together exceed the GPU memory macOS allows on 16 GB (weights alone ~12.8 GiB plus KV and
compute buffers). The matrix rows with 3 JD tasks + 1/2/3 resume requests could not run: there is no
simultaneous lane. Logs: `raw/feasibility.log`, `raw/general7-coresidency.log`.

What does work is one model at a time with a swap; its cost is measured in Experiment 3: stopping general7
and loading general14 took 10–13 s, and a resume waits for the remaining JD work plus that swap.

## Experiment 3: end-to-end workflow (adapted)

No queue exists yet, so `workflow.ts` stands in: load general7, parse 6 real JDs 3 at a time (production
jd_parse prompt and schema, nothing written to the database), stop general7, load general14, tailor the 3
resumes. Baseline = general14 with 1 slot (today); candidate = 3 slots. 3 repetitions each, order alternated.

| | 1 slot (today) | 3 slots |
|---|---:|---:|
| Workflow time (median) | 685 s | 452 s (−34%) |
| general7 load / JD phase / swap | 5 / 95 / 11 s | 5 / 94 / 11 s |
| Resume phase | 575 s | 343 s |
| Resume ready → inference start (median / max) | 264 / 395 s | 33 / 49 s |
| Resume latency, ready → done (median / max) | 430 / 590 s | 347 / 376 s |
| JDs parsed | 6/6 every run | 6/6 every run |
| Resumes completed without error | 3/3 every run | **2/3 every run** |
| Peak pressure | critical in 2 of 3 runs | warn |
| Swap change | +0.9–1.6 GB | +0.5–1.3 GB |
| OOM / KV failures | 0 | 0 |

The 3-slot failure is the same every run: the SRE resume's 4th bullet hits the reword timeout (60 s in
`api/config/models.yaml`) while three requests share the GPU at ~7 tok/s each; `rewordContent` then skips
that resume's remaining bullets (they keep their original text). The same mix stayed just under 60 s in
Experiment 1. A 3-slot setup needs a longer reword timeout (~120 s); the benchmark kept the production value.

## Final outcome

1. Best general14 concurrency alone: **3** (1.8x throughput, last resume ~4 min sooner, no quality change),
   provided the reword timeout is raised.
2. Best general14 concurrency while general7 is busy: **none**; the two cannot run together.
3. Both models resident simultaneously: **no** (Metal out of memory).
4. Resume requests start without waiting for general7: **no**; they wait for the JD phase to drain plus a
   10–13 s model swap.
5. Resume latency under the workable setup (swap): median 347 s from ready at 3 slots vs 430 s at 1 slot.
6. Throughput impact on general7: none measurable; the JD phase took the same time in both configurations
   (general7 runs alone).
7. Memory: pressure warn in all general14 runs and critical in some 1-slot workflow runs, swap +0.5–2 GB on a
   machine already holding ~7–8 GB of swap; no OOM or KV failures when only one model is loaded.
8. Recommended configuration: models in sequence, general7 (3 slots) for the JD phase then general14 with
   **3 slots and -kvu**, reword timeout raised to ~120 s, retested before adopting. Not a separate lane.

Raw data: `runs.jsonl` (Experiment 1), `workflow-runs.jsonl` (Experiment 3), `raw/` (Experiment 2 logs).
Per-second memory samples, per-run server logs and model-call logs were deleted after the summaries above
were written.

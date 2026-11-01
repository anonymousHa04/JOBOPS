# General14 Concurrency and Isolation Experiments

## Objective

Test `general14` at concurrency **1, 2, and 3**, then verify whether its resume-tailoring lane remains available while `general7` is busy. The goal is not merely to submit parallel requests: resume tailoring should not wait behind unrelated JD parsing/judging work.

## Current setup and constraints

- Mac mini M4, 16 GB unified memory.
- `llama.cpp`.
- `general7`: Qwen 2.5 7B Q4_K_M, 3 slots, shared 16,384-token KV cache.
- `general14`: Qwen 2.5 14B, currently configured for 1 request.
- `general7` handles JD parsing/judging; `general14` handles resume rewording/tailoring.
- Coder 14B is development-only and out of scope.

Both general models share system memory and GPU compute. Separate servers/queues do not guarantee physical isolation. Verify simultaneous model residency, memory pressure, swapping, and inference interference.

---

## Experiment 1 — general14 alone: concurrency 1 vs 2 vs 3

### Question

What is the maximum useful `general14` concurrency when `general7` is idle?

### Procedure

1. Keep `general7` idle.
2. Select three representative real JobOps resume-tailoring requests. Use the same inputs, actual production prompt/template and YAML preferences in every run.
3. Keep model/quantization, llama.cpp build, context/batch settings, generation parameters, and cache conditions consistent.
4. Test:
   - **A — concurrency 1:** R1, R2, R3 sequentially.
   - **B — concurrency 2:** R1 + R2 together; submit R3 when a slot frees.
   - **C — concurrency 3:** R1 + R2 + R3 together.
5. Repeat each configuration three times. If practical, vary the order of configurations to reduce warm-up/order bias.
6. Use normal production output settings; do not force identical output lengths if that would distort real usage. Record actual token counts.
7. Record prompt-cache hits/misses.

### Metrics

| Metric | Record | Why |
|---|---|---|
| Batch wall time | First submission to final completion | Total time for three requests |
| Per-request latency | Submit and completion timestamps for R1/R2/R3 | Individual user-visible delay |
| Queue wait | Submission to inference start | Time waiting for a slot |
| TTFT | Submission to first generated token | Responsiveness |
| Prompt processing | Input tokens and prompt tokens/sec | Prefill performance |
| Generation speed | Output tokens and generation tokens/sec | Decode performance |
| Aggregate throughput | Total output tokens / elapsed generation or batch time; report prompt throughput separately | Useful work completed |
| Token counts | Prompt and output tokens per request | Makes runs comparable |
| Peak memory | Peak process/system memory and memory pressure | Fit and stability |
| Swap | Before/during/after swap usage | Detects memory pressure |
| KV cache | Capacity, peak use, allocation failures/retries | Context capacity |
| Errors | Timeout, failed request, restart, OOM, incomplete output | Reliability |
| YAML validity | Parse/schema validation pass or fail | Structural correctness |
| Output quality | Same established JobOps evaluation criteria for every run | Detects quality regression |

### Results log

| Concurrency | Repetition | Batch time | R1 latency | R2 latency | R3 latency | Queue wait R1/R2/R3 | TTFT R1/R2/R3 | Prompt tok/s | Generation tok/s | Peak memory | Swap change | KV failures | YAML passes / 3 | Quality notes |
|---:|---:|---|---|---|---|---|---|---:|---:|---|---|---:|---:|---|
| 1 | 1 | | | | | | | | | | | | | |
| 1 | 2 | | | | | | | | | | | | | |
| 1 | 3 | | | | | | | | | | | | | |
| 2 | 1 | | | | | | | | | | | | | |
| 2 | 2 | | | | | | | | | | | | | |
| 2 | 3 | | | | | | | | | | | | | |
| 3 | 1 | | | | | | | | | | | | | |
| 3 | 2 | | | | | | | | | | | | | |
| 3 | 3 | | | | | | | | | | | | | |

### Interpretation

- Compare total time for all three requests, not just per-request speed.
- Higher concurrency is useful only if it improves total throughput/workflow time without unacceptable latency, memory pressure, errors, or quality regression.
- If concurrency 3 adds little throughput but sharply increases latency or memory pressure, concurrency 2 may be better.
- Do not assume the highest tested concurrency is the best setting.

---

## Experiment 2 — general14 coexisting with general7

### Question

Can `general14` serve resume requests while `general7` is actively parsing/judging JDs?

This is the core isolation test. A separate queue is not enough if model loading, shared memory, or GPU contention prevents the resume request from starting promptly.

### Procedure

1. Measure one representative resume request with `general7` idle as the baseline.
2. Run three representative JD parse/judge requests on `general7`.
3. While those tasks are active, submit one resume-tailoring request to `general14`.
4. Repeat with two and then three simultaneous `general14` requests, but only if those levels were stable in Experiment 1.
5. Repeat each configuration three times.
6. Verify whether both models remain resident at the same time. If one is unloaded before the other is loaded, record that; this is not simultaneous inference-lane availability.
7. Monitor memory pressure, swap, model reloads, KV allocation, latency, and errors.

### Test matrix

| general7 workload | general14 workload | Purpose |
|---|---|---|
| Idle | 1 request | Baseline resume latency |
| 3 concurrent JD tasks | 1 request | Test one resume request under load |
| 3 concurrent JD tasks | 2 requests | Test two resume requests under load |
| 3 concurrent JD tasks | 3 requests | Test three resume requests under load |

Use a representative parse/judge mix if three identical JD tasks do not reflect the actual workload; document which stages are active.

### Metrics

| Metric | Record | Why |
|---|---|---|
| general7 task times | Start/end timestamps per JD task | Confirms competing workload |
| Resume submission | Exact submission timestamp | Establishes arrival time |
| Resume inference start | When general14 actually begins | Direct isolation measure |
| Resume queue wait | Inference start minus submission | Does it wait for general7? |
| Resume TTFT/completion | First-token and final-completion timestamps | Responsiveness and end-to-end impact |
| Baseline delta | Same resume request with general7 idle vs busy | Quantifies interference |
| general7 latency delta | JD task times with general14 idle vs busy | Measures impact on general7 |
| Model residency | Whether both models stay loaded | Confirms simultaneous availability |
| Memory pressure | Peak memory and pressure state | Detects resource exhaustion |
| Swap | Before/during/after | Detects memory pressure |
| KV cache | Peak usage and allocation failures for both | Detects context-capacity issues |
| Errors/reloads | OOM, timeout, failed request, unload/reload, restart | Reliability |
| Output checks | YAML validity and same quality checks as Experiment 1 | Correctness |

### Results log

| general7 load | general14 concurrency | Repetition | Resume queue wait | Resume TTFT | Resume total time | general7 task time | Both resident? | Peak memory/pressure | Swap change | KV failures | Errors/reloads | YAML passes | Quality notes |
|---|---:|---:|---|---|---|---|---|---|---|---|---|---:|---|
| Idle | 1 | 1 | | | | N/A | | | | | | | |
| 3 JD tasks | 1 | 1 | | | | | | | | | | | |
| 3 JD tasks | 2 | 1 | | | | | | | | | | | |
| 3 JD tasks | 3 | 1 | | | | | | | | | | | |

Add repetitions 2 and 3 for each tested row.

### Interpretation

- Core pass condition: a resume request starts on `general14` without waiting for the `general7` queue to drain.
- Separate queue wait from inference duration. A request may start immediately but run slowly due to shared GPU/memory contention.
- Immediate start plus slower TTFT/completion means queue isolation works, but compute is shared.
- If both models cannot remain resident together, the setup does not provide an always-available independent lane.
- Treat swap growth, memory pressure, OOMs, KV failures, or model reloads as instability.

---

## Experiment 3 — end-to-end JobOps workflow under load

### Question

Does the selected `general14` concurrency improve the real workflow while keeping resume tailoring independent of unrelated JD work?

Run this after Experiments 1 and 2 identify stable candidate settings.

### Procedure

1. Select the best stable `general14` concurrency from the first two experiments. Do not automatically choose 3.
2. Use a representative batch of real JDs and associated resume-tailoring tasks.
3. Run the normal JobOps workflow, including its existing orchestration, queues, persistence, and retry behavior.
4. Keep `general7` processing JD parsing/judging while resume tasks become ready.
5. For each resume task, record when it becomes eligible, is dispatched, starts inference, and completes.
6. Compare against the current concurrency-1 configuration using the same inputs and equivalent workload.
7. Repeat at least three times where practical. Record cache state and input ordering.

### Metrics

| Metric | Record | Why |
|---|---|---|
| Total workflow duration | Batch start to all tracked tasks complete | Overall throughput |
| JD processing duration | Parse/judge start and end per JD | general7 performance |
| Resume-ready time | When tailoring becomes eligible | Separates upstream delay |
| Resume dispatch delay | Ready to dispatch | Orchestrator queueing |
| Resume inference queue wait | Dispatch/submission to inference start | Dedicated-lane availability |
| Resume completion latency | Ready to completed artifact | User-facing delay |
| Throughput | JDs processed and resumes tailored per unit time | Useful workflow output |
| Backlog | Pending tasks by stage over time | Identifies growing queues |
| Retries/failures | Count and reason by stage | Reliability |
| Memory/swap | Peak pressure and swap change | Sustained resource use |
| Model residency | Whether both models stay available | Operational independence |
| Artifact validation | Existing YAML/schema/PDF validation outcomes | Correctness |
| Quality | Same resume-tailoring evaluation criteria | Quality regression |

### Results log

| Run | general14 concurrency | JDs completed | Resumes completed | Workflow time | Ready-to-inference wait (median/max) | Resume latency (median/max) | Peak backlog by stage | Retries/failures | Peak memory/pressure | Swap change | Model reloads | Validation results | Quality notes |
|---|---:|---:|---:|---|---|---|---|---|---|---|---|---|---|
| Current baseline | 1 | | | | | | | | | | | | |
| Candidate | | | | | | | | | | | | | |
| Candidate | | | | | | | | | | | | | |

### Interpretation

- The important metric is how long a resume waits after it becomes ready—not tokens/sec alone.
- Identify whether delay comes from upstream processing, orchestrator dispatch, the general14 queue, model loading, or shared hardware contention.
- A dedicated lane succeeds when resume work does not wait behind general7 tasks and the system remains stable under representative load.
- Choose the smallest concurrency that reliably meets workflow latency and throughput needs.

---

## Decision criteria

| Observation | Conclusion / next action |
|---|---|
| Concurrency 2 or 3 improves throughput and is stable alone and during coexistence | Consider that concurrency for production |
| Higher concurrency increases per-request latency without meaningful throughput gain | Keep the lower concurrency |
| general14 is responsive alone but slows with general7 active | Queue isolation exists, but compute contention remains |
| Resume inference waits until general7 drains | Lanes are not operationally independent; inspect dispatch/model lifecycle |
| Both models cannot remain resident | Current setup cannot provide simultaneous model availability |
| Swap, OOMs, KV failures, or reloads occur | Do not adopt that configuration as stable |
| Throughput improves but YAML validity or resume quality regresses | Reject until correctness is restored |

## Measurement notes

- Keep model files, quantization, llama.cpp build, context/batch settings, prompt templates, and generation parameters fixed across comparable runs.
- Record actual prompt/output token counts. Report prefill and generation throughput separately.
- Record prompt-cache hits/misses; caching can materially change prefill measurements.
- Warm models consistently before timed runs. If cold-start behavior matters, record model-load time separately.
- Do not run the development-only coder model during these production experiments.
- Run configurations in a controlled sequence; do not launch all experiments simultaneously.
- Preserve raw server logs and timestamps so queue wait, TTFT, generation time, and completion time can be reconstructed.
- The earlier general7 benchmark found no prefill-throughput scaling with concurrency in its tested conditions. That result is specific to general7 and those prompts; do not assume general14 behaves the same way.
- The actual 120-JD general7 prompt distribution was measured previously: median 1,107 tokens, 90th percentile 1,531, maximum 1,903. Use representative real inputs rather than synthetic long prompts for workflow tests.

## Final outcome

At the end, report:

1. Best stable general14 concurrency when running alone: `1 / 2 / 3`.
2. Best stable general14 concurrency while general7 is busy: `1 / 2 / 3 / none`.
3. Both models resident simultaneously: `yes / no`.
4. Resume requests start without waiting for general7: `yes / no`.
5. Resume latency impact under coexistence: `...`.
6. Throughput impact on general7: `...`.
7. Memory pressure, swap, KV failures, and errors: `...`.
8. Selected production configuration and supporting measurements: `...`.

**Success means resume tailoring has its own available inference lane, does not wait behind unrelated general7 work, and remains reliable under the actual JobOps workload—not merely that three requests can be submitted at once.**

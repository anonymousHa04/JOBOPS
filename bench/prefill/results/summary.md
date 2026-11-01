# Prefill scaling: qwen2.5-7b Q4_K_M, general7 (3 slots, unified 16k KV, continuous batching)

Medians of 3 runs per cell. Prompts: unique random tokens, cache_prompt false, n_predict 1.

| Prompt | Concurrency | Prompt tokens (total) | Prefill end (s) | Aggregate prefill tok/s | Scaling vs 1 | Per-request prompt time (ms) | TTFT median / max (s) | Peak KV tokens (% of 16k) | Errors / deferred |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 1 | 1000 | 4.60 | 217 | 1.00x | 4480 | 4.60 / 4.60 | 1001 (6%) | 0 / 0 |
| 1000 | 2 | 2000 | 8.87 | 225 | 1.04x | 8866 | 8.87 / 8.87 | 2002 (12%) | 0 / 0 |
| 1000 | 3 | 3000 | 13.25 | 226 | 1.04x | 9002 | 9.01 / 13.25 | 3003 (18%) | 0 / 0 |
| 4000 | 1 | 4000 | 18.58 | 215 | 1.00x | 18567 | 18.58 / 18.58 | 4001 (24%) | 0 / 0 |
| 4000 | 2 | 8000 | 37.25 | 215 | 1.00x | 24713 | 28.13 / 37.25 | 8002 (49%) | 0 / 0 |
| 4000 | 3 | 12000 | 56.11 | 214 | 0.99x | 30139 | 38.20 / 56.11 | 12003 (73%) | 0 / 0 |
| 8000 | 1 | 8000 | 39.96 | 200 | 1.00x | 39866 | 39.96 / 39.96 | 8001 (49%) | 0 / 0 |
| 8000 | 2 | 16000 | 80.11 | 200 | 1.00x | 46909 | 60.45 / 80.11 | 16002 (98%) | 0 / 0 |
| 8000 | 3 | 24000 | 120.32 | 199 | 1.00x | 52242 | 81.76 / 120.32 | 24003 (147%) | 0 / 0 |

Aggregate prefill tok/s = total prompt tokens / time from batch start until the last request's first token (client side, includes one decode step and HTTP).
Per-request prompt time = the server's prompt_ms for each request (median over requests, then runs).
Peak KV tokens = computed, prompt tokens + 1 output token for every request in the run (they overlap); pressure shows in Errors / deferred and in kv_full_log_lines in runs.jsonl.

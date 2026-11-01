# Split setup: JD parsing on the laptop, tailoring on the Mac (2026-11-01)

Laptop: Lenovo, i5-12450HX, RTX 3050 Laptop 6 GB, Windows, llama.cpp b11669 CUDA 12.4 (same build as the Mac),
qwen2.5-7b Q4_K_M (same file, SHA-256 checked), general7 settings (3 slots, -kvu, 16k KV q8_0, flash
attention, all layers on GPU), API key. Link: direct 1 Gbit cable, laptop 10.10.10.1, Mac 10.10.10.2.
Mac: general14 with 3 slots and -kvu, loaded once and kept. Same 6 JDs, 3 resumes, fake bank and 60 s reword
timeout as Experiment 3 (`bench/general14/RESULTS.md`). A resume starts as soon as its own JD is parsed.
Script: `split.ts`; rows: `runs.jsonl`.

| | Single Mac, 1 slot (Exp 3) | Single Mac, 3 slots (Exp 3) | Split, 3 runs |
|---|---:|---:|---|
| Workflow time (median) | 685 s | 452 s | **279 s** (337 / 279 / 273) |
| JD phase | 95 s + 11 s swap | 94 s + 11 s swap | 32–33 s, no swap |
| Resume JD-ready → start (median) | 264 s | 33 s | **0.0 s** |
| Resume JD-ready → done (median) | 430 s | 347 s | **246 s** (294 / 246 / 239) |
| Resumes without error | 3/3 | 2/3 every run | 2/3, 3/3, 3/3 |
| Laptop VRAM | | | **4966 MiB of 6144, flat** (1749 samples at 0.5 s) |

Caveat: the Mac had less background load than during Experiment 3 (other programs were closed during run 1;
swap 4.9 GB vs 7–8 GB). Part of the faster tailoring may come from that, not from the split. The JD phase
(laptop) and the zero wait do not depend on it.

Laptop VRAM: model, 16k KV pool and buffers are allocated at start; usage did not move during parsing.
GPU load peaked at 98% during parsing.

Network: same JD-parse request (6 KB, schema, no prompt cache) sent 3 times from the Mac and from the laptop
to itself. Time outside the server's own prompt+generation time:

| | Call 1 | Call 2 | Call 3 |
|---|---:|---:|---:|
| From the Mac (over the cable) | 1947 ms | 11 ms | 14 ms |
| From the laptop itself | 87 ms | 44 ms | 55 ms |

Steady state, the cable and HTTP add about 10–15 ms per call. The first call after the laptop sat idle took
~2 s longer, likely the GPU or network card waking from power saving. The in-run overhead figures in
`runs.jsonl` (0.3–2.5 s) are not trusted: they come from reading a copy of the streamed response while three
requests share the server; the JD phase took the same 32–35 s inside the run as when parsing alone.

## JD parse quality: Mac vs laptop vs a fresh claude.ai chat

`quality.ts`; tables in `quality/compare.md`. Each machine parsed the 6 JDs twice, one at a time; Claude got
the same prompt plus the schema as text, one new chat per JD. All sources went through the production keyword
filter (keyword must appear in the JD).

- Repeatability: the laptop gave identical keyword sets on both runs for all 6 JDs. The Mac repeated itself on
  4 of 6 (overlap 0.74 and 0.59 on the other two): Metal is not bit-exact at temperature 0 here.
- Mac vs laptop: overlap 0.17–0.65, far below run-to-run. Same model, different arithmetic: once one token
  differs, greedy decoding follows a different path. This is a machine difference, not noise.
- Against Claude: both local models are far from it (overlap 0.15–0.57); the laptop is as close or closer on
  all 6 JDs. The laptop lists more keywords (14–40 vs 9–39), nearer Claude's counts (17–40), and none of its
  keywords failed the filter (the Mac's: 0–3 per JD).
- Must-haves: both local runs find far fewer than Claude (4–12 vs 6–18; 5 vs 18 on one JD). That is the 7B
  model, not the machine.
- Engine outcome on the fake bank: every source gives not_tailored / very_poor for every JD, so the decision
  never changes. Scores: Mac vs laptop within 4.3 points; Claude's parse moves them by up to 18.7 points. The
  fake bank matches none of these JDs, so this check is weak; a real-bank check would settle it.

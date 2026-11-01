// Split setup: JD parsing on the Lenovo laptop (RTX 3050 6 GB, general7 settings, 10.10.10.1:8084 over a direct
// cable), tailoring on the Mac (general14, 3 slots, -kvu, loaded once and kept). Same inputs as
// bench/general14/workflow.ts (6 JDs, 3 resumes, fake bank), so the result compares with Experiment 3.
//
//   node bench/split/split.ts [--reps 3]
//
// A resume starts as soon as its own JD is parsed (no batch barrier, no model swap). Measured per run:
// workflow time, per-resume wait and latency, laptop VRAM every 0.5 s (nvidia-smi over SSH), and per-call
// network overhead = client time minus the server's own prompt+eval time (from the response's timings).
// The laptop needs an API key (~/.ssh/jobops_laptop_llm_key); generate() has no key setting yet, so fetch
// adds the header for the laptop URL only.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rewordContent } from "../../api/src/tailor/reword.ts";
import { generate } from "../../api/src/model/llm.ts";
import { fill, loadPrompt } from "../../api/src/model/prompts.ts";
import { RequirementsSchema } from "../../api/src/requirements/schema.ts";
import { bank as fixtureBank, bullet } from "../../api/test/fixtures.ts";

const HERE = join(process.cwd(), "bench/split");
const RAW = join(HERE, "raw");
mkdirSync(RAW, { recursive: true });
// Safe after the static imports: the log path (registry.ts modelLogPath) is read on each call, not at load.
process.env.JOBOPS_MODEL_LOG = join(RAW, "calls.jsonl");

const LAPTOP = "http://10.10.10.1:8084";
const G14 = "http://127.0.0.1:8085";
const KEY = readFileSync(`${process.env.HOME}/.ssh/jobops_laptop_llm_key`, "utf8").trim();
const net: { client_ms: number; server_ms: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url: any, init: any = {}) => {
  if (!String(url).startsWith(LAPTOP)) return realFetch(url, init);
  const s = performance.now();
  const res = await realFetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${KEY}` } });
  if (!res.body) return res;
  // generate() streams (SSE); the server's timings come in the last chunk. Pass one copy through untouched
  // and read the other for the timings and the time the stream ended.
  const [mine, theirs] = res.body.tee();
  (async () => {
    const text = await new Response(mine).text();
    const client_ms = performance.now() - s;
    const t = text.split("\n").filter((l) => l.includes('"timings"')).map((l) => JSON.parse(l.slice(l.indexOf("{"))).timings).pop();
    if (t) net.push({ client_ms, server_ms: t.prompt_ms + t.predicted_ms });
  })().catch(() => {});
  return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const MODEL14 = `${process.env.HOME}/models/jobops/qwen2.5-14b-instruct-q4_k_m.gguf`;
const TAILOR = ["c0ba0995-59ca-42d2-8944-59ce31ff8941", "f8559c0a-38f4-4add-9bbd-258a9072e3e6", "e8a145b7-45af-49ac-945b-b6296796a289"];
const OTHERS = ["b841ad36-7d73-4218-a2e0-723a7d087afd", "c9ed60f0-c481-4316-b863-3fb9bae2b100", "4c76b210-552f-41ae-9585-de56152bf759"];
const JDS = [TAILOR[0], OTHERS[0], TAILOR[1], OTHERS[1], TAILOR[2], OTHERS[2]];
const reps = Number(process.argv[process.argv.indexOf("--reps") + 1] || 3) || 3;

// Same fake bank and inputs as workflow.ts.
const bank = structuredClone(fixtureBank);
bank.roles[0].bullets = [
  bullet("b1", "Moved 20 services from VMs to Kubernetes and cut deploy time from 40 to 8 minutes", ["kubernetes", "ci/cd", "backend"]),
  bullet("b2", "Built the internal deploy tool in Go used by 6 teams for daily releases", ["go", "tooling", "platform"]),
  bullet("b3", "Set up Prometheus alerts and on-call runbooks for the payments API", ["monitoring", "on-call", "reliability"]),
];
bank.roles[1].bullets = [
  bullet("b4", "Wrote the billing service in TypeScript and Node.js with PostgreSQL", ["typescript", "node.js", "postgresql"]),
  bullet("b5", "Built React screens for the admin console and its REST API", ["react", "rest", "frontend"]),
  bullet("b6", "Wrote Terraform modules for the staging and production AWS accounts", ["terraform", "aws", "infrastructure"]),
];
const extra = { skills: [], dismissed: [], learnable: [] };
const budget = { bullets_per_role: 3, bullets_total: 6, max_words: 25 };
const db = new Database("data/jobops.db", { readonly: true });
const reqOf = (id: string) => JSON.parse((db.prepare("SELECT data FROM job_requirements WHERE job_id = ?").get(id) as { data: string }).data);
const contentFor = (req: { keywords: string[] }) => ({
  summary_variant: "backend", summary_text: "Backend engineer.", skills: [],
  bullets: bank.roles.flatMap((r: any) => r.bullets.map((b: any) => ({ id: b.id, entry_id: r.id, text: b.text }))).map((b: any, i: number) => ({
    ...b, reword: { alias_only: false, keywords: req.keywords.slice(2 * i, 2 * i + 2) } })),
});
const { template } = loadPrompt("parse-job-descripton");
const jdPrompt = (id: string) => {
  const j = db.prepare("SELECT title, description FROM jobs WHERE id = ?").get(id) as { title: string; description: string };
  return fill(template, { "paste JD": `${j.title}\n\n${j.description}`, "list your variants": "general" });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// general14 once for all runs: in this setup it stays loaded.
const log14 = join(RAW, "g14.log");
writeFileSync(log14, "");
const t14 = Date.now();
const p14 = spawn("llama-server", ["-m", MODEL14, "--alias", "qwen2.5-14b", "--host", "127.0.0.1", "--port", "8085", "-ngl", "99", "-c", "16384",
  "-np", "3", "-kvu", "--cache-reuse", "256", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--metrics"], { stdio: ["ignore", "ignore", "pipe"] });
p14.stderr.on("data", (d) => appendFileSync(log14, d));
for (let i = 0; ; i++) { try { if ((await realFetch(`${G14}/health`)).ok) break; } catch {} if (i > 360) throw new Error("general14 did not start"); await sleep(500); }
console.log(`general14 loaded in ${((Date.now() - t14) / 1000).toFixed(0)} s (once; not part of a run)`);

async function runOnce(rep: number) {
  const vramFile = join(RAW, `vram-r${rep}.csv`);
  writeFileSync(vramFile, "");
  const vram = spawn("ssh", ["jobops-laptop", "nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits -lms 500"]);
  vram.stdout.on("data", (d) => appendFileSync(vramFile, d));
  const netFrom = net.length;
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / 1000;
  const parses: any[] = [];
  const tailors: any[] = [];
  const pending: Promise<void>[] = [];

  let next = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (next < JDS.length) {
      const id = JDS[next++];
      const start = at();
      const r = await generate({ task: "jd_parse", prompt: jdPrompt(id), schema: RequirementsSchema, baseUrl: `${LAPTOP}/v1` });
      const ready = at();
      parses.push({ id, start_s: start, end_s: ready, ok: r.ok, error: r.ok ? null : r.error });
      if (TAILOR.includes(id)) pending.push((async () => {
        const req = reqOf(id); // stored requirements, so rewording input matches Experiment 3 exactly
        const s = at();
        const t = await rewordContent(contentFor(req) as any, req, bank, extra, budget, { baseUrl: `${G14}/v1` });
        tailors.push({ id, ready_s: ready, start_s: s, end_s: at(), wait_s: s - ready, latency_s: at() - ready, error: t.error,
          outcomes: t.log.map((l: any) => l.outcome) });
      })());
    }
  }));
  const jd_done = at();
  await Promise.all(pending);
  const done = at();
  vram.kill();

  const v = readFileSync(vramFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(",").map((x) => Number(x.trim())));
  const n = net.slice(netFrom).map((c) => c.client_ms - c.server_ms);
  const row = {
    rep, workflow_s: done, jd_phase_s: jd_done, jds_ok: parses.filter((x) => x.ok).length, resumes_ok: tailors.filter((x) => !x.error).length,
    wait_median_s: med(tailors.map((x) => x.wait_s)), wait_max_s: Math.max(...tailors.map((x) => x.wait_s)),
    latency_median_s: med(tailors.map((x) => x.latency_s)), latency_max_s: Math.max(...tailors.map((x) => x.latency_s)),
    vram_peak_mib: Math.max(...v.map((x) => x[0])), vram_samples: v.length, gpu_util_peak: Math.max(...v.map((x) => x[1])),
    net_overhead_ms_median: med(n), net_overhead_ms_max: Math.max(...n), laptop_calls: n.length,
    oom_errors_g14: (readFileSync(log14, "utf8").match(/OutOfMemory|Compute error/g) ?? []).length,
    parses, tailors, at: new Date().toISOString(),
  };
  appendFileSync(join(HERE, "runs.jsonl"), JSON.stringify(row) + "\n");
  console.log(`rep ${rep}: workflow ${done.toFixed(0)}s (JDs ${jd_done.toFixed(0)}s), ready->start ${row.wait_median_s.toFixed(1)}/${row.wait_max_s.toFixed(1)}s, ` +
    `latency ${row.latency_median_s.toFixed(0)}/${row.latency_max_s.toFixed(0)}s, JDs ok ${row.jds_ok}/6, resumes ok ${row.resumes_ok}/3, ` +
    `VRAM peak ${row.vram_peak_mib} MiB (${row.vram_samples} samples), net overhead ${row.net_overhead_ms_median?.toFixed(1)}/${row.net_overhead_ms_max?.toFixed(1)} ms over ${row.laptop_calls} calls`);
}

for (let rep = 1; rep <= reps; rep++) await runOnce(rep);
p14.kill("SIGTERM");

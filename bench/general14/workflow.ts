// Experiment 3 of general14_concurrency_and_isolation_experiments.md, adapted: general7 and general14
// cannot both be loaded (Metal out of memory, see raw/feasibility.log), so the workflow is the one that
// fits 16 GB: load general7, parse 6 real JDs 3 at a time, swap to general14, tailor 3 resumes.
// Compared: general14 with 1 slot (today) vs 3 slots (-kvu, best in Experiment 1), 3 repetitions each,
// order alternated. There is no queue yet (Milestone 5 builds it); this script stands in for it.
//
//   node bench/general14/workflow.ts [--reps 3]
//
// JD parse: the production jd_parse prompt and schema through generate(); nothing is written to the
// database. Rewording: the same 3 resume requests as bench.ts (fake bank, stored requirements of 3 of
// the 6 JDs), so the rewording input is identical in every run. Model calls go to raw/workflow-calls.jsonl.
import { spawn, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rewordContent } from "../../api/src/tailor/reword.ts";
import { generate } from "../../api/src/model/llm.ts";
import { fill, loadPrompt } from "../../api/src/model/prompts.ts";
import { RequirementsSchema } from "../../api/src/requirements/schema.ts";
import { bank as fixtureBank, bullet } from "../../api/test/fixtures.ts";

const HERE = join(process.cwd(), "bench/general14");
const RAW = join(HERE, "raw");
mkdirSync(RAW, { recursive: true });
// Safe after the static imports: the log path (registry.ts modelLogPath) is read on each call, not at load.
process.env.JOBOPS_MODEL_LOG = join(RAW, "workflow-calls.jsonl");

const G7 = "http://127.0.0.1:8084";
const G14 = "http://127.0.0.1:8085";
const MODEL14 = `${process.env.HOME}/models/jobops/qwen2.5-14b-instruct-q4_k_m.gguf`;
const TAILOR = ["c0ba0995-59ca-42d2-8944-59ce31ff8941", "f8559c0a-38f4-4add-9bbd-258a9072e3e6", "e8a145b7-45af-49ac-945b-b6296796a289"];
const OTHERS = ["b841ad36-7d73-4218-a2e0-723a7d087afd", "c9ed60f0-c481-4316-b863-3fb9bae2b100", "4c76b210-552f-41ae-9585-de56152bf759"];
const JDS = [TAILOR[0], OTHERS[0], TAILOR[1], OTHERS[1], TAILOR[2], OTHERS[2]];
const reps = Number(process.argv[process.argv.indexOf("--reps") + 1] || 3) || 3;

// Same fake bank and inputs as bench.ts.
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
const swapMb = () => Number(/used = ([\d.]+)M/.exec(execSync("sysctl -n vm.swapusage").toString())?.[1] ?? 0);
async function waitUp(url: string) {
  for (let i = 0; i < 180; i++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch {} await sleep(500); }
  throw new Error(`${url} did not start`);
}

async function runOnce(slots: number, rep: number) {
  const log14 = join(RAW, `wf-g14-s${slots}-r${rep}.log`);
  writeFileSync(log14, "");
  const memFile = join(RAW, `wf-mem-s${slots}-r${rep}.txt`);
  writeFileSync(memFile, "");
  const samp = spawn("sh", ["-c", `while :; do echo "$(date +%s) $(sysctl -n kern.memorystatus_vm_pressure_level) $(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\\1/')" >> ${memFile}; sleep 1; done`]);
  const swap0 = swapMb();
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / 1000;

  // 1. general7 (llm.sh, production flags), 6 JD parses, 3 at a time.
  execSync("sh .claude/bin/llm.sh start general7", { stdio: "ignore" });
  await waitUp(G7);
  const g7_loaded = at();
  const parses: any[] = [];
  let next = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (next < JDS.length) {
      const id = JDS[next++];
      const start = at();
      const r = await generate({ task: "jd_parse", prompt: jdPrompt(id), schema: RequirementsSchema, baseUrl: `${G7}/v1` });
      parses.push({ id, start_s: start, end_s: at(), ok: r.ok, error: r.ok ? null : r.error });
    }
  }));
  const ready = Object.fromEntries(TAILOR.map((id) => [id, parses.find((p) => p.id === id)!.end_s]));
  const g7_done = at();

  // 2. Swap: stop general7, start general14 with the slot count under test.
  execSync("sh .claude/bin/llm.sh stop general7", { stdio: "ignore" });
  const args = ["-m", MODEL14, "--alias", "qwen2.5-14b", "--host", "127.0.0.1", "--port", "8085", "-ngl", "99", "-c", "16384",
    "-np", String(slots), ...(slots > 1 ? ["-kvu"] : []), "--cache-reuse", "256", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--metrics"];
  const p = spawn("llama-server", args, { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (d) => appendFileSync(log14, d));
  await waitUp(G14);
  const g14_loaded = at();

  // 3. Three resume requests, `slots` at a time.
  const tailors: any[] = [];
  let k = 0;
  await Promise.all(Array.from({ length: slots }, async () => {
    while (k < TAILOR.length) {
      const id = TAILOR[k++];
      const start = at();
      const req = reqOf(id);
      const r = await rewordContent(contentFor(req) as any, req, bank, extra, budget, { baseUrl: `${G14}/v1` });
      tailors.push({ id, ready_s: ready[id], start_s: start, end_s: at(), wait_s: start - ready[id], latency_s: at() - ready[id],
        error: r.error, outcomes: r.log.map((l: any) => l.outcome) });
    }
  }));
  const done = at();
  p.kill("SIGTERM");
  for (let i = 0; i < 30 && p.exitCode === null; i++) await sleep(500);
  samp.kill();

  const mem = readFileSync(memFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number));
  const log = readFileSync(log14, "utf8");
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const row = {
    slots, rep, workflow_s: done, g7_load_s: g7_loaded, jd_phase_s: g7_done - g7_loaded, swap_s: g14_loaded - g7_done,
    resume_phase_s: done - g14_loaded, jds_ok: parses.filter((x) => x.ok).length, resumes_ok: tailors.filter((x) => !x.error).length,
    wait_median_s: med(tailors.map((x) => x.wait_s)), wait_max_s: Math.max(...tailors.map((x) => x.wait_s)),
    latency_median_s: med(tailors.map((x) => x.latency_s)), latency_max_s: Math.max(...tailors.map((x) => x.latency_s)),
    peak_pressure: Math.max(0, ...mem.map((m) => m[1])), swap_change_mb: Math.max(swap0, ...mem.map((m) => m[2])) - swap0,
    oom_errors: (log.match(/OutOfMemory|Compute error/g) ?? []).length, parses, tailors, at: new Date().toISOString(),
  };
  appendFileSync(join(HERE, "workflow-runs.jsonl"), JSON.stringify(row) + "\n");
  console.log(`rep ${rep} slots ${slots}: workflow ${done.toFixed(0)}s (g7 load ${g7_loaded.toFixed(0)}, JDs ${row.jd_phase_s.toFixed(0)}, ` +
    `swap ${row.swap_s.toFixed(0)}, resumes ${row.resume_phase_s.toFixed(0)}), ready->start wait ${row.wait_median_s.toFixed(0)}/${row.wait_max_s.toFixed(0)}s, ` +
    `latency ${row.latency_median_s.toFixed(0)}/${row.latency_max_s.toFixed(0)}s, JDs ok ${row.jds_ok}/6, resumes ok ${row.resumes_ok}/3, ` +
    `pressure ${row.peak_pressure}, swap +${row.swap_change_mb.toFixed(0)}MB, oom ${row.oom_errors}`);
}

for (let rep = 1; rep <= reps; rep++) {
  for (const slots of rep % 2 ? [1, 3] : [3, 1]) await runOnce(slots, rep);
}

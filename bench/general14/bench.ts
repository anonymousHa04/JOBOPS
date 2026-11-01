// general14 concurrency (Experiment 1 of general14_concurrency_and_isolation_experiments.md):
// qwen2.5-14b Q4_K_M alone, 1 / 2 / 3 resume requests at once, 3 repetitions in rotated order.
//
//   node bench/general14/bench.ts [--reps 3]
//
// One resume request = the production reword phase (rewordContent: select-and-tailor template,
// generate() with the JSON schema, the guard and its retries) for 6 bullets of a FAKE bank against
// a real stored JD's requirements (job_requirements). The real bank in profile/ is never read.
// The server is started per configuration with llm.sh's general14 flags; for 2 and 3 slots -kvu
// keeps the same 16k pool. Concurrency 2 runs R1+R2 and starts R3 when either finishes.
// Per call: the server log's prompt/eval timings. Memory: pressure and swap sampled every second
// by a separate shell loop. Model calls go to raw/calls.jsonl (JOBOPS_MODEL_LOG), not data/.
import { spawn, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rewordContent } from "../../api/src/tailor/reword.ts";
import { bank as fixtureBank, bullet } from "../../api/test/fixtures.ts";

const HERE = join(process.cwd(), "bench/general14");
const RAW = join(HERE, "raw");
mkdirSync(RAW, { recursive: true });
// Safe after the static imports: the log path (registry.ts modelLogPath) is read on each call, not at load.
process.env.JOBOPS_MODEL_LOG = join(RAW, "calls.jsonl");

const PORT = 8085;
const URL = `http://127.0.0.1:${PORT}`;
const MODEL = `${process.env.HOME}/models/jobops/qwen2.5-14b-instruct-q4_k_m.gguf`;
const JOBS = ["c0ba0995-59ca-42d2-8944-59ce31ff8941", "f8559c0a-38f4-4add-9bbd-258a9072e3e6", "e8a145b7-45af-49ac-945b-b6296796a289"];
const reps = Number(process.argv[process.argv.indexOf("--reps") + 1] || 3) || 3;

// Fake bank: invented bullets, nothing from profile/.
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
const reqs = JOBS.map((id) => JSON.parse((db.prepare("SELECT data FROM job_requirements WHERE job_id = ?").get(id) as { data: string }).data));
const contentFor = (req: { keywords: string[] }) => ({
  summary_variant: "backend", summary_text: "Backend engineer.", skills: [],
  bullets: bank.roles.flatMap((r: any) => r.bullets.map((b: any) => ({ id: b.id, entry_id: r.id, text: b.text, reword: null as any }))).map((b: any, i: number) => ({
    ...b, reword: { alias_only: false, keywords: req.keywords.slice(2 * i, 2 * i + 2) } })),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const swapMb = () => Number(/used = ([\d.]+)M/.exec(execSync("sysctl -n vm.swapusage").toString())?.[1] ?? 0);

async function startServer(slots: number, log: string) {
  const args = ["-m", MODEL, "--alias", "qwen2.5-14b", "--host", "127.0.0.1", "--port", String(PORT), "-ngl", "99",
    "-c", "16384", "-np", String(slots), ...(slots > 1 ? ["-kvu"] : []), "--cache-reuse", "256", "-fa", "on",
    "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--metrics"];
  const p = spawn("llama-server", args, { stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (d) => appendFileSync(log, d));
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${URL}/health`)).ok) return { p, load_s: (Date.now() - t0) / 1000 }; } catch {}
    await sleep(1000);
  }
  p.kill();
  throw new Error("server did not start");
}

async function stopServer(p: ReturnType<typeof spawn>) {
  p.kill("SIGTERM");
  for (let i = 0; i < 30 && p.exitCode === null; i++) await sleep(500);
}

function sampler(file: string) {
  writeFileSync(file, "");
  return spawn("sh", ["-c", `while :; do echo "$(date +%s) $(sysctl -n kern.memorystatus_vm_pressure_level) $(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\\1/')" >> ${file}; sleep 1; done`]);
}

// print_timing lines written during this run: per call prompt tokens/ms and eval tokens/ms.
function serverTimings(log: string, from: number) {
  const text = readFileSync(log, "utf8").slice(from);
  const calls: { prompt_n: number; prompt_ms: number; eval_n: number; eval_ms: number }[] = [];
  const re = /prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens[\s\S]*?\n.*?eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/g;
  for (let m; (m = re.exec(text)); ) calls.push({ prompt_ms: +m[1], prompt_n: +m[2], eval_ms: +m[3], eval_n: +m[4] });
  return { calls, oom: (text.match(/OutOfMemory|Compute error/g) ?? []).length, kv_fail: (text.match(/failed to find (a )?free space|failed to find a memory slot/g) ?? []).length };
}

async function resumeRequest(i: number, t0: number) {
  const start = (Date.now() - t0) / 1000;
  const r = await rewordContent(contentFor(reqs[i]) as any, reqs[i], bank, extra, budget, { baseUrl: `${URL}/v1` });
  return { r: `R${i + 1}`, start_s: start, end_s: (Date.now() - t0) / 1000, error: r.error,
    outcomes: r.log.map((l: any) => l.outcome), texts: r.content.bullets.map((b: any) => b.text) };
}

async function runBatch(conc: number) {
  const t0 = Date.now();
  const out: any[] = [];
  let next = 0;
  const lane = async () => { while (next < 3) { const i = next++; out[i] = await resumeRequest(i, t0); } };
  await Promise.all(Array.from({ length: conc }, lane));
  return { wall_s: (Date.now() - t0) / 1000, requests: out };
}

const order = [[1, 2, 3], [2, 3, 1], [3, 1, 2]];
const rows: any[] = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const conc of order[(rep - 1) % 3]) {
    const log = join(RAW, `server-c${conc}-r${rep}.log`);
    writeFileSync(log, "");
    const swap0 = swapMb();
    const { p, load_s } = await startServer(conc, log);
    await rewordContent(contentFor(reqs[0]) as any, reqs[0], bank, extra, { ...budget, bullets_total: 1 }, { baseUrl: `${URL}/v1` }); // warm-up
    const off = statSync(log).size;
    const samp = join(RAW, `mem-c${conc}-r${rep}.txt`);
    const s = sampler(samp);
    const callsBefore = existsSync(process.env.JOBOPS_MODEL_LOG!) ? readFileSync(process.env.JOBOPS_MODEL_LOG!, "utf8").split("\n").length : 0;
    const batch = await runBatch(conc);
    s.kill();
    const t = serverTimings(log, off);
    const mem = readFileSync(samp, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number));
    const calls = readFileSync(process.env.JOBOPS_MODEL_LOG!, "utf8").trim().split("\n").slice(Math.max(0, callsBefore - 1)).filter(Boolean).map((l) => JSON.parse(l));
    await stopServer(p);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const row = {
      conc, rep, load_s, wall_s: batch.wall_s, requests: batch.requests.map(({ texts, ...r }: any) => r),
      texts: batch.requests.map((r: any) => r.texts),
      server_calls: t.calls.length, prompt_tokens: sum(t.calls.map((c) => c.prompt_n)), output_tokens: sum(t.calls.map((c) => c.eval_n)),
      prompt_tps_per_call: sum(t.calls.map((c) => c.prompt_n)) / (sum(t.calls.map((c) => c.prompt_ms)) / 1000),
      gen_tps_per_call: sum(t.calls.map((c) => c.eval_n)) / (sum(t.calls.map((c) => c.eval_ms)) / 1000),
      aggregate_output_tps: sum(t.calls.map((c) => c.eval_n)) / batch.wall_s,
      calls_failed: calls.filter((c: any) => c.outcome !== "ok").length, calls_logged: calls.length,
      peak_pressure: Math.max(0, ...mem.map((m) => m[1])), swap_start_mb: swap0, swap_peak_mb: Math.max(swap0, ...mem.map((m) => m[2])),
      oom_errors: t.oom, kv_failures: t.kv_fail, at: new Date().toISOString(),
    };
    rows.push(row);
    appendFileSync(join(HERE, "runs.jsonl"), JSON.stringify(row) + "\n");
    console.log(`rep ${rep} conc ${conc}: wall ${row.wall_s.toFixed(0)}s, R end ${row.requests.map((r: any) => r.end_s.toFixed(0)).join("/")}s, ` +
      `out ${row.output_tokens} tok, agg ${row.aggregate_output_tps.toFixed(1)} tok/s, gen/call ${row.gen_tps_per_call.toFixed(1)}, ` +
      `prompt/call ${row.prompt_tps_per_call.toFixed(0)}, swap +${(row.swap_peak_mb - swap0).toFixed(0)}MB, pressure ${row.peak_pressure}, ` +
      `failed calls ${row.calls_failed}, oom ${row.oom_errors}, kv ${row.kv_failures}`);
  }
}

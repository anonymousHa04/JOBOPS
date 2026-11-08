// Queue worker: lease a task, run the existing pipeline step for its job (as jobAdd does), report
// the outcome. Results hold ids, counts, scores and codes only. `worker laptop` serves parse and
// score (general7 on the laptop), `worker mac` serves tailor (general14).
import { db, render, score, tailor, tailorAll } from "../tools.ts";
import { parseJob } from "../requirements/parse.ts";
import { modelUp, switchCommands } from "../model/registry.ts";
import type { Task } from "../model/registry.ts";
import { done, fail, lease, ping, queueUp, queueUrl, QueueDownError } from "./client.ts";
import { followSse, QUEUE_EVENTS } from "../events/sse.ts";
import type { Db } from "../db.ts";
import { markerValue, setMarker, takeMarker } from "../db.ts";
import { gapHelp } from "../ui/gap-model.ts";
import { gapKey } from "../ui/gap-related.ts";
import type { VectorSearch } from "../ui/gap-related.ts";
import { gapList } from "../ui/gaps.ts";

// score first: it moves jobs forward. On the Mac, gap help first: someone is waiting for it.
export const GROUPS: Record<string, string[]> = {
  laptop: ["score", "parse"], mac: ["gap_help", "tailor"], parse: ["parse"], score: ["score"], tailor: ["tailor"],
  gap_help: ["gap_help"]
};
const MODEL: Record<string, Task> = { parse: "jd_parse", score: "judge", tailor: "reword", gap_help: "gap_help" };

// version: the task's prompt_version (a gap_help task's is gap-<key>-<batch>). d and gapOpts
// are for tests (a test database, a fake vector search).
export async function runStage(stage: string, jobId: string, version = "", d: Db = db(),
  gapOpts: { search?: VectorSearch } = {}): Promise<Record<string, unknown>> {
  if (stage === "gap_help") {
    // Which gap: the one whose key is in the version. Gone (answered, or no longer red after a
    // re-score): nothing to explain.
    const key = version.split("-")[1] ?? "";
    const gap = gapList(d, jobId).gaps.find((g) => gapKey(g.requirement) === key);
    if (!gap) return { explained: false };
    const help = await gapHelp(d, jobId, gap.kind, gap.requirement, { refresh: true, search: gapOpts.search });
    return { explained: true, related: help.related.length };
  }
  if (stage === "parse") {
    const s = await parseJob(d, jobId);
    return { keywords: s.keywords, must_have: s.must_have, cached: s.cached, reused_from: s.reused_from ?? null };
  }
  if (stage === "score") {
    const r = await score(d, jobId, true);
    const plan = tailorAll(d, { jobId }).rows[0];
    return { score: r.score, band: r.band, decision: plan?.decision ?? null };
  }
  if (stage === "tailor") {
    // Re-tailor from scratch (UI): the queue task has no options, so the route leaves a marker.
    // Its value is the batch id (retailor-<batch>), or "pending" while the route queues it: a
    // marker for another batch is left alone, so a stale one never changes an unrelated run.
    const marker = `fresh_tailor:${jobId}`;
    const value = markerValue(d, marker);
    const fresh = value !== null && (value === "pending" || version.endsWith(`-${value}`));
    if (fresh) takeMarker(d, marker);
    let t;
    try {
      t = await tailor(d, jobId, { fresh });
    } catch (err) {
      if (fresh) setMarker(d, marker, value!); // a retry of this task is still from scratch
      throw err;
    }
    if (!("created" in t)) throw new Error("tailor returned a dry run");
    const pdf = t.resume_id && t.decision !== "not_tailored" ? await render(d, t.resume_id) : null;
    // Why a PDF failed: the typst error, or the parse-back issue codes (no resume text).
    const why = pdf && !pdf.ok ? (pdf.error ?? [...new Set(pdf.issues.map((i) => i.code !== "bank_gate" ? `${i.code} (${i.extractor})`
      : i.detail.startsWith("role_dropped: ") ? `role ${i.detail.slice(14)} has no bullet on the resume (bank_gate: role_dropped)` : `bank_gate: ${i.detail}`))].join(", ")) : null;
    // reason: why the tailor decided as it did (a not_tailored or blocked run makes no resume,
    // and the drawer shows this). No score here: the job's score is the score task's.
    return { decision: t.decision, reason: t.reason, resume_id: t.resume_id ?? null, created: t.created,
      pdf_ok: pdf ? pdf.ok : null, ...(why ? { pdf_issue: why } : {}), ...(t.left_out.length ? { left_out: t.left_out } : {}) };
  }
  throw new Error(`unknown stage ${stage}`);
}

export function failureCode(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/model timeout/.test(m)) return "timeout";
  if (/model unavailable|is not running|refused the API key/.test(m)) return "unavailable";
  if (/model invalid_output/.test(m)) return "invalid_output";
  return "job_error";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Idle workers wait on the queue's change feed (GET /events) instead of asking for work every
// few seconds: a task queued, or a slot freed (a task done or failed), wakes them. The timer is
// only a fallback, for a retry whose backoff ends with no event, or a feed that is down.
const waiters = new Set<() => void>();
let feedStarted = false;
function startFeed(signal: AbortSignal) {
  if (feedStarted) return;
  feedStarted = true;
  followSse(`${queueUrl()}/events`, QUEUE_EVENTS, (name, data) => {
    if (name !== "ready" && data.state === "leased") return; // takes work, frees nothing
    for (const wake of [...waiters]) wake();
  }, { signal });
}
function waitForWork(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => { clearTimeout(t); waiters.delete(wake); resolve(); };
    const t = setTimeout(wake, ms);
    waiters.add(wake);
  });
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function runWorker(group: string, opts: { concurrency?: number } = {}) {
  const stages = GROUPS[group];
  if (!stages) throw new Error(`unknown worker group "${group}": use ${Object.keys(GROUPS).join(", ")}`);
  const n = Math.min(Math.max(Math.trunc(opts.concurrency ?? 3), 1), 3);
  if (!(await queueUp())) throw new QueueDownError();

  let stopping = false;
  const feed = new AbortController();
  startFeed(feed.signal);
  // SIGINT: Ctrl-C; SIGTERM: Kubernetes stopping the pod (it waits, then kills).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      stopping = true;
      console.error("stopping after the current tasks");
      for (const wake of [...waiters]) wake(); // idle loops see stopping now, not after 30 s
    });
  }
  const warned = new Map<string, number>();

  const loop = async (i: number) => {
    const worker = `${group}-${i}-${process.pid}`;
    while (!stopping) {
      try {
        // Only lease stages whose model answers; say once a minute what to start.
        const ready: string[] = [];
        for (const stage of stages) {
          const m = await modelUp(MODEL[stage]);
          if (m.up) ready.push(stage);
          else if (Date.now() - (warned.get(stage) ?? 0) > 60_000) {
            warned.set(stage, Date.now());
            console.error(`${stage}: ${m.spec.model} is down; ${switchCommands(m.spec).join(" && ")}`);
          }
        }
        if (!ready.length) {
          await ping(worker); // still alive, waiting for a model (the health bar shows it)
          await wait(15_000);
          continue;
        }
        const task = await lease(ready, worker);
        if (!task) {
          await waitForWork(30_000);
          continue;
        }
        const id = task.job_id.slice(0, 8);
        try {
          const result = await runStage(task.stage, task.job_id, task.prompt_version);
          await done(task.id, result);
          console.log(`${task.stage} ${id} done ${result.score ?? result.decision ?? ""}`);
        } catch (err) {
          if (err instanceof QueueDownError) throw err;
          const code = failureCode(err);
          await fail(task.id, code, message(err));
          console.log(`${task.stage} ${id} failed ${code}`);
        }
      } catch (err) {
        if (!(err instanceof QueueDownError)) throw err;
        console.error(err.message);
        await wait(15_000);
      }
    }
  };
  await Promise.all(Array.from({ length: n }, (_, i) => loop(i + 1)));
  feed.abort();
  return { stopped: true };
}

// Routes for the JobOps browser extension, under /x/. They answer only requests from a
// Chrome extension (Origin chrome-extension://..., or the one id in JOBOPS_EXTENSION_ID),
// so a web page cannot use the local API through the browser. The API listens on
// 127.0.0.1 only. Responses carry job and report metadata, never resume text.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.ts";
import { chatFollowUp, chatPrompt, followUpPrompt, listReports, loadReport, saveReport, SOURCES } from "./reports.ts";
import { fixRound } from "./loop.ts";
import { latestRecord } from "./reports.ts";
import { engineScore, loadLoop, makeCurrent, saveLoop, setChatScore, startLoop, summary } from "./rounds.ts";

export function extensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const pinned = process.env.JOBOPS_EXTENSION_ID;
  return pinned ? origin === `chrome-extension://${pinned}` : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

// Chrome sends no Origin when an extension with host permission for the API calls it,
// only Sec-Fetch-Site: none. Web pages cannot set Sec-Fetch-* headers, and their
// cross-site requests always carry an Origin and "cross-site", so this still shuts out
// web pages. (JOBOPS_EXTENSION_ID can only be checked when an Origin is sent.)
export function fromExtension(headers: { origin?: string; "sec-fetch-site"?: string | string[] }): boolean {
  if (headers.origin) return extensionOrigin(headers.origin);
  return headers["sec-fetch-site"] === "none";
}

const SaveBody = z.object({
  source: z.enum(SOURCES),
  text: z.string().min(1).max(100_000),
  round: z.number().int().min(1).max(5).optional()
});
const FixBody = z.object({ round: z.number().int().min(1).max(5), source: z.enum(SOURCES) });

export function extensionRoutes(app: FastifyInstance, db: Db): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/x/")) return;
    const origin = request.headers.origin;
    if (!fromExtension(request.headers)) {
      reply.status(403).send({ error: "forbidden", detail: "the /x/ routes answer the JobOps extension only" });
      return reply;
    }
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET, POST");
      reply.header("access-control-allow-headers", "content-type");
      reply.status(204).send();
      return reply;
    }
  });
  app.options("/x/*", async () => undefined);

  const fail = (reply: FastifyReply, err: unknown) =>
    reply.status(400).send({ error: "failed", detail: err instanceof Error ? err.message : String(err) });

  // Parsed jobs for the popup, best saved score first. Plain SQL over saved tailoring
  // records: re-scoring every job here (tailorAll) took ~33 s and blocked the server.
  // Jobs never tailored come last, with no score.
  const jobsQuery = db.prepare(
    `SELECT j.id AS job_id, j.company, j.title, r.score, r.band, r.decision
       FROM jobs j
       LEFT JOIN resume_records r ON r.resume_id =
         (SELECT resume_id FROM resume_records WHERE jd_id = j.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM job_requirements q WHERE q.job_id = j.id)
      ORDER BY r.score IS NULL, r.score DESC, j.last_seen_at DESC
      LIMIT 40`
  );
  app.get("/x/jobs", async (_request, reply) => {
    try {
      const reports = listReports();
      const rows = (jobsQuery.all() as { job_id: string }[]).map((r) => ({
        ...r,
        reports: reports.filter((x) => x.job_id === r.job_id).map((x) => x.source)
      }));
      return reply.send({ jobs: rows });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ?followup=1&source=claude|chatgpt: the job already has a chat, so send the follow-up
  // ("Attempt N: based on your input I made changes") instead of the first prompt.
  app.get<{ Params: { jobId: string }; Querystring: { followup?: string; source?: string } }>("/x/prompt/:jobId", async (request, reply) => {
    try {
      const { followup, source } = request.query;
      if (followup === "1" && (SOURCES as readonly string[]).includes(source ?? "")) {
        const next = chatFollowUp(db, request.params.jobId, source as (typeof SOURCES)[number]);
        if (next) return reply.send({ job_id: request.params.jobId, followup: true, ...next });
      }
      return reply.send(chatPrompt(db, request.params.jobId));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { jobId: string }; Body: unknown }>("/x/reports/:jobId", async (request, reply) => {
    const body = SaveBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "validation_error", issues: body.error.issues.map((i) => i.path.join(".")) });
    try {
      const r = await saveReport(db, request.params.jobId, body.data.source, body.data.text, { round: body.data.round });
      return reply.status(r.ok ? 201 : 422).send(r);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { jobId: string } }>("/x/reports/:jobId", async (request, reply) => reply.send({ reports: listReports(request.params.jobId) }));

  // Report loop: fix locally from the saved report of this round and re-score the new resume.
  // The engine score decides: the loop goes on only while it rises (at most 5 rounds), and the
  // best version stays the job's current resume. The chat's fit_score is recorded beside it.
  app.post<{ Params: { jobId: string }; Body: unknown }>("/x/fix/:jobId", async (request, reply) => {
    const body = FixBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "validation_error", issues: body.error.issues.map((i) => i.path.join(".")) });
    try {
      const { round, source } = body.data;
      const report = loadReport(request.params.jobId, source);
      if (!report) return reply.status(404).send({ error: "not_found", detail: `no saved ${source} report for this job` });
      const jobId = request.params.jobId;
      const saved = loadLoop(jobId, source);
      if (round === 5 && !saved) return reply.send({ fix: null, prompt: null });
      const loop = round === 1 || !saved ? startLoop(db, jobId, source) : saved;
      const shown = latestRecord(db, jobId);
      if (shown) setChatScore(loop, shown.resume_id, report.fit_score);
      const finish = (stopped: "no_gain" | "round_limit" | "error") => {
        loop.stopped = stopped;
        if (loop.best) makeCurrent(db, loop.best.resume_id);
        saveLoop(loop);
      };
      if (round === 5) {
        finish("round_limit");
        return reply.send({ fix: null, prompt: null, loop: summary(loop) });
      }
      const fix = await fixRound(db, jobId, round, report);
      const after = fix.error ? null : latestRecord(db, jobId);
      if (!after) {
        finish("error");
        return reply.send({ fix, prompt: null, loop: summary(loop) });
      }
      const entry = { version: round, resume_id: after.resume_id, engine_score: engineScore(db, jobId, after), chat_score: null, needs_facts: fix.needs_facts };
      loop.versions.push(entry);
      let prompt: string | null = null;
      if (!loop.best || entry.engine_score > loop.best.engine_score) {
        loop.best = { version: entry.version, resume_id: entry.resume_id, engine_score: entry.engine_score };
        saveLoop(loop);
        prompt = followUpPrompt(db, jobId, round + 1, fix, 5);
      } else {
        finish("no_gain");
      }
      return reply.send({ fix, prompt, loop: summary(loop) });
    } catch (err) {
      return fail(reply, err);
    }
  });
}

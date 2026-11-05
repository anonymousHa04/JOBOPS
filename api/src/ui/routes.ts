// Routes for the web UI (ui/, served by Vite on localhost; it calls these under /api).
// Local only: the API listens on 127.0.0.1 and there is no login.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.ts";
import { addPrepTask, APP_STATUSES, board, jobDetail, jobExists, scoreDetail, setApplication, setPrepTask } from "./data.ts";
import { health } from "./health.ts";
import { QueueDownError, rescore, rescoreJobs, tailorNow } from "../queue/client.ts";
import { markRescoredAll, rescoreAllStatus, rescoreCandidates, tailorStatus } from "./tailor-ready.ts";
import { draftBullet, gapHelp } from "./gap-model.ts";
import { answerGap, gapList } from "./gaps.ts";
import { autoCarry, carryAnswers, declineCarried, linkSame, matchSimilar, reuseAnswer, setAutoCarry } from "./gap-memory.ts";
import { analysisPrompt } from "./prompt.ts";
import { bulkDelete, bulkPreview, deleteHints, deleteJob, DeleteRefused, deleteSkipMatches, setKept, skipMatches } from "../jobs/delete.ts";

const AppBody = z.object({ status: z.enum(APP_STATUSES).nullable(), note: z.string().max(2000).nullable().optional() }).strict();
const TaskBody = z.object({ text: z.string().trim().min(1).max(300) }).strict();
const TaskPatch = z.object({ done: z.boolean().optional(), remove: z.boolean().optional() }).strict();
const Kind = z.enum(["must", "theme", "nice", "keyword"]);
const HelpBody = z.object({ kind: Kind, requirement: z.string().min(1).max(500), refresh: z.boolean().optional() }).strict();
const DraftBody = z.object({ kind: Kind, requirement: z.string().min(1).max(500), entry_id: z.string().min(1), story: z.string().trim().min(1).max(3000), proof: z.string().max(1000).optional() }).strict();
const AnswerBody = z.object({
  kind: Kind, requirement: z.string().min(1).max(500), answer: z.enum(["have", "other_name", "learnable", "no"]),
  entry_id: z.string().optional(), text: z.string().trim().max(400).optional(), tags: z.array(z.string().max(60)).max(8).optional(),
  story: z.string().max(3000).optional(), proof: z.string().max(1000).optional(), same_as: z.string().max(120).optional(),
  as_skill: z.boolean().optional(), entry_ids: z.array(z.string().max(120)).max(30).optional(),
  extra_skills: z.array(z.string().max(80)).max(10).optional(),
  with_skill: z.boolean().optional(),
  // The answer reuses an earlier answer to another ask: remember the two asks as the same.
  from_previous: z.object({ from_requirement: z.string().min(1).max(500) }).strict().optional()
}).strict();
const ReuseBody = z.object({
  kind: Kind, requirement: z.string().min(1).max(500), from_job: z.string().max(120).nullable(),
  from_requirement: z.string().min(1).max(500), accept: z.boolean()
}).strict();
const UndoBody = z.object({ requirement: z.string().min(1).max(500) }).strict();
const DeleteBody = z.object({
  reason: z.string().max(500).optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional()
}).strict();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function uiRoutes(app: FastifyInstance, db: Db): void {
  app.get("/ui/board", async () => ({ jobs: board(db) }));

  app.get("/ui/health", async () => ({ services: await health() }));

  app.get<{ Params: { id: string } }>("/ui/jobs/:id", async (request, reply) => {
    const d = jobDetail(db, request.params.id);
    return d ? d : reply.status(404).send({ error: "not_found" });
  });

  app.get<{ Params: { id: string } }>("/ui/jobs/:id/score", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      const s = scoreDetail(db, request.params.id);
      return "error" in s ? reply.status(409).send(s) : s;
    } catch (err) {
      return reply.status(500).send({ error: "score_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/application", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    const body = AppBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return setApplication(db, request.params.id, body.data.status, body.data.note);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/tasks", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    const body = TaskBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return reply.status(201).send(addPrepTask(db, request.params.id, body.data.text));
  });

  app.patch<{ Params: { id: string; taskId: string }; Body: unknown }>("/ui/jobs/:id/tasks/:taskId", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    const body = TaskPatch.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return setPrepTask(db, request.params.id, request.params.taskId, body.data);
  });

  // Gaps tab: what the bank does not show for this job, help from the local model, the user's
  // answers. A new bullet or skill re-scores the job (queue); tailoring follows if the score allows.
  app.get<{ Params: { id: string } }>("/ui/jobs/:id/gaps", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return gapList(db, request.params.id);
    } catch (err) {
      return reply.status(409).send({ error: "no_gaps", message: message(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/gaps/help", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    const body = HelpBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return await gapHelp(db, request.params.id, body.data.kind, body.data.requirement, { refresh: body.data.refresh });
    } catch (err) {
      return reply.status(503).send({ error: "model_failed", message: message(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/gaps/draft", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    const body = DraftBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return await draftBullet(body.data);
    } catch (err) {
      return reply.status(503).send({ error: "model_failed", message: message(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/gaps/answer", async (request, reply) => {
    const id = request.params.id;
    if (!jobExists(db, id)) return reply.status(404).send({ error: "not_found" });
    const body = AnswerBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    let r: ReturnType<typeof answerGap>;
    try {
      const { from_previous, ...answer } = body.data;
      r = answerGap(db, id, answer);
      if (from_previous) linkSame(db, answer.requirement, from_previous.from_requirement);
    } catch (err) {
      return reply.status(400).send({ error: "answer_failed", message: message(err) });
    }
    // rescore_batch: the batch id; 0 when a score or tailor task is already open; -1 when the
    // queue server is down. Any other queue error comes back as rescore_error.
    let queued = 0;
    let rescoreError: string | null = null;
    if (body.data.answer === "have" || body.data.answer === "other_name") {
      try {
        queued = (await rescore(id)).batch_id;
      } catch (err) {
        if (err instanceof QueueDownError) queued = -1;
        else rescoreError = message(err);
      }
    }
    return { ...r, rescore_batch: queued, rescore_error: rescoreError };
  });

  // Earlier answers (gap-memory.ts). carry: copies every exact earlier answer to this job's
  // open gaps (the UI calls it when the Gaps tab opens). match: the judge model checks the
  // similar asks not checked yet. reuse: the user accepts or rejects one proposed answer.
  // undo: declines a carried answer for this job.
  const rescoreAfter = async (id: string, needed: boolean) => {
    if (!needed) return { rescore_batch: 0, rescore_error: null as string | null, rescore_skipped: true };
    try {
      return { rescore_batch: (await rescore(id)).batch_id, rescore_error: null, rescore_skipped: false };
    } catch (err) {
      if (err instanceof QueueDownError) return { rescore_batch: -1, rescore_error: null, rescore_skipped: false };
      return { rescore_batch: 0, rescore_error: message(err), rescore_skipped: false };
    }
  };

  // Whether exact earlier answers are filled in automatically (default) or only proposed.
  app.get("/ui/gaps/settings", async () => ({ auto_carry: autoCarry(db) }));
  app.post<{ Body: unknown }>("/ui/gaps/settings", async (request, reply) => {
    const body = z.object({ auto_carry: z.boolean() }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    setAutoCarry(db, body.data.auto_carry);
    return { auto_carry: autoCarry(db) };
  });

  app.post<{ Params: { id: string } }>("/ui/jobs/:id/gaps/carry", async (request, reply) => {
    const id = request.params.id;
    if (!jobExists(db, id)) return reply.status(404).send({ error: "not_found" });
    try {
      const r = carryAnswers(db, id);
      return { carried: r.carried, ...(await rescoreAfter(id, r.rescore)) };
    } catch (err) {
      return reply.status(409).send({ error: "no_gaps", message: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/ui/jobs/:id/gaps/match", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return await matchSimilar(db, request.params.id);
    } catch (err) {
      return reply.status(503).send({ error: "match_failed", message: message(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/gaps/reuse", async (request, reply) => {
    const id = request.params.id;
    if (!jobExists(db, id)) return reply.status(404).send({ error: "not_found" });
    const body = ReuseBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    let r: ReturnType<typeof reuseAnswer>;
    try {
      r = reuseAnswer(db, id, body.data);
    } catch (err) {
      return reply.status(400).send({ error: "reuse_failed", message: message(err) });
    }
    return { outcome: r.outcome, ...(await rescoreAfter(id, r.rescore)) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/gaps/undo", async (request, reply) => {
    const id = request.params.id;
    if (!jobExists(db, id)) return reply.status(404).send({ error: "not_found" });
    const body = UndoBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      declineCarried(db, id, body.data.requirement);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: "undo_failed", message: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/ui/jobs/:id/rescore", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return { rescore_batch: (await rescore(request.params.id)).batch_id };
    } catch (err) {
      return reply.status(503).send({ error: "queue_down", message: message(err) });
    }
  });

  // Tailor now: only when the job is at 75+, open gap questions or not (or, for a
  // tailored job, Re-tailor at 75+). Rescores never start tailoring on their own.
  app.get<{ Params: { id: string } }>("/ui/jobs/:id/tailor", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return tailorStatus(db, request.params.id);
    } catch (err) {
      return reply.status(500).send({ error: "tailor_status_failed", message: message(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/ui/jobs/:id/tailor", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    let st;
    try {
      st = tailorStatus(db, request.params.id);
    } catch (err) {
      return reply.status(500).send({ error: "tailor_status_failed", message: message(err) });
    }
    if (!st.can_tailor) return reply.status(409).send({ error: "not_ready", message: st.reasons.join(" ") });
    try {
      return { tailor_batch: (await tailorNow(request.params.id)).batch_id };
    } catch (err) {
      return reply.status(503).send({ error: "queue_down", message: message(err) });
    }
  });

  // Delete this job (the UI asks the user first, with "Why delete it?"): rows, tailored resumes
  // and queue tasks go; the link stays on deleted_jobs so a fetch does not add it back. The
  // keywords given become skip keywords for later batches (title and description).
  // Top bar: the jobs with a skip word (applied/interview/offer kept apart), and deleting the
  // ones the user confirmed.
  app.get("/ui/skip-matches", async () => skipMatches(db));
  // Board selection (Tailored, Skipped, Not tailored): what the ticked jobs would lose, then
  // deleting them. Applied/interview/offer jobs only with include_applied.
  const Ids = z.array(z.string().min(1).max(120)).min(1).max(5000);
  app.post<{ Body: unknown }>("/ui/jobs/bulk-delete/preview", async (request, reply) => {
    const body = z.object({ ids: Ids }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return bulkPreview(db, body.data.ids);
  });
  app.post<{ Body: unknown }>("/ui/jobs/bulk-delete", async (request, reply) => {
    const body = z.object({ ids: Ids, include_applied: z.boolean().default(false) }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return await bulkDelete(db, body.data.ids, { include_applied: body.data.include_applied });
    } catch (err) {
      return reply.status(500).send({ error: "delete_failed", message: message(err) });
    }
  });

  // Keep this job: never skipped by the preferences (skip words), never in a bulk delete.
  app.post<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id/keep", async (request, reply) => {
    const body = z.object({ keep: z.boolean() }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return setKept(db, request.params.id, body.data.keep);
    } catch (err) {
      return reply.status(err instanceof DeleteRefused ? 404 : 500).send({ error: "keep_failed", message: message(err) });
    }
  });
  app.post<{ Body: unknown }>("/ui/skip-matches/delete", async (request, reply) => {
    const body = z.object({ ids: z.array(z.string().min(1).max(120)).min(1).max(5000) }).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return await deleteSkipMatches(db, body.data.ids);
    } catch (err) {
      return reply.status(500).send({ error: "delete_failed", message: message(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/ui/jobs/:id/delete-hints", async (request, reply) => {
    try {
      return deleteHints(db, request.params.id);
    } catch (err) {
      return reply.status(err instanceof DeleteRefused ? 404 : 500).send({ error: "hints_failed", message: message(err) });
    }
  });

  app.delete<{ Params: { id: string }; Body: unknown }>("/ui/jobs/:id", async (request, reply) => {
    const body = DeleteBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    try {
      return { deleted: true, ...(await deleteJob(db, request.params.id, body.data)) };
    } catch (err) {
      if (err instanceof DeleteRefused) return reply.status(message(err) === "job not found" ? 404 : 409).send({ error: "refused", message: message(err) });
      return reply.status(500).send({ error: "delete_failed", message: message(err) });
    }
  });

  // Rescore all: enabled when the bank, the added skills or the spellings changed since the
  // last Rescore all; re-scores only jobs below the tailoring bands that are not tailored.
  app.get("/ui/rescore-all", async () => rescoreAllStatus(db));

  app.post("/ui/rescore-all", async (_request, reply) => {
    const ids = rescoreCandidates(db);
    if (!ids.length) {
      markRescoredAll(db);
      return { batch_id: 0, queued: 0 };
    }
    try {
      const r = await rescoreJobs(ids);
      markRescoredAll(db);
      return r;
    } catch (err) {
      return reply.status(503).send({ error: "queue_down", message: message(err) });
    }
  });

  // Copy as prompt: the job, the score arithmetic and the gaps; no resume text.
  app.get<{ Params: { id: string } }>("/ui/jobs/:id/prompt", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return analysisPrompt(db, request.params.id);
    } catch (err) {
      return reply.status(409).send({ error: "no_prompt", message: message(err) });
    }
  });
}

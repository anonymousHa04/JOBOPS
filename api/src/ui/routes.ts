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
import { analysisPrompt } from "./prompt.ts";
import { deleteJob, DeleteRefused } from "../jobs/delete.ts";

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
  extra_skills: z.array(z.string().max(80)).max(10).optional()
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
      r = answerGap(db, id, body.data);
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

  app.post<{ Params: { id: string } }>("/ui/jobs/:id/rescore", async (request, reply) => {
    if (!jobExists(db, request.params.id)) return reply.status(404).send({ error: "not_found" });
    try {
      return { rescore_batch: (await rescore(request.params.id)).batch_id };
    } catch (err) {
      return reply.status(503).send({ error: "queue_down", message: message(err) });
    }
  });

  // Tailor now: only when the job is at 75+ and every gap question has an answer (or, for a
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

  // Delete this job (the UI asks the user first): rows, tailored resumes and queue tasks go;
  // the link stays on deleted_jobs so a fetch does not add it back.
  app.delete<{ Params: { id: string } }>("/ui/jobs/:id", async (request, reply) => {
    try {
      return { deleted: true, ...(await deleteJob(db, request.params.id)) };
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

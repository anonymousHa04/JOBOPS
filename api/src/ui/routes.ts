// Routes for the web UI (ui/, served by Vite on localhost; it calls these under /api).
// Local only: the API listens on 127.0.0.1 and there is no login.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.ts";
import { addPrepTask, APP_STATUSES, board, jobDetail, jobExists, scoreDetail, setApplication, setPrepTask } from "./data.ts";
import { health } from "./health.ts";

const AppBody = z.object({ status: z.enum(APP_STATUSES).nullable(), note: z.string().max(2000).nullable().optional() }).strict();
const TaskBody = z.object({ text: z.string().trim().min(1).max(300) }).strict();
const TaskPatch = z.object({ done: z.boolean().optional(), remove: z.boolean().optional() }).strict();

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
}

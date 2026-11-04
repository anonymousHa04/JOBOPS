// Batch routes: the same actions as `batch start|status|retry`, passed through to the queue server.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { batch, batches, retryBatch, startBatch, sweep, QueueDownError } from "./client.ts";
import { loadPrompt } from "../model/prompts.ts";

const StartBody = z.object({ limit: z.number().int().min(1).max(100).default(100) }).strict();
const Id = z.coerce.number().int().positive();

async function pass(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
  try {
    return reply.status(status).send(await work());
  } catch (err) {
    if (err instanceof QueueDownError) return reply.status(503).send({ error: err.message });
    return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function queueRoutes(app: FastifyInstance): void {
  app.post<{ Body: unknown }>("/batches", async (request, reply) => {
    const body = StartBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return pass(reply, () => startBatch(body.data.limit, loadPrompt("parse-job-descripton").version), 201);
  });

  // Score parsed jobs that no batch has scored (the queue server also does this every 2 minutes).
  app.post("/batches/sweep", async (_request, reply) => pass(reply, () => sweep(50)));

  app.get("/batches", async (_request, reply) => pass(reply, () => batches()));

  app.get<{ Params: { id: string } }>("/batches/:id", async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return reply.status(400).send({ error: "id must be a positive integer" });
    return pass(reply, () => batch(id.data));
  });

  app.post<{ Params: { id: string } }>("/batches/:id/retry", async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return reply.status(400).send({ error: "id must be a positive integer" });
    return pass(reply, () => retryBatch(id.data));
  });
}

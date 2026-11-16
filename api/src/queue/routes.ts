// Batch routes: the same actions as `batch start|status|retry`, passed through to the queue server.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { batch, batches, retryBatch, retryCompany, startBatch, sweep, QueueDownError, type QueueCompany } from "./client.ts";
import { loadPrompt } from "../model/prompts.ts";
import { loadPreferences, setCompany, type Ats } from "../profile/bank.ts";
import { PreferencesSchema } from "../profile/schema.ts";

// unskip: skip words turned off for this batch only (preferences.yaml stays as it is).
const StartBody = z.object({
  limit: z.number().int().min(1).max(100).default(100),
  unskip: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
}).strict();
const Id = z.coerce.number().int().positive();
// The ATS values preferences.yaml accepts (the schema's enum, so the two never drift).
const AtsEnum = PreferencesSchema.shape.companies.shape.include.element.shape.ats;
const RetryCompanyBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(500).optional(),
  ats: AtsEnum.optional(),
}).strict();

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
    return pass(reply, () => startBatch(body.data.limit, loadPrompt("parse-job-descripton").version, body.data.unskip), 201);
  });

  // Score parsed jobs that no batch has scored (the queue server also does this every 2 minutes).
  app.post("/batches/sweep", async (_request, reply) => pass(reply, () => sweep(50)));

  app.get("/batches", async (_request, reply) => pass(reply, () => batches()));

  // The skip words in preferences.yaml, for the "turn off for this batch" list. Before /batches/:id.
  app.get("/batches/skip-words", async (_request, reply) =>
    pass(reply, async () => ({ words: loadPreferences().skip_keywords })));

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

  // Retry one company of a batch, optionally with a new slug or ATS.
  app.post<{ Params: { id: string }; Body: unknown }>("/batches/:id/companies/retry", async (request, reply) => {
    const id = Id.safeParse(request.params.id);
    if (!id.success) return reply.status(400).send({ error: "id must be a positive integer" });
    const body = RetryCompanyBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid body" });
    return pass(reply, async () => {
      const { name, slug } = body.data;
      // A queue error throws here, before any save: pass() turns it into 503/500.
      const row: QueueCompany = await retryCompany(id.data, body.data);
      // Save the slug only when the retry found the board (user, 2026-11-12): a slug that
      // failed never reaches preferences.yaml. An empty slug means "retry with the current
      // slug" and is never saved (it would wipe the company's slug).
      if (row.status !== "fetched" || !slug) return { company: row, saved: [] };
      const fromRow = AtsEnum.safeParse(row.board);
      const ats: Ats = body.data.ats ?? (fromRow.success ? fromRow.data : "auto");
      const entry = loadPreferences().companies.include.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (entry && entry.slug === slug && entry.ats === ats) return { company: row, saved: [] };
      return { company: row, saved: setCompany(entry?.name ?? name, slug, ats) };
    });
  });
}

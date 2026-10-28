// Routes for the JobOps browser extension, under /x/. They answer only requests from a
// Chrome extension (Origin chrome-extension://..., or the one id in JOBOPS_EXTENSION_ID),
// so a web page cannot use the local API through the browser. The API listens on
// 127.0.0.1 only. Responses carry job and report metadata, never resume text.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.ts";
import { tailorAll } from "../tools.ts";
import { chatPrompt, listReports, saveReport, SOURCES } from "./reports.ts";

export function extensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const pinned = process.env.JOBOPS_EXTENSION_ID;
  return pinned ? origin === `chrome-extension://${pinned}` : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

const SaveBody = z.object({ source: z.enum(SOURCES), text: z.string().min(1).max(100_000) });

export function extensionRoutes(app: FastifyInstance, db: Db): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/x/")) return;
    const origin = request.headers.origin;
    if (!extensionOrigin(origin)) {
      reply.status(403).send({ error: "forbidden", detail: "the /x/ routes answer the JobOps extension only" });
      return reply;
    }
    reply.header("access-control-allow-origin", origin!);
    reply.header("vary", "origin");
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

  // Scored jobs, best first: what the popup offers to ask about.
  app.get("/x/jobs", async (_request, reply) => {
    try {
      const rows = tailorAll(db).rows.slice(0, 40).map((r) => ({
        job_id: r.job_id, company: r.company, title: r.title, score: r.score, band: r.band, decision: r.decision,
        reports: listReports(r.job_id).map((x) => x.source)
      }));
      return reply.send({ jobs: rows });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { jobId: string } }>("/x/prompt/:jobId", async (request, reply) => {
    try {
      return reply.send(chatPrompt(db, request.params.jobId));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { jobId: string }; Body: unknown }>("/x/reports/:jobId", async (request, reply) => {
    const body = SaveBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "validation_error", issues: body.error.issues.map((i) => i.path.join(".")) });
    try {
      const r = await saveReport(db, request.params.jobId, body.data.source, body.data.text);
      return reply.status(r.ok ? 201 : 422).send(r);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { jobId: string } }>("/x/reports/:jobId", async (request, reply) => reply.send({ reports: listReports(request.params.jobId) }));
}

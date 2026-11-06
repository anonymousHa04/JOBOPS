import Fastify, { LogController } from "fastify";
import type { FastifyInstance } from "fastify";
import { JobInputSchema, JobListQuerySchema } from "./jobs/schema.ts";
import type { Db } from "./db.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { extensionRoutes } from "./extension/routes.ts";
import { queueRoutes } from "./queue/routes.ts";
import { uiRoutes } from "./ui/routes.ts";
import { lineStream, setEventSink } from "./log.ts";
import { publish, subscribe } from "./events/bus.ts";

export function buildApp(opts: { db: Db; logger?: boolean }): FastifyInstance {
    // The server logs one readable line per request worth seeing (log.ts), not Fastify's two
    // JSON lines per request: the UI used to poll every 15 s, which buried everything else (it now
    // follows GET /ui/events).
    const app = Fastify(opts.logger
        ? { logger: { level: "info", stream: lineStream }, logController: new LogController({ disableRequestLogging: true }) }
        : { logger: false });
    if (opts.logger) {
        setEventSink({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
        // Writes, errors and slow requests always; a successful GET only when slow (never the event stream).
        app.addHook("onResponse", async (req, reply) => {
            const ms = reply.elapsedTime;
            const status = reply.statusCode;
            if (req.method === "GET" && status < 400 && (ms < 2000 || req.url.startsWith("/ui/events"))) return;
            const line = `${req.method} ${req.url} ${status} ${Math.round(ms)} ms`;
            if (status >= 400) app.log.warn(line);
            else app.log.info(line);
        });
    }

    // Every write that worked tells open UIs which job changed (they re-read that card only).
    // Routes without a job in the path publish their own events (add, deletes, new jobs).
    app.addHook("onResponse", async (req, reply) => {
        if (req.method === "GET" || req.method === "HEAD" || reply.statusCode >= 400) return;
        if (req.url.startsWith("/ui/client-log")) return;
        const p = (req.params ?? {}) as { id?: string; jobId?: string };
        const jobId = p.id ?? p.jobId;
        if (jobId) publish({ kind: "api", job_id: jobId });
    });

    // The change feed for the UI (Server-Sent Events). One "ready" on connect: the UI loads
    // once, then only applies changes. A keepalive comment keeps proxies from closing it.
    app.get("/ui/events", (req, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", connection: "keep-alive" });
        res.write("retry: 3000\nevent: ready\ndata: {}\n\n");
        const off = subscribe((c) => res.write(`id: ${c.seq}\nevent: change\ndata: ${JSON.stringify(c)}\n\n`));
        const keep = setInterval(() => res.write(": keepalive\n\n"), 20_000);
        req.raw.on("close", () => { off(); clearInterval(keep); });
    });

    const jobs = createJobRepository(opts.db);
    extensionRoutes(app, opts.db);
    queueRoutes(app);
    uiRoutes(app, opts.db);

    app.post<{ Body: unknown }>(`/jobs`, async (request, reply) => {
        const result = JobInputSchema.safeParse(request.body);

        if (!result.success) {
            reply.status(400).send({
                error: "validation_error",
                issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            });
        } else {
            // A job the user deleted: 200 (known, like a duplicate), so fetchers move on.
            if (jobs.isDeleted(result.data)) {
                reply.status(200).send({ deleted: true, source_url: result.data.source_url });
                return;
            }
            const { job, created } = jobs.upsert(result.data);
            if (created) publish({ kind: "job", job_id: job.id, state: "added" });
            reply.status(created ? 201 : 200).send(job);
        }
    });

    app.get<{ Querystring: unknown }>(`/jobs`, async (request, reply) => {
        const result = JobListQuerySchema.safeParse(request.query);

        if (!result.success) {
            reply.status(400).send({
                error: "validation_error",
                issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            });
        } else {
            const { items, total } = jobs.list(result.data);
            reply.status(200).send({
                items,
                total,
                limit: result.data.limit,
                offset: result.data.offset
            });
        }
    });

    app.get<{ Params: { id: string } }>(`/jobs/:id`, async (request, reply) => {
        const job = jobs.getById(request.params.id);

        if (job) {
            reply.status(200).send(job);
        } else {
            reply.status(404).send({ error: "not_found" });
        }
    });

    return app;
}

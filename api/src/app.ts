import Fastify, { LogController } from "fastify";
import type { FastifyInstance } from "fastify";
import { JobInputSchema, JobListQuerySchema } from "./jobs/schema.ts";
import type { Db } from "./db.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { extensionRoutes } from "./extension/routes.ts";
import { queueRoutes } from "./queue/routes.ts";
import { uiRoutes } from "./ui/routes.ts";
import { lineStream, setEventSink } from "./log.ts";

export function buildApp(opts: { db: Db; logger?: boolean }): FastifyInstance {
    // The server logs one readable line per request worth seeing (log.ts), not Fastify's two
    // JSON lines per request: the UI polls every 15 s, which buried everything else.
    const app = Fastify(opts.logger
        ? { logger: { level: "info", stream: lineStream }, logController: new LogController({ disableRequestLogging: true }) }
        : { logger: false });
    if (opts.logger) {
        setEventSink({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
        // Writes, errors and slow requests always; a successful GET (polling) only when slow.
        app.addHook("onResponse", async (req, reply) => {
            const ms = reply.elapsedTime;
            const status = reply.statusCode;
            if (req.method === "GET" && status < 400 && ms < 2000) return;
            const line = `${req.method} ${req.url} ${status} ${Math.round(ms)} ms`;
            if (status >= 400) app.log.warn(line);
            else app.log.info(line);
        });
    }

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

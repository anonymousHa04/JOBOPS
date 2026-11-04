import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { JobInputSchema, JobListQuerySchema } from "./jobs/schema.ts";
import type { Db } from "./db.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { extensionRoutes } from "./extension/routes.ts";
import { queueRoutes } from "./queue/routes.ts";
import { uiRoutes } from "./ui/routes.ts";

export function buildApp(opts: { db: Db; logger?: boolean }): FastifyInstance {
    const app = Fastify({ logger: opts.logger ?? false });

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

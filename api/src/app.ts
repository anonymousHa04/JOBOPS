import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { JobInputSchema } from "./jobs/schema.ts";
import type { Db } from "./db.ts";
import { createJobRepository } from "./jobs/repository.ts";

export function buildApp(opts: { db: Db; logger?: boolean }): FastifyInstance {
    const app = Fastify({ logger: opts.logger ?? false });

    const jobs = createJobRepository(opts.db);

    app.post<{ Body: unknown }>(`/jobs`, async (request, reply) => {
        const result = JobInputSchema.safeParse(request.body);

        if (!result.success) {
            reply.status(400).send({
                error: "validation_error",
                issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            });
        } else {
            const job = jobs.insert(result.data);
            reply.status(201).send(job);
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

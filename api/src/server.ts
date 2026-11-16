import "./env.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { startQueueRelay } from "./events/bus.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "data/jobops.db";
mkdirSync(dirname(dbPath), { recursive: true });

const app = buildApp({ db: openDb(dbPath), logger: true });

try {
  // 127.0.0.1 on the Mac; the container image sets HOST=0.0.0.0 so other pods can reach it
  // (inside the cluster only: its Service is not exposed outside).
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
  startQueueRelay();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

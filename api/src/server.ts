import "./env.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "data/jobops.db";
mkdirSync(dirname(dbPath), { recursive: true });

const app = buildApp({ db: openDb(dbPath), logger: true });

try {
  await app.listen({ port, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Service health for the UI's top bar: each service, whether it answers, and how to start it.
import { execFile } from "node:child_process";
import { modelUp } from "../model/registry.ts";
import type { Task } from "../model/registry.ts";
import { queueUp, workersSeen } from "../queue/client.ts";

export type Service = { name: string; role: string; up: boolean | null; detail: string; start: string };

async function ok(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

function running(pattern: string): Promise<boolean> {
  return new Promise((resolve) => execFile("pgrep", ["-f", pattern], (err) => resolve(!err)));
}

// In the cluster each worker runs in its own pod, so pgrep cannot see it: ask the queue when the
// group last leased or pinged (an idle worker leases at least every 30 s: it waits on the queue's change feed, with a 30 s fallback).
const inCluster = process.env.JOBOPS_IN_CLUSTER === "1";
async function worker(group: string): Promise<boolean> {
  if (!inCluster) return running(`cli.ts worker ${group}`);
  try {
    const at = (await workersSeen())[group];
    return !!at && Date.now() - Date.parse(at) < 60_000;
  } catch {
    return false;
  }
}

async function model(task: Task, name: string, role: string, start: string): Promise<Service> {
  try {
    const m = await modelUp(task);
    const detail = m.up ? m.spec.alias : m.status === 401 || m.status === 403 ? `refused the API key (${m.status})` : "not answering";
    return { name, role, up: m.up, detail, start };
  } catch (err) {
    return { name, role, up: false, detail: err instanceof Error ? err.message : String(err), start };
  }
}

export async function health(): Promise<Service[]> {
  const qdrant = process.env.QDRANT_URL;
  const embed = process.env.LLM_EMBED_URL ?? "http://127.0.0.1:8082/v1";
  return Promise.all([
    model("jd_parse", "general7", "JD parse, judge (laptop)", "On the laptop: C:\\llama\\start-server.cmd"),
    model("reword", "general14", "Bank build, rewording (Mac)", ".claude/bin/llm.sh start general14"),
    ok(`${embed}/models`).then((up): Service => ({ name: "embed", role: "Embeddings for repost checks", up, detail: up ? "ok" : "not answering", start: ".claude/bin/llm.sh start embed" })),
    qdrant
      ? ok(`${qdrant}/collections`).then((up): Service => ({ name: "qdrant", role: "Vector store for reposts", up, detail: up ? "ok" : "not answering", start: "docker compose -f infra/qdrant/docker-compose.yml up -d" }))
      : Promise.resolve<Service>({ name: "qdrant", role: "Vector store for reposts", up: null, detail: "off (QDRANT_URL unset)", start: "set QDRANT_URL in .env" }),
    queueUp().then((up): Service => ({ name: "queue", role: "Batch queue server", up, detail: up ? "ok" : "not running", start: inCluster ? "bin/jobops up" : "go run -C queue ./cmd/queue" })),
    worker("laptop").then((up): Service => ({ name: "worker-laptop", role: "Parse and score worker", up, detail: up ? "running" : "not running", start: inCluster ? "bin/jobops up" : "node api/src/cli.ts worker laptop" })),
    worker("mac").then((up): Service => ({ name: "worker-mac", role: "Tailor worker", up, detail: up ? "running" : "not running", start: inCluster ? "bin/jobops up" : "node api/src/cli.ts worker mac" }))
  ]);
}

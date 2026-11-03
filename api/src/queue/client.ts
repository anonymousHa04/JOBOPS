// Thin client for the Go queue server (queue/, `go run -C queue ./cmd/queue`).
export const queueUrl = () => process.env.JOBOPS_QUEUE_URL ?? "http://127.0.0.1:8090";

export type QueueTask = { id: number; batch_id: number; job_id: string; stage: string; attempts: number; prompt_version: string };

export class QueueDownError extends Error {
  constructor() {
    super(`the queue server is not running at ${queueUrl()}. Start it with: go run -C queue ./cmd/queue`);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${queueUrl()}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new QueueDownError();
  }
  if (res.status === 204) return null as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(`queue ${method} ${path}: status ${res.status}${data.error ? `: ${data.error}` : ""}`);
  return data as T;
}

export async function queueUp(): Promise<boolean> {
  try {
    return (await fetch(`${queueUrl()}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export const startBatch = (limit: number, parseVersion: string) =>
  call<{ batch_id: number }>("POST", "/batches", { limit, parse_version: parseVersion });
export const batches = () => call<unknown[]>("GET", "/batches");
export const batch = (id: number) => call<unknown>("GET", `/batches/${id}`);
export const retryBatch = (id: number) => call<{ requeued: number }>("POST", `/batches/${id}/retry`);
export const lease = (stages: string[], worker: string) => call<QueueTask | null>("POST", "/lease", { stages, worker });
export const done = (taskId: number, result: Record<string, unknown>) => call<void>("POST", `/tasks/${taskId}/done`, { result });
export const fail = (taskId: number, code: string, detail: string) =>
  call<void>("POST", `/tasks/${taskId}/fail`, { code, detail: detail.slice(0, 300) });

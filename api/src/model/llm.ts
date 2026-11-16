import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { authHeaders, forTask, modelLogPath } from "./registry.ts";
import type { Task, TaskSpec } from "./registry.ts";

// Local model provider: llama.cpp's OpenAI-compatible server (.claude/bin/llm.sh). Each
// call names its task; the registry (config/models.yaml) gives the model, server,
// timeout, and answer limit. Output is forced to the schema (json_schema) and validated
// again with Zod; an invalid answer gets one retry that names the fields that failed.
// Errors are returned, never thrown, and never include model output (it may hold resume
// text). Every call adds one line to the model call log: codes and numbers only.

export type Outcome = "ok" | "retry_ok" | "invalid_output" | "timeout" | "unavailable";

export type GenerateResult<T> =
  | { ok: true; value: T; model: string; durationMs: number }
  | { ok: false; error: "timeout" | "unavailable" | "invalid_output"; detail: string };

type Usage = { prompt_tokens?: number; completion_tokens?: number };
type Attempt<T> = (GenerateResult<T> | { ok: false; error: "retry"; detail: string }) & { usage: Usage };

export async function generate<T>(opts: {
  task: Task;
  prompt: string;
  schema: z.ZodType<T>;
  model?: string; // overrides the task's model (bank retag --model)
  baseUrl?: string; // a different server (tests use a fake one)
}): Promise<GenerateResult<T>> {
  const spec = forTask(opts.task, { model: opts.model });
  const baseUrl = opts.baseUrl ?? spec.url;
  const { $schema: _ignored, ...schema } = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  const body = (retryPaths: string | null) => JSON.stringify({
    model: spec.alias,
    temperature: 0,
    // Streamed: headers arrive at once. Without it, Node's fetch gives up after 300 s
    // waiting for headers, which a long answer (the bank build) never sends in time.
    stream: true,
    stream_options: { include_usage: true },
    ...(spec.maxTokens ? { max_tokens: spec.maxTokens } : {}),
    messages: [
      { role: "user", content: opts.prompt },
      // The retry names the schema fields that failed (paths only, never the answer).
      ...(retryPaths ? [{ role: "user", content: `Your previous answer did not match the required JSON at: ${retryPaths}. Answer again with JSON that matches the schema exactly.` }] : [])
    ],
    response_format: { type: "json_schema", json_schema: { name: "output", schema } }
  });
  const start = Date.now();
  const usage: Usage = {};
  const done = (r: GenerateResult<T>, outcome: Outcome, attempts: number): GenerateResult<T> => {
    logCall({ task: opts.task, model: spec.model, outcome, attempts, ms: Date.now() - start, ...usage });
    return r;
  };

  // One retry on invalid output; timeouts and connection errors are final.
  let retryPaths: string | null = null;
  for (let i = 0; i < 2; i++) {
    const a: Attempt<T> = await attempt(baseUrl, body(retryPaths), opts.schema, spec.timeoutMs, spec);
    usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (a.usage.prompt_tokens ?? 0);
    usage.completion_tokens = (usage.completion_tokens ?? 0) + (a.usage.completion_tokens ?? 0);
    if (a.ok) return done({ ok: true, value: a.value, model: spec.model, durationMs: Date.now() - start }, i === 0 ? "ok" : "retry_ok", i + 1);
    if (a.error !== "retry") return done({ ok: false, error: a.error, detail: a.detail }, a.error, i + 1);
    retryPaths = a.detail;
  }
  return done({ ok: false, error: "invalid_output", detail: retryPaths ?? "" }, "invalid_output", 2);
}

async function attempt<T>(baseUrl: string, body: string, schema: z.ZodType<T>, timeoutMs: number, spec: TaskSpec): Promise<Attempt<T>> {
  const none: Usage = {};
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(spec) },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "timeout", detail: `no answer in ${timeoutMs} ms`, usage: none };
    }
    return { ok: false, error: "unavailable", detail: `${err instanceof Error ? err.message : String(err)} (start it with: ${spec.remoteStart ?? `.claude/bin/llm.sh start ${spec.role}`})`, usage: none };
  }
  // Never the key itself: only the name of the setting that should hold it.
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "unavailable", detail: `status ${res.status}: wrong or missing API key (${spec.apiKeyEnv ?? "no key set"})`, usage: none };
  }
  if (!res.ok) return { ok: false, error: "unavailable", detail: `status ${res.status}`, usage: none };

  let read: { text: string; usage: Usage };
  try {
    read = await readContent(res);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "timeout", detail: `no answer in ${timeoutMs} ms`, usage: none };
    }
    return { ok: false, error: "retry", detail: "(not readable)", usage: none };
  }
  let content: unknown;
  try {
    content = JSON.parse(read.text);
  } catch {
    return { ok: false, error: "retry", detail: "(not JSON)", usage: read.usage };
  }
  const parsed = schema.safeParse(content);
  if (parsed.success) return { ok: true, value: parsed.data, model: "", durationMs: 0, usage: read.usage };
  // Issue paths only: the content may hold resume text.
  const paths = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)");
  return { ok: false, error: "retry", detail: paths.join(", "), usage: read.usage };
}

// The answer text and token usage from a streamed (server-sent events) or plain JSON response.
async function readContent(res: Response): Promise<{ text: string; usage: Usage }> {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Usage };
    return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? {} };
  }
  let text = "";
  let usage: Usage = {};
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: Usage };
      text += event.choices?.[0]?.delta?.content ?? "";
      if (event.usage) usage = event.usage;
    }
  }
  return { text, usage };
}

export type CallRecord = {
  at: string; task: Task; model: string; outcome: Outcome; attempts: number; ms: number;
  prompt_tokens?: number; completion_tokens?: number;
};

// One JSON line per call. Never the prompt or the answer: they may hold resume text.
function logCall(r: Omit<CallRecord, "at">): void {
  const path = modelLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n");
  } catch {
    // The log is for measurement; a write failure never fails the call.
  }
}

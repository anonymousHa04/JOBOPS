import { z } from "zod";

// Local model provider: llama.cpp's OpenAI-compatible server (.claude/bin/llm.sh),
// replacing Ollama (2026-10-26). Output is forced to the schema (json_schema) and
// validated again with Zod; errors are returned, never thrown, and never include
// model output (it may hold resume text).

export type GenerateResult<T> =
  | { ok: true; value: T; model: string; durationMs: number }
  | { ok: false; error: "timeout" | "unavailable" | "invalid_output"; detail: string };

type Attempt<T> = GenerateResult<T> | { ok: false; error: "retry"; detail: string };

// Model name -> llama.cpp server role (llm.sh). Only one heavy model runs at a time.
const SERVERS: Record<string, { url: string; alias: string; role: string }> = {
  "qwen2.5:7b": { url: process.env.LLM_GENERAL7_URL ?? "http://127.0.0.1:8084/v1", alias: "qwen2.5-7b", role: "general7" },
  "qwen2.5:14b": { url: process.env.LLM_GENERAL14_URL ?? "http://127.0.0.1:8085/v1", alias: "qwen2.5-14b", role: "general14" }
};

export async function generate<T>(opts: {
  model: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<GenerateResult<T>> {
  const server = SERVERS[opts.model];
  const baseUrl = opts.baseUrl ?? server?.url;
  if (!baseUrl) return { ok: false, error: "unavailable", detail: `unknown model ${opts.model}` };
  const { $schema: _ignored, ...schema } = z.toJSONSchema(opts.schema) as Record<string, unknown>;
  const body = JSON.stringify({
    model: server?.alias ?? opts.model,
    temperature: 0,
    messages: [{ role: "user", content: opts.prompt }],
    response_format: { type: "json_schema", json_schema: { name: "output", schema } }
  });
  const start = Date.now();

  // One retry on invalid output; timeouts and connection errors are final.
  let last: Attempt<T> = { ok: false, error: "retry", detail: "" };
  for (let i = 0; i < 2; i++) {
    last = await attempt(baseUrl, body, opts.schema, opts.timeoutMs ?? 300000, server?.role);
    if (last.ok) return { ...last, model: opts.model, durationMs: Date.now() - start };
    if (last.error !== "retry") return last;
  }
  return { ok: false, error: "invalid_output", detail: last.detail };
}

async function attempt<T>(
  baseUrl: string,
  body: string,
  schema: z.ZodType<T>,
  timeoutMs: number,
  role: string | undefined
): Promise<Attempt<T>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "timeout", detail: `no answer in ${timeoutMs} ms` };
    }
    const hint = role ? ` (start it with: .claude/bin/llm.sh start ${role})` : "";
    return { ok: false, error: "unavailable", detail: (err instanceof Error ? err.message : String(err)) + hint };
  }
  if (!res.ok) return { ok: false, error: "unavailable", detail: `status ${res.status}` };

  let content: unknown;
  try {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    content = JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {
    return { ok: false, error: "retry", detail: "not JSON" };
  }
  const parsed = schema.safeParse(content);
  if (parsed.success) return { ok: true, value: parsed.data, model: "", durationMs: 0 };
  // Issue paths only: the content may hold resume text.
  const paths = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)");
  return { ok: false, error: "retry", detail: paths.join(", ") };
}

import { z } from "zod";

export type GenerateResult<T> =
  | { ok: true; value: T; model: string; durationMs: number }
  | { ok: false; error: "timeout" | "unavailable" | "invalid_output"; detail: string };

type Attempt<T> = GenerateResult<T> | { ok: false; error: "retry"; detail: string };

export async function generate<T>(opts: {
  model: string;
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<GenerateResult<T>> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const body = JSON.stringify({
    model: opts.model,
    stream: false,
    messages: [{ role: "user", content: opts.prompt }],
    format: z.toJSONSchema(opts.schema),
    options: { temperature: 0 }
  });
  const start = Date.now();

  // One retry on invalid output; timeouts and connection errors are final.
  let last: Attempt<T> = { ok: false, error: "retry", detail: "" };
  for (let i = 0; i < 2; i++) {
    last = await attempt(baseUrl, body, opts.schema, opts.timeoutMs ?? 300000);
    if (last.ok) return { ...last, model: opts.model, durationMs: Date.now() - start };
    if (last.error !== "retry") return last;
  }
  return { ok: false, error: "invalid_output", detail: last.detail };
}

async function attempt<T>(baseUrl: string, body: string, schema: z.ZodType<T>, timeoutMs: number): Promise<Attempt<T>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
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
    return { ok: false, error: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, error: "unavailable", detail: `status ${res.status}` };

  let content: unknown;
  try {
    const data = (await res.json()) as { message?: { content?: string } };
    content = JSON.parse(data.message?.content ?? "");
  } catch {
    return { ok: false, error: "retry", detail: "not JSON" };
  }
  const parsed = schema.safeParse(content);
  if (parsed.success) return { ok: true, value: parsed.data, model: "", durationMs: 0 };
  // Issue paths only: the content may hold resume text.
  const paths = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)");
  return { ok: false, error: "retry", detail: paths.join(", ") };
}

// Which model each task uses (config/models.yaml, profile/models.yaml, env), its server,
// and whether that server is up. Every model call and every preflight goes through here.
import { join } from "node:path";
import { z } from "zod";
import { configFiles, readMerged } from "../lists.ts";

export const TASKS = ["jd_parse", "judge", "bank_build", "retag", "reword", "report_normalize"] as const;
export type Task = (typeof TASKS)[number];

const ModelSchema = z.object({
  alias: z.string(),
  role: z.string(),
  url_env: z.string().optional(),
  url: z.string(),
  api_key_env: z.string().optional(),
  remote_start: z.string().optional()
}).strict();
const TaskSchema = z.object({
  model: z.string(),
  env: z.string().optional(),
  timeout_s: z.number().positive(),
  max_tokens: z.number().int().positive().optional()
}).strict();
const FileSchema = z.object({
  models: z.record(z.string(), ModelSchema).default({}),
  tasks: z.record(z.string(), TaskSchema).default({})
}).strict();

export type TaskSpec = {
  task: Task;
  model: string; // as named in models.yaml ("qwen2.5:7b")
  alias: string; // the name the server knows it by
  role: string; // llm.sh role that starts its server
  url: string;
  timeoutMs: number;
  maxTokens?: number;
  apiKey?: string;
  apiKeyEnv?: string; // the env var's name, for error messages (never the key)
  remoteStart?: string;
};

function config(): z.infer<typeof FileSchema> {
  // A section in profile/models.yaml replaces the same-named one in the defaults.
  const files = configFiles("models.yaml");
  return readMerged(files, FileSchema, (a, b) => ({ models: { ...a.models, ...b.models }, tasks: { ...a.tasks, ...b.tasks } }));
}

// The model a task uses: its env var if set, else profile/models.yaml, else the default.
export function forTask(task: Task, override?: { model?: string }): TaskSpec {
  const c = config();
  const t = c.tasks[task];
  if (!t) throw new Error(`models.yaml: no task "${task}"`);
  const model = override?.model ?? (t.env ? process.env[t.env] : undefined) ?? t.model;
  const m = c.models[model];
  if (!m) throw new Error(`models.yaml: task "${task}" uses "${model}", which is not under models`);
  const spec: TaskSpec = {
    task, model, alias: m.alias, role: m.role,
    url: (m.url_env ? process.env[m.url_env] : undefined) ?? m.url,
    timeoutMs: t.timeout_s * 1000,
    ...(t.max_tokens ? { maxTokens: t.max_tokens } : {})
  };
  if (m.api_key_env) spec.apiKeyEnv = m.api_key_env;
  if (m.api_key_env && process.env[m.api_key_env]) {
    spec.apiKey = process.env[m.api_key_env];
  }
  if (m.remote_start && isRemoteUrl(spec.url)) {
    spec.remoteStart = m.remote_start;
  }
  return spec;
}

function isRemoteUrl(url: string): boolean {
  const hostname = new URL(url).hostname;
  return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
}

export async function modelUp(task: Task): Promise<{ up: boolean; spec: TaskSpec }> {
  const spec = forTask(task);
  try {
    const r = await fetch(`${spec.url}/models`, { 
      signal: AbortSignal.timeout(3000),
      headers: authHeaders(spec)
    });
    return { up: r.ok, spec };
  } catch {
    return { up: false, spec };
  }
}

// The commands that switch to a task's model (one heavy model at a time).
export const switchCommands = (spec: TaskSpec) => {
  if (spec.remoteStart) {
    return [spec.remoteStart];
  }
  return [".claude/bin/llm.sh stop all", `.claude/bin/llm.sh start ${spec.role}`];
};

export class ModelDownError extends Error {
  readonly spec: TaskSpec;
  constructor(spec: TaskSpec, why = "") {
    if (spec.remoteStart) {
      super(`${spec.model} (${spec.task}) is not running${why ? `: ${why}` : ""}. Start it with: ${spec.remoteStart}`);
    } else {
      super(`${spec.model} (${spec.task}) is not running${why ? `: ${why}` : ""}. Switch to it with: ${switchCommands(spec).join(" && ")}`);
    }
    this.spec = spec;
  }
}

// Preflight: throws ModelDownError before a command starts work it cannot finish.
export async function ensureModel(task: Task, why = ""): Promise<TaskSpec> {
  const { up, spec } = await modelUp(task);
  if (!up) throw new ModelDownError(spec, why);
  return spec;
}

export const modelLogPath = () => process.env.JOBOPS_MODEL_LOG ?? join("data", "model-calls.jsonl");

export function authHeaders(spec: TaskSpec): Record<string, string> {
  if (spec.apiKey) {
    return { authorization: "Bearer " + spec.apiKey };
  }
  return {};
}

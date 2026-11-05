// Typed calls to the JobOps API (proxied by Vite under /api).

export type Pipeline = "new" | "parsing" | "scoring" | "tailoring" | "parsed" | "to_tailor" | "not_tailored" | "tailored" | "failed" | "skipped";
export const APP_STATUSES = ["interested", "applied", "interview", "offer", "rejected", "withdrawn"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export type Card = {
  id: string; title: string; company: string; location: string | null; source_name: string | null;
  first_seen_at: string; state: Pipeline; score: number | null; band: string | null; decision: string | null;
  error_code: string | null; failed_stage: string | null; skip_reason: string | null; ready_to_tailor: boolean;
  application: AppStatus | null; open_tasks: number;
};

export type QueueTask = {
  batch_id: number; stage: string; state: string; attempts: number; worker: string | null;
  error_code: string | null; error_detail: string | null; result: Record<string, unknown> | null; final: boolean; updated_at: string;
};

export type Application = {
  status: AppStatus | null; note: string | null; applied_at: string | null; updated_at: string | null;
  tasks: { id: string; text: string; done: boolean; created_at: string }[];
};

export type JobDetail = {
  job: {
    id: string; title: string; company: string; location: string | null; source_url: string; source_name: string | null;
    employment_type: string | null; seniority: string | null; posted_at: string | null; first_seen_at: string; last_seen_at: string; description: string;
  };
  state: Pipeline; score: number | null; band: string | null; decision: string | null; error_code: string | null; failed_stage: string | null; ready_to_tailor: boolean;
  filter: { ok: boolean; reason: string; checked_at: string } | null;
  parsed: { prompt_version: string; created_at: string } | null;
  tasks: QueueTask[];
  // score/band: when the resume was made (history). latest: the newest tailor run returned it
  // (the drawer shows the job's score for it); last_run_at: the last run that returned it.
  resumes: {
    resume_id: string; decision: string; band: string | null; score: number | null; path: string; created_at: string;
    last_run_at: string | null; latest: boolean;
  }[];
  application: Application;
};

export type Kind = "must" | "theme" | "nice" | "keyword";
export type ScoreItem = {
  requirement: string; kind: Kind; label: string; credit: number; bullet_ids: string[]; source: string; qualifier: boolean; soft?: boolean;
  evidence: { id: string; text: string }[];
};
export type Part = "must" | "resp" | "nice" | "keywords";
export type ScoreDetail = {
  score: number; band: string; hard: { years_asked: number; years_have: number; pass: boolean }; cap: number | null;
  missing_must: number; tailorable: boolean; parts: Record<Part, number>;
  coverage: { must: number; theme: number; nice: number; keyword: number };
  items: ScoreItem[]; ask_user: string[];
  decision: { decision: string; equivalence: number | null; to_reword: number; blocked: boolean; unjudged: number } | null;
  reasons: string[];
  weights: {
    parts: Record<Part, number>; credit: Record<string, number>; must_missing_below: number; cap_one: number; cap_two: number;
    must_keyword_weight: number; bands: readonly { band: string; min: number }[]; tailored_bands: readonly string[];
  };
};
export type ScoreError = { error: string; message: string };

export type GapKind = "must" | "theme" | "nice" | "keyword";
export type GapAnswer = "have" | "other_name" | "learnable" | "no";
export type GapHelp = { meaning: string; similar_terms: string[]; related: { bullet_id: string; why: string }[]; questions: string[] };
export type Gap = { kind: GapKind; requirement: string; note: string | null; known_as: string | null; help: GapHelp | null; answer: GapAnswer | null; outcome: string | null; updated_at: string | null };
export type GapEntry = { id: string; title: string; company: string | null; dates: string; project: boolean; bullets: number; end: number | null };
export type GapList = { gaps: Gap[]; not_asked: { kind: GapKind; requirement: string; reason: string }[]; years: string | null; entries: GapEntry[] };
export type Draft = { text: string; tags: string[]; codes: string[]; skills: string[] };
export type AnswerBody = {
  kind: GapKind; requirement: string; answer: GapAnswer;
  entry_id?: string; text?: string; tags?: string[]; story?: string; proof?: string; same_as?: string;
  as_skill?: boolean; entry_ids?: string[]; extra_skills?: string[];
};

export type Service = { name: string; role: string; up: boolean | null; detail: string; start: string };

export type StageCount = { queued: number; leased: number; done: number; failed: number };
export type Batch = {
  id: number; limit: number; created_at: string; running: boolean; stages: Record<string, StageCount>;
  failed?: { id: number; job_id: string; stage: string; attempts: number; error_code?: string; error_detail?: string }[];
  tailored: number; skipped?: Record<string, number>;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? data.error ?? `status ${res.status}`, data);
  return data;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: unknown) {
    super(message);
  }
}

export const api = {
  board: () => call<{ jobs: Card[] }>("GET", "/ui/board").then((r) => r.jobs),
  health: () => call<{ services: Service[] }>("GET", "/ui/health").then((r) => r.services),
  job: (id: string) => call<JobDetail>("GET", `/ui/jobs/${id}`),
  score: (id: string) => call<ScoreDetail>("GET", `/ui/jobs/${id}/score`),
  setApplication: (id: string, status: AppStatus | null, note?: string | null) =>
    call<Application>("PUT", `/ui/jobs/${id}/application`, note === undefined ? { status } : { status, note }),
  addTask: (id: string, text: string) => call<Application>("POST", `/ui/jobs/${id}/tasks`, { text }),
  patchTask: (id: string, taskId: string, patch: { done?: boolean; remove?: boolean }) =>
    call<Application>("PATCH", `/ui/jobs/${id}/tasks/${taskId}`, patch),
  deleteJob: (id: string) => call<{ deleted: boolean; resumes: number; files: number; tasks: number }>("DELETE", `/ui/jobs/${id}`),
  batches: () => call<Batch[]>("GET", "/batches"),
  batch: (id: number) => call<Batch>("GET", `/batches/${id}`),
  startBatch: (limit: number) => call<{ batch_id: number }>("POST", "/batches", { limit }),
  sweep: () => call<{ batch_id: number; queued: number }>("POST", "/batches/sweep"),
  retryBatch: (id: number) => call<{ requeued: number }>("POST", `/batches/${id}/retry`),
  gaps: (id: string) => call<GapList>("GET", `/ui/jobs/${id}/gaps`),
  gapHelp: (id: string, kind: GapKind, requirement: string, refresh = false) =>
    call<GapHelp>("POST", `/ui/jobs/${id}/gaps/help`, { kind, requirement, refresh }),
  draft: (id: string, body: { kind: GapKind; requirement: string; entry_id: string; story: string; proof?: string }) =>
    call<Draft>("POST", `/ui/jobs/${id}/gaps/draft`, body),
  answer: (id: string, body: AnswerBody) =>
    call<{ outcome: string; bullet_id: string | null; rescore_batch: number; rescore_error?: string | null }>("POST", `/ui/jobs/${id}/gaps/answer`, body),
  rescore: (id: string) => call<{ rescore_batch: number }>("POST", `/ui/jobs/${id}/rescore`),
  prompt: (id: string) => call<{ prompt: string }>("GET", `/ui/jobs/${id}/prompt`),
  tailorStatus: (id: string) => call<TailorStatus>("GET", `/ui/jobs/${id}/tailor`),
  tailorNow: (id: string) => call<{ tailor_batch: number }>("POST", `/ui/jobs/${id}/tailor`),
  rescoreAllStatus: () => call<{ changed: boolean; candidates: number }>("GET", "/ui/rescore-all"),
  rescoreAll: () => call<{ batch_id: number; queued: number }>("POST", "/ui/rescore-all")
};

export type TailorStatus = {
  score: number | null; band: string | null; open_questions: number; tailored: boolean; busy: boolean;
  ready: boolean; can_tailor: boolean; reasons: string[];
  // What Tailor now would do (it decides on the job's score).
  plan: { decision: string; reason: string; open_risks: string[] } | null;
  last: { at: string; state: string; ok: boolean; message: string } | null;
};

// Shared labels and helpers.
export const STATE_LABEL: Record<Pipeline, string> = {
  new: "New", parsing: "Parsing", scoring: "Scoring", tailoring: "Tailoring", parsed: "Parsed (not scored)", to_tailor: "Ready to tailor", tailored: "Tailored",
  not_tailored: "Not tailored", failed: "Failed", skipped: "Skipped"
};
export const APP_LABEL: Record<AppStatus, string> = {
  interested: "Interested", applied: "Applied", interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn"
};
export const bandClass = (band: string | null) => (band ? `band-${band}` : "band-none");
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

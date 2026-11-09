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
  kept: boolean; // Keep this job: never skipped by skip words, never in a bulk delete
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
// An answer given on another job (or in the skills list: from_job null). match: exact (same
// ask), learned (a pair you confirmed), model (the judge says same; yours to confirm), overlap
// (shares key words; not checked by the model yet).
export type Previous = {
  from_job: string | null; company: string; title: string; requirement: string; kind: GapKind | null;
  answer: GapAnswer; outcome: string | null; match: "exact" | "learned" | "model" | "overlap";
  input: EarlierInput | null;
};
// What was typed with an earlier "have" or "other name" answer, to fill a form from.
export type EarlierInput = { answer: GapAnswer; story: string; proof: string; entry_ids: string[]; same_as: string;
  relation?: "same" | "related"; bullet_ids?: string[] };
export type CarriedFrom = { job_id: string | null; requirement: string; company: string; title: string; match: Previous["match"] };
export type Gap = {
  kind: GapKind; requirement: string; note: string | null; known_as: string | null; help: GapHelp | null;
  help_queued: boolean; // its explanation is queued or running (Mac worker, one at a time)
  answer: GapAnswer | null; outcome: string | null; updated_at: string | null;
  carried_from: CarriedFrom | null; carried_input: EarlierInput | null; declined: boolean;
  reuse: { exact: Previous | null; similar: Previous[] };
};
// "Why delete it?": suggested words (the title's, the JD's keywords), the skip words already
// saved, and the words of your own target roles (never allowed as skip words).
// Jobs with one of your skip words (title or description); kept: marked applied/interview/offer,
// never in a bulk delete.
// A ticked board job in the delete panel: resumes it would lose, tracking status, keep mark.
export type BulkItem = { id: string; title: string; company: string; resumes: number; status: string | null; kept: boolean };
export type SkipMatch = { id: string; title: string; company: string; word: string; status: string | null; resumes: number };
export type SkipMatches = { keywords: string[]; jobs: SkipMatch[]; kept: SkipMatch[] };
export type DeleteHints ={ title: string[]; keywords: string[]; current: string[]; protected: string[] };
export type DeleteResult = {
  deleted: boolean; resumes: number; files: number; tasks: number;
  keywords_added: string[]; keywords_refused: string[]; keywords_error: string | null;
};
export type MatchStats ={ gaps: number; checked: number; same: number; failed: number; error: string | null };
export type Rescored = { rescore_batch: number; rescore_error?: string | null; rescore_skipped?: boolean };
export type GapEntry = { id: string; title: string; company: string | null; dates: string; project: boolean; bullets: number; end: number | null;
  bullet_list: { id: string; short: string }[] };
export type GapList = { gaps: Gap[]; not_asked: { kind: GapKind; requirement: string; reason: string }[]; years: string | null; entries: GapEntry[] };
export type Draft = { text: string; tags: string[]; codes: string[]; skills: string[]; words?: string[] };
export type AnswerBody = {
  kind: GapKind; requirement: string; answer: GapAnswer;
  entry_id?: string; text?: string; tags?: string[]; story?: string; proof?: string; same_as?: string;
  as_skill?: boolean; entry_ids?: string[]; extra_skills?: string[];
  draft_codes?: string[]; // the codes the draft had (kept with the answer)
  with_skill?: boolean; // the bullet answer also saves the skill
  from_previous?: { from_requirement: string }; // answered from an earlier answer to that ask
  // other_name: same thing (another spelling, the default) or related work on these bank bullets.
  relation?: "same" | "related"; bullet_ids?: string[];
};

export type Service = { name: string; role: string; up: boolean | null; detail: string; start: string };

export type StageCount = { queued: number; leased: number; done: number; failed: number };
export type Batch = {
  id: number; limit: number; created_at: string; running: boolean; stages: Record<string, StageCount>;
  failed?: { id: number; job_id: string; stage: string; attempts: number; error_code?: string; error_detail?: string }[];
  tailored: number; skipped?: Record<string, number>;
};

// Check tab: the resume against the job's score, the chat check's rounds and report.
type Line = { id: string; text: string };
export type CheckRound = {
  version: number; resume_id: string; engine_score: number; chat_score: number | null; kept: boolean; current: boolean;
  added: Line[]; removed: Line[]; reworded: { id: string; before: string; after: string }[];
};
export type CheckSettings = { auto_check: boolean; source: "claude" | "chatgpt" };
export type ResumeRow = {
  resume_id: string; made_by: string; engine_score: number; chat_score: number | null;
  created_at: string; pdf: boolean; current: boolean;
};
export type CheckView = {
  resumes: ResumeRow[];
  job_score: number | null;
  resume: null | { resume_id: string; decision: string; engine_score: number; job_score: number; pdf: boolean;
    lost: { requirement: string; kind: string; job_credit: number; resume_credit: number }[] };
  loops: {
    source: string; stopped: string | null; rounds: CheckRound[];
    candidate: null | { resume_id: string; engine_score: number; start_score: number; added: Line[]; removed: Line[]; reworded: { id: string; before: string; after: string }[] };
    decision: null | "new" | "previous" | "chosen"; chosen: string | null;
  }[];
  reports: { source: string; fit_score: number | null; missed_gaps: { requirement: string; why: string }[];
    bullet_notes: { bullet_id: string; note: string }[]; from_memory: { fact: string; fills_gap: string }[] }[];
};

// A job added by its link: queued for parse/score (batch_id), or why not (queue_note).
export type AddedJob = {
  job_id: string; company: string; title: string; created: boolean;
  batch_id: number | null; stage: string | null; queue_note: string | null;
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
    this.name = "ApiError"; // clientLog.ts skips these: the API logged the failed request
  }
}

export const api = {
  board: () => call<{ jobs: Card[] }>("GET", "/ui/board").then((r) => r.jobs),
  // One card (the change feed re-reads only the job that changed); null: the job is gone.
  check: (id: string) => call<CheckView>("GET", `/ui/jobs/${id}/check`),
  checkSettings: () => call<CheckSettings>("GET", "/ui/check/settings"),
  setCheckSettings: (s: Partial<CheckSettings>) => call<CheckSettings>("POST", "/ui/check/settings", s),
  // End of a check: "new" / "previous", or any version by resume_id (Choose this). Re-scores.
  decideCheck: (id: string, source: string, choice: { use?: "new" | "previous"; resume_id?: string }) =>
    call<{ resume_id: string; version: number; rescore_batch: number | null; rescore_error?: string }>("POST", `/ui/jobs/${id}/check/decide`, { source, ...choice }),
  // Restart the chat check for one site: its rounds are kept as a file; the next check opens a new chat.
  restartCheck: (id: string, source: string) => call<{ archived: string | null }>("POST", `/ui/jobs/${id}/check/restart`, { source }),
  chooseResume: (id: string, rid: string) =>
    call<{ resume_id: string; pdf_error: string | null; rescore_batch: number | null; rescore_error?: string }>("POST", `/ui/jobs/${id}/resumes/${encodeURIComponent(rid)}/choose`),
  pdfUrl: (resumeId: string) => `/api/ui/resumes/${encodeURIComponent(resumeId)}/pdf`,
  card: (id: string) => call<{ job: Card | null }>("GET", `/ui/board/${id}`).then((r) => r.job),
  addJob: (url: string) => call<AddedJob>("POST", "/ui/jobs/add", { url }),
  health: () => call<{ services: Service[] }>("GET", "/ui/health").then((r) => r.services),
  job: (id: string) => call<JobDetail>("GET", `/ui/jobs/${id}`),
  score: (id: string) => call<ScoreDetail>("GET", `/ui/jobs/${id}/score`),
  setApplication: (id: string, status: AppStatus | null, note?: string | null) =>
    call<Application>("PUT", `/ui/jobs/${id}/application`, note === undefined ? { status } : { status, note }),
  addTask: (id: string, text: string) => call<Application>("POST", `/ui/jobs/${id}/tasks`, { text }),
  patchTask: (id: string, taskId: string, patch: { done?: boolean; remove?: boolean }) =>
    call<Application>("PATCH", `/ui/jobs/${id}/tasks/${taskId}`, patch),
  skipMatches: () => call<SkipMatches>("GET", "/ui/skip-matches"),
  bulkPreview: (ids: string[]) => call<BulkItem[]>("POST", "/ui/jobs/bulk-delete/preview", { ids }),
  bulkDelete: (ids: string[], include_applied: boolean) =>
    call<{ deleted: number; resumes: number; left_applied: number; refused: { title: string; company: string; message: string }[] }>("POST", "/ui/jobs/bulk-delete", { ids, include_applied }),
  keepJob: (id: string, keep: boolean) => call<{ kept: boolean }>("POST", `/ui/jobs/${id}/keep`, { keep }),
  deleteSkipMatches: (ids: string[]) =>
    call<{ deleted: number; resumes: number; files: number; refused: { title: string; company: string; message: string }[]; skipped: number }>("POST", "/ui/skip-matches/delete", { ids }),
  deleteHints: (id: string) => call<DeleteHints>("GET", `/ui/jobs/${id}/delete-hints`),
  deleteJob: (id: string, why: { reason?: string; keywords?: string[] } = {}) => call<DeleteResult>("DELETE", `/ui/jobs/${id}`, why),
  batches: () => call<Batch[]>("GET", "/batches"),
  batch: (id: number) => call<Batch>("GET", `/batches/${id}`),
  startBatch: (limit: number) => call<{ batch_id: number }>("POST", "/batches", { limit }),
  sweep: () => call<{ batch_id: number; queued: number }>("POST", "/batches/sweep"),
  retryBatch: (id: number) => call<{ requeued: number }>("POST", `/batches/${id}/retry`),
  gaps: (id: string) => call<GapList>("GET", `/ui/jobs/${id}/gaps`),
  // A saved explanation ({ help }), or queued for the Mac worker ({ queued }): the change feed
  // says when it is saved.
  gapHelp: (id: string, kind: GapKind, requirement: string, refresh = false) =>
    call<{ help?: GapHelp; queued?: boolean; batch_id?: number }>("POST", `/ui/jobs/${id}/gaps/help`, { kind, requirement, refresh }),
  gapHelpAll: (id: string) => call<{ queued: number; batch_id: number }>("POST", `/ui/jobs/${id}/gaps/help-all`),
  draft: (id: string, body: { kind: GapKind; requirement: string; entry_id: string; story: string; proof?: string }) =>
    call<Draft>("POST", `/ui/jobs/${id}/gaps/draft`, body),
  answer: (id: string, body: AnswerBody) =>
    call<{ outcome: string; bullet_id: string | null; rescore_batch: number; rescore_error?: string | null }>("POST", `/ui/jobs/${id}/gaps/answer`, body),
  gapSettings: () => call<{ auto_carry: boolean }>("GET", "/ui/gaps/settings"),
  setGapSettings: (auto_carry: boolean) => call<{ auto_carry: boolean }>("POST", "/ui/gaps/settings", { auto_carry }),
  carry: (id: string) => call<{ carried: number } & Rescored>("POST", `/ui/jobs/${id}/gaps/carry`),
  matchSimilar: (id: string) => call<MatchStats>("POST", `/ui/jobs/${id}/gaps/match`),
  reuse: (id: string, body: { kind: GapKind; requirement: string; from_job: string | null; from_requirement: string; accept: boolean }) =>
    call<{ outcome: string } & Rescored>("POST", `/ui/jobs/${id}/gaps/reuse`, body),
  undoCarry: (id: string, requirement: string) => call<{ ok: boolean }>("POST", `/ui/jobs/${id}/gaps/undo`, { requirement }),
  rescore: (id: string) => call<{ rescore_batch: number }>("POST", `/ui/jobs/${id}/rescore`),
  prompt: (id: string) => call<{ prompt: string }>("GET", `/ui/jobs/${id}/prompt`),
  tailorStatus: (id: string) => call<TailorStatus>("GET", `/ui/jobs/${id}/tailor`),
  // fresh: Re-tailor from scratch (earlier versions do not start it; it builds from the bank).
  tailorNow: (id: string, fresh = false) => call<{ tailor_batch: number }>("POST", `/ui/jobs/${id}/tailor`, fresh ? { fresh } : undefined),
  approveWording: (id: string, rid: string, bullet_id: string) =>
    call<{ bullet_id: string; terms: string[]; pdf_error: string | null }>("POST", `/ui/jobs/${id}/resumes/${rid}/approve-wording`, { bullet_id }),
  approveVerify: (id: string, rid: string, kind: string, itemId: string) =>
    call<{ resume_id: string; kind: string; id: string; pdf_error: string | null }>("POST", `/ui/jobs/${id}/resumes/${rid}/approve-verify`, { kind, id: itemId }),
  rescoreAllStatus: () => call<{ changed: boolean; candidates: number }>("GET", "/ui/rescore-all"),
  rescoreAll: () => call<{ batch_id: number; queued: number }>("POST", "/ui/rescore-all")
};

export type TailorStatus = {
  score: number | null; band: string | null; open_questions: number; tailored: boolean; busy: boolean;
  ready: boolean; can_tailor: boolean; reasons: string[];
  // What Tailor now would do (it decides on the job's score).
  plan: { decision: string; reason: string; open_risks: string[] } | null;
  last: { at: string; state: string; ok: boolean; message: string; left_out?: { bullet_id: string; codes: string[] }[] } | null;
  // Reworded lines with a related keyword's first use, waiting for "Approve wording".
  pending_review: { resume_id: string; bullet_id: string; keyword: string; text: string }[];
  // Items the verifier did not confirm (claim, summary, skill), waiting for "Approve".
  verify_review: { resume_id: string; kind: "claim" | "summary" | "skill"; id: string; code: string; text: string; evidence?: string }[];
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

// Add a job by its link (UI top bar): fetch the posting, store it, mark it kept (you chose it, so
// the preference check before a batch never skips it), then queue parse and score. No tailoring:
// that stays the user's click (Tailor now). Same fetch as `job add <url>` (jobs/from-url.ts).
import type { Db } from "../db.ts";
import { fetchJob } from "../jobs/from-url.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { setKept } from "../jobs/delete.ts";
import { loadPreferences } from "../profile/bank.ts";
import { addJob, QueueDownError } from "../queue/client.ts";
import { event, shortId, warnEvent } from "../log.ts";
import { publish } from "../events/bus.ts";

// code: "deleted_before" when the user deleted this posting earlier (the UI then offers
// "Add it anyway"); "add_refused" for everything else. deleted_at: when it was deleted.
export class AddRefused extends Error {
  readonly code: "add_refused" | "deleted_before";
  readonly deleted_at?: string;
  constructor(message: string, code: "add_refused" | "deleted_before" = "add_refused", deleted_at?: string) {
    super(message);
    this.code = code;
    this.deleted_at = deleted_at;
  }
}

export const deletedDay = (iso: string) => iso.slice(0, 10);

// Job sites whose terms forbid automated reading (and LinkedIn logins are at stake): never
// fetched. The user pastes the company's own link ("Apply on company website") instead.
const REFUSED: [RegExp, string][] = [
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, "LinkedIn"],
  [/(^|\.)naukri\.com$/, "Naukri"],
  [/(^|\.)indeed\.[a-z.]+$/, "Indeed"],
  [/(^|\.)glassdoor\.[a-z.]+$/, "Glassdoor"],
  [/(^|\.)foundit\.[a-z.]+$|(^|\.)monster\.[a-z.]+$/, "foundit/Monster"],
  [/(^|\.)instahyre\.com$|(^|\.)iimjobs\.com$|(^|\.)hirist\.[a-z.]+$|(^|\.)wellfound\.com$/, "this job site"]
];

export function checkLink(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AddRefused("That is not a link. Paste the job's full address (https://…).");
  }
  if (!/^https?:$/.test(u.protocol)) throw new AddRefused("The link must start with http:// or https://.");
  const host = u.hostname.toLowerCase();
  const hit = REFUSED.find(([re]) => re.test(host));
  if (hit) {
    throw new AddRefused(`${hit[1]} links are not read automatically (their terms forbid it). Open the job there, `
      + `click "Apply on company website", and paste that link instead.`);
  }
  return u;
}

export type Added = {
  job_id: string; company: string; title: string; created: boolean;
  batch_id: number | null; stage: string | null; queue_note: string | null;
  // Add it anyway: skip words that delete saved stay in preferences.yaml (they apply to other jobs).
  // Empty unless the deleted row had skip words.
  skip_words_kept: string[];
};

export async function addByLink(db: Db, raw: string, opts: { undelete?: boolean } = {}): Promise<Added> {
  const url = checkLink(raw).toString();
  let known = new Map<string, string>();
  try {
    known = new Map(loadPreferences().companies.include.map((c) => [c.slug.toLowerCase(), c.name]));
  } catch {
    // No preferences yet: the name comes from the board or the page.
  }
  let input;
  try {
    input = await fetchJob(url, { known });
  } catch (err) {
    throw new AddRefused(err instanceof Error ? err.message : String(err));
  }
  const repo = createJobRepository(db);
  const deleted = repo.deletedRows(input);
  if (deleted.length && !opts.undelete) {
    const at = deleted[0].deleted_at;
    throw new AddRefused(`You deleted this job on ${deletedDay(at)}, so it is not added again.`, "deleted_before", at);
  }
  // Add it anyway: forget the delete (same link or same content), then add as usual.
  if (deleted.length) repo.removeDeleted(input);
  const { job, created } = repo.upsert(input);
  setKept(db, job.id, true);
  publish({ kind: "job", job_id: job.id, state: created ? "added" : "changed" });
  if (deleted.length) event(`job added anyway (deleted ${deletedDay(deleted[0].deleted_at)}): ${job.company} · ${job.title}`);
  else event(`job ${created ? "added" : "added again"} by link (job ${shortId(job.id)}): ${job.company} · ${job.title}`);

  const out: Added = { job_id: job.id, company: job.company, title: job.title, created, batch_id: null, stage: null, queue_note: null,
    skip_words_kept: [...new Set(deleted.flatMap((d) => d.keywords))] };
  try {
    const q = await addJob(job.id);
    out.batch_id = q.batch_id;
    out.stage = q.stage;
    event(`add queued (job ${shortId(job.id)}): batch ${q.batch_id}, ${q.stage}`);
  } catch (err) {
    out.queue_note = err instanceof QueueDownError
      ? "The queue is not running, so it is not parsed or scored yet. Use Re-score in the drawer once it is up."
      : /status 409/.test(String(err)) ? "It is already being parsed or scored."
      : "Could not queue it: " + (err instanceof Error ? err.message : String(err));
    warnEvent(`add not queued (job ${shortId(job.id)}): ${out.queue_note}`);
  }
  return out;
}

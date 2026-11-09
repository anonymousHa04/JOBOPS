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

export class AddRefused extends Error {}

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
};

export async function addByLink(db: Db, raw: string): Promise<Added> {
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
  if (repo.isDeleted(input)) throw new AddRefused("You deleted this job earlier, so it is not added again.");
  const { job, created } = repo.upsert(input);
  setKept(db, job.id, true);
  publish({ kind: "job", job_id: job.id, state: created ? "added" : "changed" });
  event(`job ${created ? "added" : "added again"} by link (job ${shortId(job.id)}): ${job.company} · ${job.title}`);

  const out: Added = { job_id: job.id, company: job.company, title: job.title, created, batch_id: null, stage: null, queue_note: null };
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

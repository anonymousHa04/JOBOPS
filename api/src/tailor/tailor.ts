import type { Db } from "../db.ts";
import type { Bank, ResumeRecord, SkillsExtra } from "../profile/schema.ts";
import type { Requirements } from "../requirements/schema.ts";
import { riskCheck } from "../scoring/risk.ts";
import type { Risk } from "../scoring/risk.ts";
import { needsJudge, scoreRequirements, totalYears } from "../scoring/score.ts";
import { pageCount } from "../render/render.ts";
import type { Verdicts } from "../scoring/score.ts";
import { decide, pickStart } from "./decide.ts";
import type { Decision, StoredRecord } from "./decide.ts";
import { idealContent } from "./ideal.ts";
import type { Budget, ResumeContent } from "./ideal.ts";
import { originalContent, toStored, writeRecord } from "./records.ts";
import { rewordContent, rewordModel } from "./reword.ts";
import { lintRecord, sameCompany } from "./lint.ts";
import type { Finding } from "./lint.ts";
import { TAILORED_BANDS } from "../scoring/config.ts";
import type { RewordLog } from "./reword.ts";

// One JD through the engine (engine-algorithm.md §4): starting record, ideal content,
// decision, risk gate, rewording, record. Results carry ids, scores, and questions;
// never resume text.

export type Plan = {
  decision: Decision;
  start: StoredRecord | null;
  ideal: ResumeContent;
  risks: Risk[];
  unjudged: number; // requirements still waiting for the judge (dry runs use the cache only)
  same_company: { records: string[]; versions: number; warnings: Finding[] };
};

// Where each JD's company is known: lets the engine keep one version per company.
export type Companies = { company: string; companyOf: (jdId: string) => string | undefined };

// Records that can start a new one: real resumes, not not_tailored entries. The
// original resume counts even before its record is written.
function candidates(records: ResumeRecord[], bank: Bank): StoredRecord[] {
  const usable = records.filter((r) => r.decision !== "not_tailored").map((r) => toStored(r, bank));
  if (!usable.some((r) => r.resume_id === "original")) usable.unshift({ resume_id: "original", content: originalContent(bank) });
  return usable;
}

export function planJob(
  req: Requirements,
  jobId: string,
  records: ResumeRecord[],
  bank: Bank,
  extra: SkillsExtra,
  budget: Budget,
  verdicts: Verdicts,
  force = false,
  companies?: Companies
): Plan {
  const o = { jobId, verdicts };
  const sc = companies ? sameCompany(companies.company, records, companies.companyOf) : { records: [], versions: 0, warnings: [] };
  // Same company (§4 step 8): start from that company's record while it still fits the JD
  // (tailorable band); otherwise the best record overall.
  const own = candidates(records, bank).filter((r) => sc.records.includes(r.resume_id));
  const ownBest = pickStart(own, req, bank, extra, o);
  const start = (ownBest && TAILORED_BANDS.includes(ownBest.score.band) ? ownBest : pickStart(candidates(records, bank), req, bank, extra, o))?.record ?? null;
  const ideal = idealContent(req, bank, extra, budget, { ...o, start: start?.content });
  const risks = riskCheck(req, bank, extra, ideal.bullets.map((b) => b.id), jobId, verdicts);
  const decision = decide(ideal, start, req, bank, extra, risks, { ...o, force });
  const unjudged = needsJudge(req, bank, extra).filter((r) => !verdicts.has(r)).length;
  return { decision, start, ideal, risks, unjudged, same_company: sc };
}

export type TailorResult = {
  job_id: string;
  decision: Decision["decision"] | "blocked";
  reason: string;
  band: string;
  score: number;
  equivalence: number | null;
  start: string | null;
  flags: Decision["flags"];
  questions: { id: string; question: string }[]; // open risks; answer them or use --force
  resume_id: string | null;
  path: string | null;
  created: boolean;
  reworded: RewordLog[];
  lint: Finding[]; // the written record's lint, tenure, and same-company findings
  error: string | null;
};

// Tailor one JD and write its record. Reuse writes the starting record's content as
// this JD's record; adapt rewords the marked bullets first; not_tailored records the
// reason. A blocked adapt (open risks, no --force) writes nothing.
export async function tailorJob(
  db: Db,
  req: Requirements,
  jobId: string,
  records: ResumeRecord[],
  bank: Bank,
  extra: SkillsExtra,
  budget: Budget,
  verdicts: Verdicts,
  opts: { force?: boolean; baseUrl?: string; companies?: Companies; notes?: { bullet_id: string; note: string }[] } = {}
): Promise<TailorResult> {
  const plan = planJob(req, jobId, records, bank, extra, budget, verdicts, opts.force, opts.companies);
  const d = plan.decision;
  const base = {
    job_id: jobId, reason: d.reason, band: d.band, score: d.score, equivalence: d.equivalence,
    start: plan.start?.resume_id ?? null, flags: d.flags,
    questions: plan.risks.map((r) => ({ id: r.id, question: r.question }))
  };
  if (d.risk_gate.blocked) {
    return { ...base, decision: "blocked", reason: `open risks: ${d.risk_gate.open.join(", ")}`,
      resume_id: null, path: null, created: false, reworded: [], lint: plan.same_company.warnings, error: null };
  }

  // The original resume is the first record.
  if (!records.some((r) => r.resume_id === "original")) {
    writeRecord(db, bank, { jd_id: "original", source_resume_id: null, decision: "original", reason: "original resume",
      band: null, score: null, equivalence: null, flags: { unsupported_must_haves: [], risks: [] },
      review_findings: [], changes: [], evidence_refs: [], content: originalContent(bank) });
  }

  let content = d.decision === "reuse" && plan.start ? plan.start.content : plan.ideal;
  let changes: ResumeRecord["changes"] = [];
  let reworded: RewordLog[] = [];
  let error: string | null = null;
  if (d.decision === "adapt") {
    const r = await rewordContent(plan.ideal, req, bank, extra, budget, { baseUrl: opts.baseUrl }, opts.notes);
    ({ content, changes, error } = r);
    reworded = r.log;
  }

  // Length: the user's tailoring.max_pages, else one page up to 8 years of experience and
  // two after (gaps-and-rejection-risks.md). Over the limit, drop the last-ranked bullet of the entry with the most bullets (never
  // an entry's only bullet) until it fits; each drop is logged in the record's changes.
  if (d.decision !== "not_tailored") {
    const fit = fitPages(content, bank, budget.max_pages ?? (totalYears(bank) <= 8 ? 1 : 2));
    content = fit.content;
    changes = [...changes, ...fit.dropped.map((b) => ({ bullet_id: b.id, from: b.text, to: null, reason: "dropped to fit the page limit" }))];
  }

  // Evidence for each requirement the record covers, as scored on its own bullets.
  const ids = content.bullets.map((b) => b.id);
  const scored = scoreRequirements(req, bank, extra, ids, jobId, verdicts);
  const evidence_refs = scored.items
    .filter((i) => i.credit > 0 && i.bullet_ids.length && i.kind !== "keyword")
    .map((i) => ({ requirement: i.requirement, bullet_ids: i.bullet_ids }));

  const { record, path, created } = writeRecord(db, bank, {
    jd_id: jobId, source_resume_id: plan.start?.resume_id ?? null, decision: d.decision, reason: d.reason,
    band: d.band, score: d.score, equivalence: d.equivalence, flags: d.flags,
    review_findings: [], changes, evidence_refs, content,
    meta: reworded.length ? { model: rewordModel() } : undefined
  });
  const lint = d.decision === "not_tailored" ? [] : [...lintRecord(record, bank, extra), ...plan.same_company.warnings];
  return { ...base, decision: d.decision, resume_id: record.resume_id, path, created, reworded, lint, error };
}

export type DryRow = {
  job_id: string;
  company: string;
  title: string;
  decision: Decision["decision"];
  band: string;
  score: number;
  equivalence: number | null;
  start: string | null;
  blocked: boolean;
  to_reword: number;
  unsupported_must_haves: string[];
  unjudged: number;
  same_company: string[]; // warning codes
};

// `tailor --all --dry-run` (§4 step 7): the decision for every parsed JD and every
// open risk question, with cached judge verdicts only; no model calls, no files.
export function dryRunAll(
  jobs: { job_id: string; company: string; title: string; req: Requirements; verdicts: Verdicts }[],
  records: ResumeRecord[],
  bank: Bank,
  extra: SkillsExtra,
  budget: Budget,
  companyOf: (jdId: string) => string | undefined = () => undefined
): { rows: DryRow[]; questions: { id: string; question: string; job_ids: string[] }[] } {
  const rows: DryRow[] = [];
  const questions = new Map<string, { id: string; question: string; job_ids: string[] }>();
  for (const j of jobs) {
    const p = planJob(j.req, j.job_id, records, bank, extra, budget, j.verdicts, false, { company: j.company, companyOf });
    const d = p.decision;
    rows.push({
      job_id: j.job_id, company: j.company, title: j.title, decision: d.decision, band: d.band, score: d.score,
      equivalence: d.equivalence, start: p.start?.resume_id ?? null, blocked: d.risk_gate.blocked,
      to_reword: d.decision === "adapt" ? p.ideal.bullets.filter((b) => b.reword).length : 0,
      unsupported_must_haves: d.flags.unsupported_must_haves, unjudged: p.unjudged,
      same_company: p.same_company.warnings.map((w) => w.code)
    });
    for (const r of p.risks) {
      // Same id, different wording (each job's "keywords" lists its own): kept apart.
      const key = `${r.id}\n${r.question}`;
      const q = questions.get(key) ?? { id: r.id, question: r.question, job_ids: [] };
      q.job_ids.push(j.job_id);
      questions.set(key, q);
    }
  }
  rows.sort((a, b) => b.score - a.score || a.job_id.localeCompare(b.job_id));
  return { rows, questions: [...questions.values()] };
}

// Drops bullets until the resume renders within maxPages (render.ts pageCount). Content
// order inside an entry is by rank, so an entry's last bullet is its weakest.
export function fitPages(content: ResumeContent, bank: Bank, maxPages: number): { content: ResumeContent; dropped: { id: string; text: string }[] } {
  let bullets = [...content.bullets];
  const dropped: { id: string; text: string }[] = [];
  const record = (bs: typeof bullets) => ({ resume_id: "fit", content: { ...content, bullets: bs } }) as unknown as ResumeRecord;
  for (;;) {
    const pages = pageCount(record(bullets), bank);
    if (pages === null || pages <= maxPages) break;
    const per = new Map<string, number>();
    for (const b of bullets) per.set(b.entry_id, (per.get(b.entry_id) ?? 0) + 1);
    // The entry with the most bullets; on a tie, the older one (later in bank order).
    const order = [...bank.roles, ...bank.projects].map((e) => e.id);
    const target = [...per].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || order.indexOf(b[0]) - order.indexOf(a[0]))[0]?.[0];
    if (!target) break;
    const last = bullets.map((b) => b.entry_id).lastIndexOf(target);
    dropped.push({ id: bullets[last].id, text: bullets[last].text });
    bullets = bullets.filter((_, i) => i !== last);
  }
  return { content: { ...content, bullets }, dropped };
}

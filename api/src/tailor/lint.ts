import { vocabulary } from "../profile/bank.ts";
import type { Bank, ResumeRecord, SkillsExtra } from "../profile/schema.ts";
import { span, totalYears } from "../scoring/score.ts";
import { hasTerm, norm, SYNONYMS } from "../scoring/terms.ts";
import { metricLed } from "./ideal.ts";

// Resume lint (gaps-and-rejection-risks.md §3), tenure/gaps (§2 recruiter scan), and the
// same-company warning (engine-algorithm.md §4 step 8). Lint reports; it never rewrites.
// Findings carry codes and ids, never resume text.

export type Finding = { code: string; detail: string; needs: "engine" | "user" | "manual" };

// Scope or outcome in a bullet: a number, a scale word, or an outcome verb.
const SIGNAL = /\d|\b(team|teams|services?|users?|customers?|engineers?|across|production|company|org|clients?|requests?|traffic|latency|uptime|throughput|cost|revenue|reduc\w*|cut|improv\w*|increas\w*|sav\w*|grew|scal\w*|launch\w*|migrat\w*)\b/gi;
const signals = (t: string) => (t.match(SIGNAL) ?? []).length;
const PLANNED = /\b(planned|planning|will|working on|in progress|going to)\b/i;
const SOFT = /\b(communication|leadership|team player|hard[- ]working|detail[- ]oriented|passionate|problem[- ]solving|self[- ]motivated)\b/i;
const FORMATS: [string, RegExp][] = [["Mon YYYY", /^[A-Za-z]{3,9}\.? \d{4}$/], ["MM/YYYY", /^\d{1,2}\/\d{4}$/], ["YYYY", /^\d{4}$/]];
const SHORT_TENURE_MONTHS = 12;
const GAP_MONTHS = 6;
export const SAME_COMPANY_MAX = 3;

function editDistance1(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function lintRecord(record: ResumeRecord, bank: Bank, extra: SkillsExtra, opts: { pages?: number; now?: Date } = {}): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, detail: string, needs: Finding["needs"]) => out.push({ code, detail, needs });
  const bullets = record.content.bullets;
  const byEntry = new Map<string, typeof bullets>();
  for (const b of bullets) byEntry.set(b.entry_id, [...(byEntry.get(b.entry_id) ?? []), b]);
  const roles = bank.roles.filter((r) => byEntry.has(r.id)); // bank order: most recent first

  // Top third and inverted evidence: the most recent role should lead with scope and outcome.
  if (roles.length) {
    const top = byEntry.get(roles[0].id) ?? [];
    const duty = top.slice(0, 2).filter((b) => signals(b.text) === 0);
    if (duty.length) add("top_third_weak", duty.map((b) => b.id).join(","), "user");
    const avg = (bs: typeof bullets) => bs.reduce((n, b) => n + signals(b.text), 0) / Math.max(bs.length, 1);
    const older = roles.slice(1).flatMap((r) => byEntry.get(r.id) ?? []);
    if (older.length && avg(top) < avg(older)) add("inverted_evidence", roles[0].id, "user");
  }
  for (const b of bullets) {
    if (signals(b.text) === 0) add("no_scope_or_outcome", b.id, "user");
    if (PLANNED.test(b.text)) add("planned_work", b.id, "user");
  }
  // Skills shown in no bullet (interviewers probe them); soft skills listed as skills.
  const vocab = new Set([...vocabulary(bank, extra)].map(norm));
  const tagged = new Set(bank.roles.concat(bank.projects).flatMap((e) => e.bullets).filter((b) => bullets.some((x) => x.id === b.id)).flatMap((b) => b.tags.map(norm)));
  record.content.skills.forEach((s, i) => {
    if (SOFT.test(s)) add("soft_skill_listed", `skill#${i + 1}`, "engine");
    else if (!tagged.has(norm(s)) && !bullets.some((b) => hasTerm(b.text, s))) add("skill_not_evidenced", `skill#${i + 1}`, "engine");
  });
  // Length: one page up to about 8 years of experience.
  if (opts.pages !== undefined && opts.pages > 1 && totalYears(bank, opts.now) <= 8) add("too_long", `${opts.pages} pages`, "engine");
  // Spelling: a word one letter away from a known term ("Kubernates") is likely a typo.
  const known = [...vocab, ...Object.keys(SYNONYMS), ...Object.values(SYNONYMS)].filter((k) => k.length >= 5 && !k.includes(" "));
  for (const b of bullets) {
    for (const w of new Set(b.text.toLowerCase().match(/[a-z][a-z0-9.+#-]{4,}/g) ?? [])) {
      // A word that only extends a known one ("template" / "templates") or differs only in
      // punctuation ("on-call" / "oncall") is not a typo.
      const bare = (x: string) => x.replace(/[-.]/g, "");
      const typo = (k: string) => editDistance1(w, k) && !w.startsWith(k) && !k.startsWith(w) && bare(w) !== bare(k);
      if (!known.includes(w) && known.some(typo)) { add("possible_typo", b.id, "user"); break; }
    }
  }
  // Verb variety and metric density.
  const first = bullets.map((b) => b.text.split(/\s+/)[0]?.toLowerCase() ?? "");
  const top = [...new Set(first)].map((v) => [v, first.filter((x) => x === v).length] as const).sort((a, b) => b[1] - a[1])[0];
  if (top && bullets.length >= 5 && top[1] / bullets.length > 0.4) add("same_opening_verb", `${top[1]}/${bullets.length}`, "user");
  for (const [entry, bs] of byEntry) if (bs.filter((b) => metricLed(b.text)).length > 2) add("metric_led_over_2", entry, "engine");
  // Links: profile entries must be full URLs, not labels like "LinkedIn".
  bank.basics.links.forEach((l, i) => { if (!/[a-z0-9-]+\.[a-z]{2,}\/\S+/i.test(l)) add("link_not_url", `link#${i + 1}`, "user"); });
  out.push(...tenure(bank, opts.now));
  add("check_linkedin", "titles and dates match LinkedIn", "manual");
  return out;
}

// Short tenures, gaps between roles, and mixed date formats (years computed wrong).
export function tenure(bank: Bank, now = new Date()): Finding[] {
  const out: Finding[] = [];
  // A year-only end ("2014 - 2017") means some time in that year: count it as December,
  // so it never shows up as a gap or a short tenure that is not there.
  const spans = bank.roles.map((r) => {
    const s = span(r.dates, now);
    const yearEnd = /^\d{4}$/.test(r.dates.split(/\s*(?:-|–|—|\bto\b)\s*/i).at(-1)?.trim() ?? "");
    return { id: r.id, s: s && yearEnd ? { start: s.start, end: s.end + 11 } : s };
  });
  for (const { id, s } of spans) {
    if (!s) out.push({ code: "date_unparsed", detail: id, needs: "user" });
    else if (s.end - s.start < SHORT_TENURE_MONTHS) out.push({ code: "short_tenure", detail: `${id}: ${s.end - s.start} months`, needs: "user" });
  }
  const sorted = spans.filter((x) => x.s).sort((a, b) => a.s!.start - b.s!.start);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].s!.start - sorted[i - 1].s!.end;
    if (gap > GAP_MONTHS) out.push({ code: "gap", detail: `${gap} months before ${sorted[i].id}`, needs: "user" });
  }
  const sides = bank.roles.flatMap((r) => r.dates.split(/\s*(?:-|–|—|\bto\b)\s*/i)).filter((d) => !/^(present|current|now)$/i.test(d.trim()));
  const kinds = new Set(sides.map((d) => FORMATS.find(([, re]) => re.test(d.trim()))?.[0] ?? "other"));
  if (kinds.size > 1) out.push({ code: "mixed_date_formats", detail: [...kinds].sort().join(","), needs: "user" });
  return out;
}

// Same company: one resume version across roles, and a warning above SAME_COMPANY_MAX
// applications (the recruiter sees every version in one ATS).
export function sameCompany(company: string, records: ResumeRecord[], companyOf: (jdId: string) => string | undefined): {
  records: string[]; versions: number; warnings: Finding[];
} {
  const mine = records.filter((r) => r.decision !== "not_tailored" && r.decision !== "original" && norm(companyOf(r.jd_id) ?? "") === norm(company));
  const versions = new Set(mine.map((r) => r.hashes.content)).size;
  const warnings: Finding[] = [];
  if (mine.length >= SAME_COMPANY_MAX) warnings.push({ code: "same_company_applications", detail: `${mine.length + 1} with this one`, needs: "user" });
  if (versions > 1) warnings.push({ code: "same_company_versions", detail: `${versions} versions`, needs: "user" });
  return { records: mine.map((r) => r.resume_id), versions, warnings };
}

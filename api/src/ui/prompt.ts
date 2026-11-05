// "Copy as prompt" (UI job drawer): the job, how it was scored, and the gaps, for the user's own
// Claude or ChatGPT chat to find their weak points. Never resume or bullet text, evidence, or
// contact details: only the JD's own wording, labels and numbers (user decision 2026-11-04).
import type { Db } from "../db.ts";
import { gaps } from "../extension/reports.ts";
import { loadRequirements } from "../requirements/parse.ts";
import { scoreDetail } from "./data.ts";

const MAX_JD = 12_000;

type JobRow = { title: string; company: string; location: string | null; description: string; source_url: string };

const ASK = `Please answer in plain prose, specific to me and this job:
1. The 3 to 5 weaknesses most likely to get me rejected, by an ATS keyword filter or by a recruiter, most serious first.
2. For each gap: is it more likely a wording problem (I may have the experience under another name) or a real gap? Name the other terms I might have used.
3. Questions I should ask myself to find evidence I already have.
4. For the real gaps: what to learn or build first, and roughly how long it takes.
5. Which requirements are deal-breakers, and which a hiring manager would likely overlook.
You have not seen my resume, so do not guess what it says, and don't invent facts about me. Don't save anything from this chat to your memory.`;

export function analysisPrompt(db: Db, jobId: string): { prompt: string } {
  const j = db.prepare("SELECT title, company, location, description, source_url FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!j) throw new Error("no job " + jobId);
  const s = scoreDetail(db, jobId);
  if ("error" in s) throw new Error(s.message);
  const req = loadRequirements(db, jobId);
  const g = gaps(db, jobId, null);
  const answers = db.prepare("SELECT requirement, outcome FROM gap_notes WHERE job_id = ? AND outcome IS NOT NULL").all(jobId) as { requirement: string; outcome: string }[];

  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const parts = (Object.keys(s.weights.parts) as (keyof typeof s.parts)[])
    .map((k) => `- ${k}: ${s.parts[k].toFixed(1)} of ${s.weights.parts[k]}`);
  const items = s.items.map((i) => `- [${i.kind}] ${i.requirement}: ${i.label} (credit ${i.credit})`);
  const jd = j.description.length > MAX_JD ? `${j.description.slice(0, MAX_JD)}\n[...cut]` : j.description;

  const sections = [
    `I'm a software engineer applying for ${j.title} at ${j.company}${j.location ? ` (${j.location})` : ""}. My local resume matcher scored my experience ${s.score.toFixed(1)} out of 100 (band: ${s.band}) for this job. I think I may be better qualified than that, perhaps because of keywords and wording. Help me see my real weaknesses for this job.`,
    `Job link: ${j.source_url}`,
    `Job description:\n"""\n${jd}\n"""`,
    `Parsed requirements:\nMust-haves:\n${list(req?.must_have ?? [])}\nNice-to-haves:\n${list(req?.nice_to_have ?? [])}\nKeywords:\n${list(req?.keywords ?? [])}`,
    [
      "How the score was calculated (points earned of points possible):",
      ...parts,
      ...(s.cap !== null ? [`Score cap: at most ${s.cap} (must-haves without evidence)`] : []),
      ...(s.hard.years_asked > 0 ? [`Years: the job asks ${s.hard.years_asked}+, I have ${s.hard.years_have}`] : [])
    ].join("\n"),
    `Each requirement against my experience (label and credit from 0 to 1):\n${items.join("\n")}`,
    ...(s.reasons.length ? [`Why it was not tailored:\n${list(s.reasons)}`] : []),
    `Gaps the matcher found:\nMust-haves without evidence:\n${list(g.must)}\nNice-to-haves not shown:\n${list(g.nice)}\nMissing keywords:\n${list(g.keywords)}`,
    ...(answers.length ? [`My answers so far:\n${answers.map((a) => `- ${a.requirement}: ${a.outcome}`).join("\n")}`] : []),
    ASK
  ];
  return { prompt: sections.join("\n\n") };
}

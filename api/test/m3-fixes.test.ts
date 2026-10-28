import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bank, ResumeRecord, SkillsExtra } from "../src/profile/schema.ts";
import type { Requirements } from "../src/requirements/schema.ts";
import { addRole, checkBank, excludeTitleWords, loadBank, markBreak, saveBank, setCompany, vocabulary } from "../src/profile/bank.ts";
import { degreeAsked, degreeHave, scoreRequirements, totalYears } from "../src/scoring/score.ts";
import { lintRecord, tenure } from "../src/tailor/lint.ts";
import { aiTellsIn, cleanText, hiddenChars } from "../src/tailor/writing.ts";
import { checkRewrite, guardedReword } from "../src/tailor/guard.ts";
import { checkText } from "../src/render/parseback.ts";
import { riskCheck } from "../src/scoring/risk.ts";
import { norm } from "../src/scoring/terms.ts";
import { idealContent } from "../src/tailor/ideal.ts";
import { renderRecord, resumeData } from "../src/render/render.ts";
import { detectBoard, jobLinks, jsonLdPostings, robotsAllows } from "../src/careers/crawl.ts";
import { boardOf, fetchJob, looksLikeJd } from "../src/jobs/from-url.ts";
import { openDb } from "../src/db.ts";
import { jobAdd } from "../src/tools.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync } from "node:fs";
import { judgeRequirements, judgeSettled } from "../src/scoring/judge.ts";
import { needsJudge } from "../src/scoring/score.ts";
import { fitPages } from "../src/tailor/tailor.ts";
import { MAX_SKILLS } from "../src/scoring/config.ts";

// Career breaks, degree and soft-skill must-haves, synonym-aware skill questions,
// preferences commands, the careers crawler's page reading, and `job add <url>`.
// Fake resume and saved responses only: no real profile, no network, no browser.
process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-fixes-"));
const tempProfile = () => (process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-fixes-")));

const bullet = (id: string, text: string, tags: string[]) =>
  ({ id, text, short: text, tags, impact: "medium" as const, source: "resume" as const });

const bank: Bank = {
  basics: { name: "Test Person", email: "test@example.com", phone: "0", location: "Bangalore", links: [] },
  summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
  roles: [
    {
      id: "cur", title: "Senior Engineer", company: "Acme", location: "Bangalore", dates: "Mar 2025 - Oct 2026",
      bullets: [
        bullet("cur-1", "Moved 20 services to Kubernetes", ["kubernetes", "backend"]),
        bullet("cur-2", "Presented the migration plan to four teams", ["migration", "planning"]),
        bullet("cur-3", "Built AI agents that check designs", ["ai agents", "automation"])
      ]
    },
    { id: "brk", title: "Career break (family)", dates: "Sep 2024 - Feb 2025", kind: "break", bullets: [] },
    {
      id: "old", title: "Engineer", company: "OldCo", location: "Pune", dates: "Jan 2020 - Aug 2024",
      bullets: [bullet("old-1", "Wrote the TypeScript billing service", ["typescript", "billing"])]
    }
  ],
  projects: [],
  education: [{ id: "edu", degree: "B.Tech in Mechanical Engineering", school: "Some University", dates: "2015 - 2019", details: [] }],
  skills: { languages: ["typescript"], frameworks: [], tools: ["kubernetes"], domains: ["AI Agents"] },
  approved: true
};
const extra: SkillsExtra = { skills: [], dismissed: [], learnable: [] };
const now = new Date("2026-10-28");
const req = (over: Partial<Requirements>): Requirements =>
  ({ role: "Backend Engineer", seniority: "senior", must_have: [], nice_to_have: [], keywords: [], themes: [], summary_variant: "backend", ...over });

// --- Career breaks ---

test("career break: adds no years and no short tenure, but leaves no gap", () => {
  // cur: 19 months, old: 55 months; the 5-month break is not counted.
  assert.equal(totalYears(bank, now), Math.round((74 / 12) * 10) / 10);
  const job = structuredClone(bank);
  job.roles[1].kind = "job";
  assert.ok(totalYears(job, now) > totalYears(bank, now));
  const codes = tenure(bank, now).map((f) => f.code);
  assert.ok(!codes.includes("short_tenure"), "a break is not a short job");
  assert.ok(!codes.includes("gap"), "the break covers its months");
  const noBreak = structuredClone(bank);
  noBreak.roles.splice(1, 1);
  assert.ok(tenure(noBreak, now).some((f) => f.code === "gap"), "without the break the months are a gap");
});

test("career break: a role titled like one is marked on save", () => {
  tempProfile();
  const b = structuredClone(bank);
  b.roles[1] = { id: "brk", title: "Sabbatical", dates: "Sep 2024 - Feb 2025", bullets: [] };
  saveBank(b);
  assert.equal(loadBank()!.roles[1].kind, "break");
});

test("bank mark-break: sets the title, drops company and location, refuses a role with bullets", () => {
  tempProfile();
  const b = structuredClone(bank);
  b.roles[1] = { id: "brk", title: "Gap", company: "Home", location: "Pune", dates: "Sep 2024 - Feb 2025", bullets: [] };
  saveBank(b);
  assert.deepEqual(markBreak("brk", "Career break (health)"), { id: "brk", dates: "Sep 2024 - Feb 2025" });
  const role = loadBank()!.roles[1];
  assert.deepEqual([role.kind, role.title, role.company, role.location], ["break", "Career break (health)", undefined, undefined]);
  assert.throws(() => markBreak("cur"), /has 3 bullets/);
});

const breakRecord = () => ({ resume_id: "fake", content: { summary_variant: "backend", summary_text: "Backend engineer.", skills: ["TypeScript", "Kubernetes"],
  bullets: [{ id: "cur-1", entry_id: "cur", text: "Moved 20 services to Kubernetes" }, { id: "old-1", entry_id: "old", text: "Wrote the TypeScript billing service" }] } }) as unknown as ResumeRecord;

test("render data: a career break appears in its place, shaped like a job (company line, then title)", () => {
  const data = resumeData(breakRecord(), bank);
  assert.deepEqual(data.experience.map((e) => [e.id, e.bullets.length]), [["cur", 1], ["brk", 0], ["old", 1]]);
  assert.deepEqual([data.experience[1].company, data.experience[1].title, data.experience[1].kind], ["Career break", "Family", "break"],
    "Workday reads a company line then a title line, and drops 'Career break' from the dated line");
});

// Third parse-back check (with pdftotext and pdf.js in render): OpenResume's resume
// parser (AGPL-3.0), run from its local copy in .scout/openresume-runner, never part of
// JobOps. Its phone and location patterns are US-only ("(xxx) xxx-xxxx", "City, ST"), so
// those two fields are not compared.
const OPENRESUME = join(import.meta.dirname, "..", "..", ".scout", "openresume-runner");
const hasOpenResume = existsSync(join(OPENRESUME, "node_modules", ".bin", "tsx")) && ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error);

test("OpenResume reads every entry back: titles, companies, dates, bullets, education, and the career break", { skip: !hasOpenResume && "OpenResume runner, typst, or pdftotext missing" }, async () => {
  tempProfile();
  const b = structuredClone(bank);
  b.basics = { ...b.basics, email: "test.person@example.com", links: ["https://github.com/testperson"] };
  const record = breakRecord();
  const r = await renderRecord(record, b);
  assert.ok(r.ok && r.path, JSON.stringify(r.issues));
  const run = spawnSync(join(OPENRESUME, "node_modules", ".bin", "tsx"), ["parse.ts", r.path!], { cwd: OPENRESUME, encoding: "utf8" });
  const json = run.stdout.split("\n").filter((l) => l.startsWith("{")).at(-1); // pdf.js prints warnings first
  assert.ok(json, run.stderr);
  const parsed = JSON.parse(json!) as {
    profile: Record<string, string>;
    workExperiences: { company: string; jobTitle: string; date: string; descriptions: string[] }[];
    educations: { school: string; degree: string; date: string }[];
    skills: { descriptions: string[] };
  };
  assert.deepEqual([parsed.profile.name, parsed.profile.email, parsed.profile.url, parsed.profile.summary],
    ["Test Person", "test.person@example.com", "github.com/testperson", "Backend engineer."]);
  assert.deepEqual(parsed.workExperiences.map((w) => [w.jobTitle, w.company, w.date, w.descriptions]), [
    ["Senior Engineer", "Acme, Bangalore", "Mar 2025 - Oct 2026", ["Moved 20 services to Kubernetes"]],
    ["", "Career break", "Sep 2024 - Feb 2025", []], // OpenResume finds titles by job words; "Family" is not one
    ["Engineer", "OldCo, Pune", "Jan 2020 - Aug 2024", ["Wrote the TypeScript billing service"]]
  ]);
  assert.deepEqual(parsed.educations.map((e) => [e.school, e.degree, e.date]), [["Some University", "B.Tech in Mechanical Engineering", "2015 - 2019"]]);
  assert.deepEqual(parsed.skills.descriptions, ["TypeScript, Kubernetes"]);
});

// --- Degrees ---

test("degree: checked against education; 'or equivalent experience' passes on years", () => {
  assert.equal(degreeAsked("Bachelor’s or Master’s degree in CS"), 1);
  assert.equal(degreeAsked("Master's degree in CS"), 2);
  assert.equal(degreeAsked("PhD in Machine Learning"), 3);
  assert.equal(degreeAsked("Kubernetes"), 0);
  assert.equal(degreeHave(bank), 1); // B.Tech
  const items = (must: string[], b = bank) => scoreRequirements(req({ must_have: must }), b, extra).items;
  const [bachelor, master, equivalent] = items(["Bachelor's degree in Computer Science", "Master's degree required", "Master's degree in CS or equivalent experience"]);
  assert.deepEqual([bachelor.label, bachelor.source], ["supported", "education"]);
  assert.equal(master.label, "not_demonstrated");
  assert.equal(equivalent.label, "supported", "6 years count as the equivalent");
  const noDegree = { ...structuredClone(bank), education: [] };
  assert.equal(items(["Bachelor's degree or equivalent experience"], noDegree)[0].label, "supported");
  const r = scoreRequirements(req({ must_have: ["Master's degree required"] }), bank, extra);
  assert.ok(!r.ask_user.some((q) => /degree/.test(q.skill)), "a degree is never a skill question");
});

// --- Soft skills ---

test("soft skill must-have: scored as a theme, never caps the score, never asked", () => {
  const r = scoreRequirements(req({ must_have: ["Kubernetes", "Excellent communication skills", "Experience in fast-paced agile environments"] }), bank, extra);
  const soft = r.items.filter((i) => i.soft);
  assert.deepEqual(soft.map((i) => i.kind), ["theme", "theme"]);
  assert.equal(r.missing_must, 0);
  assert.equal(r.cap, null);
  assert.ok(!r.ask_user.some((q) => /communication|agile/.test(q.skill)));
});

test("soft skill: bullets that show it are partial evidence, and tailoring picks one", () => {
  const r = scoreRequirements(req({ must_have: ["Excellent communication skills"] }), bank, extra);
  const comm = r.items.find((i) => i.soft)!;
  assert.deepEqual([comm.label, comm.bullet_ids.sort()], ["partial", ["cur-2", "old-1"]]); // "Presented", "Wrote"
  const ideal = idealContent(req({ must_have: ["Kubernetes", "Excellent communication skills"] }), bank, extra,
    { bullets_per_role: 1, bullets_total: 2, max_words: 25 });
  assert.ok(ideal.bullets.some((b) => b.id === "cur-2"), "the communication bullet is chosen");
});

// --- Skill questions ---

test("skill questions: a missed literal keyword the bank has under a synonym is not asked", () => {
  const r = scoreRequirements(req({ keywords: ["Agentic AI", "Kafka"] }), bank, extra);
  const kw = r.items.filter((i) => i.kind === "keyword");
  assert.deepEqual(kw.map((i) => i.label), ["not_demonstrated", "not_demonstrated"], "keywords stay literal");
  const asked = r.ask_user.map((q) => q.skill);
  assert.ok(!asked.includes("agents"), "Agentic AI = AI Agents, which the bank lists");
  assert.ok(asked.includes("kafka"));
});

// --- Preferences commands ---

const PREFS = `# my preferences
compensation: { currency: INR, unit: year, min: 1, target: 2, keep_if_unlisted: true }
roles:
  - title: SDE 3   # main target
    aliases: [SDE III]
seniority:
  include: [senior]
  exclude: [intern] # never
location: { cities: [Bengaluru], remote: true, hybrid: true, onsite: true }
visa_sponsorship_needed: false
companies:
  include:
    # fintech
    - { name: Razorpay, slug: razorpay, ats: auto }
    - { name: Swiggy, slug: swiggy, ats: auto } # food
  exclude: []
tailoring: { bullets_per_role: 4, bullets_total: 12, max_words: 25 }
`;

test("prefs: roles, title exclusions, and companies are edited in place; comments stay", () => {
  tempProfile();
  const path = join(process.env.JOBOPS_PROFILE_DIR!, "preferences.yaml");
  writeFileSync(path, PREFS);
  assert.deepEqual(addRole("SDE 3", ["SDE III", "SDE-3"]), ["SDE-3"], "known aliases are skipped");
  assert.deepEqual(addRole("Senior Software Engineer", []), ["Senior Software Engineer"]);
  assert.deepEqual(excludeTitleWords(["Staff", "intern", "staff"]), ["staff"]);
  assert.deepEqual(setCompany("razorpay", "razorpaysoftwareprivatelimited", "greenhouse"),
    ["Razorpay: auto/razorpay -> greenhouse/razorpaysoftwareprivatelimited"]);
  assert.deepEqual(setCompany("Razorpay", "razorpaysoftwareprivatelimited", "greenhouse"), [], "no change");
  assert.deepEqual(setCompany("Atlassian", "https://example.com/careers", "careers"), ["Atlassian: added careers/https://example.com/careers"]);
  const text = readFileSync(path, "utf8");
  for (const c of ["# my preferences", "# main target", "# never", "# fintech", "# food"]) assert.ok(text.includes(c), `keeps ${c}`);
  assert.match(text, /slug: razorpaysoftwareprivatelimited/);
});

// --- Careers crawler: reading pages ---

test("crawler: the board behind a careers page, from its URLs", () => {
  assert.deepEqual(detectBoard(["https://boards.greenhouse.io/embed/job_board?for=acme", "https://x.com/a.js"]), { name: "greenhouse", slug: "acme" });
  assert.deepEqual(detectBoard(["https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs"]), { name: "workday", slug: "acme.wd3/External" });
  assert.deepEqual(detectBoard(["https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/x"]), { name: "workday", slug: "acme.wd5/Careers" });
  assert.deepEqual(detectBoard(["https://jobs.lever.co/acme/123", "https://jobs.lever.co/acme"]), { name: "lever", slug: "acme" });
  assert.deepEqual(detectBoard(["https://careers.smartrecruiters.com/AcmeLtd"]), { name: "smartrecruiters", slug: "AcmeLtd" });
  assert.equal(detectBoard(["https://acme.com/careers"]), null);
});

test("crawler: robots.txt rules for every crawler, longest rule wins", () => {
  const robots = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /company/jobs/\nAllow: /company/jobs/public/\n";
  assert.equal(robotsAllows(robots, "/careers"), true);
  assert.equal(robotsAllows(robots, "/company/jobs/123"), false);
  assert.equal(robotsAllows(robots, "/company/jobs/public/9"), true);
  assert.equal(robotsAllows("", "/anything"), true);
});

test("crawler: job links are the biggest same-pattern group that reads like job titles", () => {
  const here = "https://acme.com/careers/all-jobs";
  const links = [
    { text: "Forward Deployed Engineering", href: "https://acme.com/enterprise/fde" },
    { text: "Developer Support", href: "https://developer.acme.com/" },
    { text: "Skip to content", href: "https://acme.com/careers/all-jobs#content" },
    { text: "Senior Data Engineer", href: "https://acme.com/careers/details/27575", row: "Bengaluru or Remote" },
    { text: "Senior Software Engineer", href: "https://acme.com/careers/details/27576", row: "Sydney" },
    { text: "Engineering", href: "https://acme.com/careers/details/teams" }
  ];
  assert.deepEqual(jobLinks(links, here), [
    { title: "Senior Data Engineer", url: "https://acme.com/careers/details/27575", location: "Bengaluru or Remote" },
    { title: "Senior Software Engineer", url: "https://acme.com/careers/details/27576", location: "Sydney" }
  ]);
  assert.deepEqual(jobLinks(links.slice(0, 3), here), [], "menus and promos are not jobs");
});

test("crawler: JobPosting JSON-LD, in a graph or a list; malformed blocks skipped", () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"SDE 3"}]}</script>
    <script type="application/ld+json">{bad json</script>
    <script type="application/ld+json">[{"@type":["JobPosting"],"title":"SDE 2"}]</script>`;
  assert.deepEqual(jsonLdPostings(html).map((p) => p.title), ["SDE 3", "SDE 2"]);
});

// --- job add <url> ---

const GH_JOB = { title: "Senior Backend Engineer", company_name: "Acme Inc", content: "&lt;p&gt;Responsibilities: build APIs.&lt;/p&gt;&lt;p&gt;Requirements: 5+ years of experience.&lt;/p&gt;",
  location: { name: "Bengaluru" }, updated_at: "2026-10-01T10:00:00Z" };

// Stubs fetch with saved responses by URL prefix; anything else is a connection error.
function stubFetch(routes: Record<string, unknown>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError(`fetch failed: ${url}`);
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

test("job link: each board is read through its API, and an embedded Greenhouse job through the company list", async () => {
  assert.equal(boardOf("https://job-boards.greenhouse.io/acme/jobs/123"), "greenhouse");
  assert.equal(boardOf("https://acme.com/jobs?gh_jid=123"), "greenhouse");
  assert.equal(boardOf("https://jobs.lever.co/acme/0f4e2c3a-1b2c-4d5e-8f90-123456789abc"), "lever");
  assert.equal(boardOf("https://acme.wd3.myworkdayjobs.com/External/job/Pune/SDE_JR1"), "workday");
  assert.equal(boardOf("https://jobs.smartrecruiters.com/acme/6000000001"), "smartrecruiters");
  assert.equal(boardOf("https://acme.com/careers/details/1"), "careers");

  const restore = stubFetch({
    "https://boards-api.greenhouse.io/v1/boards/acmeinc/jobs/123": GH_JOB,
    "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Pune/SDE_JR1":
      { jobPostingInfo: { title: "SDE 3", jobDescription: "<p>Responsibilities</p><p>Requirements</p>", location: "Pune", startDate: "2026-10-20" } },
    "https://api.smartrecruiters.com/v1/companies/acme/postings/6000000001":
      { name: "SDE III", company: { name: "ACME" }, location: { city: "Bengaluru", country: "in" },
        jobAd: { sections: { jobDescription: { title: "Job", text: "<p>Build things</p>" } } } }
  });
  try {
    const gh = await fetchJob("https://acme.com/jobs?gh_jid=123", { known: new Map([["acmeinc", "Acme"]]) });
    assert.deepEqual([gh.title, gh.company, gh.location, gh.source_name], ["Senior Backend Engineer", "Acme", "Bengaluru", "greenhouse"]);
    assert.match(gh.description, /Responsibilities: build APIs\.\n+Requirements/);
    const wd = await fetchJob("https://acme.wd3.myworkdayjobs.com/External/job/Pune/SDE_JR1");
    assert.deepEqual([wd.title, wd.location, wd.posted_at, wd.source_name], ["SDE 3", "Pune", "2026-10-20T00:00:00Z", "workday"]);
    const sr = await fetchJob("https://jobs.smartrecruiters.com/acme/6000000001", { company: "Acme Corp" });
    assert.deepEqual([sr.title, sr.company, sr.location], ["SDE III", "Acme Corp", "Bengaluru, IN"]);
  } finally {
    restore();
  }
});

test("job link: a list or landing page is not a job description", () => {
  assert.equal(looksLikeJd("Life at Acme. Our values. Benefits. Join us!"), false);
  assert.equal(looksLikeJd("About the role: you will build APIs. Requirements: 5+ years of experience with Go."), true);
});

test("job add: stops with the commands to continue when the parse model is down; the job is kept", async () => {
  tempProfile();
  const db = openDb(":memory:");
  const restore = stubFetch({ "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123": GH_JOB });
  try {
    const url = "https://job-boards.greenhouse.io/acme/jobs/123";
    const first = await jobAdd(db, url) as { steps: { step: string; status: string }[]; next?: string[] };
    assert.deepEqual(first.steps.map((s) => `${s.step}:${s.status}`), ["fetch:done", "parse:stopped"]);
    assert.deepEqual(first.next, [".claude/bin/llm.sh stop all", ".claude/bin/llm.sh start general7", `node api/src/cli.ts job add "${url}"`]);
    const again = await jobAdd(db, url) as { steps: { step: string; status: string }[] };
    assert.deepEqual(again.steps.map((s) => `${s.step}:${s.status}`), ["fetch:cached", "parse:stopped"], "the stored job is found again");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  } finally {
    restore();
  }
});

// --- Hidden characters and AI-sounding wording ---

test("hidden characters: found as code points, cleaned, and removed when the bank is saved", () => {
  const dirty = "Built\u200B the API\u00A0service\u2060 for \u2018billing\u2019\u{E0041}";
  assert.deepEqual(hiddenChars(dirty).sort(), ["U+00A0", "U+200B", "U+2060", "U+E0041"]);
  assert.equal(cleanText(dirty), "Built the API service for 'billing'");
  assert.deepEqual(hiddenChars("Plain text, with a - hyphen."), []);
  tempProfile();
  const b = structuredClone(bank);
  b.roles[0].bullets[0].text = "Moved 20\u200B services to\u00A0Kubernetes";
  assert.ok(checkBank(b, "20").some((i) => i.startsWith("cur-1: hidden characters U+200B,U+00A0")));
  saveBank(b);
  assert.equal(loadBank()!.roles[0].bullets[0].text, "Moved 20 services to Kubernetes");
});

test("AI tells: words, riders, dashes between clauses, and 'not only'; dates and hyphens are fine", () => {
  assert.deepEqual(aiTellsIn("Spearheaded a robust pipeline, ensuring seamless delivery").sort(),
    ["rider: ensuring", "robust", "seamless", "spearheaded"]);
  assert.deepEqual(aiTellsIn("Moved services to Kubernetes \u2014 deploys got faster"), ["dash"]);
  assert.deepEqual(aiTellsIn("Not only cut costs but also improved uptime"), ["not only"]);
  assert.deepEqual(aiTellsIn("Jan 2019 \u2013 Present"), []);
  assert.deepEqual(aiTellsIn("Wrote the on-call runbook for a state-machine service"), []);
});

test("guard: a rewrite that adds an AI tell is rejected; hidden characters are removed before checking", async () => {
  const opts = { vocab: new Set([...vocabulary(bank, extra)].map(norm)), allowed: [], maxWords: 25 };
  assert.deepEqual(checkRewrite("Moved 20 services to Kubernetes", "Seamlessly moved 20 services to Kubernetes", opts), ["ai_tell_added"]);
  assert.deepEqual(checkRewrite("Leveraged Kubernetes for 20 services", "Leveraged Kubernetes for 20 services", opts), [], "the source's own wording is not added");
  const answers = ["Moved 20 services to Kubernetes, ensuring uptime", "Moved\u200B 20 services to\u00A0Kubernetes"];
  const r = await guardedReword("Moved 20 services to Kubernetes", opts, async () => answers.shift() ?? null);
  assert.deepEqual([r.outcome, r.text, r.codes], ["accepted_on_retry", "Moved 20 services to Kubernetes", [["ai_tell_added"], []]]);
});

test("lint: AI tells in bullets are the user's call; hidden characters are the engine's", () => {
  const record = { content: { summary_text: "Backend engineer\u200B.", skills: [],
    bullets: [{ id: "cur-1", entry_id: "cur", text: "Leveraged Kubernetes to move 20 services" }] } } as unknown as ResumeRecord;
  const found = lintRecord(record, bank, extra, { now }).filter((f) => f.code === "ai_tell" || f.code === "hidden_chars");
  assert.deepEqual(found, [
    { code: "hidden_chars", detail: "summary: U+200B", needs: "engine" },
    { code: "ai_tell", detail: "cur-1: leveraged", needs: "user" }
  ]);
});

test("parse-back: hidden characters and text the record does not have are flagged", () => {
  const data = resumeData(breakRecord(), bank);
  const good = [data.name, data.phone, data.location, data.email, "Summary", data.summary, "Experience",
    ...data.experience.flatMap((e) => [e.title, e.dates, e.company, e.location, ...e.bullets]),
    "Education", ...data.education.flatMap((e) => [e.school, e.dates, e.degree]), "Skills", data.skills.join(", ")].join("\n");
  const codes = (text: string) => checkText(text, data, "test").map((i) => i.code).filter((c) => c === "hidden_chars" || c === "extra_text");
  assert.deepEqual(codes(good), []);
  assert.deepEqual(codes(good.replace("Kubernetes", "Kuber\u200Bnetes")), ["hidden_chars"]);
  assert.deepEqual(codes(good + "\nkafka spark airflow"), ["extra_text"], "white-text keyword stuffing");
});

test("questions: generic terms are never asked, as skills or in the keyword question", () => {
  const r = scoreRequirements(req({ must_have: ["Scale", "Software engineering", "Kafka"] }), bank, extra);
  assert.deepEqual(r.ask_user.map((q) => q.skill), ["kafka"]);
  const risks = riskCheck(req({ keywords: ["scale", "cost", "communication skills", "Kafka", "Spark"] }), bank, extra, ["cur-1"]);
  const kw = risks.find((x) => x.id === "keywords");
  assert.equal(kw?.question, "Have or don't have: Kafka, Spark?");
});

// --- Tailored resume: skills, page fit, headings ---

test("skills: JD matches first, then only skills the chosen bullets show; never soft skills; at most MAX_SKILLS", () => {
  const b = structuredClone(bank);
  b.skills.tools = ["Kubernetes", "Terraform", "Ansible", "Communication"]; // Terraform, Ansible: in no bullet
  const ideal = idealContent(req({ must_have: ["Kubernetes"], keywords: ["TypeScript"] }), b, extra,
    { bullets_per_role: 3, bullets_total: 6, max_words: 25 });
  assert.equal(ideal.skills[0], "TypeScript", "the JD's own spelling first");
  assert.ok(ideal.skills.includes("Kubernetes"));
  for (const s of ["Terraform", "Ansible", "Communication"]) assert.ok(!ideal.skills.includes(s), `${s} left out`);
  const many = structuredClone(bank);
  const names = Array.from({ length: 20 }, (_, i) => `Tool${i + 1}`);
  many.skills.tools = names;
  const capped = idealContent(req({ keywords: names }), many, extra, { bullets_per_role: 3, bullets_total: 6, max_words: 25 });
  assert.equal(capped.skills.length, MAX_SKILLS);
});

const hasTypst = !spawnSync("typst", ["--version"]).error && !spawnSync("pdfinfo", ["-v"]).error;

test("page fit: drops the last bullet of the fullest entry, never an entry's only one", { skip: !hasTypst && "typst or pdfinfo missing" }, () => {
  const b = structuredClone(bank);
  b.roles[0].bullets.push(bullet("cur-4", "Wrote the runbook for the billing service", ["runbook", "billing"]));
  const content = { summary_variant: "backend", summary_text: "Backend engineer.", skills: [],
    bullets: ["cur-1", "cur-2", "cur-4", "old-1"].map((id) => ({ id, entry_id: id.split("-")[0], text: [...b.roles[0].bullets, ...b.roles[2].bullets].find((x) => x.id === id)!.text })) };
  // A limit of 0 pages can never be met: it trims until every entry has one bullet.
  const none = fitPages(content as never, b, 0);
  assert.deepEqual(none.dropped.map((d) => d.id), ["cur-4", "cur-2"]);
  assert.deepEqual(none.content.bullets.map((x) => x.id), ["cur-1", "old-1"]);
  assert.deepEqual(fitPages(content as never, b, 2).dropped, [], "already within the limit");
});

test("template: a page never ends on a section heading, and Skills never splits", { skip: !hasTypst && "typst or pdfinfo missing" }, () => {
  const TEMPLATE = join(import.meta.dirname, "..", "templates", "resume.typ");
  const words = "Moved the billing and reporting services to Kubernetes with zero downtime for every tenant";
  const heads = ["Summary", "Experience", "Projects", "Education", "Skills"];
  // Many lengths, so page breaks land at many places, near Education and Skills too.
  for (let n = 26; n <= 46; n += 2) {
    const b = structuredClone(bank);
    b.roles[0].bullets = Array.from({ length: n }, (_, i) => bullet(`cur-${i + 1}`, `${words} ${i + 1}`, ["kubernetes"]));
    b.skills.tools = Array.from({ length: 15 }, (_, i) => `Tool${i + 1}`);
    const record = { resume_id: "x", content: { summary_text: "Backend engineer.", skills: b.skills.tools,
      bullets: [...b.roles[0].bullets.map((x) => ({ id: x.id, entry_id: "cur", text: x.text })), { id: "old-1", entry_id: "old", text: b.roles[2].bullets[0].text }] } } as unknown as ResumeRecord;
    const work = mkdtempSync(join(tmpdir(), "jobops-pagebreak-"));
    copyFileSync(TEMPLATE, join(work, "resume.typ"));
    writeFileSync(join(work, "data.json"), JSON.stringify(resumeData(record, b)));
    spawnSync("typst", ["compile", "--root", work, join(work, "resume.typ"), join(work, "r.pdf")]);
    const pages = Number(spawnSync("pdfinfo", [join(work, "r.pdf")], { encoding: "utf8" }).stdout.match(/Pages:\s+(\d+)/)?.[1]);
    const text = (p: number) => spawnSync("pdftotext", ["-f", String(p), "-l", String(p), join(work, "r.pdf"), "-"], { encoding: "utf8" }).stdout
      .split("\n").map((l) => l.trim()).filter(Boolean);
    for (let p = 1; p < pages; p++) assert.ok(!heads.includes(text(p).at(-1) ?? ""), `${n} bullets: page ${p} ends on a heading`);
    const skillsPage = Array.from({ length: pages }, (_, i) => i + 1).find((p) => text(p).includes("Skills"))!;
    assert.ok(text(skillsPage).some((l) => l.includes("Tool1,")), `${n} bullets: the skills list is on the Skills heading's page`);
  }
});

// --- Judge: skip settled jobs, parallel calls ---

test("judge: settled by years, settled when the best case is below moderate, open otherwise", () => {
  const none = new Map();
  assert.match(judgeSettled(req({ must_have: ["10+ years of experience", "Kafka"] }), bank, extra, none, ["Kafka"]) ?? "", /^years: JD asks 10\+/);
  const said = { ...extra, skills: ["kafka", "spark", "flink"].map((n) => ({ name: n, status: "dont_have" as const, evidence: "", added_at: "" })) };
  assert.match(judgeSettled(req({ must_have: ["Kafka", "Spark", "Flink", "Airflow"] }), bank, said, none, ["Airflow"]) ?? "", /below moderate/);
  assert.equal(judgeSettled(req({ must_have: ["Kubernetes", "Airflow"] }), bank, extra, none, ["Airflow"]), null);
});

// A judge server that answers "supported" with the first bullet listed, after a delay,
// and records how many calls ran at once.
async function fakeJudge(opts: { fail?: boolean } = {}) {
  let inFlight = 0;
  const seen = { calls: 0, maxAtOnce: 0 };
  const server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      seen.calls++;
      inFlight++;
      seen.maxAtOnce = Math.max(seen.maxAtOnce, inFlight);
      setTimeout(() => {
        inFlight--;
        if (opts.fail) { rs.statusCode = 500; rs.end("down"); return; }
        const prompt = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
        const id = prompt.match(/^([a-z0-9-]+) \| /m)?.[1] ?? "";
        rs.setHeader("content-type", "application/json");
        rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ label: "supported", bullet_ids: [id] }) } }] }));
      }, 60);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_GENERAL7_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { seen, close: () => { server.close(); delete process.env.LLM_GENERAL7_URL; } };
}

const judgeReq = () => req({ must_have: ["Kubernetes"],
  themes: ["led a migration in production", "owned the billing platform", "production on-call at scale", "led design reviews", "owned observability"] });

test("judge: calls run in parallel, every verdict is saved, and the cache answers the second time", async () => {
  const db = openDb(":memory:");
  const r = judgeReq();
  const open = needsJudge(r, bank, extra).length;
  assert.ok(open >= 4, "enough requirements need the judge");
  process.env.JOBOPS_JUDGE_PARALLEL = "3";
  const judge = await fakeJudge();
  try {
    const first = await judgeRequirements(db, r, bank, extra);
    assert.deepEqual([first.stats.judged, first.stats.failed, first.stats.skipped], [open, 0, null]);
    assert.equal(judge.seen.calls, open);
    assert.ok(judge.seen.maxAtOnce >= 2, `calls overlapped (max ${judge.seen.maxAtOnce} at once)`);
    const again = await judgeRequirements(db, r, bank, extra);
    assert.equal(again.stats.cached, open);
    assert.equal(judge.seen.calls, open, "no new calls");
  } finally {
    judge.close();
  }
});

test("judge: a server failure stops further calls; nothing is cached", async () => {
  const db = openDb(":memory:");
  const judge = await fakeJudge({ fail: true });
  try {
    const r = await judgeRequirements(db, judgeReq(), bank, extra);
    assert.equal(r.stats.judged, 0);
    assert.ok(r.stats.error);
    assert.ok(judge.seen.calls <= 3, `at most the first parallel round was sent (${judge.seen.calls})`);
    assert.equal(r.verdicts.size, 0);
  } finally {
    judge.close();
  }
});

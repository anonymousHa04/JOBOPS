import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bullet } from "./fixtures.ts";
import type { Bank, ResumeRecord } from "../src/profile/schema.ts";
import type { ResumeData } from "../src/render/render.ts";
import { renderRecord, resumeData, splitClient } from "../src/render/render.ts";
import { layoutIssues } from "../src/render/parseback.ts";
import { fakeBank, fakeRecord } from "../src/render/fake-resume.ts";
import { resumeForChat } from "../src/extension/reports.ts";

// iCIMS parser fixes (plan-parser-icims.md T5): a missing required reader fails the render,
// career breaks stay off the PDF and the chat's resume text, a "(Client: Y)" goes on its own
// line, and the layout limits iCIMS needs. Fake person, fake bank, temp folders: no profile/.

// CI has no OpenResume copy; cases 1 and 2 set it themselves and restore it.
process.env.JOBOPS_PARSE_READERS = "pdftotext,pdfjs";
process.env.JOBOPS_PROFILE_DIR = mkdtempSync(join(tmpdir(), "jobops-icims-"));

const hasTools = ["typst", "pdftotext"].every((c) => !spawnSync(c, ["--version"]).error) && !spawnSync("pdfinfo", ["-v"]).error;
const skip = !hasTools && "typst, pdftotext, or pdfinfo missing";
const tempDir = () => mkdtempSync(join(tmpdir(), "jobops-icims-"));

// Sets env vars for one case and puts them back afterwards.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// A bank with a client in a company and a career break between two jobs; the record has a
// bullet on every entry, the break too, so leaving it off is resumeData's doing.
function clientBank(): Bank {
  return {
    basics: { name: "Riya Testwal", email: "riya@example.com", phone: "+91 90000 11111", location: "Pune", links: [] },
    summaries: [{ id: "s1", variant: "backend", text: "Backend engineer." }],
    roles: [
      { id: "jtw", title: "Platform Engineer", company: "Joules to Watts (Client: Schneider Electric)", dates: "Mar 2024 - Present",
        bullets: [bullet("jtw-1", "Ran the nightly billing export", ["billing"])] },
      { id: "gap", title: "Career break", dates: "Jan 2023 - Feb 2024", kind: "break",
        bullets: [bullet("gap-1", "Cared for family", ["family"])] },
      { id: "orb", title: "Software Engineer", company: "Orbitware", dates: "Jan 2020 - Dec 2022",
        bullets: [bullet("orb-1", "Wrote the Go ingestion worker", ["go"])] }
    ],
    projects: [],
    education: [{ id: "edu", degree: "B.E.", school: "Fake Institute", dates: "2016 - 2020", details: [] }],
    skills: { languages: ["go"], frameworks: [], tools: [], domains: [] },
    approved: true
  };
}

function clientRecord(b: Bank): ResumeRecord {
  return {
    resume_id: "icims-test",
    content: {
      summary_variant: "backend", summary_text: "Backend engineer.", skills: ["Go"],
      bullets: b.roles.flatMap((e) => e.bullets.map((x) => ({ id: x.id, entry_id: e.id, text: x.text })))
    }
  } as unknown as ResumeRecord;
}

// Render data with n entries, `dated` of them with dates.
function layoutData(dated: number, undated: number, company = "Acme"): ResumeData {
  const entry = (i: number, dates: string) => ({ id: `e${i}`, title: "Engineer", company, location: "", dates, bullets: ["Did a thing"] });
  return {
    name: "Riya Testwal", phone: "", email: "", location: "", links: [], paper: "a4", summary: "",
    experience: Array.from({ length: dated }, (_, i) => entry(i, `Jan ${2010 + i} - Dec ${2010 + i}`)),
    projects: Array.from({ length: undated }, (_, i) => ({ ...entry(dated + i, ""), company: "" })),
    education: [], skills: []
  };
}

test("1. OpenResume required and missing: reader_missing, no PDF", { skip }, async () => {
  for (const readers of [undefined, "pdftotext,pdfjs,openresume"]) {
    const out = tempDir();
    const r = await withEnv({ JOBOPS_PARSE_READERS: readers, JOBOPS_OPENRESUME_DIR: tempDir() }, () =>
      renderRecord(fakeRecord(), fakeBank, { outDir: out }));
    assert.equal(r.ok, false, `readers ${readers ?? "unset"}`);
    assert.equal(r.path, null);
    assert.ok(r.issues.some((i) => i.code === "reader_missing"), JSON.stringify(r.issues));
    assert.deepEqual(existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".pdf")) : [], []);
  }
});

test("2. JOBOPS_PARSE_READERS=pdftotext,pdfjs: no reader_missing, render ok", { skip }, async () => {
  const out = tempDir();
  const r = await withEnv({ JOBOPS_PARSE_READERS: "pdftotext,pdfjs", JOBOPS_OPENRESUME_DIR: tempDir() }, () =>
    renderRecord(fakeRecord(), fakeBank, { outDir: out }));
  assert.ok(!r.issues.some((i) => i.code === "reader_missing"), JSON.stringify(r.issues));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("3. resumeData leaves a career break out of experience; other roles stay in order", () => {
  const b = clientBank();
  const d = resumeData(clientRecord(b), b);
  assert.deepEqual(d.experience.map((e) => e.id), ["jtw", "orb"]);
});

test("4. splitClient: company and client split, case-insensitive; resumeData puts client on the entry", () => {
  assert.deepEqual(splitClient("Joules to Watts (Client: Schneider Electric)"), { company: "Joules to Watts", client: "Schneider Electric" });
  assert.deepEqual(splitClient("Joules to Watts (CLIENT: Schneider Electric)"), { company: "Joules to Watts", client: "Schneider Electric" });
  assert.deepEqual(splitClient("Joules to Watts (client: Schneider Electric)"), { company: "Joules to Watts", client: "Schneider Electric" });
  const plain = splitClient("Orbitware");
  assert.deepEqual(plain, { company: "Orbitware" });
  assert.equal("client" in plain, false);
  const b = clientBank();
  const [jtw, orb] = resumeData(clientRecord(b), b).experience;
  assert.equal(jtw.company, "Joules to Watts");
  assert.equal(jtw.client, "Schneider Electric");
  assert.equal(orb.company, "Orbitware");
  assert.equal("client" in orb, false);
});

test("5. layoutIssues: 6 dated entries -> too_many_entries; 5 dated plus an undated project -> none", () => {
  const six = layoutIssues(layoutData(6, 0));
  assert.deepEqual(six.filter((i) => i.code === "too_many_entries").map((i) => i.detail), ["6 > 5"]);
  assert.deepEqual(layoutIssues(layoutData(5, 1)), []);
});

test("6. layoutIssues: a company with parentheses -> company_has_parens with the entry id", () => {
  const issues = layoutIssues(layoutData(1, 0, "Acme (India)"));
  assert.deepEqual(issues.map((i) => [i.code, i.detail]), [["company_has_parens", "e0"]]);
});

test("7. fake resume PDF: Client line under title/dates, Skills between Summary and Experience, skills whole", { skip }, async () => {
  const out = tempDir();
  const r = await renderRecord(fakeRecord(), fakeBank, { outDir: out });
  assert.equal(r.ok, true, JSON.stringify(r));
  const text = spawnSync("pdftotext", [r.path!, "-"], { encoding: "utf8" }).stdout;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  // Client on its own line, right after the entry's title and dates lines, before its bullets.
  const at = lines.indexOf("Client: Globex Corp");
  assert.ok(at > 0, `no "Client: Globex Corp" line:\n${lines.join("\n")}`);
  const before = lines.slice(Math.max(0, at - 3), at).join("\n");
  assert.ok(before.includes("Senior Software Engineer"), `title not just before the client line:\n${before}`);
  assert.ok(before.includes("Jan 2018 - Present"), `dates not just before the client line:\n${before}`);
  assert.ok(lines.findIndex((l) => l.includes("Moved 20 services")) > at, "client line comes before the bullets");
  // Section order: Summary, Skills, Experience.
  const pos = ["summary", "skills", "experience"].map((s) => lines.findIndex((l) => l.toLowerCase() === s));
  assert.ok(pos.every((p) => p >= 0) && pos[0] < pos[1] && pos[1] < pos[2], `headings at ${pos}`);
  // Every skill whole on one line.
  for (const s of fakeRecord().content.skills) assert.ok(lines.some((l) => l.includes(s)), `skill split or missing: ${s}`);
  assert.ok(!/career break/i.test(text), "career break text in the PDF");
});

test("8. resumeForChat: no career break, the client split off the company", () => {
  const b = clientBank();
  const chat = resumeForChat(b, clientRecord(b));
  const y = parse(chat) as { experience: { role?: string; company?: string; client?: string; bullets: string[] }[] };
  assert.deepEqual(y.experience.map((e) => e.role), ["Platform Engineer", "Software Engineer"]);
  assert.ok(!/career break|gap-1/i.test(chat), "career break in the chat's resume text");
  assert.ok(!chat.includes("(Client:"), "company still holds the client");
  assert.equal(y.experience[0].company, "Joules to Watts");
  assert.equal(y.experience[0].client, "Schneider Electric");
  assert.equal(y.experience[1].client, undefined);
});

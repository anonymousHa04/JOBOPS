import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atsReferences, compareIcims, compareReport, icimsExpected } from "../src/render/ats-report.ts";
import type { IcimsReported } from "../src/render/ats-report.ts";
import { fakeBank, fakeRecord } from "../src/render/fake-resume.ts";
import { resumeData } from "../src/render/render.ts";

// K4 (plan-exit-gate.md): iCIMS in `ats compare`, and `ats references` re-running saved reports
// against today's fake resume. Fake resume only; reports live in temp folders.

// What iCIMS should show for the fake resume (career break left off, client split off).
const matching = (): IcimsReported => ({
  site: "icims",
  uploaded: "2026-11-09",
  entries: [
    { employer: "Acme Software", title: "Senior Software Engineer", start: "01/2018", end: "", description: "Moved 20 services to Kubernetes" },
    { employer: "OldCo Systems", title: "Software Engineer", start: "01/2014", end: "02/2017", description: "Built internal reporting dashboards" }
  ],
  education: [],
  linkedin: ""
});
const fields = (r: { mismatches: { field: string }[] }) => r.mismatches.map((m) => m.field);

test("K4 icims: a report matching the fake resume passes", () => {
  const r = compareReport(matching());
  assert.equal(r.site, "icims");
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.report, "", "nothing is written for an iCIMS report");
});

test("K4 icims: the entries may come in iCIMS's own order (matched by start date)", () => {
  const r = matching();
  r.entries.reverse();
  assert.deepEqual(compareIcims(r).mismatches, []);
});

test("K4 icims: the client (Globex Corp) as employer instead of Acme Software fails", () => {
  const r = matching();
  r.entries[0].employer = "Globex Corp";
  assert.deepEqual(compareIcims(r).mismatches, [{ field: "entry#1.employer", filled: "Globex Corp", expected: "Acme Software" }]);
});

test("K4 icims: 6 entries fails (count > 5)", () => {
  const r = matching();
  for (let y = 2008; y < 2012; y++) r.entries.push({ employer: "Initech", title: "Engineer", start: `01/${y}`, end: `12/${y}`, description: "Wrote code" });
  assert.equal(r.entries.length, 6);
  const m = compareIcims(r).mismatches.find((x) => x.field === "entry_count");
  assert.deepEqual(m, { field: "entry_count", filled: "6", expected: "2 (at most 5)" });
});

test("K4 icims: empty Education and LinkedIn are fill by hand, not failures", () => {
  const r = compareIcims(matching());
  assert.deepEqual(r.fill_by_hand, ["education", "linkedin"]);
  assert.deepEqual(r.mismatches, []);
  const filled = compareIcims({ ...matching(), education: [{ school: "University of Mumbai", degree: "BTech" }], linkedin: "linkedin.com/in/x" });
  assert.deepEqual(filled.fill_by_hand, []);
});

test("K4 icims: a description that starts with a company line is a warning, not a failure", () => {
  const r = matching();
  r.entries.push({ employer: "", title: "", start: "", end: "", description: "OldCo Systems, -------- Pune" });
  const c = compareIcims(r);
  assert.deepEqual(c.warnings.map((w) => w.field), ["reported_entry#3.description"]);
  assert.ok(!fields(c).some((f) => f.includes("description")));
});

test("K4 icims: the expected employer has no (Client: ...) and the break is left off", () => {
  const want = icimsExpected();
  assert.deepEqual(want.entries.map((e) => [e.employer, e.start, e.end, e.current]), [["Acme Software", "01/2018", "", true], ["OldCo Systems", "01/2014", "02/2017", false]]);
});

test("K4 ats references: lists a field that changed after the fake resume's data changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobops-atsref-"));
  writeFileSync(join(dir, "icims-2026-11-09.json"), JSON.stringify(matching()));
  writeFileSync(join(dir, "icims-TEMPLATE.json"), JSON.stringify({ ...matching(), entries: [] }));

  const today = atsReferences(dir);
  assert.equal(today.references.length, 1, "the template is not a reference");
  assert.deepEqual([today.references[0].site, today.references[0].date, today.references[0].differs], ["icims", "2026-11-09", []]);

  // A template/data change: a different title for the Acme job (data passed in, fake-resume.ts untouched).
  const data = resumeData(fakeRecord(), fakeBank);
  const changed = { ...data, experience: data.experience.map((e) => e.id === "acme" ? { ...e, title: "Staff Software Engineer" } : e) };
  const after = atsReferences(dir, changed);
  assert.deepEqual(after.references[0].differs, [{ field: "entry#1.title", filled: "Senior Software Engineer", expected: "Staff Software Engineer" }]);
});

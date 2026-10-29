// Get a job report through the JobOps extension, end to end, and print a short summary.
// Drives the extension popup in the Chrome started with a debug port (see extension/README.md),
// waits until the report is saved (or the report loop is done), then prints the status steps
// and counts per report field. Never prints report or resume text.
//
// Usage (from the repo root, with `npm start` running):
//   node extension/tools/get-report.mjs <job-id> [claude|chatgpt] [--timeout 15]
// Chrome: open -na "Google Chrome" --args --user-data-dir=$HOME/.jobops-chrome --remote-debugging-port=9222
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const timeoutMin = Number(flag("--timeout", "15"));
const [jobId, target = "claude"] = args;
if (!jobId || !["claude", "chatgpt"].includes(target)) {
  console.error("usage: node extension/tools/get-report.mjs <job-id> [claude|chatgpt] [--timeout 15]");
  process.exit(2);
}
const API = "http://127.0.0.1:3000";
const reportsDir = join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "reports");
const t0 = Date.now();
const log = (m) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${m}`);
const fail = (m) => { console.error(m); process.exit(1); };

// 1. The API answers the extension (no Origin, Sec-Fetch-Site: none, like Chrome sends).
try {
  const r = await fetch(`${API}/x/jobs`, { headers: { "sec-fetch-site": "none" } });
  if (!r.ok) fail(`API answered ${r.status} on /x/jobs`);
  const { jobs } = await r.json();
  if (!jobs.some((j) => j.job_id === jobId)) fail(`job ${jobId} is not in the popup's list (parsed jobs only, top 40)`);
} catch (e) {
  if (e?.cause?.code === "ECONNREFUSED") fail("API not running: npm start (in the repo)");
  throw e;
}

// 2. Chrome with the debug port, and the extension's id.
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
} catch {
  fail('Chrome not on port 9222: open -na "Google Chrome" --args --user-data-dir=$HOME/.jobops-chrome --remote-debugging-port=9222');
}
const context = browser.contexts()[0];
let extId = process.env.JOBOPS_EXTENSION_ID;
if (!extId) {
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  extId = targetInfos.map((t) => t.url.match(/^chrome-extension:\/\/([a-p]{32})\/(background\.js|popup\.html)/)?.[1]).find(Boolean);
  if (!extId) fail("JobOps extension not found: load extension/ in chrome://extensions (Load unpacked), or set JOBOPS_EXTENSION_ID");
}

// 3. Open the popup as a tab, pick the job and the chat, click Get report.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForFunction((id) => [...document.querySelectorAll("#jobSelect option")].some((o) => o.value === id), jobId, { timeout: 30000 });
await popup.selectOption("#jobSelect", jobId);
// The radios are visually hidden behind the Claude | ChatGPT toggle: click its label, as a user does.
await popup.click(`label[for="${await popup.getAttribute(`input[name="target"][value="${target}"]`, "id")}"]`);
await popup.evaluate(() => chrome.storage.local.remove("status"));
await popup.click("#getReport");
log(`Get report: ${target}`);

// 4. Follow the status until it ends. Without the report loop the end is "saved"; with it,
// "saved" is followed by "fixing" within a few seconds, and the end is "done".
const status = () => popup.evaluate(() => chrome.storage.local.get("status").then((r) => r.status ?? {}));
let last = "", savedAt = 0, final = null;
while (Date.now() - t0 < timeoutMin * 60_000) {
  const s = await status();
  const line = [s.round ? `round ${s.round}` : "", s.step, s.error && `error: ${s.error}`].filter(Boolean).join(" | ");
  if (line && line !== last) { log(line); last = line; }
  if (s.step === "failed" || s.step === "done") { final = s; break; }
  if (s.step === "saved") {
    savedAt ||= Date.now();
    if (Date.now() - savedAt > 15_000) { final = s; break; }
  } else savedAt = 0;
  await new Promise((r) => setTimeout(r, 2000));
}
await popup.close();
if (!final) fail(`timed out after ${timeoutMin} min (last: ${last || "no status"})`);

// 5. Summary: counts per field for each saved report of this run. No text.
const fields = ["missed_gaps", "already_covered", "bullet_notes", "from_memory", "gaps"];
const files = [join(reportsDir, `${jobId}.${target}.yaml`)];
for (let r = 1; r <= (final.round ?? 0); r++) files.push(join(reportsDir, `${jobId}.${target}.r${r}.yaml`));
for (const f of files.filter(existsSync)) {
  const d = parse(readFileSync(f, "utf8"));
  const counts = fields.map((k) => `${k}=${(d.report?.[k] ?? []).length}`).join(" ");
  console.log(`${f.split("/").pop()}: ${counts} | local needs: must=${d.local?.must?.length ?? "-"} nice=${d.local?.nice?.length ?? "-"} | tidied=${d.meta?.normalized_by ? "yes" : "no"}`);
}
// Local review of the chat's claims per round (data/report-feedback.jsonl): verdicts and causes.
const fb = "data/report-feedback.jsonl";
if (existsSync(fb)) {
  const since = new Date(t0).toISOString();
  for (const line of readFileSync(fb, "utf8").trim().split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.job_id !== jobId || e.at < since) continue;
    const tally = (key) => Object.entries(e.findings.reduce((m, f) => ((m[f[key]] = (m[f[key]] ?? 0) + 1), m), {})).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(`review round ${e.round}: ${tally("verdict")} | causes: ${tally("cause")}`);
  }
}
if (final.step === "done") console.log(`loop done after ${final.round} rounds; ${final.needs_facts ?? 0} gaps need your facts`);
process.exit(final.step === "failed" ? 1 : 0);

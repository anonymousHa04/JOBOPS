// JD parse quality: Mac general7 (Metal) vs laptop general7 (CUDA), same model file, prompt and schema, with
// fresh claude.ai chats as an outside reference (no project context).
//   node bench/split/quality.ts parse   -> the 6 JDs twice on each machine, one at a time (no batching drift)
//   node bench/split/quality.ts claude  -> one new claude.ai chat per JD in the debug Chrome (port 9222), same
//                                          prompt plus the JSON schema as text (the local servers enforce it)
//   node bench/split/quality.ts compare -> keyword agreement and engine outcome (planJob on a fake bank, no
//                                          judge verdicts) for every source
// Every source gets the production keyword filter (keywords must appear in the JD text). Variants are
// "general" as in the other benchmarks; profile/ is not read. Output in bench/split/quality/.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { fill, loadPrompt } from "../../api/src/model/prompts.ts";
import { RequirementsSchema } from "../../api/src/requirements/schema.ts";
import { generate } from "../../api/src/model/llm.ts";
import { chromium } from "playwright-core";
import { planJob } from "../../api/src/tailor/tailor.ts";
import { bank as fixtureBank, bullet } from "../../api/test/fixtures.ts";

const HERE = join(process.cwd(), "bench/split/quality");
mkdirSync(HERE, { recursive: true });
// Safe after the static imports: the log path (registry.ts modelLogPath) is read on each call, not at load.
process.env.JOBOPS_MODEL_LOG = join(HERE, "calls.jsonl");
const LAPTOP = "http://10.10.10.1:8084";
const MAC = "http://127.0.0.1:8084";
const KEY = readFileSync(`${process.env.HOME}/.ssh/jobops_laptop_llm_key`, "utf8").trim();
const realFetch = globalThis.fetch;
globalThis.fetch = (url: any, init: any = {}) =>
  String(url).startsWith(LAPTOP) ? realFetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${KEY}` } }) : realFetch(url, init);
const JDS = ["c0ba0995-59ca-42d2-8944-59ce31ff8941", "b841ad36-7d73-4218-a2e0-723a7d087afd", "f8559c0a-38f4-4add-9bbd-258a9072e3e6",
  "c9ed60f0-c481-4316-b863-3fb9bae2b100", "e8a145b7-45af-49ac-945b-b6296796a289", "4c76b210-552f-41ae-9585-de56152bf759"];
const db = new Database("data/jobops.db", { readonly: true });
const jd = (id: string) => db.prepare("SELECT title, description FROM jobs WHERE id = ?").get(id) as { title: string; description: string };
const jdText = (id: string) => `${jd(id).title}\n\n${jd(id).description}`;
const { template } = loadPrompt("parse-job-descripton");
const prompt = (id: string) => fill(template, { "paste JD": jdText(id), "list your variants": "general" });
const file = (name: string) => join(HERE, `${name}.json`);
const save = (name: string, v: unknown) => writeFileSync(file(name), JSON.stringify(v, null, 1));

const mode = process.argv[2];

if (mode === "parse") {
  const runAll = async (name: string, base: string) => {
    const out: Record<string, any> = {};
    for (const id of JDS) {
      const r = await generate({ task: "jd_parse", prompt: prompt(id), schema: RequirementsSchema, baseUrl: `${base}/v1` });
      out[id] = r.ok ? r.value : { error: r.error };
      console.log(name, id.slice(0, 8), r.ok ? `${r.value.keywords.length} keywords` : r.error);
    }
    save(name, out);
  };
  await runAll("laptop_1", LAPTOP);
  await runAll("laptop_2", LAPTOP);
  execSync("sh .claude/bin/llm.sh start general7", { stdio: "ignore" });
  for (let i = 0; i < 120; i++) { try { if ((await realFetch(`${MAC}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  await runAll("mac_1", MAC);
  await runAll("mac_2", MAC);
  execSync("sh .claude/bin/llm.sh stop general7", { stdio: "ignore" });
}

if (mode === "claude") {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  const schemaText = JSON.stringify(z.toJSONSchema(RequirementsSchema));
  const out: Record<string, any> = existsSync(file("claude")) ? JSON.parse(readFileSync(file("claude"), "utf8")) : {};
  for (const id of JDS) {
    if (out[id] && !out[id].error) continue;
    const page = await context.newPage();
    try {
      await page.goto("https://claude.ai/new");
      const input = page.locator("div.ProseMirror[contenteditable='true']");
      await input.waitFor({ timeout: 30000 });
      // A code block: claude.ai renders plain-text JSON as Markdown (underscores become italics, quotes curl).
      const text = `${prompt(id)}\n\nReturn only a JSON object that matches this JSON Schema, inside one \`\`\`json code block, with no other text and no artifact:\n${schemaText}`;
      await input.click();
      await page.evaluate((t) => document.execCommand("insertText", false, t), text);
      const send = page.locator("button[data-testid='chat-input-send'], button[aria-label='Send message']").first();
      await send.waitFor({ timeout: 10000 });
      await send.click();
      // Answer started, then streaming finished (same signals as extension/chat.js).
      await page.locator("div[data-is-streaming]").first().waitFor({ timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector("[data-is-streaming='true'], button[data-testid='chat-input-stop']"), null, { timeout: 300000 });
      const answer = await page.locator("div[data-is-streaming]").last().evaluate((el) => (el.querySelector("pre code") ?? el).textContent ?? "");
      const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
      const parsed = RequirementsSchema.safeParse(JSON.parse(json));
      out[id] = parsed.success ? parsed.data : { error: `schema: ${parsed.error.issues[0]?.message}` };
      console.log("claude", id.slice(0, 8), parsed.success ? `${parsed.data.keywords.length} keywords` : out[id].error, page.url());
    } catch (e) {
      out[id] = { error: (e as Error).message.split("\n")[0] };
      console.log("claude", id.slice(0, 8), "failed:", out[id].error);
    }
    save("claude", out);
    await page.close();
  }
  await browser.close(); // disconnects; the user's Chrome stays open
}

if (mode === "compare") {
  const names = ["mac_1", "mac_2", "laptop_1", "laptop_2", "claude"].filter((n) => existsSync(file(n)));
  const src: Record<string, Record<string, any>> = Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(file(n), "utf8"))]));
  // Production filter: keep only keywords that appear in the JD text.
  for (const n of names) for (const id of JDS) {
    const r = src[n][id];
    if (r && !r.error) { const hay = jdText(id).toLowerCase(); r.dropped = r.keywords.filter((k: string) => !hay.includes(k.toLowerCase())).length; r.keywords = r.keywords.filter((k: string) => hay.includes(k.toLowerCase())); }
  }
  const bank = structuredClone(fixtureBank);
  bank.roles[0].bullets = [
    bullet("b1", "Moved 20 services from VMs to Kubernetes and cut deploy time from 40 to 8 minutes", ["kubernetes", "ci/cd", "backend"]),
    bullet("b2", "Built the internal deploy tool in Go used by 6 teams for daily releases", ["go", "tooling", "platform"]),
    bullet("b3", "Set up Prometheus alerts and on-call runbooks for the payments API", ["monitoring", "on-call", "reliability"]),
  ];
  bank.roles[1].bullets = [
    bullet("b4", "Wrote the billing service in TypeScript and Node.js with PostgreSQL", ["typescript", "node.js", "postgresql"]),
    bullet("b5", "Built React screens for the admin console and its REST API", ["react", "rest", "frontend"]),
    bullet("b6", "Wrote Terraform modules for the staging and production AWS accounts", ["terraform", "aws", "infrastructure"]),
  ];
  const extra = { skills: [], dismissed: [], learnable: [] };
  const budget = { bullets_per_role: 3, bullets_total: 6, max_words: 25 };
  const set = (a: string[] = []) => new Set(a.map((k) => k.toLowerCase().trim()));
  const jacc = (a?: string[], b?: string[]) => {
    const A = set(a), B = set(b);
    const inter = [...A].filter((x) => B.has(x)).length;
    return A.size + B.size ? inter / (A.size + B.size - inter) : 1;
  };
  const pairs = [["mac_1", "mac_2"], ["laptop_1", "laptop_2"], ["mac_1", "laptop_1"], ["mac_2", "laptop_2"], ["mac_1", "claude"], ["laptop_1", "claude"]]
    .filter(([a, b]) => names.includes(a) && names.includes(b));
  const L: string[] = ["# JD parse: Mac (Metal) vs laptop (CUDA) vs fresh claude.ai chat", "",
    "## Keyword overlap after the production filter (Jaccard: 1 = identical sets)", "",
    `| JD | ${pairs.map(([a, b]) => `${a} / ${b}`).join(" | ")} |`, `|---|${pairs.map(() => "---:").join("|")}|`];
  for (const id of JDS) L.push(`| ${id.slice(0, 8)} | ${pairs.map(([a, b]) => jacc(src[a][id]?.keywords, src[b][id]?.keywords).toFixed(2)).join(" | ")} |`);
  L.push("", "## Counts per source: keywords kept (dropped by the filter) / must-haves / nice-to-haves", "",
    `| JD | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`);
  for (const id of JDS) L.push(`| ${id.slice(0, 8)} | ${names.map((n) => { const r = src[n][id]; return !r || r.error ? `error` : `${r.keywords.length} (${r.dropped}) / ${r.must_have.length} / ${r.nice_to_have.length}`; }).join(" | ")} |`);
  L.push("", "## Engine outcome on the fake bank (planJob, no judge verdicts): decision, band, score", "",
    `| JD | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`);
  for (const id of JDS) L.push(`| ${id.slice(0, 8)} | ${names.map((n) => {
    const r = src[n][id];
    if (!r || r.error) return "error";
    try { const d = planJob(r, id, [], bank as any, extra as any, budget as any, new Map()).decision; return `${d.decision}, ${d.band}, ${d.score.toFixed(2)}`; }
    catch (e) { return `failed: ${(e as Error).message.slice(0, 50)}`; }
  }).join(" | ")} |`);
  writeFileSync(join(HERE, "compare.md"), L.join("\n") + "\n");
  console.log(L.join("\n"));
}

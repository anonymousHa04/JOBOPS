// Checks the selectors extension/chat.js uses against the live chat pages.
// Read-only: attaches to a Chrome the user started with a debug port and never clicks,
// types or navigates. Records element attributes only, never page text.
// Run: node extension/tools/dump-selectors.mjs   (writes extension/selectors.md)
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const SITES = {
  claude: { host: "claude.ai", groups: {
    input: ["div.ProseMirror[contenteditable='true']"],
    send: ["button[data-testid='chat-input-send']", "button[aria-label='Send message']"],
    answering: ["[data-is-streaming='true']", "button[data-testid='chat-input-stop']"],
    answer: ["div[data-is-streaming]"] } },
  chatgpt: { host: "chatgpt.com", groups: {
    input: ["div[contenteditable='true']"],
    send: ["button[aria-label='Send']", "button[data-testid='send-button']"],
    answering: ["[data-talvt-turn-state='in_progress']", "button[aria-label='Stop']"],
    answer: ["[data-content-search-unit-key$=':assistant']"] } } };

// Where to look for candidates when no selector in a group matches.
const CANDIDATES = {
  input: "[contenteditable], textarea",
  send: "button",
  answering: "button",
  answer: "[data-testid], [data-message-author-role], [data-is-streaming], [class*='message'], [class*='response'], [data-turn], article, [class*='markdown'], [class*='prose']"
};

function describe(query) {
  return Array.from(document.querySelectorAll(query))
    .filter(el => !el.closest("nav, aside, header"))
    .slice(0, 15)
    .map(el => [
      el.tagName.toLowerCase(),
      el.id && "#" + el.id,
      ...["data-testid", "aria-label", "role", "data-message-author-role", "data-is-streaming"]
        .filter(a => el.hasAttribute(a))
        .map(a => `${a}="${el.getAttribute(a).slice(0, 40)}"`),
      Array.from(el.classList).slice(0, 3).map(c => "." + c).join("")
    ].filter(Boolean).join(" "));
}

let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
} catch {
  console.error('Start Chrome first: open -na "Google Chrome" --args --user-data-dir=$HOME/.jobops-chrome --remote-debugging-port=9222');
  process.exit(1);
}

const pages = browser.contexts().flatMap(c => c.pages());
const out = [`# Chat selectors (checked ${new Date().toISOString()})`, ""];

for (const [site, { host, groups }] of Object.entries(SITES)) {
  out.push(`## ${site}`, "");
  const page = pages.find(p => { try { return new URL(p.url()).host === host; } catch { return false; } });
  if (!page) { out.push("not open", ""); continue; }
  for (const [group, selectors] of Object.entries(groups)) {
    out.push(`### ${group}`, "", "| selector | matches |", "|---|---|");
    let any = false;
    for (const sel of selectors) {
      const n = await page.evaluate(s => document.querySelectorAll(s).length, sel);
      if (n > 0) any = true;
      out.push(`| \`${sel}\` | ${n} |`);
    }
    out.push("");
    if (!any) {
      out.push("Candidates:", ...(await page.evaluate(describe, CANDIDATES[group])).map(c => `- ${c}`), "");
    }
  }
}

const text = out.join("\n");
writeFileSync(new URL("../selectors.md", import.meta.url), text + "\n");
console.log(text);
// No browser.close(): it would close the user's Chrome. Exit just drops the connection.
process.exit(0);

// Careers-site crawler for companies with no public job-board API. jd-search runs it
// (ats: careers) and does the filtering and posting itself. Prints JSON on stdout.
//
//   node api/src/careers/crawl.ts list <careers-url>
//     {"ats": {"name","slug"}}  the page loads its jobs from a board jd-search can read
//     {"jobs": [{"title","url","location"}]}  job links found on the page
//     {"blocked": "<why>"}  robots.txt disallows the page, or the site refuses automated
//                           access; never retried or worked around
//   node api/src/careers/crawl.ts describe <job-url>
//     {"description","location","posted_at"}
//
// Manners: robots.txt is checked before every page, pages are opened one at a time, and
// the browser is the user's installed Chrome, headless, with its own user agent.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

type Ats = { name: string; slug: string };
type Job = { title: string; url: string; location: string };
// title and company are for a single job added by its link (job add <url>).
export type Details = { description: string; location: string; posted_at: string; title: string; company: string };

const MAX_HOPS = 2;
const MAX_JOBS = 500;
const PAGE_TIMEOUT = 30_000;

// Boards jd-search has fetchers for, found in the page's requests, links, and frames.
const BOARDS: [string, RegExp, (m: RegExpMatchArray) => string][] = [
  ["greenhouse", /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/i, (m) => m[1]],
  ["greenhouse", /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/i, (m) => m[1]],
  ["greenhouse", /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([\w-]+)/i, (m) => m[1]],
  ["lever", /(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([\w-]+)/i, (m) => m[1]],
  ["ashby", /(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([\w.-]+)/i, (m) => m[1]],
  ["workday", /([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[\w-]+\/)?(?:[a-z]{2}-[A-Z]{2}\/)?(?!wday\b)([\w-]+)/, (m) => `${m[1]}.${m[2]}/${m[3]}`],
  ["smartrecruiters", /(?:(?:careers|jobs)\.smartrecruiters\.com|api\.smartrecruiters\.com\/v1\/companies)\/([\w-]+)/i, (m) => m[1]]
];

// The most-seen board across every URL the page touched.
export function detectBoard(urls: string[]): Ats | null {
  const seen = new Map<string, number>();
  for (const u of urls) {
    for (const [name, re, slug] of BOARDS) {
      const m = u.match(re);
      if (m) {
        const key = `${name} ${slug(m)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        break;
      }
    }
  }
  const top = [...seen].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [name, slug] = top[0].split(" ");
  return { name, slug };
}

// robots.txt rules for every crawler ("User-agent: *"): the longest matching rule wins.
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  let inAgents = false;
  const rules: { allow: boolean; prefix: string }[] = [];
  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const k = key.trim().toLowerCase();
    if (k === "user-agent") {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === "*") applies = true;
    } else if (k === "allow" || k === "disallow") {
      inAgents = false;
      if (applies && value) rules.push({ allow: k === "allow", prefix: value.replace(/\*$/, "") });
    } else if (k) {
      inAgents = false;
    }
  }
  const hit = rules.filter((r) => path.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return hit ? hit.allow : true;
}

const robotsCache = new Map<string, string>();
async function allowed(url: string): Promise<boolean> {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    try {
      const r = await fetch(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
      robotsCache.set(u.origin, r.ok ? await r.text() : "");
    } catch {
      robotsCache.set(u.origin, "");
    }
  }
  return robotsAllows(robotsCache.get(u.origin) ?? "", u.pathname + u.search);
}

// A page that refuses automated access: we stop there.
const BLOCK_TITLE = /access denied|just a moment|attention required|are you a robot|captcha|forbidden|request blocked/i;

// A link to one job: its text reads like a job title (two words or more, with a role
// word), and it leads to another page. Team pages ("Engineering") have one word.
const ROLE_WORD = /\b(engineer|developer|sde|swe|sdet|manager|lead|architect|designer|analyst|scientist|specialist|intern|associate|director|consultant|executive|administrator|officer|head|programmer|tester|devops|sre|researcher|recruiter|counsel|accountant|representative|strategist|partner|owner)s?\b/i;
// Links from a careers landing page to the openings: strong phrases first, then generic.
const LIST_STRONG = /\b(open (roles|positions)|(view|see|browse|explore|search)( all)? (jobs|openings|roles|positions|opportunities)|current openings|job openings|all jobs|view jobs|find (a )?jobs?)\b/i;
const LIST_WEAK = /\b(careers?|jobs|join (us|our team))\b/i;

type Link = { text: string; href: string; row?: string };

// A URL without its #fragment or trailing slash, to compare pages.
const bare = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");

// Job links on a listing page share one URL pattern (/careers/details/<id>); menus and
// promos do not. Takes the biggest same-pattern group of links that read like job titles.
export function jobLinks(found: Link[], here: string): Job[] {
  const groups = new Map<string, Map<string, Job>>();
  for (const l of found) {
    if (!/^https?:/.test(l.href) || bare(l.href) === here || l.text.length > 120) continue;
    if (l.text.split(" ").length < 2 || !ROLE_WORD.test(l.text)) continue;
    const u = new URL(l.href);
    const dir = u.pathname.replace(/\/[^/]*\/?$/, "/*");
    const shape = u.hostname + dir + (u.search ? "?" + [...u.searchParams.keys()].sort().join("&") : "");
    const g = groups.get(shape) ?? new Map<string, Job>();
    if (!g.has(bare(l.href))) g.set(bare(l.href), { title: l.text, url: l.href, location: l.row ?? "" });
    groups.set(shape, g);
  }
  const top = [...groups.values()].sort((a, b) => b.size - a.size)[0];
  return top && top.size >= 2 ? [...top.values()] : [];
}

// Every link with the text of its row (the nearest parent that says more than the link):
// on a job list the row usually holds the location.
async function links(page: Page): Promise<Link[]> {
  return page.$$eval("a[href]", (as) =>
    as.map((a) => {
      const own = ((a as HTMLElement).innerText ?? a.textContent ?? "").replace(/\s+/g, " ").trim();
      let row: Element = a;
      for (let i = 0; i < 4 && row.parentElement; i++) {
        row = row.parentElement;
        if (((row as HTMLElement).innerText ?? "").trim().length > own.length + 5) break;
      }
      const rowText = ((row as HTMLElement).innerText ?? "").split(/\s*\n\s*/).map((x) => x.trim()).filter((x) => x && x !== own).join(" · ");
      return { text: own, href: (a as HTMLAnchorElement).href, row: rowText.length <= 150 ? rowText : "" };
    })
  );
}

// JobPosting items in the page's JSON-LD (what careers sites publish for Google Jobs).
export function jsonLdPostings(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const type = o["@type"];
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) out.push(o);
      if (o["@graph"]) visit(o["@graph"]);
      if (o.itemListElement) visit(o.itemListElement);
      if (o.item) visit(o.item);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]));
    } catch {
      // A malformed block is skipped; the page's links are the fallback.
    }
  }
  return out;
}

function ldLocation(p: Record<string, unknown>): string {
  const locs = [p.jobLocation].flat().filter(Boolean) as Record<string, unknown>[];
  const parts = locs.map((l) => {
    const a = (l.address ?? {}) as Record<string, unknown>;
    return [a.addressLocality, a.addressRegion, a.addressCountry].filter((x) => typeof x === "string" && x).join(", ");
  }).filter(Boolean);
  if (p.jobLocationType === "TELECOMMUTE") parts.push("Remote");
  return [...new Set(parts)].join("; ");
}

// Plain text with a line break after each block, so paragraphs do not run together.
function text(html: string): string {
  const spaced = html.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, "$&\n");
  const { document } = parseHTML(`<html><body>${spaced}</body></html>`);
  return (document.body.textContent ?? "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function open(browser: Browser): Promise<{ page: Page; urls: string[] }> {
  const page = await browser.newPage();
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("frameattached", (f) => urls.push(f.url()));
  return { page, urls };
}

// Loads a page; returns why it is blocked, or null.
async function load(page: Page, url: string): Promise<string | null> {
  if (!(await allowed(url))) return "robots.txt disallows " + new URL(url).pathname;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const status = resp?.status() ?? 0;
  if (status === 403 || status === 429) return `status ${status}`;
  if (BLOCK_TITLE.test(await page.title())) return "challenge page";
  return null;
}

export async function list(start: string): Promise<{ ats?: Ats; jobs?: Job[]; blocked?: string }> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const { page, urls } = await open(browser);
    let url = start;
    const visited = new Set<string>();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const blocked = await load(page, url);
      if (blocked) return { blocked };
      const found = await links(page);
      const board = detectBoard([...urls, ...found.map((l) => l.href), ...page.frames().map((f) => f.url())]);
      if (board) return { ats: board };

      const html = await page.content();
      const ld = jsonLdPostings(html).filter((p) => typeof p.title === "string");
      if (ld.length) {
        return {
          jobs: ld.slice(0, MAX_JOBS).map((p) => ({
            title: String(p.title), url: typeof p.url === "string" ? p.url : page.url(), location: ldLocation(p)
          }))
        };
      }
      const here = bare(page.url());
      visited.add(here);
      const jobs = jobLinks(found, here);
      if (jobs.length >= 2) return { jobs: jobs.slice(0, MAX_JOBS) };

      // A landing page: follow the link to the openings (strong wording first, same site
      // first), never a page already seen.
      const host = new URL(page.url()).hostname;
      const rank = (l: Link) => (LIST_STRONG.test(l.text) ? 2 : 0) + (new URL(l.href).hostname === host ? 1 : 0);
      const next = found
        .filter((l) => /^https?:/.test(l.href) && !visited.has(bare(l.href)) && (LIST_STRONG.test(l.text) || LIST_WEAK.test(l.text)))
        .sort((a, b) => rank(b) - rank(a))[0];
      if (!next) break;
      url = next.href;
    }
    return { jobs: [] };
  } finally {
    await browser.close();
  }
}

// Description from JSON-LD, else the page's main text (Readability). Plain HTTP first; a
// browser only when the page needs scripts to show the job.
export async function describe(url: string): Promise<Details | { blocked: string }> {
  if (!(await allowed(url))) return { blocked: "robots.txt disallows " + new URL(url).pathname };
  const fromHtml = (html: string): Details | null => {
    const { document } = parseHTML(html);
    const meta = (prop: string) => document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content")?.trim() ?? "";
    const heading = (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const title = heading || meta("og:title") || (document.querySelector("title")?.textContent ?? "").trim();
    const company = meta("og:site_name");
    const ld = jsonLdPostings(html)[0];
    if (ld && typeof ld.description === "string") {
      const org = ld.hiringOrganization as Record<string, unknown> | undefined;
      return {
        description: text(ld.description), location: ldLocation(ld), posted_at: iso(ld.datePosted),
        title: typeof ld.title === "string" ? ld.title : title,
        company: typeof org?.name === "string" ? org.name : company
      };
    }
    const main = text(new Readability(document as unknown as Document).parse()?.content ?? "");
    return main.length >= 500 ? { description: main, location: "", posted_at: "", title, company } : null;
  };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const d = fromHtml(await r.text());
      if (d) return d;
    }
  } catch {
    // Fall through to the browser.
  }
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const { page } = await open(browser);
    const blocked = await load(page, url);
    if (blocked) return { blocked };
    return fromHtml(await page.content()) ?? { description: "", location: "", posted_at: "", title: "", company: "" };
  } finally {
    await browser.close();
  }
}

function iso(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

if (import.meta.main) {
  const [cmd, url] = process.argv.slice(2);
  if (!url || (cmd !== "list" && cmd !== "describe")) {
    console.error("usage: crawl.ts list <careers-url> | describe <job-url>");
    process.exit(2);
  }
  const out = cmd === "list" ? await list(url) : await describe(url);
  if ("blocked" in out && out.blocked && cmd === "describe") {
    console.error(`blocked: ${out.blocked}`);
    process.exit(1);
  }
  console.log(JSON.stringify(out));
}

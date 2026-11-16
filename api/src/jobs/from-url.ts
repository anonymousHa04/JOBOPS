// One job from its link (job add <url>). Links on a known board use that board's API for
// the one posting; any other page goes through the careers crawler (describe), which
// reads the job's JSON-LD or its main text.
import { describe } from "../careers/crawl.ts";
import type { JobInput } from "./schema.ts";
import { JobInputSchema } from "./schema.ts";

type Fetched = Omit<JobInput, "required_skills" | "preferred_skills" | "company"> & { company: string };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) throw new Error(`job not found (it may be closed): ${url}`);
  if (!r.ok) throw new Error(`GET ${url}: status ${r.status}`);
  return (await r.json()) as T;
}

// Plain text from board HTML, a line break after each block.
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|ul|ol)>/gi, "$&\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const iso = (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString().replace(/\.\d{3}Z$/, "Z");
};
// "razorpaysoftwareprivatelimited" stays as is; the user's company list names it better.
const titleCase = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

type Board = { name: string; re: RegExp; fetch: (m: RegExpMatchArray, url: string) => Promise<Fetched> };

const BOARDS: Board[] = [
  {
    name: "greenhouse",
    re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i,
    fetch: async ([, slug, id], url) => {
      const j = await getJson<{ title: string; content: string; location?: { name?: string }; updated_at?: string; company_name?: string }>(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`);
      return { title: j.title, company: j.company_name ?? titleCase(slug), description: plain(unescape(j.content)),
        location: j.location?.name, posted_at: iso(j.updated_at), source_url: url, source_name: "greenhouse" };
    }
  },
  {
    name: "lever",
    re: /jobs\.lever\.co\/([\w-]+)\/([0-9a-f-]{36})/i,
    fetch: async ([, slug, id], url) => {
      const j = await getJson<{ text: string; descriptionPlain?: string; additionalPlain?: string; createdAt?: number;
        categories?: { location?: string }; lists?: { text: string; content: string }[] }>(`https://api.lever.co/v0/postings/${slug}/${id}`);
      const lists = (j.lists ?? []).map((l) => `${l.text}\n${plain(l.content)}`).join("\n\n");
      return { title: j.text, company: titleCase(slug), description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join("\n\n").trim(),
        location: j.categories?.location, posted_at: iso(j.createdAt), source_url: url, source_name: "lever" };
    }
  },
  {
    name: "ashby",
    re: /jobs\.ashbyhq\.com\/([\w.-]+)\/([0-9a-f-]{36})/i,
    fetch: async ([, slug, id], url) => {
      const board = await getJson<{ jobs: { id: string; title: string; location?: string; descriptionPlain?: string; publishedAt?: string }[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      const j = board.jobs.find((x) => x.id === id);
      if (!j) throw new Error(`job not found on ${slug}'s board (it may be closed): ${url}`);
      return { title: j.title, company: titleCase(slug), description: j.descriptionPlain ?? "", location: j.location,
        posted_at: iso(j.publishedAt), source_url: url, source_name: "ashby" };
    }
  },
  {
    name: "workday",
    re: /([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)(\/job\/[^?#]+)/,
    fetch: async (m, url) => {
      const [whole, tenant, wd, site, path] = m;
      // LinkedIn share links end in /apply (or /apply/...) after the job's /job/... path; the job is the part before it.
      const segs = path.split("/");
      const k = segs.indexOf("apply", 2);
      const job = k > 2 ? segs.slice(0, k).join("/") : path;
      const start = m.index! + whole.length - path.length;
      const link = job === path ? url : url.slice(0, start) + job + url.slice(start + path.length);
      const j = await getJson<{ jobPostingInfo: { title: string; jobDescription: string; location?: string; startDate?: string } }>(
        `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${job}`);
      const i = j.jobPostingInfo;
      return { title: i.title, company: titleCase(tenant), description: plain(i.jobDescription), location: i.location,
        posted_at: iso(i.startDate), source_url: link, source_name: "workday" };
    }
  },
  {
    name: "smartrecruiters",
    re: /jobs\.smartrecruiters\.com\/([\w-]+)\/(\d+)/i,
    fetch: async ([, slug, id], url) => {
      const j = await getJson<{ name: string; releasedDate?: string; company?: { name?: string };
        location?: { city?: string; country?: string; remote?: boolean };
        jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`);
      const sections = j.jobAd?.sections ?? {};
      const description = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
        .map((k) => sections[k]).filter((s) => s?.text).map((s) => `${s!.title ?? ""}\n${plain(s!.text!)}`).join("\n\n");
      const loc = [j.location?.city, j.location?.country?.toUpperCase(), j.location?.remote ? "Remote" : ""].filter(Boolean).join(", ");
      return { title: j.name, company: j.company?.name ?? titleCase(slug), description, location: loc || undefined,
        posted_at: iso(j.releasedDate), source_url: url, source_name: "smartrecruiters" };
    }
  }
];

// The board a link belongs to, or "careers" for any other page.
export function boardOf(url: string): string {
  if (/[?&]gh_jid=\d+/.test(url)) return "greenhouse";
  return BOARDS.find((b) => b.re.test(url))?.name ?? "careers";
}

// A Greenhouse job embedded on the company's own site (?gh_jid=123): the id is in the
// link, the board slug is not. Tries the slugs the user's company list gives for this
// site, then the site's name.
async function embeddedGreenhouse(url: string, slugs: string[]): Promise<{ job: Fetched; slug: string } | null> {
  const id = url.match(/[?&]gh_jid=(\d+)/)?.[1];
  if (!id) return null;
  const board = BOARDS[0];
  for (const slug of slugs) {
    try {
      return { job: await board.fetch(["", slug, id] as unknown as RegExpMatchArray, url), slug };
    } catch {
      // Not this slug.
    }
  }
  return null;
}

// Words a job description has and a landing or list page does not.
const JD_SIGNALS = /\b(responsibilit|requirement|qualification|what you('|’)ll do|you will|about the role|about you|experience (with|in)|years of experience|must have|nice to have|we('|’)re looking for)/gi;
export const looksLikeJd = (t: string) => new Set((t.match(JD_SIGNALS) ?? []).map((m) => m.toLowerCase().slice(0, 12))).size >= 2;

// Fetches one job. `company` overrides the name read from the board or page; `known`
// maps board slugs to the names in the user's company list.
export async function fetchJob(url: string, opts: { company?: string; known?: Map<string, string> } = {}): Promise<JobInput> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("the link must start with http:// or https://");
  let job: Fetched | null = null;
  for (const b of BOARDS) {
    const m = url.match(b.re);
    if (m) {
      job = await b.fetch(m, url);
      job.company = opts.known?.get(m[1].toLowerCase()) ?? job.company;
      break;
    }
  }
  const site = u.hostname.replace(/^(www|careers|jobs)\./, "").split(".")[0];
  if (!job) {
    const named = [...(opts.known ?? [])].filter(([slug, name]) => name.toLowerCase().replace(/\W/g, "") === site || slug === site).map(([slug]) => slug);
    const found = await embeddedGreenhouse(url, [...new Set([...named, site, `${site}inc`])]);
    if (found) job = { ...found.job, company: opts.known?.get(found.slug) ?? found.job.company };
  }
  if (!job) {
    const d = await describe(url);
    if ("blocked" in d) throw new Error(`the page refuses automated access (${d.blocked}); this site cannot be read automatically`);
    if (!d.description || !looksLikeJd(d.description)) {
      throw new Error("no job description found on the page (it looks like a list or landing page); use the link to the job's own page");
    }
    job = { title: d.title, company: d.company || titleCase(site), description: d.description,
      location: d.location || undefined, posted_at: d.posted_at || undefined, source_url: url, source_name: "careers" };
  }
  if (opts.company) job.company = opts.company;
  if (!job.title) throw new Error("no job title found on the page");
  if (!job.description.trim()) throw new Error("the job has no description");
  return JobInputSchema.parse({ ...job, description: job.description.slice(0, 45_000), location: job.location?.slice(0, 200) });
}

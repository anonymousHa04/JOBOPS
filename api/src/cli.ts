// JobOps command line: node api/src/cli.ts <command>. Prints JSON.
import "./env.ts";
import * as t from "./tools.ts";

const USAGE = `usage: node api/src/cli.ts <command>
  bank build | check | retag | dedupe | approve | status
  bank mark-break <role-id> [--title "Career break (reason)"]
  bank education [--school "<name>"] [--degree "<degree>"] [--dates "<from - to>"] [--id <education-id>]
  prefs role <title> [--aliases "a,b"]   (target job title for jd-search)
  prefs exclude <word> [<word> ...]       (title words that drop a posting)
  prefs pages <1-3>                       (page limit for tailored resumes)
  prefs company <name> --slug <slug> --ats auto|greenhouse|lever|ashby|workday|smartrecruiters|careers
  skill add <name> --evidence "<where used>"
  skill no <name>
  skill remove <name>
  bullet add <entry-id> "<text>" --tags a,b,c [--impact high|medium|low] [--topic <slug>] [--evidence "<answer>"]
  learnable <skill> yes|no --job <job_id>
  risk skip <risk-id>
  models                  (which model each task uses, and whether its server is up)
  models stats [--since <ISO time>]   (the model call log: outcomes, timing, tokens per task)
  job add <url> [--company <name>] [--force] [--no-render]
                         (fetch one job by its link, then parse, judge, tailor, and render)
  jobs [--q <text>] [--limit N] [--unparsed]
  jd parse <job_id>
  jd parse-all [--limit N]
  score <job_id> [--no-judge]
  risk <job_id>
  tailor <job_id> [--dry-run] [--force]
  tailor --all --dry-run
  render <resume_id>     (PDF, kept only if the parse-back test passes)
  lint <resume_id>
  ats check [<resume_id>]  (local readers: pdftotext, pdf.js, OpenResume; the fake resume without an id)
  ats compare <report.json>     (what a site's autofill showed for the fake resume vs expected)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}\n${USAGE}`);
  return v;
}

async function main(argv: string[]): Promise<unknown> {
  const [cmd, sub, ...rest] = argv;
  const args = [sub, ...rest].filter((a): a is string => a !== undefined);
  switch (cmd) {
    case "bank":
      if (sub === "build") return t.bankBuild();
      if (sub === "check") return t.bankCheck();
      if (sub === "retag") return t.bankRetag();
      if (sub === "dedupe") return t.bankDedupeSkills();
      if (sub === "approve") return t.bankApprove();
      if (sub === "status") return t.bankStatus();
      if (sub === "education") return t.bankEducation({ school: flag(rest, "school"), degree: flag(rest, "degree"), dates: flag(rest, "dates") }, flag(rest, "id"));
      if (sub === "mark-break") return t.bankMarkBreak(need(rest[0], "role id"), flag(rest, "title"));
      break;
    case "prefs":
      if (sub === "role") return t.prefsRoleAdd(need(rest[0], "title"), (flag(rest, "aliases") ?? "").split(",").filter(Boolean));
      if (sub === "company") {
        const ats = need(flag(rest, "ats"), "--ats");
        const known = ["auto", "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "careers"] as const;
        if (!(known as readonly string[]).includes(ats)) throw new Error(`--ats: ${known.join("|")}`);
        return t.prefsCompany(need(rest[0], "company name"), need(flag(rest, "slug"), "--slug"), ats as (typeof known)[number]);
      }
      if (sub === "pages") {
        const n = Number(need(rest[0], "page count"));
        if (![1, 2, 3].includes(n)) throw new Error("pages: 1, 2, or 3");
        return t.prefsPages(n);
      }
      if (sub === "exclude") return t.prefsExclude(rest.length ? rest : [need(undefined, "word")]);
      break;
    case "skill":
      if (sub === "add") return t.skillAdd(need(rest[0], "skill name"), true, flag(rest, "evidence") ?? "");
      if (sub === "no") return t.skillAdd(need(rest[0], "skill name"), false, "");
      if (sub === "remove") return t.skillRemove(need(rest[0], "skill name"));
      break;
    case "bullet": {
      if (sub !== "add") break;
      const impact = flag(rest, "impact") ?? "medium";
      if (impact !== "high" && impact !== "medium" && impact !== "low") throw new Error("impact: high|medium|low");
      const tags = need(flag(rest, "tags"), "--tags").split(",");
      return t.bulletAdd(need(rest[0], "entry id"), need(rest[1], "bullet text"), tags, impact,
        { topic: flag(rest, "topic"), evidence: flag(rest, "evidence") });
    }
    case "learnable": {
      const answer = need(rest[0], "yes|no");
      if (answer !== "yes" && answer !== "no") throw new Error("answer yes or no");
      return t.learnableSet(need(sub, "skill"), answer === "yes", need(flag(rest, "job"), "--job"));
    }
    case "risk":
      if (sub === "skip") return t.riskSkip(need(rest[0], "risk id"));
      return t.risk(t.db(), need(sub, "job id"));
    case "models":
      if (sub === "stats") return t.modelStats({ since: flag(rest, "since") });
      if (!sub) return t.models();
      break;
    case "job":
      if (sub === "add") {
        return t.jobAdd(t.db(), need(rest[0], "job link"),
          { company: flag(rest, "company"), force: rest.includes("--force"), render: !rest.includes("--no-render") });
      }
      break;
    case "jobs":
      return t.listJobs(t.db(), {
        q: flag(args, "q"),
        limit: Number(flag(args, "limit") ?? 50),
        unparsed: args.includes("--unparsed")
      });
    case "jd":
      if (sub === "parse") return t.jdParse(t.db(), need(rest[0], "job id"));
      if (sub === "parse-all") return t.jdParseAll(t.db(), Number(flag(rest, "limit") ?? 20));
      break;
    case "score":
      return t.score(t.db(), need(sub, "job id"), !args.includes("--no-judge"));
    case "ats":
      if (sub === "check") return t.ats(t.db(), { resumeId: rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined });
      if (sub === "compare") return t.atsCompare(need(rest[0], "report file"));
      break;
    case "lint":
      return t.lint(t.db(), need(sub, "resume id"));
    case "render":
      return t.render(t.db(), need(sub, "resume id"));
    case "tailor":
      if (sub === "--all") {
        if (!args.includes("--dry-run")) throw new Error("tailor --all only as a dry run; tailor one job at a time");
        return t.tailorAll(t.db());
      }
      return t.tailor(t.db(), need(sub, "job id"), { force: args.includes("--force"), dryRun: args.includes("--dry-run") });
  }
  throw new Error(USAGE);
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

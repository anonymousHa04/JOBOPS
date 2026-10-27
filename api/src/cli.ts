// JobOps command line: node api/src/cli.ts <command>. Prints JSON.
import "./env.ts";
import * as t from "./tools.ts";

const USAGE = `usage: node api/src/cli.ts <command>
  bank build | check | approve | status
  skill add <name> --evidence "<where used>"
  skill no <name>
  bullet add <entry-id> "<text>" --tags a,b,c [--impact high|medium|low]
  learnable <skill> yes|no --job <job_id>
  risk skip <risk-id>
  jobs [--q <text>] [--limit N] [--unparsed]
  jd parse <job_id>
  jd parse-all [--limit N]
  score <job_id> [--no-judge]
  risk <job_id>
  tailor <job_id> [--dry-run] [--force]
  tailor --all --dry-run
  render <resume_id>     (PDF, kept only if the parse-back test passes)
  lint <resume_id>`;

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
      if (sub === "approve") return t.bankApprove();
      if (sub === "status") return t.bankStatus();
      break;
    case "skill":
      if (sub === "add") return t.skillAdd(need(rest[0], "skill name"), true, flag(rest, "evidence") ?? "");
      if (sub === "no") return t.skillAdd(need(rest[0], "skill name"), false, "");
      break;
    case "bullet": {
      if (sub !== "add") break;
      const impact = flag(rest, "impact") ?? "medium";
      if (impact !== "high" && impact !== "medium" && impact !== "low") throw new Error("impact: high|medium|low");
      const tags = need(flag(rest, "tags"), "--tags").split(",");
      return t.bulletAdd(need(rest[0], "entry id"), need(rest[1], "bullet text"), tags, impact);
    }
    case "learnable": {
      const answer = need(rest[0], "yes|no");
      if (answer !== "yes" && answer !== "no") throw new Error("answer yes or no");
      return t.learnableSet(need(sub, "skill"), answer === "yes", need(flag(rest, "job"), "--job"));
    }
    case "risk":
      if (sub === "skip") return t.riskSkip(need(rest[0], "risk id"));
      return t.risk(t.db(), need(sub, "job id"));
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

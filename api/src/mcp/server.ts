// MCP stdio server "jobops-tools": the same operations as the CLI.
// Tool results are ids, counts, scores, and questions; never resume text.
import "../env.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as t from "../tools.ts";

const server = new McpServer({ name: "jobops-tools", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function reply(run: () => unknown): Promise<Result> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(), null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const job = { job_id: z.string().describe("Job id from list_jobs") };

server.registerTool("bank_status", { description: "Experience bank counts, approval, and issue count." }, () =>
  reply(() => t.bankStatus())
);

server.registerTool(
  "add_skill",
  {
    description: "Record a skill the resume omits (have) or one the user doesn't have (dont_have).",
    inputSchema: { name: z.string(), have: z.boolean(), evidence: z.string().default("") }
  },
  ({ name, have, evidence }) => reply(() => t.skillAdd(name, have, evidence))
);

server.registerTool(
  "add_bullet",
  {
    description: "Add a user-written bullet to a role or project in the bank.",
    inputSchema: {
      entry_id: z.string(),
      text: z.string(),
      tags: z.array(z.string()),
      impact: z.enum(["high", "medium", "low"]).default("medium")
    }
  },
  ({ entry_id, text, tags, impact }) => reply(() => t.bulletAdd(entry_id, text, tags, impact))
);

server.registerTool(
  "record_learnable",
  {
    description: "Record whether a missing skill is learnable for this JD.",
    inputSchema: { skill: z.string(), learnable: z.boolean(), ...job }
  },
  ({ skill, learnable, job_id }) => reply(() => t.learnableSet(skill, learnable, job_id))
);

server.registerTool(
  "dismiss_risk",
  { description: "Stop a risk question from being asked again.", inputSchema: { id: z.string() } },
  ({ id }) => reply(() => t.riskSkip(id))
);

server.registerTool(
  "list_jobs",
  {
    description: "List stored jobs (id, company, title, location).",
    inputSchema: { q: z.string().optional(), limit: z.number().int().positive().default(50), unparsed: z.boolean().default(false) }
  },
  ({ q, limit, unparsed }) => reply(() => t.listJobs(t.db(), { q, limit, unparsed }))
);

server.registerTool(
  "parse_jd",
  { description: "Extract requirements from a stored JD with the local model.", inputSchema: job },
  ({ job_id }) => reply(() => t.jdParse(t.db(), job_id))
);

server.registerTool(
  "score",
  {
    description: "Score the bank against a parsed JD: band, hard constraint, gaps, skill questions. " +
      "Uses the local LLM judge (general7) for requirements the index cannot settle; judge=false uses cached verdicts only.",
    inputSchema: { ...job, judge: z.boolean().default(true) }
  },
  ({ job_id, judge }) => reply(() => t.score(t.db(), job_id, judge))
);

server.registerTool(
  "risk_check",
  { description: "Rejection risks for a parsed JD, each with a question for the user.", inputSchema: job },
  ({ job_id }) => reply(() => t.risk(t.db(), job_id))
);

const record = { resume_id: z.string().describe("Record id from tailor or tailor_all_dry_run") };

server.registerTool(
  "tailor",
  {
    description: "Tailor the resume for one parsed JD: judge, decide (reuse/adapt/not_tailored), ask open risk " +
      "questions, reword marked bullets on the local model, and write the record in profile/records. " +
      "Blocked by open risks unless force=true. dry_run=true decides only (cached verdicts, no model calls, no files). " +
      "Needs an approved bank.",
    inputSchema: { ...job, force: z.boolean().default(false), dry_run: z.boolean().default(false) }
  },
  ({ job_id, force, dry_run }) => reply(() => t.tailor(t.db(), job_id, { force, dryRun: dry_run }))
);

server.registerTool(
  "job_from_url",
  {
    description: "Add one job by its link and run the rest: fetch it (Greenhouse, Lever, Ashby, Workday, " +
      "SmartRecruiters by their APIs; any other careers page through the crawler), parse the JD, judge and score, " +
      "decide, reword on the local model, write the record, and render the PDF. Steps already done are skipped. " +
      "When a step's model is not running it stops and returns the commands to continue; it never starts models.",
    inputSchema: {
      url: z.url().describe("The job's link"),
      company: z.string().optional().describe("Company name, when the page does not say it well"),
      force: z.boolean().default(false),
      render: z.boolean().default(true)
    }
  },
  ({ url, company, force, render }) => reply(() => t.jobAdd(t.db(), url, { company, force, render }))
);

server.registerTool(
  "tailor_all_dry_run",
  {
    description: "Decision table for every parsed JD (reuse/adapt/not_tailored, band, score, equivalence, " +
      "same-company warnings) and every open risk question with its jobs. Cached verdicts only; no model calls, no files."
  },
  () => reply(() => t.tailorAll(t.db()))
);

server.registerTool(
  "render",
  {
    description: "Render a record to an ATS-safe PDF in profile/pdf. The PDF is kept only if the parse-back test " +
      "(pdftotext and pdf.js) reads every bullet, field, and link back exactly; otherwise the issues are returned.",
    inputSchema: record
  },
  ({ resume_id }) => reply(() => t.render(t.db(), resume_id))
);

server.registerTool(
  "ats_check",
  {
    description: "ATS check: render a resume and read it back with three local readers (pdftotext, pdf.js, " +
      "OpenResume), field by field. resume_id checks a record; without it, the fake test resume. Returns codes and ids.",
    inputSchema: { resume_id: z.string().optional().describe("A record to check; omit for the fake resume") }
  },
  ({ resume_id }) => reply(() => t.ats(t.db(), { resumeId: resume_id }))
);

server.registerTool(
  "models",
  { description: "Which local model each task uses (api/config/models.yaml), its timeout and answer limit, and whether its server is up." },
  () => reply(() => t.models())
);

server.registerTool(
  "model_stats",
  {
    description: "The model call log per task and model: calls, outcomes (ok, retry_ok, invalid_output, timeout, " +
      "unavailable), average and p95 seconds, and tokens. Codes and numbers only.",
    inputSchema: { since: z.string().optional().describe("ISO time; only calls after it") }
  },
  ({ since }) => reply(() => t.modelStats({ since }))
);

server.registerTool(
  "lint",
  {
    description: "Resume lint, tenure/gap checks for a record: findings as codes and ids, each marked " +
      "engine, user, or manual. Reports only; never changes the record.",
    inputSchema: record
  },
  ({ resume_id }) => reply(() => t.lint(t.db(), resume_id))
);

await server.connect(new StdioServerTransport());

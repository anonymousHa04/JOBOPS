// MCP stdio server "jobops-tools": the same operations as the CLI.
// Tool results are ids, counts, scores, and questions; never resume text.
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
  { description: "Score the bank against a parsed JD: band, hard constraint, gaps, skill questions.", inputSchema: job },
  ({ job_id }) => reply(() => t.score(t.db(), job_id))
);

server.registerTool(
  "risk_check",
  { description: "Rejection risks for a parsed JD, each with a question for the user.", inputSchema: job },
  ({ job_id }) => reply(() => t.risk(t.db(), job_id))
);

await server.connect(new StdioServerTransport());

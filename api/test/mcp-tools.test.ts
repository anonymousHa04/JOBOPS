import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The MCP server as Claude Code starts it (stdio), on an empty profile: the engine tools
// are registered and answer with an error message instead of crashing.
test("mcp: tailor, tailor_all_dry_run, render, and lint are served", async () => {
  const profile = mkdtempSync(join(tmpdir(), "jobops-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "mcp", "server.ts")],
    env: { ...process.env, JOBOPS_PROFILE_DIR: profile, DB_PATH: ":memory:" } as Record<string, string>,
    stderr: "ignore"
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of ["tailor", "tailor_all_dry_run", "render", "lint", "score", "risk_check"]) assert.ok(names.includes(n), n);
    const r = await client.callTool({ name: "lint", arguments: { resume_id: "nope" } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /no bank/);
  } finally {
    await client.close();
  }
});

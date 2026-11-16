import { existsSync } from "node:fs";
import { join } from "node:path";

// Loads the repo's .env (see .env.example) into process.env. Import it first in every
// entry point (server, CLI, MCP server). Variables already set in the shell win; a
// missing .env changes nothing, since every setting has the same default in code.
// Tests do not load it, so they never depend on local settings.
const path = join(import.meta.dirname, "..", "..", ".env");
if (existsSync(path)) process.loadEnvFile(path);

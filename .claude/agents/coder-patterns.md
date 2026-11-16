# JobOps code patterns (read before writing code)

Collected from real coder mistakes in Milestone 3. Follow them exactly.

## Runtime
- Node 24 runs .ts files directly (type stripping). tsconfig: strict, nodenext,
  verbatimModuleSyntax, erasableSyntaxOnly.
- No enums, namespaces, decorators, or constructor parameter properties.

## Imports
- Relative imports end in .ts:  import { openDb } from "../db.ts";
- Types use import type:  import type { Bank } from "../profile/schema.ts";
- Only these packages exist: zod, yaml, better-sqlite3, fastify,
  @modelcontextprotocol/sdk. Never import anything else.
- Use Node built-ins: fetch, AbortSignal.timeout(ms), crypto.randomUUID(),
  node:fs (readFileSync, writeFileSync, existsSync, mkdirSync), node:path,
  node:crypto (createHash).
- Before importing from a project file, check the API map: use the exact
  exported names and signatures listed there.

## Zod v4
- Put trim/min/max before any transform: z.string().trim().min(1).max(120).
  .transform() returns ZodPipe, which has no .min/.max.
- JSON Schema: z.toJSONSchema(schema) is a function. schema.toJSONSchema() does not exist.
- Defaults: z.array(z.string()).default([]).
- Validate with schema.safeParse(x); errors are in result.error.issues.

## Exports
- Every name the spec says to export must be exported: export const X,
  export function X, export type X. Schemas too, not only their types.

## Errors and unknown values
- catch (err): err is unknown. Use err instanceof Error ? err.message : String(err).
- res.json(), JSON.parse, and db rows are unknown: cast to a narrow type
  (as { data: string } | undefined) or validate with a schema.
- Model output: data.message.content is a string. JSON.parse it inside try,
  then safeParse.

## SQLite (better-sqlite3)
- import type { Db } from "../db.ts";
- db.prepare(sql).get(a, b) / .all() / .run(); use ? placeholders, never
  string-built SQL.

## YAML
- import { parse, stringify } from "yaml"; always validate parse() output with a schema.

## Style
- Double quotes, 2-space indent, semicolons. Match the nearest existing file.
- No tests unless the spec asks for them.

## Before you finish
1. Every function and type named in the spec exists, with the spec's signature.
2. Every name the spec says to export is exported.
3. No imports outside the list above; relative imports end in .ts.
4. No "any"; parameters have types.

## Tests
- Tests use Node's runner only: import { test } from "node:test"; import assert from
  "node:assert/strict". Never vitest, jest, or mocha (not installed).
- Test files live in api/test/ and import source with "../src/<path>.ts".
- No model calls in tests: test pure functions, or use the fixture style the spec names
  (a temp JOBOPS_PROFILE_DIR, openDb(":memory:"), buildApp({ db }) and app.inject).
- Build test data with ./fixtures.ts (bank, setup, addRecord, postReport, ext): never write
  a Bank, record or requirements object by hand.
- Asserts that say what they got: assert.equal(a, b) and assert.deepEqual(a, b), never
  assert(a === b); assert.ok(cond, "what was expected") for includes/startsWith.
- No comments that describe your edit ("// Added import ...").

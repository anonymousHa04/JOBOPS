// Send to review (plan-exit-gate.md A3): a verifier item the 7B did not confirm waits for the
// user's approval instead of being a dead end. An approval holds for the exact checked text
// (the reworded bullet, the summary, or the skill name + its evidence); a changed text asks again.
// verify_not_run is never reviewable: the model did not answer, so nothing was checked.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ResumeRecord } from "../profile/schema.ts";
import { textHash } from "../profile/bank.ts";
import { norm } from "../scoring/terms.ts";
import type { Issue } from "./parseback.ts";

export const VerifyKind = z.enum(["claim", "summary", "skill"]);
export type VerifyKind = z.infer<typeof VerifyKind>;
const Approval = z.object({ kind: VerifyKind, id: z.string(), text_hash: z.string(), at: z.string() });
export type VerifyApproval = z.infer<typeof Approval>;
const File = z.object({ approvals: z.array(Approval).default([]) });

export const verifyApprovalsPath = () => join(process.env.JOBOPS_PROFILE_DIR ?? "profile", "verify-approvals.yaml");

export function loadVerifyApprovals(): VerifyApproval[] {
  const path = verifyApprovalsPath();
  if (!existsSync(path)) return [];
  return File.parse(parse(readFileSync(path, "utf8")) ?? {}).approvals;
}

const sameId = (kind: VerifyKind, a: string, b: string) => (kind === "skill" ? norm(a) === norm(b) : a === b);

// One approval per item: a newer approval replaces the one for an older text.
export function addVerifyApproval(kind: VerifyKind, id: string, text: string): VerifyApproval {
  const entry = { kind, id, text_hash: textHash(text), at: new Date().toISOString() };
  const approvals = [...loadVerifyApprovals().filter((a) => !(a.kind === kind && sameId(kind, a.id, id))), entry];
  const path = verifyApprovalsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify({ approvals }));
  return entry;
}

export function isApproved(approvals: VerifyApproval[], kind: VerifyKind, id: string, text: string): boolean {
  const hash = textHash(text);
  return approvals.some((a) => a.kind === kind && sameId(kind, a.id, id) && a.text_hash === hash);
}

// The text a skill is checked (and approved) on: its name and its evidence.
export const skillCheckedText = (skill: string, evidence: string) => skill + "\n" + evidence;

// Which item a verifier issue is about, or null when it is not reviewable (verify_not_run).
export function reviewRef(issue: Issue, record: ResumeRecord): { kind: VerifyKind; id: string } | null {
  if (issue.extractor !== "verifier") return null;
  if (issue.code === "claim_unsupported") return issue.detail === "summary" ? { kind: "summary", id: "summary" } : { kind: "claim", id: issue.detail };
  if (issue.code === "skill_unsupported_model") {
    const skill = record.content.skills[Number(issue.detail.replace(/^skill#/, "")) - 1];
    return skill === undefined ? null : { kind: "skill", id: skill };
  }
  return null;
}

// The reviewable items of a verifier result, once each (kind + id), with the issue code.
export function reviewRefs(issues: Issue[], record: ResumeRecord): { kind: VerifyKind; id: string; code: string }[] {
  const out: { kind: VerifyKind; id: string; code: string }[] = [];
  for (const i of issues) {
    const r = reviewRef(i, record);
    if (r && !out.some((o) => o.kind === r.kind && o.id === r.id)) out.push({ ...r, code: i.code });
  }
  return out;
}

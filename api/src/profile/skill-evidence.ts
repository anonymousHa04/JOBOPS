// When an added skill's evidence backs it (2026-11-10): the one rule the exit gate, "Add as a
// skill" in Gaps and "Edit evidence" in Added skills share, so a skill that would be blocked at
// render time is caught when it is saved. Backed: the evidence names the skill, or it links a
// bank bullet ("bullet <id>") the user ticked as this work. Whether that bullet really shows the
// skill is the verifier's question (it reads the linked bullets' text); code only offers bullets
// whose text or tags name the skill, and never links one by itself.
import type { Bank, Bullet } from "./schema.ts";
import { names } from "./gate.ts";

const skillName = (name: string) => name.replace(/^experience with /i, "");
const allBullets = (bank: Bank): Bullet[] => [...bank.roles, ...bank.projects].flatMap((e) => e.bullets);

// "bullet <id>" in an evidence text, unique, in order (the verifier reads the same form).
export const linkedIds = (evidence: string): string[] => [...new Set([...evidence.matchAll(/bullet ([a-z0-9-]+)/g)].map((m) => m[1]))];

// A bank bullet shows the skill: its text names it, or one of its tags is the skill.
export const bulletShows = (b: Bullet, name: string) =>
  names(b.text, skillName(name)) || (b.tags ?? []).some((t) => t.trim().toLowerCase() === skillName(name).trim().toLowerCase());

// Bank bullets whose own text or tags show the skill (offered with a tick box; found by code).
export function bulletsShowing(bank: Bank, name: string): { id: string; text: string }[] {
  return allBullets(bank).filter((b) => bulletShows(b, name)).map((b) => ({ id: b.id, text: b.text }));
}

// Evidence text for a skill: the user's note, then the ticked bullets as "bullet <id>".
export function withBullets(note: string, bulletIds: string[]): string {
  const ids = [...new Set(bulletIds.filter((id) => /^[a-z0-9-]+$/.test(id)))];
  return ids.length ? `${note.trim()} (${ids.map((id) => `bullet ${id}`).join("; ")})` : note.trim();
}

// null when backed; else why not (for the UI's warning).
export function skillEvidenceIssue(bank: Bank, name: string, evidence: string): string | null {
  if (names(evidence, skillName(name))) return null;
  const byId = new Map(allBullets(bank).map((b) => [b.id, b]));
  if (linkedIds(evidence).some((id) => byId.has(id))) return null;
  return `Your note does not name "${skillName(name)}" and no bullet from your bank is ticked: the resume check would block this skill. Tick a bullet that is this work, or describe the work naming it.`;
}

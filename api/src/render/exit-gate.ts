import type { ResumeRecord, Bank, SkillsExtra } from "../profile/schema.ts";
import type { Issue } from "./parseback.ts";
import { norm } from "../scoring/terms.ts";
import { names } from "../profile/gate.ts";
import { relatedKeywords, textHash } from "../profile/bank.ts";

// A pending related keyword (record.pending_review) the user approved for this exact text: the
// bank bullet's approved_terms has the term with the hash of the record's reworded line.
export function wordingApproved(record: ResumeRecord, bank: Bank, p: { bullet_id: string; keyword: string }): boolean {
  const text = record.content.bullets.find((b) => b.id === p.bullet_id)?.text;
  const b = [...bank.roles, ...bank.projects].flatMap((e) => e.bullets).find((x) => x.id === p.bullet_id);
  return text !== undefined && !!b?.approved_terms?.some((a) => a.term === p.keyword && a.text_hash === textHash(text));
}

// Exit gate: checks every part of the PDF that the bullet-only bank gate does not
// (skills line, summary, open chat fact flags, first use of a related keyword).
export function exitIssues(record: ResumeRecord, bank: Bank, extra: SkillsExtra, openFlags: string[]): Issue[] {
  const issues: Issue[] = [];
  const shownIds = new Set(record.content.bullets.map((b) => b.id));

  // Skills line
  record.content.skills.forEach((s, i) => {
    const skillNorm = norm(s);
    const supported = Object.values(bank.skills).flat().some(skill => norm(skill) === skillNorm) ||
                      extra.skills.some(x => {
                        const ev = x.evidence ?? "";
                        return x.status === "have" && norm(x.name) === skillNorm &&
                          (!ev.startsWith("answer") || names(ev, x.name.replace(/^experience with /i, "")));
                      });
    if (!supported) {
      issues.push({ code: "skill_unsupported", detail: "skill#" + (i + 1), extractor: "exit_gate" });
    }
    // A6 on the output: a related keyword needs one of its linked bullets on this resume (also
    // catches records made before K2). Bank skills, "same" and unlabeled skills are never flagged.
    const isBankSkill = Object.values(bank.skills).flat().some((skill) => norm(skill) === skillNorm);
    const rel = relatedKeywords(extra).find((r) => r.kind === "related" && norm(r.name) === skillNorm);
    if (!isBankSkill && rel && !rel.bullets.some((id) => shownIds.has(id))) {
      issues.push({ code: "skill_unlinked", detail: "skill#" + (i + 1), extractor: "exit_gate" });
    }
  });

  // Summary
  const v = bank.summaries.find(x => x.variant === record.content.summary_variant);
  if (record.content.summary_text && (v === undefined || v.text !== record.content.summary_text)) {
    issues.push({ code: "summary_changed", detail: record.content.summary_variant, extractor: "exit_gate" });
  }

  // Open flags
  openFlags.forEach(id => {
    issues.push({ code: "fact_flag_open", detail: id, extractor: "exit_gate" });
  });

  // A related keyword's first use in a rewording waits for the user's approval of that line (K2).
  (record.pending_review ?? []).filter((p) => !wordingApproved(record, bank, p)).forEach((p) => {
    issues.push({ code: "keyword_review", detail: p.bullet_id, extractor: "exit_gate" });
  });

  return issues;
}

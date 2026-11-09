import type { ResumeRecord, Bank, SkillsExtra } from "../profile/schema.ts";
import type { Issue } from "./parseback.ts";
import { norm } from "../scoring/terms.ts";
import { names } from "../profile/gate.ts";

// Exit gate: checks every part of the PDF that the bullet-only bank gate does not
// (skills line, summary, open chat fact flags).
export function exitIssues(record: ResumeRecord, bank: Bank, extra: SkillsExtra, openFlags: string[]): Issue[] {
  const issues: Issue[] = [];

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

  return issues;
}

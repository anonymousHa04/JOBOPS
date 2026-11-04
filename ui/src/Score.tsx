import { useState } from "react";
import { bandClass } from "./api";
import type { Kind, Part, ScoreDetail, ScoreItem } from "./api";

const PART_LABEL: Record<Part, string> = { must: "Must-haves", resp: "Responsibilities", nice: "Nice-to-haves", keywords: "Keywords" };
const PART_KIND: Record<Part, Kind> = { must: "must", resp: "theme", nice: "nice", keywords: "keyword" };
const COVER_KEY: Record<Part, keyof ScoreDetail["coverage"]> = { must: "must", resp: "theme", nice: "nice", keywords: "keyword" };
const KIND_LABEL: Record<Kind, string> = { must: "Must-have", theme: "Responsibility", nice: "Nice-to-have", keyword: "Keyword" };
const KIND_PLURAL: Record<Kind, string> = { must: "Must-haves", theme: "Responsibilities", nice: "Nice-to-haves", keyword: "Keywords" };
const LABEL_CLASS: Record<string, string> = {
  supported_metric: "ok", supported: "ok", partial: "warn", skill_list_only: "warn", learnable: "info", not_demonstrated: "bad", unknown: "bad"
};
const SOURCE_LABEL: Record<string, string> = {
  index: "found in bank", judge: "judge verdict", index_no_judge: "needs judge", years: "role dates", education: "education",
  user: "your answer", literal: "literal match", none: "no evidence"
};

// Which parts had requirements: a part without any gives its points to the others.
function present(d: ScoreDetail): Part[] {
  return (Object.keys(d.weights.parts) as Part[]).filter((p) =>
    p === "resp" ? d.items.some((i) => i.kind === "theme" || (i.kind === "must" && i.soft)) : d.items.some((i) => i.kind === PART_KIND[p])
  );
}

export function ScoreView({ d }: { d: ScoreDetail }) {
  const parts = present(d);
  const total = parts.reduce((n, p) => n + d.weights.parts[p], 0);
  const raw = parts.reduce((n, p) => n + d.parts[p], 0);
  const band = d.weights.bands.find((b) => d.score >= b.min);

  return (
    <div className="score-view">
      <div className="score-hero">
        <div className={`score-big ${bandClass(d.band)}`}>{d.score.toFixed(1)}</div>
        <div>
          <div className={`band-label ${bandClass(d.band)}`}>{d.band.replace("_", " ")}</div>
          <div className="muted">Decision: <b>{d.decision?.decision.replace("_", " ") ?? "—"}</b>
            {d.decision?.equivalence != null && <> · equivalence {d.decision.equivalence}%</>}
            {d.decision && d.decision.to_reword > 0 && <> · {d.decision.to_reword} bullets to reword</>}
          </div>
          <div className="muted small">Recomputed now from your bank and the cached judge verdicts (no model call).</div>
        </div>
      </div>

      {d.reasons.length > 0 && (
        <div className="why">
          <div className="why-title">{d.tailorable ? "Notes" : "Why it was not tailored"}</div>
          <ul>{d.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      <h4>How the score was calculated</h4>
      <table className="calc">
        <thead><tr><th>Part</th><th>Base points</th><th>Share</th><th>Coverage</th><th>Earned</th></tr></thead>
        <tbody>
          {(Object.keys(d.weights.parts) as Part[]).map((p) => {
            const on = parts.includes(p);
            const share = on ? (100 * d.weights.parts[p]) / total : 0;
            const cov = d.coverage[COVER_KEY[p]];
            return (
              <tr key={p} className={on ? "" : "dim"}>
                <td>{PART_LABEL[p]}</td>
                <td>{d.weights.parts[p]}</td>
                <td>{on ? share.toFixed(1) : "— (none in JD)"}</td>
                <td>
                  {on ? <div className="bar"><div className="bar-fill" style={{ width: `${Math.round(cov * 100)}%` }} /><span>{(cov * 100).toFixed(0)}%</span></div> : "—"}
                </td>
                <td><b>{d.parts[p].toFixed(1)}</b></td>
              </tr>
            );
          })}
          <tr className="sum"><td colSpan={4}>Sum of parts</td><td><b>{raw.toFixed(1)}</b></td></tr>
          {d.cap !== null && (
            <tr className="sum warn-row"><td colSpan={4}>Cap: {d.missing_must} must-have(s) under {d.weights.must_missing_below} credit → at most {d.cap}</td><td><b>{Math.min(raw, d.cap).toFixed(1)}</b></td></tr>
          )}
          <tr className="sum"><td colSpan={4}>Final score → band “{band?.band.replace("_", " ")}” (from {band?.min})</td><td><b>{d.score.toFixed(1)}</b></td></tr>
        </tbody>
      </table>
      <p className="muted small">
        Earned = share × coverage. Coverage of a part is the average credit of its requirements; keywords are hits ÷ total
        (a keyword that is also in a must-have counts ×{d.weights.must_keyword_weight}). Credit per requirement:{" "}
        {Object.entries(d.weights.credit).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}, times the recency of the
        best evidence (1.0 within 12 months, 0.9 within 36, 0.75 older). Only bands {d.weights.tailored_bands.join(", ")} get a
        tailored resume. Years asked {d.hard.years_asked || "—"}, bank shows {d.hard.years_have}: {d.hard.pass ? "pass" : "fail"}.
      </p>

      {d.ask_user.length > 0 && (
        <div className="ask"><b>Skills to answer</b> (have it, learnable, or don't have): {d.ask_user.join(", ")}</div>
      )}

      <h4>Requirements</h4>
      {(["must", "theme", "nice", "keyword"] as Kind[]).map((k) => {
        const list = d.items.filter((i) => i.kind === k);
        if (!list.length) return null;
        return (
          <div key={k} className="req-group">
            <div className="req-group-head">{KIND_PLURAL[k]} <span className="muted">({list.length})</span></div>
            {list.map((i, n) => <Requirement key={`${k}-${n}`} item={i} />)}
          </div>
        );
      })}
    </div>
  );
}

function Requirement({ item }: { item: ScoreItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="req">
      <div className="req-row" onClick={() => item.evidence.length && setOpen(!open)}>
        <span className={`label-chip ${LABEL_CLASS[item.label] ?? ""}`}>{item.label.replace(/_/g, " ")}</span>
        <span className="req-text">{item.requirement}{item.qualifier && <span className="chip tiny" title="Needs judgement beyond a term match">qualifier</span>}{item.soft && <span className="chip tiny">soft skill</span>}</span>
        <span className="req-credit">{item.credit.toFixed(2)}</span>
        <span className="req-source muted">{SOURCE_LABEL[item.source] ?? item.source}</span>
        <span className="req-toggle">{item.evidence.length ? (open ? "▾" : `▸ ${item.evidence.length}`) : ""}</span>
      </div>
      {open && (
        <ul className="evidence">{item.evidence.map((e) => <li key={e.id}><span className="muted">{e.id}</span> {e.text}</li>)}</ul>
      )}
    </div>
  );
}

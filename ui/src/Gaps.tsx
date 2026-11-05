// Gaps tab of the job drawer: what the bank does not show for this job, what each item means and
// where the user may already have it (local model), and their answers. Only the user's own facts
// become bullets; the guard flags any draft that adds to them.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Gap, GapAnswer, GapList, GapHelp, Draft } from "./api";
import { RescoreBar } from "./Rescore";

type Answered = { outcome: string; rescore_batch: number; rescore_error?: string | null };

export function GapsView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [list, setList] = useState<GapList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [watch, setWatch] = useState<number | null>(null); // a re-score batch to follow
  const [explaining, setExplaining] = useState<string | null>(null);

  const load = () => {
    api.gaps(id)
      .then(setList)
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) {
    return <div className="banner error">{err}</div>;
  }

  if (!list) {
    return <div>Loading...</div>;
  }

  const { gaps, not_asked, years, entries } = list;
  const answered = (r: Answered) => {
    setNote(r.outcome + (r.rescore_error ? " · re-score failed: " + r.rescore_error
      : r.rescore_batch > 0 ? " · re-scoring (batch " + r.rescore_batch + ")"
      : r.rescore_batch === -1 ? " · queue server down: re-score from the Batches tab later"
      : " · a score or tailor task is already queued for this job; it uses the new bullet"));
    if (r.rescore_batch > 0) setWatch(r.rescore_batch);
    load();
    onChanged();
  };
  const groups: [Gap["kind"], string][] = [["must", "Must-haves"], ["theme", "Responsibilities"], ["nice", "Nice-to-haves"], ["keyword", "Keywords"]];
  // Asks the local model about every gap with no explanation and no answer, one at a time.
  const explainAll = async () => {
    const todo = gaps.filter((g) => !g.help && !g.answer);
    for (let i = 0; i < todo.length; i++) {
      setExplaining(`Explaining ${i + 1} of ${todo.length}…`);
      await api.gapHelp(id, todo[i].kind, todo[i].requirement).catch(() => null);
    }
    setExplaining(null);
    load();
  };
  const unexplained = gaps.filter((g) => !g.help && !g.answer).length;

  return (
    <div>
      <div className="muted small">
        Everything red on the Score tab for this job. For each one: see what it means, where you may already have it, then answer. A new bullet or skill re-scores the job; if the score allows it, tailoring follows on its own.
      </div>
      <RescoreBar id={id} watch={watch} onDone={() => { setWatch(null); load(); onChanged(); }} />
      {unexplained > 0 && (
        <button className="btn tiny" disabled={explaining !== null} onClick={() => void explainAll()}>
          {explaining ?? `Explain all remaining (${unexplained})`}
        </button>
      )}
      {years && <div className="banner">Years: {years} (years are the one hard limit; answers here cannot change them)</div>}
      {note && <div className="banner ok">{note}</div>}
      {gaps.length === 0 && not_asked.length === 0 && <div className="banner">No gaps: every requirement of this job is covered.</div>}
      {groups.map(([kind, title]) => {
        const items = gaps.filter((gap) => gap.kind === kind);
        return items.length ? (
          <div key={kind}>
            <h4>{title}</h4>
            {items.map((gap) => <GapRow key={gap.kind + gap.requirement + (gap.help ? ":h" : "")} id={id} gap={gap} entries={entries} onAnswered={answered} />)}
          </div>
        ) : null;
      })}
      {not_asked.length > 0 && (
        <div>
          <h4>Not asked here</h4>
          {not_asked.map((n) => (
            <div key={n.kind + n.requirement} className="gap answered">
              <div className="gap-head"><span className="chip">{n.kind}</span><b>{n.requirement}</b></div>
              <div className="muted small">{n.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GapRow({ id, gap, entries, onAnswered }: { id: string; gap: Gap; entries: GapList["entries"]; onAnswered: (r: Answered) => void }) {
  const [help, setHelp] = useState<GapHelp | null>(gap.help);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<GapAnswer | null>(null);
  const [story, setStory] = useState<string>("");
  const [proof, setProof] = useState<string>("");
  // Roles where the user used it: pre-checked from "You may already have it" (a bullet id starts
  // with its role id plus "-"; the longest matching role id wins).
  const roleOf = (bulletId: string) =>
    entries.filter((e) => bulletId.startsWith(e.id + "-")).sort((a, b) => b.id.length - a.id.length)[0]?.id;
  const suggested = (h: GapHelp | null) => [...new Set((h?.related ?? []).map((r) => roleOf(r.bullet_id)).filter((x): x is string => !!x))];
  const [checked, setChecked] = useState<string[]>(() => suggested(gap.help));
  useEffect(() => {
    setChecked((c) => (c.length ? c : suggested(help)));
  }, [help]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const entry = checked.length === 1 ? checked[0] : ""; // a bullet belongs to exactly one role
  const [sameAs, setSameAs] = useState<string>(gap.known_as ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState<string>("");

  const filled = (v: string) => v.trim().length > 0;
  const run = <T,>(what: string, p: Promise<T>, then: (v: T) => void) => {
    setBusy(what);
    setErr(null);
    p.then(then).catch((e: Error) => setErr(e.message)).finally(() => setBusy(null));
  };

  const handleAnswer = (answer: GapAnswer) => {
    if (answer === "learnable" || answer === "no") {
      run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer }), onAnswered);
    } else {
      setMode(answer);
    }
  };

  const handleDraft = () => {
    if (filled(story)) {
      run("draft", api.draft(id, { kind: gap.kind, requirement: gap.requirement, entry_id: entry, story, proof: proof || undefined }), (d) => {
        setDraft(d);
        setText(d.text);
      });
    }
  };

  const handleSave = () => {
    if (filled(text)) {
      run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "have", entry_id: entry, text, tags: draft?.tags, story, proof: proof || undefined }), onAnswered);
    }
  };

  return (
    <div className={`gap${gap.answer ? " answered" : ""}`}>
      <div className="gap-head">
        <span className="chip">{gap.kind}</span>
        <b>{gap.requirement}</b>
        {gap.outcome && <span className="muted small">Answered: {gap.outcome}</span>}
      </div>
      {gap.note && <div className="muted small">{gap.note}</div>}
      {help === null && (
        <button className="btn tiny" onClick={() => run("help", api.gapHelp(id, gap.kind, gap.requirement), setHelp)} disabled={busy === "help"}>
          {busy === "help" ? "Asking the local model…" : "Explain and find related experience"}
        </button>
      )}
      {help !== null && (
        <div className="gap-help">
          <div>What it means: {help.meaning}</div>
          {help.similar_terms.length > 0 && <div>Related terms (check they really match): {help.similar_terms.join(", ")}</div>}
          {help.related.length > 0 && (
            <div>
              You may already have it:
              <ul>
                {help.related.map(item => (
                  <li key={item.bullet_id}><code>{item.bullet_id}</code> {item.why}</li>
                ))}
              </ul>
            </div>
          )}
          {help.questions.length > 0 && (
            <div>
              Think about:
              <ul>
                {help.questions.map(question => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          )}
          <button className="btn ghost tiny" disabled={busy === "help"} onClick={() => run("help", api.gapHelp(id, gap.kind, gap.requirement, true), setHelp)}>
            {busy === "help" ? "Asking the local model…" : "Ask again"}
          </button>
        </div>
      )}
      <div>
        <button className={`btn tiny${mode === "have" ? " accent" : ""}`} onClick={() => handleAnswer("have")}>Yes, I've done this</button>
        {gap.kind === "keyword" && (
          <button className={`btn tiny${mode === "other_name" ? " accent" : ""}`} onClick={() => handleAnswer("other_name")}>I have it under another name</button>
        )}
        <button className={`btn tiny${mode === "learnable" ? " accent" : ""}`} onClick={() => handleAnswer("learnable")}>No, but I could learn it</button>
        <button className={`btn tiny${mode === "no" ? " accent" : ""}`} onClick={() => handleAnswer("no")}>No</button>
      </div>
      {mode === "have" && (
        <div>
          <div className="roles">
            <div className="muted small">Where did you use it? Check every role that applies.</div>
            {entries.map((e) => (
              <label key={e.id} className="role-check">
                <input type="checkbox" checked={checked.includes(e.id)} onChange={() => toggle(e.id)} />
                {e.title + (e.company ? " · " + e.company : "") + " (" + e.dates + ")"}
              </label>
            ))}
            <div>
              <button type="button" className="btn ghost tiny" onClick={() => setChecked(entries.map((e) => e.id))}>Select all</button>
              <button type="button" className="btn ghost tiny" onClick={() => setChecked([])}>Clear</button>
            </div>
          </div>
          <textarea rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Where did you use it, what did you do, and what changed? Your own words; only facts you can defend in an interview." />
          <input type="text" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Proof (optional): a link, a PR, a doc, a number you measured" />
          <button className="btn tiny" onClick={handleDraft} disabled={!filled(story) || !entry || busy === "draft"}>{busy === "draft" ? "Drafting…" : "Draft a bullet"}</button>
          <button className="btn tiny" disabled={!filled(story) || !checked.length || busy === "answer"}
            onClick={() => run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "have", as_skill: true, entry_ids: checked, story, proof: proof || undefined }), onAnswered)}>
            Add as a skill ({checked.length} role{checked.length === 1 ? "" : "s"})
          </button>
          {checked.length !== 1 && <div className="muted small">Check exactly one role to draft a bullet for it.</div>}
          {gap.kind !== "keyword" && (
            <div className="muted small">As a skill this counts 0.3 of 1 for a {gap.kind === "must" ? "must-have" : gap.kind === "theme" ? "responsibility" : "nice-to-have"}; a bullet counts 0.85.{gap.kind === "must" ? " A must-have needs 0.5, so a bullet at your strongest role helps more." : ""}</div>
          )}
          {draft && (
            <div>
              <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              <div>Words: {text.split(/\s+/).filter(word => word.length > 0).length} of 25</div>
              {draft.codes.length > 0 && <div className="banner error">The draft adds what your answer does not say ({draft.codes.join(", ")}). Edit it so it only states your facts.</div>}
              <button className="btn tiny" onClick={handleSave} disabled={!filled(text) || busy === "answer"}>Add to my bank and re-score</button>
            </div>
          )}
        </div>
      )}
      {mode === "other_name" && (
        <div>
          <input type="text" value={sameAs} onChange={(e) => setSameAs(e.target.value)} placeholder="The name you have it under (e.g. a similar tool)" />
          {help && help.similar_terms.length > 0 && (
            <div>
              {help.similar_terms.map(term => (
                <button key={term} className="btn ghost tiny" onClick={() => setSameAs(term)}>{term}</button>
              ))}
            </div>
          )}
          <textarea rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Optional short story" />
          <button className="btn tiny" disabled={!filled(sameAs) || busy === "answer"} onClick={() => {
            if (filled(sameAs)) run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "other_name", same_as: sameAs, story: story || undefined }), onAnswered);
          }}>Save and re-score</button>
        </div>
      )}
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

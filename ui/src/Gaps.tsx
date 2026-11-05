// Gaps tab of the job drawer: what the bank does not show for this job, what each item means and
// where the user may already have it (local model), and their answers. Only the user's own facts
// become bullets; the guard flags any draft that adds to them.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Gap, GapAnswer, GapList, GapHelp, Draft } from "./api";

export function GapsView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [list, setList] = useState<GapList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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

  const { gaps, years, entries } = list;
  const answered = (r: { outcome: string; rescore_batch: number }) => {
    setNote(r.outcome + (r.rescore_batch > 0 ? " · re-scoring (batch " + r.rescore_batch + ")" : r.rescore_batch === -1 ? " · queue server down: re-score from the Batches tab later" : ""));
    load();
    onChanged();
  };
  const groups: [Gap["kind"], string][] = [["must", "Must-haves"], ["nice", "Nice-to-haves"], ["keyword", "Keywords"]];

  return (
    <div>
      <div className="muted small">
        Requirements your experience bank does not show for this job. For each one: see what it means, where you may already have it, then answer. A new bullet or skill re-scores the job; if the score allows it, tailoring follows on its own.
      </div>
      {years && <div className="banner">Years: {years} (years are the one hard limit; answers here cannot change them)</div>}
      {note && <div className="banner ok">{note}</div>}
      {gaps.length === 0 && <div className="banner">No gaps: the bank shows every requirement of this job.</div>}
      {groups.map(([kind, title]) => {
        const items = gaps.filter((gap) => gap.kind === kind);
        return items.length ? (
          <div key={kind}>
            <h4>{title}</h4>
            {items.map((gap) => <GapRow key={gap.kind + gap.requirement} id={id} gap={gap} entries={entries} onAnswered={answered} />)}
          </div>
        ) : null;
      })}
    </div>
  );
}

function GapRow({ id, gap, entries, onAnswered }: { id: string; gap: Gap; entries: GapList["entries"]; onAnswered: (r: { outcome: string; rescore_batch: number }) => void }) {
  const [help, setHelp] = useState<GapHelp | null>(gap.help);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<GapAnswer | null>(null);
  const [story, setStory] = useState<string>("");
  const [proof, setProof] = useState<string>("");
  const [entry, setEntry] = useState<string>(entries[0]?.id ?? "");
  const [sameAs, setSameAs] = useState<string>("");
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
          <select value={entry} onChange={(e) => setEntry(e.target.value)}>
            {entries.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.title + (entry.company ? " · " + entry.company : "") + " (" + entry.dates + ")"}</option>
            ))}
          </select>
          <textarea rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Where did you use it, what did you do, and what changed? Your own words; only facts you can defend in an interview." />
          <input type="text" value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Proof (optional): a link, a PR, a doc, a number you measured" />
          <button className="btn tiny" onClick={handleDraft} disabled={!filled(story) || busy === "draft"}>{busy === "draft" ? "Drafting…" : "Draft a bullet"}</button>
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

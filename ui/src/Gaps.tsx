// Gaps tab of the job drawer: what the bank does not show for this job, what each item means and
// where the user may already have it (local model), and their answers. Only the user's own facts
// become bullets; the guard flags any draft that adds to them.
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { onChange } from "./events";
import type { AnswerBody, Gap, GapAnswer, GapList, GapHelp, Draft, Previous, EarlierInput, TellFix } from "./api";
import { RescoreBar } from "./Rescore";
import { TailorBox } from "./Tailor";

type Answered = { outcome: string; rescore_batch: number; rescore_error?: string | null; rescore_skipped?: boolean };

const ANSWER_LABEL: Record<GapAnswer, string> = { have: "Yes, done it", other_name: "Under another name", learnable: "Could learn it", no: "No" };
const whereFrom = (p: { from_job: string | null; company: string; title: string }) => (p.from_job && p.company ? `${p.company} · ${p.title}` : p.title);

export function GapsView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [list, setList] = useState<GapList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [watch, setWatch] = useState<number | null>(null); // a re-score batch to follow
  const [explaining, setExplaining] = useState<string | null>(null);
  const [loads, setLoads] = useState(0); // bumps on every reload, so the tailor box rechecks
  const [memory, setMemory] = useState<string | null>(null); // what earlier answers did here
  const [matching, setMatching] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null); // fill exact earlier answers automatically
  useEffect(() => {
    api.gapSettings().then((s) => setAuto(s.auto_carry)).catch(() => setAuto(null));
  }, []);
  const toggleAuto = (on: boolean) => {
    api.setGapSettings(on).then((s) => {
      setAuto(s.auto_carry);
      if (s.auto_carry) {
        // Turned on: carry what matches now.
        void api.carry(id).then((c) => { if (c.carried > 0) { setMemory(`${c.carried} earlier answer${c.carried === 1 ? "" : "s"} carried`); onChanged(); } void load(); });
      }
    }).catch((e: Error) => setErr(e.message));
  };

  const load = (): Promise<GapList | null> => {
    setLoads((n) => n + 1);
    return api.gaps(id)
      .then((l) => { setList(l); return l; })
      .catch((e: Error) => { setErr(e.message); return null; });
  };

  // On open: carry the exact earlier answers, then let the local model check the similar ones
  // in the background. Both are remembered, so the next open is instant.
  const shownId = useRef(id);
  shownId.current = id;
  useEffect(() => {
    let gone = false;
    setMemory(null);
    setMatching(null);
    void (async () => {
      const c = await api.carry(id).catch(() => null);
      // The carry is written even when this run was cancelled (React runs effects twice in
      // development): report it as long as the drawer still shows this job.
      if (shownId.current !== id) return;
      if (c && c.carried > 0) {
        setMemory(`${c.carried} answer${c.carried === 1 ? "" : "s"} carried from your earlier answers (each shows where from; Undo if it does not apply here)`
          + (c.rescore_batch > 0 ? ` · re-scoring (batch ${c.rescore_batch})` : c.rescore_batch === -1 ? " · queue server down: re-score later" : ""));
        if (c.rescore_batch > 0) setWatch(c.rescore_batch);
        onChanged();
      }
      if (gone) return;
      const l = await load();
      if (gone || !l || !l.gaps.some((g) => !g.answer && g.reuse.similar.some((p) => p.match === "overlap"))) return;
      setMatching("Checking similar earlier answers with the local model…");
      const m = await api.matchSimilar(id).catch((e: Error) => ({ gaps: 0, checked: 0, same: 0, failed: 1, error: e.message }));
      if (gone) return;
      setMatching(m.error ? `Similar earlier answers were not checked by the model (${m.error}). They show as "not checked".` : null);
      void load();
    })();
    return () => { gone = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The change feed: this job changed (an explanation saved by the Mac worker, a re-score):
  // read the list again, once per burst.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onChange((c) => {
      if (c.kind !== "resync" && c.job_id !== id) return;
      if (t) return;
      t = setTimeout(() => { t = null; void load(); }, 300);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) {
    return <div className="banner error">{err}</div>;
  }

  if (!list) {
    return <div>Loading...</div>;
  }

  const { gaps, not_asked, years, entries } = list;
  const answered = (r: Answered) => {
    setNote(r.outcome + (r.rescore_skipped ? "" : r.rescore_error ? " · re-score failed: " + r.rescore_error
      : r.rescore_batch > 0 ? " · re-scoring (batch " + r.rescore_batch + ")"
      : r.rescore_batch === -1 ? " · queue server down: re-score from the Batches tab later"
      : " · a score or tailor task is already queued for this job; it uses the new bullet"));
    if (r.rescore_batch > 0) setWatch(r.rescore_batch);
    load();
    onChanged();
  };
  const groups: [Gap["kind"], string][] = [["must", "Must-haves"], ["theme", "Responsibilities"], ["nice", "Nice-to-haves"], ["keyword", "Keywords"]];
  // Queues every gap with no explanation and no answer for the Mac worker, which explains them
  // one at a time (the 14B has one slot); each one shows as soon as it is saved.
  const explainAll = () => {
    setExplaining("Queuing…");
    api.gapHelpAll(id)
      .then(() => { setExplaining(null); void load(); })
      .catch((e: Error) => setExplaining("Could not queue: " + e.message));
  };
  const queuedHelp = gaps.filter((g) => g.help_queued).length;
  const unexplained = gaps.filter((g) => !g.help && !g.answer && !g.help_queued).length;

  return (
    <div>
      <div className="muted small">
        Everything red on the Score tab for this job. For each one: see what it means, where you may already have it, then answer. A new bullet or skill re-scores the job. Once it reaches 75 it is ready for tailor, even with questions still open: start it with Tailor now (the job stays in its column until then).
      </div>
      <RescoreBar id={id} watch={watch} onDone={() => { setWatch(null); load(); onChanged(); }} />
      <TailorBox id={id} refresh={loads} onChanged={onChanged} />
      {unexplained > 0 && (
        <button className="btn tiny" disabled={explaining === "Queuing…"} onClick={explainAll}>
          {`Explain all remaining (${unexplained})`}
        </button>
      )}
      {queuedHelp > 0 && <span className="muted small"> Explaining {queuedHelp} with the local model, one at a time…</span>}
      {explaining && <span className="muted small"> {explaining}</span>}
      {years && <div className="banner">Years: {years} (years are the one hard limit; answers here cannot change them)</div>}
      {auto !== null && (
        <label className="role-check small">
          <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
          Fill exact matches from my earlier answers automatically (off: they are only suggested here, to use or edit)
        </label>
      )}
      {memory && <div className="banner ok">{memory}</div>}
      {matching && <div className="banner">{matching}</div>}
      {note && <div className="banner ok">{note}</div>}
      {gaps.length === 0 && not_asked.length === 0 && <div className="banner">No gaps: every requirement of this job is covered.</div>}
      {groups.map(([kind, title]) => {
        const items = gaps.filter((gap) => gap.kind === kind);
        return items.length ? (
          <div key={kind}>
            <h4>{title}</h4>
            {items.map((gap) => <GapRow key={gap.kind + gap.requirement + (gap.help ? ":h" : "")} id={id} gap={gap} entries={entries} onAnswered={answered} onUndone={() => { void load(); onChanged(); }} onQueued={() => void load()} />)}
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

// Earlier answers to similar asks on other jobs: accept one to use it here (that pair is then
// carried automatically), or say it is not the same (never proposed again).
// An exact earlier answer is listed here only when it was not filled in (automatic filling is
// off, or Undo was used for this job). "Use my earlier answer" only fills the form below.
// "Add previous response and rescore": the earlier answer submitted again for this gap, in this
// job's wording. A keyword answered "under another name" keeps that name; any other "have"
// becomes a skill with the earlier story and roles (never a second copy of a bullet). Returns
// the answer body, or why it cannot be sent as it is.
function previousBody(gap: Gap, i: EarlierInput, known: Set<string>): AnswerBody | string {
  // Related work keeps its bullets (the server refuses ids no longer in the bank).
  if (i.answer === "other_name" && gap.kind === "keyword" && i.relation === "related") {
    return { kind: gap.kind, requirement: gap.requirement, answer: "other_name", relation: "related", bullet_ids: i.bullet_ids ?? [], story: i.story };
  }
  if (i.answer === "other_name" && gap.kind === "keyword" && i.same_as.trim()) {
    return { kind: gap.kind, requirement: gap.requirement, answer: "other_name", same_as: i.same_as, story: i.story || undefined };
  }
  const roles = i.entry_ids.filter((x) => known.has(x));
  if (!i.story.trim()) return "The earlier answer has no story to reuse: use the edit button first.";
  if (!roles.length) return "The earlier answer's roles are no longer in your bank: use the edit button first.";
  return { kind: gap.kind, requirement: gap.requirement, answer: "have", as_skill: true, entry_ids: roles, story: i.story, proof: i.proof || undefined };
}
const PREVIOUS_TITLE = (gap: Gap) => gap.kind === "keyword"
  ? "Saves it as a skill under this job's spelling and re-scores: the keyword then matches and leaves the gaps."
  : "Drafts a bullet for this requirement from your earlier story (local model), then shows it with 'Add skill and bullet point': a bullet counts 0.85, a skill alone 0.3.";

function Similar({ id, gap, known, onAnswered, onPrefill, onDraftPrevious }: {
  id: string; gap: Gap; known: Set<string>; onAnswered: (r: Answered) => void;
  onPrefill: (i: EarlierInput) => void; onDraftPrevious: (i: EarlierInput, fromRequirement: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const keyOf = (p: Previous) => `${p.from_job ?? ""}\u0000${p.requirement}`;
  const all = [...(gap.reuse.exact ? [gap.reuse.exact] : []), ...gap.reuse.similar];
  const shown = all.filter((p) => !gone.includes(keyOf(p)));
  if (gap.answer || !shown.length) return null;
  const decide = (p: Previous, accept: boolean) => {
    setBusy(true);
    setErr(null);
    api.reuse(id, { kind: gap.kind, requirement: gap.requirement, from_job: p.from_job, from_requirement: p.requirement, accept })
      .then((r) => (accept ? onAnswered(r) : setGone((g) => [...g, keyOf(p)])))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  // Submits the earlier answer for this gap and re-scores. For a similar (not the same) ask it
  // first records that the asks are the same, so the pair is carried from now on.
  const submitPrevious = (p: Previous) => {
    // A sentence needs a bullet to count: draft it now and let the user check it before saving.
    if (gap.kind !== "keyword") { onDraftPrevious(p.input!, p.match === "exact" ? null : p.requirement); return; }
    const body = previousBody(gap, p.input!, known);
    if (typeof body === "string") { setErr(body); return; }
    setBusy(true);
    setErr(null);
    const same = p.match === "exact" ? Promise.resolve(null)
      : api.reuse(id, { kind: gap.kind, requirement: gap.requirement, from_job: p.from_job, from_requirement: p.requirement, accept: true });
    same.then((first) => api.answer(id, body).then((r) => onAnswered(first && first.rescore_batch > 0 ? { ...r, rescore_batch: first.rescore_batch } : r)))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="gap-help">
      <div>You answered this{gap.reuse.exact ? "" : " or a similar ask"} before:</div>
      <ul>
        {shown.map((p) => (
          <li key={keyOf(p)}>
            <b>{ANSWER_LABEL[p.answer]}</b> to "{p.requirement}" <span className="muted small">({whereFrom(p)}{p.outcome ? `: ${p.outcome}` : ""})</span>{" "}
            <span className="chip">{p.match === "exact" ? "same ask" : p.match === "learned" ? "you said: same ask" : p.match === "model" ? "local model: same ask" : "not checked"}</span>{" "}
            <button className="btn tiny" disabled={busy} onClick={() => decide(p, true)}>{p.match === "exact" || p.match === "learned" ? "Use this answer" : "Same ask: use this answer"}</button>
            {p.input && (
              <>
                <button className="btn tiny accent" disabled={busy} title={PREVIOUS_TITLE(gap)} onClick={() => submitPrevious(p)}>Add previous response and rescore</button>
                <button className="btn tiny" disabled={busy} onClick={() => onPrefill(p.input!)}>Use my earlier answer (edit first)</button>
              </>
            )}
            <button className="btn ghost tiny" disabled={busy} onClick={() => decide(p, false)}>{p.match === "exact" ? "Not for this job" : "Not the same"}</button>
          </li>
        ))}
      </ul>
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

function GapRow({ id, gap, entries, onAnswered, onUndone, onQueued }: { id: string; gap: Gap; entries: GapList["entries"]; onAnswered: (r: Answered) => void; onUndone: () => void; onQueued: () => void }) {
  const [help, setHelp] = useState<GapHelp | null>(gap.help);
  useEffect(() => { if (gap.help) setHelp(gap.help); }, [gap.help]); // Ask again: the new one
  // Explain: a saved explanation shows at once; otherwise it is queued (the list shows it).
  const explain = (refresh: boolean) => run("help", api.gapHelp(id, gap.kind, gap.requirement, refresh),
    (r) => { if (r.help) setHelp(r.help); else onQueued(); });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<GapAnswer | null>(null);
  const [story, setStory] = useState<string>("");
  const [proof, setProof] = useState<string>("");
  // Roles where the user used it: nothing is pre-checked; the user checks each one.
  const [checked, setChecked] = useState<string[]>([]);
  const toggle = (id: string) => setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  // The drafted bullet goes under the one checked job or project the user picks (never automatic).
  const jobs = entries.filter((e) => checked.includes(e.id));
  const [chosen, setChosen] = useState<string>("");
  const entry = jobs.some((e) => e.id === chosen) ? chosen : "";
  const label = (e: GapList["entries"][number]) => e.title + (e.company ? " · " + e.company : "") + " (" + e.dates + ")";
  const [extras, setExtras] = useState<string[]>([]);
  const [sameAs, setSameAs] = useState<string>(gap.known_as ?? "");
  // "Under another name": the same thing spelled another way (a synonym), or related work shown by
  // the bullets the user picks (a tag on those bullets only; the story must name the term).
  const [relation, setRelation] = useState<"same" | "related">("same");
  const [picked, setPicked] = useState<string[]>([]);
  const togglePick = (b: string) => setPicked((p) => (p.includes(b) ? p.filter((x) => x !== b) : [...p, b]));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState<string>("");
  // A flagged draft cannot be saved as drafted: an edit re-enables Save and the server checks it again.
  const saveBlocked = !!draft && draft.codes.length > 0 && text === draft.text;
  // One-click fixes for AI-tell words (a fixed list, not the model): shown under the red box,
  // asked again after each one so several words can be fixed in turn. Save re-checks the text.
  const [fixes, setFixes] = useState<TellFix[]>([]);
  useEffect(() => { setFixes(draft?.fixes ?? []); }, [draft]);
  const applyFix = (f: TellFix) => {
    setText(f.text);
    api.tellFixes(f.text, story).then((r) => setFixes(r.fixes)).catch(() => setFixes([]));
  };
  // A draft is written for one job: a new target job means a new draft.
  useEffect(() => {
    setDraft(null);
  }, [entry]);

  const filled = (v: string) => v.trim().length > 0;
  const run = <T,>(what: string, p: Promise<T>, then: (v: T) => void) => {
    setBusy(what);
    setErr(null);
    p.then(then).catch((e: Error) => setErr(e.message)).finally(() => setBusy(null));
  };

  // Add as a skill, backed by ticked bullets: the model's "You may already have it" ones plus the
  // bank bullets whose text or tags show it (found by code). Nothing is linked unless ticked.
  // If the resume check would block it (error weak_evidence), ask before saving anyway.
  const [proofBullets, setProofBullets] = useState<{ id: string; text: string }[]>([]);
  const [ticked, setTicked] = useState<string[]>([]);
  const suggested = (help?.related ?? []).map((r) => r.bullet_id).join(",");
  useEffect(() => {
    if (gap.kind === "keyword") return;
    api.skillCandidates(gap.requirement, suggested ? suggested.split(",") : []).then(setProofBullets).catch(() => setProofBullets([]));
  }, [gap.kind, gap.requirement, suggested]);
  const addAsSkill = (confirm_weak: boolean) => {
    const body: AnswerBody = { kind: gap.kind, requirement: gap.requirement, answer: "have", as_skill: true, entry_ids: checked, story,
      proof: proof || undefined, bullet_ids: ticked, ...(confirm_weak ? { confirm_weak } : {}) };
    setBusy("answer");
    setErr(null);
    api.answer(id, body).then(onAnswered).catch((e: Error) => {
      const data = e instanceof ApiError ? (e.data as { error?: string; message?: string }) : null;
      if (data?.error === "weak_evidence" && !confirm_weak) {
        if (window.confirm(`${data.message}\n\nSave the skill anyway? It will be blocked on your resume until it is backed.`)) { addAsSkill(true); return; }
        setErr(data.message ?? e.message);
      } else setErr(e.message);
    }).finally(() => setBusy(null));
  };

  // Start over: drop the draft and its text, keep the user's story and proof, explain again.
  const startOver = () => {
    setDraft(null);
    setText("");
    setExtras([]);
    setErr(null);
    explain(true);
  };

  const known = new Set(entries.map((e) => e.id)); // role ids still in the bank
  // Fills the answer form from an earlier answer's story, proof and roles (roles no longer in
  // the bank are dropped). Nothing is saved until the user drafts and saves, or adds the skill.
  const prefill = (i: EarlierInput) => {
    setMode(i.answer === "other_name" && gap.kind === "keyword" ? "other_name" : "have");
    setStory(i.story);
    setProof(i.proof);
    setSameAs(i.same_as || sameAs);
    setRelation(i.relation ?? "same");
    setPicked(i.bullet_ids ?? []);
    const roles = i.entry_ids.filter((x) => known.has(x));
    if (roles.length) setChecked(roles);
    setDraft(null);
    setWithSkill(false);
    setFromPrev(null);
  };

  // "Add previous response and rescore" on a sentence: fill the form, draft the bullet at once
  // (no Draft click), under the earlier answer's job or project when it has exactly one; otherwise
  // the user picks one first. The user checks the draft, then saves the bullet and the skill together.
  const [withSkill, setWithSkill] = useState(false);
  const [fromPrev, setFromPrev] = useState<string | null>(null);
  const draftPrevious = (i: EarlierInput, fromRequirement: string | null) => {
    prefill(i);
    if (!filled(i.story)) { setErr("The earlier answer has no story to draft from: write it below, then Draft a bullet."); return; }
    const roles = entries.filter((e) => i.entry_ids.includes(e.id));
    if (roles.length !== 1) { setErr("Pick the job or project this story happened at, then Draft a bullet."); return; }
    const target = roles[0].id;
    setChosen(target);
    setWithSkill(true);
    setFromPrev(fromRequirement);
    run("draft", api.draft(id, { kind: gap.kind, requirement: gap.requirement, entry_id: target, story: i.story, proof: i.proof || undefined }), (d) => {
      setDraft(d);
      setText(d.text);
      setExtras([]);
    });
  };

  const handleAnswer = (answer: GapAnswer) => {
    if (answer === "learnable" || answer === "no") {
      run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer }), onAnswered);
    } else {
      setMode(answer);
      setWithSkill(false);
      setFromPrev(null);
    }
  };

  const handleDraft = () => {
    if (filled(story)) {
      run("draft", api.draft(id, { kind: gap.kind, requirement: gap.requirement, entry_id: entry, story, proof: proof || undefined }), (d) => {
        setDraft(d);
        setText(d.text);
        setExtras([]);
      });
    }
  };

  const handleSave = () => {
    if (filled(text)) {
      run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "have", entry_id: entry, text, tags: draft?.tags, story, proof: proof || undefined, entry_ids: checked, extra_skills: extras, draft_codes: draft?.codes ?? [],
        ...(withSkill ? { with_skill: true } : {}), ...(fromPrev ? { from_previous: { from_requirement: fromPrev } } : {}) }), onAnswered);
    }
  };

  return (
    <div className={`gap${gap.answer ? " answered" : ""}`}>
      <div className="gap-head">
        <span className="chip">{gap.kind}</span>
        <b>{gap.requirement}</b>
        {gap.outcome && <span className="muted small">Answered: {gap.outcome}</span>}
        {gap.carried_from && (
          <button className="btn ghost tiny" disabled={busy === "undo"}
            onClick={() => run("undo", api.undoCarry(id, gap.requirement), onUndone)}>
            Undo (does not apply here)
          </button>
        )}
        {gap.carried_from && gap.carried_input && (
          <button className="btn tiny accent" disabled={busy === "answer" || busy === "draft"} title={PREVIOUS_TITLE(gap)} onClick={() => {
            if (gap.kind !== "keyword") { draftPrevious(gap.carried_input!, null); return; }
            const body = previousBody(gap, gap.carried_input!, known);
            if (typeof body === "string") setErr(body);
            else run("answer", api.answer(id, body), onAnswered);
          }}>
            {busy === "answer" ? "Saving…" : busy === "draft" ? "Drafting…" : "Add previous response and rescore"}
          </button>
        )}
        {gap.carried_from && gap.carried_input && (
          <button className="btn ghost tiny" onClick={() => prefill(gap.carried_input!)}
            title="Opens the form with that answer's story, proof and roles, e.g. to draft a bullet for this job's wording (a bullet counts 0.85, a skill 0.3)">
            Edit / improve
          </button>
        )}
      </div>
      {gap.note && <div className="muted small">{gap.note}</div>}
      <Similar id={id} gap={gap} known={known} onAnswered={onAnswered} onPrefill={prefill} onDraftPrevious={draftPrevious} />
      {busy === "draft" && withSkill && <div className="muted small">Drafting a bullet from your earlier answer (local model)…</div>}
      {gap.declined && !gap.answer && <div className="muted small">You undid the earlier answer for this job: answer it below.</div>}
      {help === null && (
        <button className="btn tiny" onClick={() => explain(false)} disabled={busy === "help" || gap.help_queued}>
          {gap.help_queued ? "Queued for the local model…" : busy === "help" ? "Queuing…" : "Explain and find related experience"}
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
          <button className="btn ghost tiny" disabled={busy === "help" || gap.help_queued} onClick={() => explain(true)}>
            {gap.help_queued ? "Asking again (queued)…" : busy === "help" ? "Queuing…" : "Ask again"}
          </button>
          <button className="btn ghost tiny" disabled={busy === "help" || busy === "draft" || gap.help_queued} onClick={startOver}
            title="Clears the drafted bullet and its text and asks the local model again. Your story and proof stay.">
            Start over
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
                {label(e)}
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
          {proofBullets.length > 0 && (
            <div className="roles">
              <div className="muted small">Bullets that show it (tick the ones that are this work; they back the skill on your resume):</div>
              {proofBullets.map((b) => (
                <label key={b.id} className="role-check" title={b.text}>
                  <input type="checkbox" checked={ticked.includes(b.id)} onChange={() => setTicked((t) => (t.includes(b.id) ? t.filter((x) => x !== b.id) : [...t, b.id]))} />
                  {" "}<code>{b.id}</code> <span className="muted small">{b.text.length > 110 ? b.text.slice(0, 110) + "…" : b.text}</span>
                </label>
              ))}
            </div>
          )}
          <button className="btn tiny" disabled={!filled(story) || !checked.length || busy === "answer"}
            onClick={() => addAsSkill(false)}>
            Add as a skill ({checked.length} role{checked.length === 1 ? "" : "s"}{ticked.length ? `, ${ticked.length} bullet${ticked.length === 1 ? "" : "s"}` : ""})
          </button>
          {jobs.length > 0 && (
            <div className="muted small">
              Bullet goes under{" "}
              <select value={entry} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Pick the job or project this story happened at</option>
                {jobs.map((e) => <option key={e.id} value={e.id}>{label(e)}, {e.bullets} bullets</option>)}
              </select>
              {checked.length > 1 ? " The skill is saved with every checked role as context." : ""}
            </div>
          )}
          {gap.kind !== "keyword" && (
            <div className="muted small">As a skill this counts 0.3 of 1 for a {gap.kind === "must" ? "must-have" : gap.kind === "theme" ? "responsibility" : "nice-to-have"}; a bullet counts 0.85.{gap.kind === "must" ? " A must-have needs 0.5, so a bullet at your strongest role helps more." : ""}</div>
          )}
          {draft && (
            <div>
              <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              <div>Words: {text.split(/\s+/).filter(word => word.length > 0).length} of 25</div>
              {draft.codes.length > 0 && <div className="banner error">The draft adds what your answer does not say ({draft.codes.join(", ")}).{draft.words && draft.words.length > 0 ? <> Remove or reword: <b>{draft.words.join(", ")}</b>.</> : " Edit it so it only states your facts."}</div>}
              {fixes.length > 0 && (
                <div className="small">Plain wording: {fixes.map((f) => (
                  <button key={f.label} className="btn tiny" title={f.text} onClick={() => applyFix(f)}>{f.label}</button>
                ))}</div>
              )}
              {saveBlocked && <div className="muted small">Save is off until you edit the text; the server checks the edited text again when you save.</div>}
              {draft.skills.length > 0 && (
                <div className="roles">
                  <div className="muted small">Your story also names these. Tick the ones to add as skills:</div>
                  {draft.skills.map((sk) => (
                    <label key={sk} className="role-check">
                      <input type="checkbox" checked={extras.includes(sk)} onChange={() => setExtras((x) => (x.includes(sk) ? x.filter((y) => y !== sk) : [...x, sk]))} />
                      {sk}
                    </label>
                  ))}
                </div>
              )}
              <button className="btn tiny" onClick={handleSave} disabled={!filled(text) || saveBlocked || busy === "answer"}>
                {(withSkill ? "Add skill and bullet point" : "Add bullet" + (checked.length > 1 ? " + skill" : "")) + (extras.length ? ` + ${extras.length} more skill${extras.length === 1 ? "" : "s"}` : "") + " and re-score"}
              </button>
            </div>
          )}
        </div>
      )}
      {mode === "other_name" && (
        <div>
          <div>
            <label className="role-check"><input type="radio" checked={relation === "same"} onChange={() => setRelation("same")} /> Same thing, another spelling</label>
            <label className="role-check"><input type="radio" checked={relation === "related"} onChange={() => setRelation("related")} /> Related work</label>
          </div>
          {relation === "related" && (
            <div className="roles">
              <div className="muted small">Pick the bullets that show this work. The term is used only on these bullets, and the first time a rewording uses it you approve the line.</div>
              {entries.filter((e) => e.bullet_list.length).map((e) => (
                <div key={e.id}>
                  <div className="muted small">{label(e)}</div>
                  {e.bullet_list.map((b) => (
                    <label key={b.id} className="role-check">
                      <input type="checkbox" checked={picked.includes(b.id)} onChange={() => togglePick(b.id)} />
                      <code>{b.id}</code> {b.short}
                    </label>
                  ))}
                </div>
              ))}
              <textarea rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder={`What you did that is "${gap.requirement}": your own words, naming it.`} />
              <button className="btn tiny" disabled={!picked.length || !filled(story) || busy === "answer"} onClick={() =>
                run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "other_name", relation: "related", bullet_ids: picked, story }), onAnswered)}>
                Save related work and re-score
              </button>
            </div>
          )}
          {relation === "same" && <>
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
            if (filled(sameAs)) run("answer", api.answer(id, { kind: gap.kind, requirement: gap.requirement, answer: "other_name", relation: "same", same_as: sameAs, story: story || undefined }), onAnswered);
          }}>Save and re-score</button>
          </>}
        </div>
      )}
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

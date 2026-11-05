// Top bar: "Delete N jobs with skip words". N is worked out live from your skip words
// (preferences.yaml skip_keywords) against every stored job's title and description, whole words.
// A confirm panel lists them first. Jobs marked applied, interview or offer are never in it.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { SkipMatches } from "./api";

export function SkipDelete({ refresh, onDone }: { refresh: unknown; onDone: () => void }) {
  const [m, setM] = useState<SkipMatches | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.skipMatches().then(setM).catch(() => setM(null));
  }, [refresh]);

  // Which listed jobs will be deleted: all at first; untick any to keep it.
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const openPanel = () => {
    setChosen(new Set((m?.jobs ?? []).map((j) => j.id)));
    setOpen(true);
    setNote(null);
  };

  const n = m?.jobs.length ?? 0;
  if (!m || (n === 0 && !note)) return null;

  const tailored = m.jobs.filter((j) => j.resumes > 0);
  const others = m.jobs.filter((j) => j.resumes === 0);
  const picked = m.jobs.filter((j) => chosen.has(j.id));
  const keepTailored = tailored.length > 0 && tailored.every((j) => !chosen.has(j.id));
  const toggle = (id: string) => setChosen((c) => { const x = new Set(c); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const setTailored = (keep: boolean) => setChosen((c) => {
    const x = new Set(c);
    for (const j of tailored) if (keep) x.delete(j.id); else x.add(j.id);
    return x;
  });

  const run = () => {
    setBusy(true);
    setErr(null);
    api.deleteSkipMatches(picked.map((j) => j.id))
      .then((r) => {
        setNote(`Deleted ${r.deleted} job${r.deleted === 1 ? "" : "s"}` + (r.resumes ? ` and ${r.resumes} resume record${r.resumes === 1 ? "" : "s"}` : "")
          + (r.refused.length ? `; ${r.refused.length} not deleted (${r.refused.map((x) => `${x.title}: ${x.message}`).join("; ")})` : "")
          + (r.skipped ? `; ${r.skipped} no longer matched` : ""));
        setOpen(false);
        onDone();
      })
      .catch((e: Error) => setErr("Delete failed: " + e.message))
      .finally(() => setBusy(false));
  };

  // How many jobs each word matches, for the summary line.
  const byWord = new Map<string, number>();
  for (const j of m.jobs) byWord.set(j.word, (byWord.get(j.word) ?? 0) + 1);

  const row = (j: SkipMatches["jobs"][number]) => (
    <li key={j.id}>
      <label className="role-check">
        <input type="checkbox" checked={chosen.has(j.id)} onChange={() => toggle(j.id)} />
        <b>{j.title}</b> · {j.company} <span className="chip">{j.word}</span>
        {j.resumes > 0 && <span className="chip accent">tailored · {j.resumes} resume{j.resumes === 1 ? "" : "s"}</span>}
        {j.status ? <span className="muted small"> ({j.status})</span> : null}
      </label>
    </li>
  );

  return (
    <>
      {n > 0 && (
        <button className="btn danger" disabled={busy || open} onClick={openPanel}
          title={`Jobs whose title or description has one of your skip words: ${m.keywords.join(", ")}`}>
          Delete {n} job{n === 1 ? "" : "s"} with skip words
        </button>
      )}
      {note && <span className="muted small">{note}</span>}
      {open && (
        <div className="delete-panel skip-delete">
          <h4>Delete {n} job{n === 1 ? "" : "s"} with skip words?</h4>
          <div className="muted small">
            {[...byWord].map(([w, c]) => `${w}: ${c}`).join(" · ")}. Each one goes like Delete this job: its gap answers, tracking and
            tailored resumes are removed, and a later fetch will not add it back. This cannot be undone.
          </div>
          {tailored.length > 0 && (
            <>
              <div className="banner">
                {tailored.length} of these {tailored.length === 1 ? "is a tailored job" : "are tailored jobs"}: deleting {tailored.length === 1 ? "it" : "them"} also removes {tailored.reduce((s, j) => s + j.resumes, 0)} tailored resume(s) (YAML and PDF).{" "}
                <label className="role-check">
                  <input type="checkbox" checked={keepTailored} onChange={(e) => setTailored(e.target.checked)} /> Keep tailored jobs
                </label>
              </div>
              <ul className="skip-list">{tailored.map(row)}</ul>
            </>
          )}
          {others.length > 0 && <ul className="skip-list">{others.map(row)}</ul>}
          <div>
            <button type="button" className="btn ghost tiny" onClick={() => setChosen(new Set(m.jobs.map((j) => j.id)))}>Select all</button>
            <button type="button" className="btn ghost tiny" onClick={() => setChosen(new Set())}>Select none</button>
          </div>
          {m.kept.length > 0 && (
            <div className="banner">
              Not included ({m.kept.length}), because you marked them applied, interview or offer: {m.kept.map((j) => `${j.title} · ${j.company}`).join("; ")}. Delete those one by one from the job if you want.
            </div>
          )}
          <div>
            <button className="btn tiny danger" disabled={busy || picked.length === 0} onClick={run}>
              {busy ? "Deleting…" : `Delete ${picked.length} of ${n} job${n === 1 ? "" : "s"}`}
            </button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {err && <div className="banner error">{err}</div>}
        </div>
      )}
    </>
  );
}

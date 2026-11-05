// Top bar: "Delete N jobs with skip keywords". Deletes every job whose title or description has
// one of your skip words (preferences.yaml skip_keywords, whole words) and that is not tailored.
// Tailored jobs, jobs you applied to and kept jobs are never included. One confirm first.
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

  const n = m?.jobs.length ?? 0;
  if (!m) return null;

  const run = () => {
    setBusy(true);
    setErr(null);
    api.deleteSkipMatches(m.jobs.map((j) => j.id))
      .then((r) => {
        setNote(`Deleted ${r.deleted} job${r.deleted === 1 ? "" : "s"} with skip keywords`
          + (r.refused.length ? `; ${r.refused.length} not deleted (${r.refused.map((x) => `${x.title}: ${x.message}`).join("; ")})` : ""));
        setOpen(false);
        onDone();
      })
      .catch((e: Error) => setErr("Delete failed: " + e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {/* Always shown; greyed out when no job matches (it used to hide, which looked missing). */}
      <button className={n > 0 ? "btn danger" : "btn ghost"} disabled={busy || open || n === 0} onClick={() => { setOpen(true); setNote(null); }}
        title={!m.keywords.length ? "No skip keywords yet: they are added when you delete a job and pick words."
          : n === 0 ? `No not-tailored job has one of your ${m.keywords.length} skip keywords right now (${m.keywords.join(", ")}).`
          : `Not-tailored jobs whose title or description has one of your skip keywords: ${m.keywords.join(", ")}`}>
        Delete {n} job{n === 1 ? "" : "s"} with skip keywords
      </button>
      {note && <span className="muted small">{note}</span>}
      {open && (
        <div className="delete-panel skip-delete">
          <h4>Delete {n} job{n === 1 ? "" : "s"} with skip keywords?</h4>
          <div className="muted small">
            Not-tailored jobs only. Tailored jobs, jobs you applied to and kept jobs are never deleted here
            {m.kept.length ? ` (${m.kept.length} left out)` : ""}. Gap answers and tracking go with each job; a later fetch will not add it back.
          </div>
          <ul className="skip-list">
            {m.jobs.map((j) => <li key={j.id}><b>{j.title}</b> · {j.company} <span className="chip">{j.word}</span></li>)}
          </ul>
          <div>
            <button className="btn tiny danger" disabled={busy} onClick={run}>{busy ? "Deleting…" : `Delete ${n} job${n === 1 ? "" : "s"}`}</button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {err && <div className="banner error">{err}</div>}
        </div>
      )}
    </>
  );
}

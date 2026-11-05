// Top bar: "Delete N selected", for the jobs ticked on the board (Tailored, Not tailored,
// Skipped). A confirm panel lists them first: tailored ones with the resumes they would lose,
// kept ones marked, and jobs you applied to only with an extra tick.
import { useState } from "react";
import { api } from "./api";
import type { BulkItem } from "./api";

export function BulkDelete({ selected, onClear, onDone }: { selected: string[]; onClear: () => void; onDone: () => void }) {
  const [items, setItems] = useState<BulkItem[] | null>(null);
  const [withApplied, setWithApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!selected.length && !note) return null;

  const open = () => {
    setErr(null);
    setNote(null);
    setWithApplied(false);
    api.bulkPreview(selected).then(setItems).catch((e: Error) => setErr(e.message));
  };
  const applied = (items ?? []).filter((i) => i.status && ["applied", "interview", "offer"].includes(i.status));
  const tailored = (items ?? []).filter((i) => i.resumes > 0);
  const n = (items?.length ?? 0) - (withApplied ? 0 : applied.length);

  const run = () => {
    if (!items) return;
    setBusy(true);
    api.bulkDelete(items.map((i) => i.id), withApplied)
      .then((r) => {
        setNote(`Deleted ${r.deleted} job${r.deleted === 1 ? "" : "s"}` + (r.resumes ? ` and ${r.resumes} tailored resume${r.resumes === 1 ? "" : "s"}` : "")
          + (r.left_applied ? `; kept ${r.left_applied} you applied to` : "")
          + (r.refused.length ? `; ${r.refused.length} not deleted (${r.refused.map((x) => `${x.title}: ${x.message}`).join("; ")})` : ""));
        setItems(null);
        onClear();
        onDone();
      })
      .catch((e: Error) => setErr("Delete failed: " + e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {selected.length > 0 && (
        <>
          <button className="btn danger" disabled={busy || items !== null} onClick={open}>Delete {selected.length} selected</button>
          <button className="btn ghost" disabled={busy} onClick={() => { onClear(); setItems(null); }}>Clear selection</button>
        </>
      )}
      {note && <span className="muted small">{note}</span>}
      {err && <span className="banner error">{err}</span>}
      {items && (
        <div className="delete-panel skip-delete">
          <h4>Delete {items.length} selected job{items.length === 1 ? "" : "s"}?</h4>
          <div className="muted small">
            Each one goes like Delete this job: its gap answers, tracking and tailored resumes are removed, and a later fetch will not add it back. This cannot be undone.
          </div>
          {tailored.length > 0 && (
            <div className="banner">
              {tailored.length} tailored job{tailored.length === 1 ? "" : "s"}: deleting {tailored.length === 1 ? "it" : "them"} also removes {tailored.reduce((s, i) => s + i.resumes, 0)} tailored resume(s) (YAML and PDF). Untick them on the board to keep them.
            </div>
          )}
          <ul className="skip-list">
            {items.map((i) => (
              <li key={i.id}>
                <b>{i.title}</b> · {i.company}
                {i.resumes > 0 && <span className="chip accent">tailored · {i.resumes} resume{i.resumes === 1 ? "" : "s"}</span>}
                {i.kept && <span className="chip">kept</span>}
                {i.status && <span className="muted small"> ({i.status})</span>}
              </li>
            ))}
          </ul>
          {applied.length > 0 && (
            <label className="role-check">
              <input type="checkbox" checked={withApplied} onChange={(e) => setWithApplied(e.target.checked)} />
              Also delete the {applied.length} you marked applied, interview or offer (otherwise they are left)
            </label>
          )}
          <div>
            <button className="btn tiny danger" disabled={busy || n === 0} onClick={run}>{busy ? "Deleting…" : `Delete ${n} job${n === 1 ? "" : "s"}`}</button>
            <button className="btn ghost tiny" disabled={busy} onClick={() => setItems(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

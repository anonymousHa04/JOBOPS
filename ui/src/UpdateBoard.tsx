// Top bar: "Update board". Tailored jobs whose score is now below 75 (the tailoring bands) move
// to Not tailored and their tailored resumes are deleted (backed up first in data/backups/).
// Every application status is included. The job, score, gaps and tracking stay. One confirm.
// The cards move through the change feed (the API publishes one change per job).
import { useState } from "react";
import { api, APP_LABEL, bandClass } from "./api";
import type { UpdateCandidate } from "./api";

export function UpdateBoard({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<UpdateCandidate[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const show = () => {
    setOpen(true);
    setNote(null);
    setErr(null);
    setList(null);
    api.updateBoardPreview().then(setList).catch((e: Error) => setErr("Could not read the board: " + e.message));
  };

  const n = list?.length ?? 0;
  const resumes = (list ?? []).reduce((s, j) => s + j.resumes.length, 0);

  const run = () => {
    setBusy(true);
    setErr(null);
    api.updateBoard()
      .then((r) => {
        setNote(`Moved ${r.jobs} job${r.jobs === 1 ? "" : "s"} to Not tailored; ${r.records} resume${r.records === 1 ? "" : "s"} deleted`
          + (r.backup_dir ? ` (backup in ${r.backup_dir})` : "")
          + (r.refused.length ? `; ${r.refused.length} not moved (${r.refused.map((x) => `${x.title}: ${x.message}`).join("; ")})` : ""));
        setOpen(false);
        onDone();
      })
      .catch((e: Error) => setErr("Update board failed: " + e.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button className="btn ghost" disabled={busy || open} onClick={show}
        title="Tailored jobs whose score is now below 75 move to Not tailored; their tailored resumes are deleted (backed up first).">
        Update board
      </button>
      {note && <span className="muted small">{note}</span>}
      {open && (
        <div className="delete-panel skip-delete">
          {!list && !err && <div className="muted small">Checking…</div>}
          {list && n === 0 && (
            <>
              <h4>Board is up to date</h4>
              <div className="muted small">No tailored job is below 75.</div>
              <div><button className="btn ghost tiny" onClick={() => setOpen(false)}>Close</button></div>
            </>
          )}
          {list && n > 0 && (
            <>
              <h4>Move {n} job{n === 1 ? "" : "s"} to Not tailored?</h4>
              <div className="muted small">
                Tailored jobs whose score is now below 75, every application status included. Their tailored resumes
                ({resumes}) are deleted, backed up first. The job, its score, gap answers, keep mark and tracking stay.
              </div>
              <ul className="skip-list">
                {list.map((j) => (
                  <li key={j.id}>
                    <b>{j.title}</b> · {j.company}{" "}
                    <span className={`chip ${bandClass(j.band)}`}>{j.score === null ? "no score" : j.score.toFixed(1)}{j.band ? ` ${j.band}` : ""}</span>
                    {j.application && <span className="chip">{APP_LABEL[j.application]}</span>}
                    <span className="muted small"> {j.resumes.length ? `deletes ${j.resumes.join(", ")}` : "no resume file left"}</span>
                  </li>
                ))}
              </ul>
              <div>
                <button className="btn tiny danger" disabled={busy} onClick={run}>
                  {busy ? "Updating…" : `Move ${n} job${n === 1 ? "" : "s"} to Not tailored and delete their tailored resumes`}
                </button>
                <button className="btn ghost tiny" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </>
          )}
          {err && <div className="banner error">{err}</div>}
          {err && !list && <div><button className="btn ghost tiny" onClick={() => setOpen(false)}>Close</button></div>}
        </div>
      )}
    </>
  );
}

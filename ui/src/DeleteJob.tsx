// "Why delete it?" (job drawer): asks what is wrong with the job before deleting it. The words
// picked become skip keywords (preferences.yaml skip_keywords): jd-search skips every later
// posting whose title or description has one as a whole word, and the stored jobs that have one
// are skipped at the next batch's re-check. Words of the user's own target roles are refused.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { DeleteHints, DeleteResult, JobDetail } from "./api";

export function DeletePanel({ d, onCancel, onDeleted }: { d: JobDetail; onCancel: () => void; onDeleted: () => void }) {
  const [hints, setHints] = useState<DeleteHints | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<DeleteResult | null>(null);

  useEffect(() => {
    api.deleteHints(d.job.id).then(setHints).catch((e: Error) => setErr("No suggestions: " + e.message));
  }, [d.job.id]);

  const applied = ["applied", "interview", "offer"].includes(d.application?.status ?? "");
  const resumes = d.resumes.filter((r) => r.decision !== "not_tailored").length;
  const typed = other.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const words = [...new Set([...picked, ...typed])];
  const blocked = typed.filter((w) => hints?.protected.includes(w));
  const toggle = (w: string) => setPicked((p) => (p.includes(w) ? p.filter((x) => x !== w) : [...p, w]));

  const remove = () => {
    setBusy(true);
    setErr(null);
    api.deleteJob(d.job.id, { reason: reason.trim() || undefined, keywords: words.length ? words : undefined })
      .then((r) => (r.keywords_refused.length || r.keywords_error ? setDone(r) : onDeleted()))
      .catch((e: Error) => setErr("Could not delete: " + e.message))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <div className="delete-panel">
        <div className="banner ok">Deleted.{done.keywords_added.length ? ` Later batches skip jobs with: ${done.keywords_added.join(", ")}.` : ""}</div>
        {done.keywords_refused.length > 0 && <div className="banner">Not used as skip words (they name your own target roles, so they would skip every job): {done.keywords_refused.join(", ")}.</div>}
        {done.keywords_error && <div className="banner error">The skip words were not saved: {done.keywords_error}</div>}
        <button className="btn tiny" onClick={onDeleted}>Close</button>
      </div>
    );
  }

  const chip = (w: string) => (
    <button key={w} type="button" className={`btn tiny${picked.includes(w) ? " accent" : " ghost"}`} onClick={() => toggle(w)}>{w}</button>
  );

  return (
    <div className="delete-panel">
      <h4>Why delete it?</h4>
      <div className="muted small">
        Pick the words that make this job wrong for you. Later batches skip every job whose title or description has one of
        them (whole words), and jobs already fetched that have one are skipped at the next batch.
      </div>
      {hints && hints.title.length > 0 && <div><span className="muted small">From the title: </span>{hints.title.map(chip)}</div>}
      {hints && hints.keywords.length > 0 && <div><span className="muted small">Keywords you are missing (Gaps tab): </span>{hints.keywords.map(chip)}</div>}
      <input type="text" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Other words, comma separated (e.g. php, night shift, contract)" />
      {blocked.length > 0 && <div className="banner">Not allowed (your own target roles use them): {blocked.join(", ")}</div>}
      {hints && hints.current.length > 0 && <div className="muted small">Already on your skip list and in this job (it was fetched before you added them): {hints.current.join(", ")}</div>}
      <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Note (optional): anything else about why" />
      <div className="muted small">
        Also removed: its gap answers, tracking{resumes ? ` and ${resumes} tailored resume${resumes === 1 ? "" : "s"} (YAML and PDF)` : ""}. A later fetch will not add it back. This cannot be undone.
      </div>
      {applied && (
        <label className="role-check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          You marked this job as {d.application!.status}. Delete it anyway.
        </label>
      )}
      <div>
        <button className="btn tiny danger" disabled={busy || (applied && !sure) || blocked.length > 0} onClick={remove}>
          {busy ? "Deleting…" : words.length ? `Delete and skip jobs with ${words.length === 1 ? `"${words[0]}"` : `these ${words.length} words`}` : "Delete without skip words"}
        </button>
        <button className="btn ghost tiny" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="banner error">{err}</div>}
    </div>
  );
}

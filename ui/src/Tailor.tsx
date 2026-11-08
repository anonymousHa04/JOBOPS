// Tailor now: a rescore only updates the score; the user starts tailoring here once the job is
// at 75+ and the tailor would build a resume. Open gap questions do not block it; answering them
// can still raise the score (Re-tailor for a job tailored before). The last tailor run's outcome shows below, with its reason when it made
// no resume or the PDF failed.
import { useEffect, useState } from "react";
import { api } from "./api";
import type { TailorStatus } from "./api";

export function TailorBox({ id, refresh, onChanged }: { id: string; refresh: number; onChanged: () => void }) {
  const [st, setSt] = useState<TailorStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.tailorStatus(id).then(setSt).catch((e: Error) => setNote("Tailor status: " + e.message));
  }, [id, refresh]);

  if (!st) return note ? <div className="muted small">{note}</div> : null;

  const start = (fresh = false) => {
    setBusy(true);
    api.tailorNow(id, fresh)
      .then((r) => {
        setNote(r.tailor_batch > 0
          ? `Queued for tailoring (batch ${r.tailor_batch}): the Mac worker tailors it, and the job moves to Tailoring.`
          : "A score or tailor task is already open for this job.");
        onChanged();
      })
      .catch((e: Error) => setNote("Could not tailor: " + e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className={"tailor-box" + (st.ready ? " ready" : "")}>
      {st.ready && <b>Ready for tailor</b>}
      <button className="btn tiny accent" disabled={!st.can_tailor || busy || note?.startsWith("Queued") === true} onClick={() => start()}
        title="Make a tailored resume for this job (the Mac worker, general14). Only at 75 or more; open gap questions do not block it.">
        {busy ? "Queuing…" : st.tailored ? "Re-tailor" : "Tailor now"}
      </button>
      {st.tailored && (
        <button className="btn tiny" disabled={!st.can_tailor || busy || note?.startsWith("Queued") === true} onClick={() => start(true)}
          title="Ignores this job's earlier versions and builds a new resume from your bank. The earlier versions stay in the list.">
          Re-tailor from scratch
        </button>
      )}
      {!st.can_tailor && st.reasons.length > 0 && <span className="muted small">{st.reasons.join(" ")}</span>}
      {st.can_tailor && st.open_questions > 0 && (
        <span className="muted small">
          {st.open_questions} gap question{st.open_questions === 1 ? "" : "s"} still open: you can tailor now; answering them may raise the score (then Re-tailor).
        </span>
      )}
      {note && <span className="muted small">{note}</span>}
      {st.last && (
        <div className={"small tailor-last" + (st.last.ok ? " muted" : " bad")}>
          Last tailor ({new Date(st.last.at).toLocaleString()}): {st.last.message}
          {st.last.left_out && st.last.left_out.length > 0 && (
            <div>Left out (fix in the bank or review): {st.last.left_out.map((l) => `${l.bullet_id} (${l.codes.join(", ")})`).join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

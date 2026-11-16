// Toolbar: paste a job's link, and JobOps fetches it, parses and scores it in the background.
// Tailoring stays your click (Tailor now in the drawer). LinkedIn, Naukri, Indeed and similar
// links are refused by the API: paste the company's own link ("Apply on company website").
import { useState } from "react";
import { api, ApiError } from "./api";

export function AddJob({ onAdded }: { onAdded: (jobId: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // deleted: the API refused a job you deleted earlier (error deleted_before); the note then
  // offers "Add it anyway", which resends the same link with undelete.
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string; deleted?: string } | null>(null);

  const add = (undelete = false) => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setNote(null);
    api.addJob(url.trim(), undelete)
      .then((r) => {
        const what = r.created ? "Added" : "Already on your board";
        const next = r.queue_note ?? (r.stage === "parse" ? "parsing, then scoring" : r.stage === "score" ? "scoring" : "");
        const kept = r.skip_words_kept?.length ? `. Skip words kept: ${r.skip_words_kept.join(", ")}` : "";
        setNote({ kind: r.queue_note ? "error" : "ok", text: `${what}: ${r.company} · ${r.title}${next ? ` (${next})` : ""}${kept}` });
        setUrl("");
        onAdded(r.job_id);
      })
      .catch((e: Error) => {
        const data = e instanceof ApiError ? (e.data as { error?: string; deleted_at?: string }) : null;
        if (data?.error === "deleted_before") {
          const on = data.deleted_at ? new Date(data.deleted_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "an earlier day";
          setNote({ kind: "error", text: `You deleted this job on ${on}.`, deleted: url.trim() });
        } else {
          setNote({ kind: "error", text: e.message });
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <span className="add-job">
      <input className="search add-job-url" placeholder="Paste a job link…" value={url} disabled={busy}
        title="A Greenhouse, Lever, Ashby, Workday, SmartRecruiters or company careers link. It is fetched, parsed and scored; you tailor it."
        onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <button className="btn" disabled={busy || !url.trim()} onClick={() => add()}>{busy ? "Fetching…" : "Add job"}</button>
      {note && <span className={note.kind === "error" ? "add-job-note error" : "add-job-note muted small"}>{note.text}</span>}
      {note?.deleted && !busy && note.deleted === url.trim() && <button className="btn" onClick={() => add(true)}>Add it anyway</button>}
    </span>
  );
}

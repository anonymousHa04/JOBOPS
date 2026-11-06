// Toolbar: paste a job's link, and JobOps fetches it, parses and scores it in the background.
// Tailoring stays your click (Tailor now in the drawer). LinkedIn, Naukri, Indeed and similar
// links are refused by the API: paste the company's own link ("Apply on company website").
import { useState } from "react";
import { api } from "./api";

export function AddJob({ onAdded }: { onAdded: (jobId: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const add = () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setNote(null);
    api.addJob(url.trim())
      .then((r) => {
        const what = r.created ? "Added" : "Already on your board";
        const next = r.queue_note ?? (r.stage === "parse" ? "parsing, then scoring" : r.stage === "score" ? "scoring" : "");
        setNote({ kind: r.queue_note ? "error" : "ok", text: `${what}: ${r.company} · ${r.title}${next ? ` (${next})` : ""}` });
        setUrl("");
        onAdded(r.job_id);
      })
      .catch((e: Error) => setNote({ kind: "error", text: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <span className="add-job">
      <input className="search add-job-url" placeholder="Paste a job link…" value={url} disabled={busy}
        title="A Greenhouse, Lever, Ashby, Workday, SmartRecruiters or company careers link. It is fetched, parsed and scored; you tailor it."
        onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <button className="btn" disabled={busy || !url.trim()} onClick={add}>{busy ? "Fetching…" : "Add job"}</button>
      {note && <span className={note.kind === "error" ? "add-job-note error" : "add-job-note muted small"}>{note.text}</span>}
    </span>
  );
}

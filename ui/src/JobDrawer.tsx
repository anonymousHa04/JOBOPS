import { useEffect, useState } from "react";
import { onChange } from "./events";
import { api, ApiError, APP_LABEL, APP_STATUSES, bandClass, fmtDate, STATE_LABEL } from "./api";
import type { Application, AppStatus, JobDetail, ScoreDetail } from "./api";
import { ScoreView } from "./Score";
import { GapsView } from "./Gaps";
import { TailorBox } from "./Tailor";
import { DeletePanel } from "./DeleteJob";

export type Tab = "overview" | "score" | "gaps" | "tracking" | "description";

export function JobDrawer({ id, initialTab, onClose, onChanged }: { id: string; initialTab?: Tab; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<JobDetail | null>(null);
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [scoreErr, setScoreErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false); // "Why delete it?" open

  useEffect(() => {
    setD(null); setScore(null); setScoreErr(null); setErr(null); setDeleting(false);
    api.job(id).then(setD).catch((e: Error) => setErr(e.message));
    api.score(id).then(setScore).catch((e: Error) => setScoreErr(e instanceof ApiError ? e.message : String(e)));
  }, [id]);

  // The open job changed (a task moved, an answer saved): read its detail and score again, once
  // per burst. rev re-reads the Tailor box too.
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onChange((c) => {
      if (c.kind !== "resync" && c.job_id !== id) return;
      if (t) return;
      t = setTimeout(() => {
        t = null;
        api.job(id).then(setD).catch(() => undefined);
        api.score(id).then((s) => { setScore(s); setScoreErr(null); }).catch(() => undefined);
        setRev((r) => r + 1);
      }, 300);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [id]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const setApp = (a: Application) => { setD((x) => (x ? { ...x, application: a } : x)); onChanged(); };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <button className="close" onClick={onClose} title="Close (Esc)">×</button>
        {err && <div className="banner error">{err}</div>}
        {!d && !err && <div className="muted pad">Loading…</div>}
        {d && (
          <>
            <div className="drawer-head">
              <div className="crumbs muted">{d.job.company} · {d.job.id.slice(0, 8)}</div>
              <h2>{d.job.title}</h2>
              <div className="head-meta">
                <span className={`status-chip state-${d.state}`}>{STATE_LABEL[d.state]}</span>
                {(score?.score ?? d.score) != null && (
                  <span className={`score-pill ${bandClass(score?.band ?? d.band)}`}>{(score?.score ?? d.score)!.toFixed(1)}</span>
                )}
                {d.application.status && <span className="chip accent">{APP_LABEL[d.application.status]}</span>}
                <span className="muted">{d.job.location ?? "No location"}</span>
                <a href={d.job.source_url} target="_blank" rel="noreferrer">Open posting ↗</a>
                <button className="btn tiny" title="Copies the job, how it was scored and your gaps (no resume text, no contact details) for Claude or ChatGPT to find your weak points." onClick={() => api.prompt(id).then((r) => navigator.clipboard.writeText(r.prompt)).then(() => setCopied("Copied")).catch((e: Error) => setCopied("Copy failed: " + e.message)).finally(() => setTimeout(() => setCopied(null), 4000))}>{copied ?? "Copy as prompt"}</button>
                <button className={`btn tiny${d.kept ? " accent" : ""}`}
                  title={d.kept ? "Kept: skip words never skip this job and a bulk delete never takes it. Click to undo." : "Keep this job whatever your skip words say: the batch check never skips it and a bulk delete never takes it."}
                  onClick={() => api.keepJob(id, !d.kept).then((r) => { setD((x) => (x ? { ...x, kept: r.kept } : x)); onChanged(); }).catch(() => undefined)}>
                  {d.kept ? "Kept ✓" : "Keep this job"}
                </button>
                <button className="btn tiny danger" disabled={deleting} title="Remove this job, its answers and its tailored resumes; asks why first, and skips later jobs with the words you pick." onClick={() => setDeleting(true)}>Delete this job</button>
              </div>
            </div>
            {deleting && <DeletePanel d={d} onCancel={() => setDeleting(false)} onDeleted={() => { onChanged(); onClose(); }} />}
            <div className="muted small prompt-note">Copy as prompt: the job, how it was scored, and your gaps, for a stronger model to find your weak points. No resume text or contact details are included.</div>
            <nav className="drawer-tabs">
              {(["overview", "score", "gaps", "tracking", "description"] as Tab[]).map((t) => (
                <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </nav>
            <div className="drawer-body">
              {tab === "overview" && <Overview d={d} score={score} scoreErr={scoreErr} rev={rev} onScore={() => setTab("score")} onChanged={() => { onChanged(); api.job(id).then(setD).catch(() => undefined); }} />}
              {tab === "score" && (score ? <ScoreView d={score} /> : <div className="banner">{scoreErr ?? "Computing…"}</div>)}
              {tab === "gaps" && <GapsView id={id} onChanged={() => { onChanged(); api.score(id).then(setScore).catch(() => undefined); }} />}
              {tab === "tracking" && <Tracking id={id} app={d.application} onChange={setApp} />}
              {tab === "description" && <pre className="description">{d.job.description}</pre>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function Overview({ d, score, scoreErr, rev, onScore, onChanged }: { d: JobDetail; score: ScoreDetail | null; scoreErr: string | null; rev: number; onScore: () => void; onChanged: () => void }) {
  const failed = d.tasks.filter((t) => t.state === "failed");
  return (
    <div className="overview">
      <div className="why">
        <div className="why-title">Status: {STATE_LABEL[d.state]}</div>
        {d.state === "failed" && failed.map((t) => (
          <div key={t.stage + t.updated_at}>
            <b>{t.stage}</b> failed after {t.attempts} attempt(s): <code>{t.error_code ?? "error"}</code>
            {t.error_detail && <div className="detail">{t.error_detail}</div>}
            <div className="muted small">Retry it from the Batches tab (batch {t.batch_id}).</div>
          </div>
        ))}
        {d.state === "skipped" && <div>Skipped by your preferences: <b>{d.filter?.reason}</b> (checked {fmtDate(d.filter?.checked_at)}). Change <code>profile/preferences.yaml</code> to include it.</div>}
        {d.state === "new" && <div>Not parsed yet. Start a batch to parse and score it.</div>}
        {(d.state === "parsing" || d.state === "scoring" || d.state === "tailoring") && <div>Queued or running: {d.state} (needs the {d.state === "tailoring" ? "Mac" : "laptop"} worker).</div>}
        {d.state === "parsed" && <div>Parsed, not scored yet. The queue server scores leftovers like this every 2 minutes; or use “Score parsed jobs now” on the Batches tab.</div>}
        {d.state === "to_tailor" && <div>Scored well enough to tailor ({d.decision}); the Mac worker tailors it next.</div>}
        {d.state === "tailored" && <div>A tailored resume exists (below).</div>}
        {d.state === "not_tailored" && d.ready_to_tailor && <div>Re-scored into a tailoring band ({d.decision}). It stays here until you start tailoring.</div>}
        {d.state === "not_tailored" && !d.ready_to_tailor && (score?.reasons.length ? <ul>{score.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <div>Score below the tailoring bands.</div>)}
        {(d.state === "not_tailored" || d.state === "tailored") && <TailorBox id={d.job.id as string} refresh={rev} onChanged={onChanged} />}
        {score && <button className="btn link" onClick={onScore}>See how the score was calculated →</button>}
        {scoreErr && d.parsed && <div className="muted small">Score: {scoreErr}</div>}
      </div>

      <div className="facts">
        <Fact k="Company" v={d.job.company} />
        <Fact k="Source" v={d.job.source_name ?? "—"} />
        <Fact k="Seniority" v={d.job.seniority ?? "—"} />
        <Fact k="Type" v={d.job.employment_type ?? "—"} />
        <Fact k="Posted" v={fmtDate(d.job.posted_at)} />
        <Fact k="First seen" v={fmtDate(d.job.first_seen_at)} />
        <Fact k="Parsed" v={d.parsed ? `${fmtDate(d.parsed.created_at)} (${d.parsed.prompt_version})` : "no"} />
        <Fact k="Batch score" v={d.score != null ? `${d.score.toFixed(1)} (${d.band})` : "—"} />
      </div>

      {d.resumes.length > 0 && (
        <>
          <h4>Resumes</h4>
          {(() => {
            // A tailor that produced the same content returns that resume as is (records never
            // change): say so, with the job's score now, so the table does not look stale.
            const last = [...d.tasks].reverse().find((t) => t.stage === "tailor" && t.state === "done");
            const res = last?.result as { created?: boolean; resume_id?: string | null } | null | undefined;
            return res && res.created === false && res.resume_id ? (
              <div className="banner">
                The last tailor ({fmtDate(last!.updated_at)}) picked the same bullets and skills as <code>{res.resume_id}</code>, so no new resume was made.
                {d.score !== null ? ` The job scores ${d.score.toFixed(1)} now.` : ""}
                {" "}New answers raise the job's score, but change the resume only when they beat a bullet that is already picked (each role has a bullet limit).
              </div>
            ) : null;
          })()}
          <table className="tasks">
            <thead><tr><th>Resume</th><th>Decision</th><th>Score</th><th>File</th><th>Created</th><th>Last tailor run</th></tr></thead>
            <tbody>
              {[...d.resumes].sort((a, b) => Number(b.latest) - Number(a.latest) || (b.last_run_at ?? b.created_at).localeCompare(a.last_run_at ?? a.created_at)).map((r) => (
                <tr key={r.resume_id} className={r.latest ? "" : "old-row"}>
                  <td className="mono">{r.resume_id}{r.latest && <span className="chip ok-chip">latest</span>}</td>
                  <td>{r.decision}</td>
                  {/* The latest resume carries the job's score (the Score tab's); older ones are history. */}
                  {r.latest && d.score != null
                    ? <td>{d.score.toFixed(1)} ({d.band})</td>
                    : <td className="muted" title="Score at the time it was made (history).">{r.score != null ? `${r.score}${r.band ? ` (${r.band})` : ""}` : "—"} then</td>}
                  <td className="mono">{r.path}</td>
                  <td className="muted">{fmtDate(r.created_at)}</td>
                  <td className="muted">{r.last_run_at ? fmtDate(r.last_run_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      
      <h4>Pipeline history</h4>
      {d.tasks.length ? (
        <table className="tasks">
          <thead><tr><th>Stage</th><th>State</th><th>Batch</th><th>Tries</th><th>Worker</th><th>Result</th><th>Updated</th></tr></thead>
          <tbody>
            {[...d.tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((t, n) => (
              <tr key={n} className={t.state === "failed" ? "fail-row" : ""}>
                <td>{t.stage}</td>
                <td><span className={`task-state ${t.state}`}>{t.state}</span></td>
                <td>{t.batch_id}</td>
                <td>{t.attempts}</td>
                <td className="muted">{t.worker ?? "—"}</td>
                <td className="mono">{t.error_code ?? (t.result ? Object.entries(t.result).map(([k, v]) => `${k}: ${v}`).join(", ") : "—")}</td>
                <td className="muted">{fmtDate(t.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="muted">No batch has picked up this job.</div>}

      
    </div>
  );
}

const Fact = ({ k, v }: { k: string; v: string }) => <div className="fact"><span className="muted">{k}</span><span>{v}</span></div>;

function Tracking({ id, app, onChange }: { id: string; app: Application; onChange: (a: Application) => void }) {
  const [note, setNote] = useState(app.note ?? "");
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<Application>) => p.then((a) => { onChange(a); setErr(null); }).catch((e: Error) => setErr(e.message));

  return (
    <div className="tracking">
      {err && <div className="banner error">{err}</div>}
      <label className="field">
        <span>Status</span>
        <select value={app.status ?? ""} onChange={(e) => run(api.setApplication(id, (e.target.value || null) as AppStatus | null))}>
          <option value="">Not tracked</option>
          {APP_STATUSES.map((s) => <option key={s} value={s}>{APP_LABEL[s]}</option>)}
        </select>
      </label>
      {!app.status && <button className="btn" onClick={() => run(api.setApplication(id, "interested"))}>Track this job</button>}
      {app.status && (
        <>
          <div className="muted small">Applied {fmtDate(app.applied_at)} · updated {fmtDate(app.updated_at)}</div>
          <label className="field">
            <span>Notes</span>
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Recruiter, referral, interview dates…" />
          </label>
          <button className="btn" disabled={note === (app.note ?? "")} onClick={() => run(api.setApplication(id, app.status, note))}>Save note</button>

          <h4>Preparation tasks</h4>
          <ul className="checklist">
            {app.tasks.map((t) => (
              <li key={t.id}>
                <label><input type="checkbox" checked={t.done} onChange={(e) => run(api.patchTask(id, t.id, { done: e.target.checked }))} /> <span className={t.done ? "done" : ""}>{t.text}</span></label>
                <button className="btn ghost tiny" onClick={() => run(api.patchTask(id, t.id, { remove: true }))}>Remove</button>
              </li>
            ))}
          </ul>
          <form className="add-task" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { run(api.addTask(id, text.trim())); setText(""); } }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a task, e.g. Review system design notes" maxLength={300} />
            <button className="btn" type="submit">Add</button>
          </form>
        </>
      )}
    </div>
  );
}

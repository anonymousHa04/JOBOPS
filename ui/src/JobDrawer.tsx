import { useEffect, useState } from "react";
import { api, ApiError, APP_LABEL, APP_STATUSES, bandClass, fmtDate, STATE_LABEL } from "./api";
import type { Application, AppStatus, JobDetail, ScoreDetail } from "./api";
import { ScoreView } from "./Score";
import { GapsView } from "./Gaps";

export type Tab = "overview" | "score" | "gaps" | "tracking" | "description";

export function JobDrawer({ id, initialTab, onClose, onChanged }: { id: string; initialTab?: Tab; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<JobDetail | null>(null);
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [scoreErr, setScoreErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setD(null); setScore(null); setScoreErr(null); setErr(null);
    api.job(id).then(setD).catch((e: Error) => setErr(e.message));
    api.score(id).then(setScore).catch((e: Error) => setScoreErr(e instanceof ApiError ? e.message : String(e)));
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
              </div>
            </div>
            <div className="muted small prompt-note">Copy as prompt: the job, how it was scored, and your gaps, for a stronger model to find your weak points. No resume text or contact details are included.</div>
            <nav className="drawer-tabs">
              {(["overview", "score", "gaps", "tracking", "description"] as Tab[]).map((t) => (
                <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </nav>
            <div className="drawer-body">
              {tab === "overview" && <Overview d={d} score={score} scoreErr={scoreErr} onScore={() => setTab("score")} />}
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

function Overview({ d, score, scoreErr, onScore }: { d: JobDetail; score: ScoreDetail | null; scoreErr: string | null; onScore: () => void }) {
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
        {d.state === "not_tailored" && (score?.reasons.length ? <ul>{score.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <div>Score below the tailoring bands.</div>)}
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

      <h4>Pipeline history</h4>
      {d.tasks.length ? (
        <table className="tasks">
          <thead><tr><th>Stage</th><th>State</th><th>Batch</th><th>Tries</th><th>Worker</th><th>Result</th><th>Updated</th></tr></thead>
          <tbody>
            {d.tasks.map((t, n) => (
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

      {d.resumes.length > 0 && (
        <>
          <h4>Resumes</h4>
          <table className="tasks">
            <thead><tr><th>Resume</th><th>Decision</th><th>Score</th><th>File</th><th>Created</th></tr></thead>
            <tbody>
              {d.resumes.map((r) => (
                <tr key={r.resume_id}><td className="mono">{r.resume_id}</td><td>{r.decision}</td><td>{r.score ?? "—"}</td><td className="mono">{r.path}</td><td className="muted">{fmtDate(r.created_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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

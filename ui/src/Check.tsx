// Check tab of the job drawer: after tailoring, is the resume as strong as the job's score, and
// what did a Claude (or ChatGPT) check change? The check runs in the JobOps Chrome extension
// (its report loop): the chat reviews the tailored resume, JobOps fixes it locally through the
// guard, re-scores it, and keeps a version only if the engine score rose, up to 5 rounds. The
// best version stays the current resume and gets its PDF. This tab starts it, follows it, and
// shows each round's changes and the report.
import { useEffect, useState } from "react";
import { api, fmtDate } from "./api";
import type { CheckSettings, CheckView as View } from "./api";
import { useExtension } from "./extension";

type Status = { jobId?: string; target?: string; step?: string; round?: number; error?: string; at?: string };
const STEP: Record<string, string> = {
  prompt: "Preparing the prompt…", chat: "Opening the chat…", waiting: "Waiting for the chat's answer…",
  saving: "Saving the report…", fixing: "Fixing the resume from the report…", asking: "Sending the new version back to the chat…",
  done: "Done.", failed: "Failed", saved: "Report saved."
};

const STOPPED: Record<string, string> = {
  covered: "nothing left it can fix (any remaining points need your facts)", no_change: "a round changed nothing",
  repeat: "a round made a version it had already tried",
  round_limit: "5 rounds done", error: "an error", no_gain: "a round did not raise the score"
};

export function CheckView({ id, rev }: { id: string; rev: number }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ext = useExtension();
  // "Check with Claude after each tailor": one switch for all jobs (server-side), told to the
  // app's AutoCheck through a window event so it applies at once.
  const [auto, setAuto] = useState<CheckSettings | null>(null);
  useEffect(() => { api.checkSettings().then(setAuto).catch(() => setAuto(null)); }, []);
  const saveAuto = (s: Partial<CheckSettings>) => (setAuto((a) => (a ? { ...a, ...s } : a)), api.setCheckSettings(s)).then((x) => {
    setAuto(x);
    window.dispatchEvent(new CustomEvent("jobops:check-settings", { detail: x }));
  }).catch((e: Error) => setErr(e.message));
  const load = () => api.check(id).then((x) => { setV(x); setErr(null); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, [id, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = (source: string, choice: { use?: "new" | "previous"; resume_id?: string }) => {
    setBusy(true);
    setNote(null);
    api.decideCheck(id, source, choice)
      .then((r) => {
        setNote(`Round ${r.version === 0 ? "tailored" : r.version} is your resume now` + (r.version === 0 ? "." : "; its PDF is made.")
          + (r.rescore_batch ? " Re-scoring the job…" : r.rescore_error ? ` Re-score not started: ${r.rescore_error}` : "")
          + " A new check starts a new chat.");
        return load();
      })
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const choose = (rid: string) => {
    setBusy(true);
    setNote(null);
    api.chooseResume(id, rid)
      .then((r) => {
        setNote("That resume is yours now" + (r.pdf_error ? ` (its PDF failed: ${r.pdf_error})` : "; its PDF is ready.")
          + (r.rescore_batch ? " Re-scoring the job…" : r.rescore_error ? ` Re-score not started: ${r.rescore_error}` : "")
          + " The next check starts a new chat.");
        return load();
      })
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const restart = (source: string) => {
    setBusy(true);
    setNote(null);
    api.restartCheck(id, source)
      .then(() => { setNote(`${source === "claude" ? "Claude" : "ChatGPT"} check restarted: the old rounds are kept as a file; the next check opens a new chat.`); return load(); })
      .catch((e: Error) => setNote("Could not restart: " + e.message)).finally(() => setBusy(false));
  };
  // After a choice, the next check starts a new chat (the old one reviewed other versions).
  const fresh = (source: string) => !!v?.loops.find((l) => l.source === source)?.decision;
  const mine = ext.status && ext.status.jobId === id ? ext.status : null;
  const running = !!mine && mine.step !== "done" && mine.step !== "failed";

  if (err) return <div className="banner error">{err}</div>;
  if (!v) return <div className="muted pad">Loading…</div>;
  if (!v.resume) return <div className="banner">No tailored resume yet: tailor the job first (Tailor now, at 75+). The check reviews the tailored resume.</div>;
  const r = v.resume;
  const drop = r.job_score - r.engine_score;

  return (
    <div className="check-tab">
      <div className="muted small">
        Click Check with Claude and keep the Claude tab open. Claude reviews the tailored resume (no contact details); JobOps fixes each point it can through the guard, re-scores, and sends Claude the new version with what changed, until nothing is left to fix or 5 rounds are done. Your resume does not change during the check: at the end, if the best version scores the same or higher, you choose here.
      </div>

      <div className={"check-score" + (drop > 0 ? " warn" : "")}>
        <div>
          Resume <code>{r.resume_id}</code> ({r.decision}) scores <b>{r.engine_score.toFixed(1)}</b>; the job scores <b>{r.job_score.toFixed(1)}</b> with your whole bank.
          {r.pdf ? <> <a href={api.pdfUrl(r.resume_id)} target="_blank" rel="noreferrer">Open PDF ↗</a></> : <span className="muted"> No PDF yet.</span>}
        </div>
        {drop > 0 && (
          <div>
            It lost {r.lost.length} requirement{r.lost.length === 1 ? "" : "s"} your bank shows (bullets left out to fit the page, or reworded away):
            <ul>{r.lost.map((l) => <li key={l.kind + l.requirement}><b>{l.requirement}</b> <span className="muted">({l.kind}: {l.job_credit.toFixed(2)} → {l.resume_credit.toFixed(2)})</span></li>)}</ul>
          </div>
        )}
      </div>

      <h4>Resumes for this job</h4>
      <table className="tasks check-resumes">
        <thead><tr><th>Resume</th><th>Made by</th><th>Engine score</th><th>Claude's fit</th><th>PDF</th><th title="When it was made, or last chosen">Last used</th><th></th></tr></thead>
        <tbody>
          {v.resumes.map((x, i) => (
            <tr key={x.resume_id}>
              <td className="mono">{x.resume_id.slice(-8)}</td>
              <td>{x.made_by}</td>
              <td>
                {x.engine_score.toFixed(1)}
                {i === 0 && v.resumes.length > 1 && <span className="chip ok-chip">best</span>}
              </td>
              <td>{x.chat_score ?? "—"}</td>
              <td>{x.pdf ? <a href={api.pdfUrl(x.resume_id)} target="_blank" rel="noreferrer">Open ↗</a> : <span className="muted">—</span>}</td>
              <td className="muted small">{fmtDate(x.created_at)}</td>
              <td>{x.current ? <span className="chip ok-chip">current</span>
                : <button className="btn tiny" disabled={busy || running} onClick={() => choose(x.resume_id)}
                    title="Make this your resume (PDF made if missing), re-score the job; the next check starts a new chat">Choose this</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {auto && (
        <label className="check-auto small">
          <input type="checkbox" checked={auto.auto_check} onChange={(e) => void saveAuto({ auto_check: e.target.checked })} />
          {" "}Check with{" "}
          <select value={auto.source} onChange={(e) => void saveAuto({ source: e.target.value as CheckSettings["source"] })}>
            <option value="claude">Claude</option><option value="chatgpt">ChatGPT</option>
          </select>
          {" "}after each tailor, for every job <span className="muted">(starts by itself when a tailor makes a new resume, in a new chat, while a JobOps page is open in Chrome; one check at a time)</span>
        </label>
      )}

      <div className="check-run">
        <button className="btn accent" disabled={!ext.ready || running} onClick={() => ext.start(id, "claude", fresh("claude"))}
          title={ext.ready ? "Opens this job's Claude chat in Chrome and runs the check" : "The JobOps Chrome extension is not installed or not loaded on this page"}>
          {running ? "Checking…" : v.loops.some((l) => l.source === "claude") ? "Check again with Claude" : "Check with Claude"}
        </button>
        <button className="btn ghost tiny" disabled={!ext.ready || running} onClick={() => ext.start(id, "chatgpt", fresh("chatgpt"))}>ChatGPT instead</button>
        {!ext.ready && <span className="muted small"> Load the JobOps extension (chrome://extensions → Load unpacked → extension/), then reload this page.</span>}
        {mine && (
          <span className={mine.step === "failed" ? "small bad" : "muted small"}>
            {" "}{STEP[mine.step ?? ""] ?? mine.step}{mine.round ? ` (round ${mine.round})` : ""}{mine.error ? `: ${mine.error}` : ""}
          </span>
        )}
      </div>

      {v.loops.map((l) => (
        <div key={l.source} className="check-loop">
          <h4>{l.source === "claude" ? "Claude" : "ChatGPT"} check: {l.rounds.length - 1} round{l.rounds.length === 2 ? "" : "s"}
            {l.stopped && <span className="muted small"> · stopped: {STOPPED[l.stopped] ?? l.stopped}</span>}
            {" "}<button className="btn ghost tiny" disabled={busy || running} onClick={() => {
                if (l.candidate && !l.decision && !window.confirm("This check is waiting for your choice. Restarting removes the Choose panel; its versions stay in the resume list.")) return;
                restart(l.source);
              }}
              title="Start this check over: its rounds are kept as a file, and the next check opens a new chat at round 1.">Restart check</button>
          </h4>
          {l.stopped && l.candidate && !l.decision && (
            <div className="check-choose">
              <div>
                The best new version scores <b>{l.candidate.engine_score.toFixed(1)}</b> (your resume: {l.candidate.start_score.toFixed(1)}
                {l.candidate.engine_score > l.candidate.start_score ? `, +${(l.candidate.engine_score - l.candidate.start_score).toFixed(1)}` : ", the same"}). Use it?
              </div>
              {l.candidate.added.map((b) => <div key={"ca" + b.id} className="small">+ <span className="mono">{b.id}</span> {b.text}</div>)}
              {l.candidate.removed.map((b) => <div key={"cr" + b.id} className="small muted">− <span className="mono">{b.id}</span> {b.text}</div>)}
              {l.candidate.reworded.map((b) => <div key={"cw" + b.id} className="small">~ <span className="mono">{b.id}</span> <span className="muted">{b.before}</span> → {b.after}</div>)}
              <div>
                <button className="btn accent" disabled={busy} onClick={() => decide(l.source, { use: "new" })}>{busy ? "Making the resume…" : "Use new resume"}</button>
                <button className="btn ghost" disabled={busy} onClick={() => decide(l.source, { use: "previous" })}>Keep previous</button>
              </div>
            </div>
          )}
          {l.stopped && !l.candidate && <div className="muted small">No new version scored as high as your resume, so it stays as it is.</div>}
          {l.decision && <div className="muted small">You chose: {l.decision === "previous" ? "your previous resume" : `round ${l.rounds.find((x) => x.resume_id === l.chosen)?.version ?? "?"} (its PDF is made)`}. The next check starts a new chat.</div>}
          <table className="tasks">
            <thead><tr><th>Round</th><th>Resume</th><th>Engine score</th><th>Chat's fit score</th><th></th></tr></thead>
            <tbody>
              {l.rounds.map((x) => (
                <tr key={x.version} className={x.kept ? "" : "old-row"}>
                  <td>{x.version === 0 ? "tailored" : x.version}</td>
                  <td className="mono">{x.resume_id}</td>
                  <td>{x.engine_score.toFixed(1)}</td>
                  <td>{x.chat_score ?? "—"}</td>
                  <td>{x.current ? <span className="chip ok-chip">current</span> : x.kept ? "kept" : <span className="muted">lower</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {l.rounds.filter((x) => x.version > 0).map((x) => (x.added.length + x.removed.length + x.reworded.length > 0) && (
            <div key={"c" + x.version} className={"check-changes" + (x.kept ? "" : " old-row")}>
              <div className="small"><b>Round {x.version}</b>{x.kept ? "" : " (not kept)"}</div>
              {x.added.map((b) => <div key={"a" + b.id} className="small">+ <span className="mono">{b.id}</span> {b.text}</div>)}
              {x.removed.map((b) => <div key={"r" + b.id} className="small muted">− <span className="mono">{b.id}</span> {b.text}</div>)}
              {x.reworded.map((b) => <div key={"w" + b.id} className="small">~ <span className="mono">{b.id}</span> <span className="muted">{b.before}</span> → {b.after}</div>)}
            </div>
          ))}
        </div>
      ))}

      {v.reports.map((rep) => (
        <div key={"rep" + rep.source} className="check-report">
          <h4>{rep.source === "claude" ? "Claude" : "ChatGPT"}'s last report{rep.fit_score != null ? `: fit ${rep.fit_score}` : ""}</h4>
          {rep.missed_gaps.length > 0 && <><div className="small"><b>Says the resume misses</b></div><ul>{rep.missed_gaps.map((g) => <li key={g.requirement} className="small">{g.requirement}: <span className="muted">{g.why}</span></li>)}</ul></>}
          {rep.bullet_notes.length > 0 && <><div className="small"><b>Notes on bullets</b></div><ul>{rep.bullet_notes.map((n) => <li key={n.bullet_id + n.note} className="small"><span className="mono">{n.bullet_id}</span>: {n.note}</li>)}</ul></>}
          {rep.from_memory.length > 0 && <><div className="small"><b>From the chat's memory, not in your bank (confirm before using)</b></div><ul>{rep.from_memory.map((f) => <li key={f.fact} className="small">{f.fact} <span className="muted">(for {f.fills_gap})</span></li>)}</ul></>}
        </div>
      ))}
      {note && <div className="banner">{note}</div>}
      {mine?.at && <div className="muted small">Last status {fmtDate(mine.at)}</div>}
    </div>
  );
}

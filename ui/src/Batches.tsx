import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "./api";
import { onChange } from "./events";
import type { Batch } from "./api";

const STAGES = ["fetch", "parse", "score", "tailor"];

export function Batches({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const [list, setList] = useState<Batch[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [cur, setCur] = useState<Batch | null>(null);
  const [limit, setLimit] = useState(3);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const loadList = useCallback(() => {
    api.batches().then((b) => { setList(b); setSel((s) => s ?? b[0]?.id ?? null); }).catch((e: Error) => { setList([]); setMsg({ kind: "error", text: e.message }); });
  }, []);
  // No polling: the list and the selected batch are read again when the change feed names a
  // batch (a task of it changed, or a new batch started), at most once per 300 ms.
  useEffect(() => {
    loadList();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onChange((c) => {
      if (c.kind !== "resync" && (c.batch_id === undefined || c.batch_id === 0)) return;
      if (t) return;
      t = setTimeout(() => { t = null; loadList(); }, 300);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [loadList]);

  useEffect(() => {
    if (sel === null) return;
    let stop = false;
    let wasRunning = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = () => api.batch(sel).then((b) => {
      if (stop) return;
      setCur(b);
      if (wasRunning && !b.running) onChanged();
      wasRunning = b.running;
    }).catch(() => undefined);
    tick();
    const off = onChange((c) => {
      if (c.kind !== "resync" && c.batch_id !== sel) return;
      if (t) return;
      t = setTimeout(() => { t = null; tick(); }, 300);
    });
    return () => { stop = true; off(); if (t) clearTimeout(t); };
  }, [sel, onChanged]);

  const start = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.startBatch(limit);
      setMsg({ kind: "ok", text: `Batch ${r.batch_id} started.` });
      setSel(r.batch_id); loadList();
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const sweepNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.sweep();
      setMsg({ kind: "ok", text: r.queued ? `Batch ${r.batch_id}: ${r.queued} parsed job(s) queued for scoring.` : "No parsed jobs are waiting for a score." });
      if (r.queued) { setSel(r.batch_id); loadList(); onChanged(); }
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const retry = async (id: number) => {
    setBusy(true);
    try { const r = await api.retryBatch(id); setMsg({ kind: "ok", text: `${r.requeued} task(s) queued again.` }); }
    catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
    setBusy(false);
  };

  const anyRunning = list?.some((b) => b.running);

  return (
    <div className="batches">
      <div className="batch-start panel">
        <h3>Start a batch</h3>
        <p className="muted small">Searches the job boards, re-checks stored jobs against your preferences, then parses, scores and tailors up to the limit (newest first).</p>
        <div className="row">
          <label className="field inline"><span>Limit</span>
            <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </label>
          <button className="btn primary" disabled={busy || anyRunning} onClick={start}>{anyRunning ? "A batch is running" : "Start batch"}</button>
          <button className="btn" disabled={busy} onClick={sweepNow} title="Queue a score task for every parsed job that no batch has scored">Score parsed jobs now</button>
        </div>
        <p className="muted small">Parsed jobs that no batch scored are also picked up automatically every 2 minutes by the queue server; the score then decides whether to tailor.</p>
        {msg && <div className={`banner ${msg.kind === "error" ? "error" : "ok"}`}>{msg.text}</div>}
      </div>

      <div className="batch-grid">
        <div className="panel batch-list">
          <h3>Recent batches</h3>
          {!list && <div className="muted">Loading…</div>}
          {list?.length === 0 && <div className="muted">No batches yet.</div>}
          {list?.map((b) => (
            <button key={b.id} className={`batch-row ${sel === b.id ? "active" : ""}`} onClick={() => setSel(b.id)}>
              <span>#{b.id}</span>
              <span className="muted">{fmtDate(b.created_at)}</span>
              <span className={b.running ? "chip accent" : "chip"}>{b.running ? "running" : "done"}</span>
            </button>
          ))}
        </div>

        <div className="panel batch-detail">
          {!cur && <div className="muted">Select a batch.</div>}
          {cur && (
            <>
              <div className="row spread">
                <h3>Batch #{cur.id} <span className="muted small">limit {cur.limit} · {fmtDate(cur.created_at)}</span></h3>
                {cur.running ? <span className="chip accent pulse">running</span> : <span className="chip">finished</span>}
              </div>
              <table className="calc">
                <thead><tr><th>Stage</th><th>Queued</th><th>Working</th><th>Done</th><th>Failed</th><th /></tr></thead>
                <tbody>
                  {STAGES.filter((s) => cur.stages[s]).map((s) => {
                    const c = cur.stages[s];
                    const n = c.queued + c.leased + c.done + c.failed;
                    return (
                      <tr key={s}>
                        <td>{s}</td><td>{c.queued}</td><td>{c.leased}</td><td>{c.done}</td><td className={c.failed ? "bad" : ""}>{c.failed}</td>
                        <td><div className="bar"><div className="bar-fill" style={{ width: `${n ? (100 * c.done) / n : 0}%` }} /></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row gap">
                <span>Tailored: <b>{cur.tailored}</b></span>
                {cur.skipped && <span className="muted">Skipped by preferences: {Object.entries(cur.skipped).map(([k, v]) => `${k} ${v}`).join(", ")}</span>}
              </div>
              {cur.failed && cur.failed.length > 0 && (
                <>
                  <h4>Failures</h4>
                  <table className="tasks">
                    <thead><tr><th>Job</th><th>Stage</th><th>Tries</th><th>Error</th></tr></thead>
                    <tbody>
                      {cur.failed.map((f) => (
                        <tr key={f.id} className="fail-row clickable" onClick={() => !f.job_id.startsWith("batch:") && onOpen(f.job_id)}>
                          <td className="mono">{f.job_id.slice(0, 8)}</td><td>{f.stage}</td><td>{f.attempts}</td>
                          <td><code>{f.error_code}</code> <span className="muted">{f.error_detail}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button className="btn" disabled={busy} onClick={() => retry(cur.id)}>Retry failed tasks</button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

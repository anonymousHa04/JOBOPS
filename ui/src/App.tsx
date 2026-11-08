import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Card } from "./api";
import { HealthBar } from "./HealthBar";
import { AppBoard, PipelineBoard } from "./Board";
import { JobDrawer } from "./JobDrawer";
import type { Tab } from "./JobDrawer";
import { Batches } from "./Batches";
import { SkipDelete } from "./SkipDelete";
import { BulkDelete } from "./BulkDelete";
import { AddJob } from "./AddJob";
import { AutoCheck } from "./AutoCheck";
import { onChange } from "./events";

type View = "pipeline" | "applications" | "batches";

export function App() {
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || "pipeline");
  const [jobs, setJobs] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<Tab | undefined>(undefined);
  const openJob = (id: string, tab?: Tab) => { setOpenTab(tab); setOpen(id); };
  const [query, setQuery] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);
  // Skipped jobs ticked on the board, for "Delete N selected".
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const select = (ids: string[], on: boolean) => setSelected((cur) => {
    const next = new Set(cur);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    return next;
  });

  const lastLoad = useRef(0);
  const load = useCallback(() => {
    lastLoad.current = Date.now();
    api.board().then((j) => { setJobs(j); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);

  // No polling: the board loads once, then the change feed moves single cards. A change names
  // a job: only that card is read again (GET /ui/board/:id) and put in place, or removed when
  // the job is gone. A resync (the feed (re)connected, so changes may have been missed), a
  // preference check (it can skip many jobs at once) or a burst of many jobs reloads once.
  const pending = useRef(new Set<string>());
  const flushT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshCards = useCallback((ids: string[]) => {
    for (const id of ids) {
      api.card(id).then((c) => setJobs((cur) => {
        if (!cur) return cur;
        const i = cur.findIndex((j) => j.id === id);
        if (!c) return i < 0 ? cur : cur.filter((j) => j.id !== id);
        if (i < 0) return [c, ...cur];
        const next = cur.slice();
        next[i] = c;
        return next;
      })).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    load();
    const off = onChange((c) => {
      if (c.kind === "resync" || c.kind === "filter") {
        // The first "ready" arrives right after the first load: no second load for it.
        if (c.kind === "filter" || Date.now() - lastLoad.current > 2000) { pending.current.clear(); load(); }
        return;
      }
      if (!c.job_id) return;
      pending.current.add(c.job_id);
      if (flushT.current) return;
      // Changes come in bursts (a task done, then the next one queued): one read per card.
      flushT.current = setTimeout(() => {
        flushT.current = null;
        const ids = [...pending.current];
        pending.current.clear();
        if (ids.length > 25) load(); else refreshCards(ids);
      }, 250);
    });
    return () => { off(); if (flushT.current) clearTimeout(flushT.current); };
  }, [load, refreshCards]);
  // Children report their own writes; the change feed already moves those cards.
  const changed = useCallback(() => undefined, []);
  const changedJob = useCallback((id: string) => refreshCards([id]), [refreshCards]);
  useEffect(() => { location.hash = view; }, [view]);

  // A ticked job that left the board (deleted, moved to another column) is no longer ticked.
  useEffect(() => {
    if (!jobs) return;
    const ok = new Set(jobs.filter((j) => j.state === "skipped").map((j) => j.id));
    setSelected((cur) => ([...cur].every((id) => ok.has(id)) ? cur : new Set([...cur].filter((id) => ok.has(id)))));
  }, [jobs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (jobs ?? []).filter((j) => !q || `${j.title} ${j.company} ${j.location ?? ""}`.toLowerCase().includes(q));
  }, [jobs, query]);

  const counts = useMemo(() => {
    const all = jobs ?? [];
    return { total: all.length, tracked: all.filter((j) => j.application).length, failed: all.filter((j) => j.state === "failed").length };
  }, [jobs]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">J</span> JobOps</div>
        <nav className="tabs">
          {(["pipeline", "applications", "batches"] as View[]).map((v) => (
            <button key={v} className={view === v ? "tab active" : "tab"} onClick={() => setView(v)}>
              {v === "pipeline" ? "Pipeline" : v === "applications" ? `Applications${counts.tracked ? ` (${counts.tracked})` : ""}` : "Batches"}
            </button>
          ))}
        </nav>
        <HealthBar />
      </header>

      {view !== "batches" && (
        <div className="toolbar">
          <input className="search" placeholder="Search title, company, location…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {view === "pipeline" && (
            <label className="check"><input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show skipped</label>
          )}
          {view === "pipeline" && <AddJob onAdded={(id) => { changedJob(id); openJob(id); }} />}
          <AutoCheck />
          <span className="muted">{counts.total} jobs{counts.failed ? ` · ${counts.failed} failed` : ""}</span>
          <button className="btn ghost" onClick={load}>Refresh</button>
          <RescoreAll refresh={jobs} onDone={changed} />
          <SkipDelete refresh={jobs} onDone={changed} />
          {view === "pipeline" && <BulkDelete selected={[...selected]} onClear={() => setSelected(new Set())} onDone={changed} />}
        </div>
      )}

      <main className="content">
        {error && <div className="banner error">API not reachable: {error}. Start it with <code>node api/src/server.ts</code>.</div>}
        {!jobs && !error && <div className="muted pad">Loading…</div>}
        {jobs && view === "pipeline" && <PipelineBoard jobs={shown} showSkipped={showSkipped} onOpen={openJob} selected={selected} onSelect={select} />}
        {jobs && view === "applications" && <AppBoard jobs={shown} onOpen={openJob} onChanged={changed} />}
        {view === "batches" && <Batches onOpen={openJob} onChanged={changed} />}
      </main>

      {open && <JobDrawer key={open + (openTab ?? "")} id={open} initialTab={openTab} onClose={() => setOpen(null)} onChanged={() => changedJob(open)} />}
    </div>
  );
}

// Rescore all: enabled when your bank, added skills or spellings changed since the last one.
// Only jobs below 75 that are not tailored are re-scored; nothing is tailored on its own.
function RescoreAll({ refresh, onDone }: { refresh: unknown; onDone: () => void }) {
  const [st, setSt] = useState<{ changed: boolean; candidates: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.rescoreAllStatus().then(setSt).catch(() => setSt(null));
  }, [refresh]);
  const run = () => {
    setBusy(true);
    api.rescoreAll()
      .then((r) => {
        setNote(r.queued ? `Re-scoring ${r.queued} job${r.queued === 1 ? "" : "s"} (batch ${r.batch_id})` : "Nothing to re-score");
        onDone();
      })
      .catch((e: Error) => setNote("Rescore all failed: " + e.message))
      .finally(() => setBusy(false));
  };
  const enabled = !!st && st.changed && st.candidates > 0 && !busy;
  const title = !st ? "Checking…"
    : !st.changed ? "Your bank, skills and spellings have not changed since the last Rescore all."
    : st.candidates === 0 ? "No job below 75 to re-score."
    : `Your bank, skills or spellings changed: re-score the ${st.candidates} job(s) below 75. Jobs at 75+ and tailored jobs are not touched.`;
  return (
    <>
      <button className="btn ghost" disabled={!enabled} title={title} onClick={run}>
        {busy ? "Queuing…" : `Rescore all${st?.changed && st.candidates ? ` (${st.candidates})` : ""}`}
      </button>
      {note && <span className="muted small">{note}</span>}
    </>
  );
}

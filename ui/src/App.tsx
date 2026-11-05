import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Card } from "./api";
import { HealthBar } from "./HealthBar";
import { AppBoard, PipelineBoard } from "./Board";
import { JobDrawer } from "./JobDrawer";
import type { Tab } from "./JobDrawer";
import { Batches } from "./Batches";

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

  const load = useCallback(() => {
    api.board().then((j) => { setJobs(j); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { location.hash = view; }, [view]);

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
          <span className="muted">{counts.total} jobs{counts.failed ? ` · ${counts.failed} failed` : ""}</span>
          <button className="btn ghost" onClick={load}>Refresh</button>
          <RescoreAll refresh={jobs} onDone={load} />
        </div>
      )}

      <main className="content">
        {error && <div className="banner error">API not reachable: {error}. Start it with <code>node api/src/server.ts</code>.</div>}
        {!jobs && !error && <div className="muted pad">Loading…</div>}
        {jobs && view === "pipeline" && <PipelineBoard jobs={shown} showSkipped={showSkipped} onOpen={openJob} />}
        {jobs && view === "applications" && <AppBoard jobs={shown} onOpen={openJob} onChanged={load} />}
        {view === "batches" && <Batches onOpen={openJob} onChanged={load} />}
      </main>

      {open && <JobDrawer key={open + (openTab ?? "")} id={open} initialTab={openTab} onClose={() => setOpen(null)} onChanged={load} />}
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

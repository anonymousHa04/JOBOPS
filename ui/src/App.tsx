import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Card } from "./api";
import { HealthBar } from "./HealthBar";
import { AppBoard, PipelineBoard } from "./Board";
import { JobDrawer } from "./JobDrawer";
import { Batches } from "./Batches";

type View = "pipeline" | "applications" | "batches";

export function App() {
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || "pipeline");
  const [jobs, setJobs] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
        </div>
      )}

      <main className="content">
        {error && <div className="banner error">API not reachable: {error}. Start it with <code>node api/src/server.ts</code>.</div>}
        {!jobs && !error && <div className="muted pad">Loading…</div>}
        {jobs && view === "pipeline" && <PipelineBoard jobs={shown} showSkipped={showSkipped} onOpen={setOpen} />}
        {jobs && view === "applications" && <AppBoard jobs={shown} onOpen={setOpen} onChanged={load} />}
        {view === "batches" && <Batches onOpen={setOpen} onChanged={load} />}
      </main>

      {open && <JobDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

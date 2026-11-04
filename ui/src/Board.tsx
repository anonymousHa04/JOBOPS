import { useState } from "react";
import { api, APP_LABEL, APP_STATUSES, bandClass, STATE_LABEL } from "./api";
import type { AppStatus, Card, Pipeline } from "./api";

const PIPELINE: Pipeline[] = ["new", "parsing", "parsed", "scoring", "to_tailor", "tailoring", "tailored", "not_tailored", "failed", "skipped"];

function JobCard({ job, onOpen, draggable }: { job: Card; onOpen: (id: string) => void; draggable?: boolean }) {
  return (
    <div
      className={`card state-${job.state}`}
      onClick={() => onOpen(job.id)}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData("text/job", job.id); e.dataTransfer.effectAllowed = "move"; }}
    >
      <div className="card-title">{job.title}</div>
      <div className="card-sub">{job.company}{job.location ? ` · ${job.location}` : ""}</div>
      <div className="card-meta">
        {job.score !== null && <span className={`score-pill ${bandClass(job.band)}`}>{job.score.toFixed(1)}</span>}
        {job.decision && <span className="chip">{job.decision.replace("_", " ")}</span>}
        {job.state === "failed" && <span className="chip danger">{job.failed_stage}: {job.error_code ?? "failed"}</span>}
        {job.state === "skipped" && job.skip_reason && <span className="chip muted-chip">{job.skip_reason}</span>}
        {job.application && <span className="chip accent">{APP_LABEL[job.application]}</span>}
        {job.open_tasks > 0 && <span className="chip">☐ {job.open_tasks}</span>}
      </div>
    </div>
  );
}

export function PipelineBoard({ jobs, showSkipped, onOpen }: { jobs: Card[]; showSkipped: boolean; onOpen: (id: string) => void }) {
  // Parsing and Tailoring appear only while they hold jobs; Skipped only when asked for.
  const cols = PIPELINE.filter((p) => p !== "skipped" || showSkipped);
  return (
    <div className="board">
      {cols.map((p) => {
        const list = jobs.filter((j) => j.state === p).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        if ((p === "parsing" || p === "tailoring") && !list.length) return null;
        return (
          <section className={`column col-${p}`} key={p}>
            <header className="col-head"><span>{STATE_LABEL[p]}</span><span className="count">{list.length}</span></header>
            <div className="col-body">
              {list.map((j) => <JobCard key={j.id} job={j} onOpen={onOpen} />)}
              {!list.length && <div className="empty">Nothing here</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// The tracker: drag cards between your own statuses.
export function AppBoard({ jobs, onOpen, onChanged }: { jobs: Card[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [over, setOver] = useState<AppStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tracked = jobs.filter((j) => j.application);

  const drop = async (status: AppStatus, id: string) => {
    setOver(null);
    try { await api.setApplication(id, status); onChanged(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      {!tracked.length && (
        <div className="banner">No tracked jobs yet. Open a job on the Pipeline board and choose “Track” to add it here.</div>
      )}
      <div className="board">
        {APP_STATUSES.map((s) => {
          const list = tracked.filter((j) => j.application === s);
          return (
            <section
              key={s}
              className={`column app-col ${over === s ? "drop" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(s); }}
              onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/job"); if (id) void drop(s, id); }}
            >
              <header className="col-head"><span>{APP_LABEL[s]}</span><span className="count">{list.length}</span></header>
              <div className="col-body">
                {list.map((j) => <JobCard key={j.id} job={j} onOpen={onOpen} draggable />)}
                {!list.length && <div className="empty">Drop here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

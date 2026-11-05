import { useState } from "react";
import { api, APP_LABEL, APP_STATUSES, bandClass, STATE_LABEL } from "./api";
import type { Tab } from "./JobDrawer";
import type { AppStatus, Card, Pipeline } from "./api";

const PIPELINE: Pipeline[] = ["new", "parsing", "parsed", "scoring", "to_tailor", "tailoring", "tailored", "not_tailored", "failed", "skipped"];

// Columns whose cards can be ticked for "Delete N selected" (top bar).
export const SELECTABLE: Pipeline[] = ["tailored", "not_tailored", "skipped"];

function JobCard({ job, onOpen, draggable, selected, onToggle }: {
  job: Card; onOpen: (id: string) => void; draggable?: boolean; selected?: boolean; onToggle?: (id: string) => void;
}) {
  return (
    <div
      className={`card state-${job.state}${selected ? " selected" : ""}`}
      onClick={() => onOpen(job.id)}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData("text/job", job.id); e.dataTransfer.effectAllowed = "move"; }}
    >
      <div className="card-title">
        {onToggle && (
          <input type="checkbox" className="card-check" checked={!!selected} title="Tick to delete with others (top bar)"
            onClick={(e) => e.stopPropagation()} onChange={() => onToggle(job.id)} />
        )}
        {job.title}
      </div>
      <div className="card-sub">{job.company}{job.location ? ` · ${job.location}` : ""}</div>
      <div className="card-meta">
        {job.score !== null && <span className={`score-pill ${bandClass(job.band)}`}>{job.score.toFixed(1)}</span>}
        {job.ready_to_tailor
          ? <span className="chip accent" title="Re-scored to 75 or more: open it to tailor (Overview or Gaps)">re-scored 75+</span>
          : job.decision && <span className="chip">{job.decision.replace("_", " ")}</span>}
        {job.state === "failed" && <span className="chip danger">{job.failed_stage}: {job.error_code ?? "failed"}</span>}
        {job.state === "skipped" && job.skip_reason && <span className="chip muted-chip">{job.skip_reason}</span>}
        {job.application && <span className="chip accent">{APP_LABEL[job.application]}</span>}
        {job.open_tasks > 0 && <span className="chip">☐ {job.open_tasks}</span>}
      </div>
    </div>
  );
}

export function PipelineBoard({ jobs, showSkipped, onOpen, selected, onSelect }: {
  jobs: Card[]; showSkipped: boolean; onOpen: (id: string) => void;
  selected: Set<string>; onSelect: (ids: string[], on: boolean) => void;
}) {
  // Parsing and Tailoring appear only while they hold jobs; Skipped only when asked for.
  const cols = PIPELINE.filter((p) => p !== "skipped" || showSkipped);
  return (
    <div className="board">
      {cols.map((p) => {
        const list = jobs.filter((j) => j.state === p).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        if ((p === "parsing" || p === "tailoring") && !list.length) return null;
        return (
          <section className={`column col-${p}`} key={p}>
            <header className="col-head">
              <span>
                {SELECTABLE.includes(p) && list.length > 0 && (
                  <input type="checkbox" className="card-check" title="Tick every job in this column"
                    checked={list.every((j) => selected.has(j.id))} onChange={(e) => onSelect(list.map((j) => j.id), e.target.checked)} />
                )}
                {STATE_LABEL[p]}
              </span>
              <span className="count">{list.length}</span>
            </header>
            <div className="col-body">
              {list.map((j) => (
                <JobCard key={j.id} job={j} onOpen={onOpen}
                  {...(SELECTABLE.includes(p) ? { selected: selected.has(j.id), onToggle: (id: string) => onSelect([id], !selected.has(id)) } : {})} />
              ))}
              {!list.length && <div className="empty">Nothing here</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// The tracker: drag cards between your own statuses.
export function AppBoard({ jobs, onOpen, onChanged }: { jobs: Card[]; onOpen: (id: string, tab?: Tab) => void; onChanged: () => void }) {
  const [over, setOver] = useState<AppStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tracked = jobs.filter((j) => j.application);

  const drop = async (status: AppStatus, id: string) => {
    setOver(null);
    try {
      await api.setApplication(id, status);
      onChanged();
      if (status === "interested") onOpen(id, "gaps"); // fill the job's gaps right away
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      {!tracked.length && (
        <div className="banner">No tracked jobs yet. Open a job on the Pipeline board and choose “Track”. Drop a job into Interested to fill its gaps.</div>
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

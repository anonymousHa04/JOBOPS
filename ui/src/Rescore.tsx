import { useEffect, useRef, useState } from "react";
import { api, bandClass } from "./api";
import { onChange } from "./events";
import type { ScoreDetail } from "./api";

export function RescoreBar({ id, watch, onDone }: { id: string; watch: number | null; onDone: () => void }) {
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const beforeRef = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null); // the 10-minute give-up
  const unfollow = useRef<(() => void) | null>(null); // stop listening to the change feed

  const loadScore = () => api.score(id).then(setScore).catch(() => setScore(null));

  useEffect(() => {
    loadScore();
  }, [id]);

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      unfollow.current?.();
    };
  }, []);

  // No polling: the job's tasks are read once now and again on each change-feed event for this
  // job; it gives up after 10 minutes.
  const follow = (batch: number) => {
    unfollow.current?.();
    let over = false;
    const stop = () => {
      over = true;
      unfollow.current?.();
      unfollow.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const poll = () => {
      if (over) return;
      api.job(id)
        .then((detail) => {
          const tasks = detail.tasks;
          const mine = batch > 0 ? tasks.filter((t) => t.batch_id === batch) : tasks.filter((t) => (t.stage === "score" || t.stage === "tailor") && (t.state === "queued" || t.state === "leased"));
          const scoreTask = mine.find((t) => t.stage === "score");
          const tailorTask = mine.find((t) => t.stage === "tailor");

          if (scoreTask?.state === "failed") {
            stop();
            setStatus("Re-score failed: " + (scoreTask.error_code ?? "error"));
            setBusy(false);
            return;
          }

          if ((batch === 0 && mine.length === 0) || (scoreTask?.state === "done" && (!tailorTask || tailorTask.state === "done" || tailorTask.state === "failed"))) {
            stop();
            finish();
            return;
          }

          if (tailorTask && (tailorTask.state === "queued" || tailorTask.state === "leased")) {
            setStatus("Scored; tailoring on the Mac…");
          } else if (scoreTask && scoreTask.state === "leased") {
            setStatus("Scoring on the laptop…");
          } else {
            setStatus("Queued…");
          }
        })
        .catch((e: Error) => {
          stop();
          setStatus("Lost the API: " + e.message);
          setBusy(false);
        });
    };

    unfollow.current = onChange((c) => { if (c.kind === "resync" || c.job_id === id) poll(); });
    timer.current = setTimeout(() => {
      stop();
      setStatus("Still running after 10 minutes: check the Batches tab.");
      setBusy(false);
    }, 10 * 60_000);
    poll();
  };

  const finish = () => {
    api.score(id).then((s) => {
      setScore(s);
      setStatus(beforeRef.current !== null ? `Score ${beforeRef.current.toFixed(1)} → ${s.score.toFixed(1)} (${s.band})` : `Score ${s.score.toFixed(1)} (${s.band})`);
    }).catch(() => {
      setScore(null);
      setStatus("Failed to fetch updated score.");
    }).finally(() => {
      setBusy(false);
      onDone();
    });
  };

  useEffect(() => {
    if (watch && watch > 0) {
      beforeRef.current = score?.score ?? null;
      setBusy(true);
      setStatus("Queued…");
      follow(watch);
    }
  }, [watch]);

  const start = () => {
    beforeRef.current = score?.score ?? null;
    setBusy(true);
    setStatus("Queued…");
    api.rescore(id).then((r) => follow(r.rescore_batch)).catch((e: Error) => {
      setStatus("Could not re-score: " + e.message);
      setBusy(false);
    });
  };

  return (
    <div className="rescore-bar">
      <span>Current score: </span>
      {score ? (
        <span className={"score-pill " + bandClass(score.band)}>{score.score.toFixed(1)}</span>
      ) : (
        <span className="muted">not scored</span>
      )}
      <span className="muted"> {score?.band}</span>
      <button className="btn tiny" disabled={busy} onClick={start} title="Score this job again with your current bank (judge on the laptop). Tailoring waits for Tailor now.">
        {busy ? "Re-scoring…" : "Re-score now"}
      </button>
      {status && <span className="muted small">{status}</span>}
    </div>
  );
}

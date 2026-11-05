import { useEffect, useRef, useState } from "react";
import { api, bandClass } from "./api";
import type { ScoreDetail } from "./api";

export function RescoreBar({ id, watch, onDone }: { id: string; watch: number | null; onDone: () => void }) {
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const beforeRef = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadScore = () => api.score(id).then(setScore).catch(() => setScore(null));

  useEffect(() => {
    loadScore();
  }, [id]);

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  const follow = (batch: number) => {
    let attempts = 0;
    const poll = () => {
      api.job(id)
        .then((detail) => {
          const tasks = detail.tasks;
          const mine = batch > 0 ? tasks.filter((t) => t.batch_id === batch) : tasks.filter((t) => (t.stage === "score" || t.stage === "tailor") && (t.state === "queued" || t.state === "leased"));
          const scoreTask = mine.find((t) => t.stage === "score");
          const tailorTask = mine.find((t) => t.stage === "tailor");

          if (scoreTask?.state === "failed") {
            setStatus("Re-score failed: " + (scoreTask.error_code ?? "error"));
            setBusy(false);
            return;
          }

          if ((batch === 0 && mine.length === 0) || (scoreTask?.state === "done" && (!tailorTask || tailorTask.state === "done" || tailorTask.state === "failed"))) {
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

          attempts++;
          if (attempts < 200) {
            timer.current = setTimeout(poll, 3000);
          } else {
            setStatus("Still running after 10 minutes: check the Batches tab.");
            setBusy(false);
          }
        })
        .catch((e: Error) => {
          setStatus("Lost the API: " + e.message);
          setBusy(false);
        });
    };

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
      <button className="btn tiny" disabled={busy} onClick={start} title="Score this job again with your current bank (judge on the laptop); tailoring follows if the score allows it.">
        {busy ? "Re-scoring…" : "Re-score now"}
      </button>
      {status && <span className="muted small">{status}</span>}
    </div>
  );
}

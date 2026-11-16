// The API's change feed (GET /api/ui/events, Server-Sent Events), one connection per tab.
// A change names what changed (job_id, batch_id, stage, state); components re-read only that.
// "resync" comes on every (re)connect: events may have been missed, so reload once.
export type Change = {
  seq?: number;
  kind: "task" | "batch" | "job" | "filter" | "api" | "resync";
  job_id?: string; batch_id?: number; stage?: string; state?: string;
};

type Listener = (c: Change) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function emit(c: Change) {
  for (const fn of [...listeners]) {
    try { fn(c); } catch (e) { console.error(e); }
  }
}

function connect() {
  if (source) return;
  source = new EventSource("/api/ui/events");
  source.addEventListener("ready", () => emit({ kind: "resync" }));
  source.addEventListener("change", (e) => {
    try { emit(JSON.parse((e as MessageEvent).data) as Change); } catch { /* not JSON */ }
  });
  // EventSource reconnects on its own (retry: 3 s); the next "ready" resyncs.
}

export function onChange(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

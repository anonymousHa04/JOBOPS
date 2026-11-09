// The API's change feed for the UI (GET /ui/events). Two sources:
// - the queue's feed (task queued, leased, done, failed; batches; forgets), relayed as is;
// - the API's own writes (a job added, deleted, kept, a gap answered, an application moved).
// An event says what changed (kind, job_id, ...), not the new data: the UI reads that one card
// or panel again. "resync" means events may have been missed: reload everything once.
import { EventEmitter } from "node:events";
import { followSse, QUEUE_EVENTS } from "./sse.ts";
import { queueUrl } from "../queue/client.ts";
import { event as logEvent, warnEvent } from "../log.ts";

export type Change = {
  kind: "task" | "batch" | "job" | "filter" | "api" | "resync";
  job_id?: string; batch_id?: number; stage?: string; state?: string;
};

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open browser tab
let seq = 0;

export function publish(c: Change): void {
  seq++;
  bus.emit("change", { seq, ...c });
}

export function subscribe(fn: (c: Change & { seq: number }) => void): () => void {
  bus.on("change", fn);
  return () => bus.off("change", fn);
}

// Relay the queue's feed (server.ts starts it; tests do not). Each (re)connect is a "ready":
// events from while it was down were missed, so the UI resyncs once.
export function startQueueRelay(signal?: AbortSignal): void {
  let down = false;
  followSse(`${queueUrl()}/events`, QUEUE_EVENTS, (name, data) => {
    if (name === "ready") {
      if (down) logEvent("queue events: connected again");
      down = false;
      publish({ kind: "resync" });
      return;
    }
    const kind = data.kind as Change["kind"];
    if (!["task", "batch", "job", "filter"].includes(kind)) return;
    publish({
      kind,
      job_id: typeof data.job_id === "string" ? data.job_id : undefined,
      batch_id: typeof data.batch_id === "number" ? data.batch_id : undefined,
      stage: typeof data.stage === "string" ? data.stage : undefined,
      state: typeof data.state === "string" ? data.state : undefined
    });
  }, {
    signal,
    onDown: (why) => {
      if (!down) warnEvent(`queue events: not connected (${why}); retrying`);
      down = true;
    }
  });
}

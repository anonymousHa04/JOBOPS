// Follow the queue's event stream (GET /events) with the eventsource package (the browser's
// EventSource, for Node). It parses events (several data: lines included) and reconnects after
// a drop on its own, waiting the server's retry time (3 s). "ready" comes on every (re)connect,
// so the caller reloads once.
import { EventSource } from "eventsource";

export type SseHandler = (event: string, data: Record<string, unknown>) => void;

// The event names the queue sends (events.Event Kind, plus "ready" on connect).
export const QUEUE_EVENTS = ["ready", "task", "batch", "job", "filter"];

export function followSse(url: string, names: string[], onEvent: SseHandler,
  opts: { signal?: AbortSignal; onDown?: (why: string) => void } = {}): void {
  if (opts.signal?.aborted) return;
  const es = new EventSource(url);
  for (const name of names) {
    es.addEventListener(name, (e) => {
      try {
        onEvent(name, JSON.parse(e.data));
      } catch {
        // not JSON: ignore it
      }
    });
  }
  es.onerror = (e) => {
    opts.onDown?.(e.message ?? "connection lost");
    // A refused answer (not 200, or not an event stream) closes it for good: start again in 5 s.
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => followSse(url, names, onEvent, opts), 5000).unref();
    }
  };
  opts.signal?.addEventListener("abort", () => es.close(), { once: true });
}

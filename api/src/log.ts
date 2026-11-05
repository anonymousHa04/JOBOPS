// Readable log lines for the server (bin/jobops watch, bin/jobops logs api). Fastify's logger
// (pino) writes JSON; lineStream turns each record into one line in the Go services' style:
//   2026/11/05 19:41:41 POST /ui/skip-matches/delete 200 132 ms
//   2026/11/05 19:41:41 jobs deleted (skip words): 60; 2 tailored resumes removed
// event() is how library code (delete, gaps, keep) reports what it changed. It prints only in
// the server (buildApp with logger on); tests and the CLI stay quiet. Lines carry ids, titles,
// counts and JD wording only: never resume text, stories or contact details.
import { Writable } from "node:stream";

const LEVEL: Record<number, string> = { 10: "TRACE ", 20: "DEBUG ", 30: "", 40: "WARN ", 50: "ERROR ", 60: "FATAL " };
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

export function formatRecord(line: string): string {
  let r: { level?: number; time?: number; msg?: string; err?: { message?: string; stack?: string } };
  try {
    r = JSON.parse(line) as typeof r;
  } catch {
    return line; // not a pino record: print as is
  }
  const err = r.err ? ` (${r.err.stack ?? r.err.message ?? ""})` : "";
  return `${stamp(r.time ?? Date.now())} ${LEVEL[r.level ?? 30] ?? ""}${r.msg ?? ""}${err}`;
}

export const lineStream = new Writable({
  write(chunk: Buffer, _enc, done) {
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) process.stdout.write(formatRecord(line) + "\n");
    done();
  }
});

type Sink = { info: (msg: string) => void; warn: (msg: string) => void };
let sink: Sink | null = null;
export function setEventSink(s: Sink | null): void {
  sink = s;
}

// One line about something that changed (a delete, an answer, a task queued).
export function event(msg: string): void {
  sink?.info(msg);
}
export function warnEvent(msg: string): void {
  sink?.warn(msg);
}

// Short labels for log lines.
export const shortId = (id: string) => id.slice(0, 8);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "Check with Claude after each tailor" (Check tab switch): while a JobOps page is open, a tailor
// task that made a resume starts a check of that job in the extension, in a new chat. One check
// at a time (the extension runs one): later ones wait in line. With several JobOps tabs open, a
// mark in localStorage lets only one of them start each check.
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CheckSettings } from "./api";
import { onChange } from "./events";
import { extBusy, extReady, onExt, startCheck } from "./extension";

export function AutoCheck() {
  const [settings, setSettings] = useState<CheckSettings | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const waiting = useRef<string[]>([]);
  const sref = useRef<CheckSettings | null>(null);
  sref.current = settings;

  const next = () => {
    const s = sref.current;
    if (!s?.auto_check || !extReady() || extBusy() || !waiting.current.length) return;
    const jobId = waiting.current.shift()!;
    startCheck(jobId, s.source, true);
    setNote(`Auto-check: ${s.source === "claude" ? "Claude" : "ChatGPT"} is checking a newly tailored resume` + (waiting.current.length ? ` (${waiting.current.length} more waiting)` : ""));
  };

  useEffect(() => {
    api.checkSettings().then(setSettings).catch(() => setSettings(null));
    const offExt = onExt(() => { if (!extBusy()) { setNote(null); next(); } });
    const offFeed = onChange((c) => {
      if (c.kind === "api" && !c.job_id) return;
      // The switch may change in another tab: read it again on a resync.
      if (c.kind === "resync") { api.checkSettings().then(setSettings).catch(() => undefined); return; }
      if (c.kind !== "task" || c.stage !== "tailor" || c.state !== "done" || !c.job_id || !sref.current?.auto_check) return;
      const jobId = c.job_id;
      api.job(jobId).then((d) => {
        const t = [...d.tasks].reverse().find((x) => x.stage === "tailor" && x.state === "done");
        const r = (t?.result ?? {}) as { resume_id?: string | null; decision?: string; created?: boolean };
        // Only a tailor that made a new resume (a run that picked an existing one adds nothing new).
        if (!t || !r.resume_id || r.decision === "not_tailored" || r.created === false) return;
        const mark = `jobops:autocheck:${jobId}:${t.updated_at}`;
        if (localStorage.getItem(mark)) return; // another JobOps tab started it
        localStorage.setItem(mark, String(Date.now()));
        if (!waiting.current.includes(jobId)) waiting.current.push(jobId);
        next();
      }).catch(() => undefined);
    });
    return () => { offExt(); offFeed(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Turned on or off in the Check tab (same page): the tab posts a window event.
  useEffect(() => {
    const on = (e: Event) => setSettings((e as CustomEvent<CheckSettings>).detail);
    window.addEventListener("jobops:check-settings", on);
    return () => window.removeEventListener("jobops:check-settings", on);
  }, []);

  return note ? <span className="muted small">{note}</span> : null;
}

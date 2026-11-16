// The JobOps Chrome extension's bridge (extension/jobops.js) on this page: one listener for the
// whole app. The Check tab and the auto-check after tailoring both use it.
import { useEffect, useState } from "react";

export type ExtStatus = { jobId?: string; target?: string; step?: string; round?: number; error?: string; at?: string };
type Listener = () => void;

let ready = false;
let status: ExtStatus | null = null;
const listeners = new Set<Listener>();
let started = false;

function connect() {
  if (started) return;
  started = true;
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window || e.data?.from !== "jobops-extension") return;
    if (e.data.type === "ready") ready = true;
    if (e.data.type === "status") status = e.data.status as ExtStatus;
    for (const fn of [...listeners]) fn();
  });
  window.postMessage({ from: "jobops-ui", type: "ping" }, location.origin);
}

export function onExt(fn: Listener): () => void {
  connect();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const extReady = () => ready;
export const extStatus = () => status;
// A check is running in the extension (one at a time).
export const extBusy = () => !!status && !!status.step && !["done", "failed", "saved"].includes(status.step);

// newChat: start a new conversation (after a choice, or a new tailored resume: the old chat's
// history no longer matches your resume).
export function startCheck(jobId: string, target: "claude" | "chatgpt", newChat: boolean) {
  window.postMessage({ from: "jobops-ui", type: "check", jobId, target, newChat }, location.origin);
}

export function useExtension() {
  const [, bump] = useState(0);
  useEffect(() => onExt(() => bump((n) => n + 1)), []);
  return { ready: extReady(), status: extStatus(), start: startCheck };
}

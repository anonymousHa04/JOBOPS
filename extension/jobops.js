// Bridge between the JobOps web UI (127.0.0.1:8080, or the Vite dev UI) and this extension, so
// the job drawer's "Check with Claude" button can start a report run without the popup.
// The page posts { from: "jobops-ui", type: "check", jobId, target }; the bridge passes it to
// the background worker as a "run" message, says it is installed ("ready"), and forwards the
// run's status steps (prompt, chat, waiting, saving, fixing, asking, done, failed) to the page.
const ORIGIN = window.location.origin;
const post = (msg) => window.postMessage({ from: "jobops-extension", ...msg }, ORIGIN);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== ORIGIN) return;
  const m = event.data;
  if (!m || m.from !== "jobops-ui") return;
  if (m.type === "ping") post({ type: "ready" });
  if (m.type === "check") {
    if (typeof m.jobId !== "string" || !m.jobId || (m.target !== "claude" && m.target !== "chatgpt")) {
      post({ type: "status", status: { jobId: m.jobId, target: m.target, step: "failed", error: "bad request" } });
      return;
    }
    chrome.runtime.sendMessage({ type: "run", jobId: m.jobId, target: m.target, newChat: m.newChat === true });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.status) post({ type: "status", status: changes.status.newValue });
});

post({ type: "ready" });

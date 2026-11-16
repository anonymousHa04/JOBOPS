// Browser errors to the api log (POST /ui/client-log), so bin/jobops watch shows them next to
// the requests. Uncaught errors and unhandled promise rejections only (a failed API call is
// already logged by the API). At most 10 a minute, the same message once a minute; a failure
// to send is dropped (never reported again, so it cannot loop).
const seen = new Map<string, number>();
let sentThisMinute = 0;
let minute = 0;

function send(message: string, where: string): void {
  const now = Date.now();
  if (Math.floor(now / 60000) !== minute) { minute = Math.floor(now / 60000); sentThisMinute = 0; }
  const key = message.slice(0, 200);
  if ((seen.get(key) ?? 0) > now - 60000 || sentThisMinute >= 10) return;
  seen.set(key, now);
  sentThisMinute++;
  void fetch("/api/ui/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: message.slice(0, 2000), where: where.slice(0, 300) })
  }).catch(() => undefined);
}

export function reportClientErrors(): void {
  window.addEventListener("error", (e) => {
    const where = e.filename ? `${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : location.hash || "page";
    send(e.error instanceof Error ? `${e.error.name}: ${e.error.message}` : String(e.message), where);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as unknown;
    if (r instanceof Error && r.name === "ApiError") return; // the API logged it already
    send(r instanceof Error ? `${r.name}: ${r.message}` : `unhandled rejection: ${String(r)}`, location.hash || "page");
  });
}

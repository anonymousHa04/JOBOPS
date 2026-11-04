import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Service } from "./api";

// Dots for each service; click for details and the command that starts a stopped one.
export function HealthBar() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [down, setDown] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => api.health().then((s) => { setServices(s); setDown(false); }).catch(() => setDown(true));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const bad = services?.filter((s) => s.up === false).length ?? 0;
  return (
    <div className="health" ref={ref}>
      <button className="health-btn" onClick={() => setOpen(!open)} title="Service health">
        {down ? <span className="dot down" /> : (services ?? []).map((s) => <span key={s.name} className={`dot ${s.up === null ? "off" : s.up ? "up" : "down"}`} title={s.name} />)}
        <span className="health-label">{down ? "API down" : !services ? "Checking…" : bad ? `${bad} down` : "All up"}</span>
      </button>
      {open && (
        <div className="popover">
          {down && <div className="svc"><span className="dot down" /><div><b>api</b><div className="muted">not reachable</div><code>node api/src/server.ts</code></div></div>}
          {services?.map((s) => (
            <div className="svc" key={s.name}>
              <span className={`dot ${s.up === null ? "off" : s.up ? "up" : "down"}`} />
              <div>
                <b>{s.name}</b> <span className="muted">{s.role}</span>
                <div className="muted">{s.detail}</div>
                {s.up === false && <code className="copyable" onClick={() => navigator.clipboard.writeText(s.start)} title="Click to copy">{s.start}</code>}
              </div>
            </div>
          ))}
          <div className="muted small">Everything at once: <code>.claude/bin/batch-up.sh</code></div>
        </div>
      )}
    </div>
  );
}

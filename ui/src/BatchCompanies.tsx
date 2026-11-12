import { useMemo, useState } from "react";
import { api } from "./api";
import type { BatchCompany } from "./api";

const STATUSES = ["fetched", "unreachable", "no_slug", "excluded"] as const;
const BOARDS = ["auto", "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "careers"];

type SortKey = "name" | "board" | "slug" | "status" | "postings" | "matched" | "created";
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Company" },
  { key: "board", label: "Board" },
  { key: "slug", label: "Slug" },
  { key: "status", label: "Status" },
  { key: "postings", label: "Postings" },
  { key: "matched", label: "Matched" },
  { key: "created", label: "Added" },
];

// What the user typed for one company: a new slug, a board, and whether Edit was clicked.
type Draft = { slug?: string; ats?: string; edit?: boolean };
type Result = { kind: "error" | "ok"; text: string };

const statusChip = (s: BatchCompany["status"]) =>
  s === "unreachable" ? "chip danger" : s === "fetched" ? "chip accent" : "chip muted-chip";
const defaultBoard = (r: BatchCompany) => (BOARDS.includes(r.board) ? r.board : "auto");

// Every preferred company of a batch and how its search went, with a retry per company.
export function BatchCompanies({ batchId, rows, onChanged }: { batchId: number; rows: BatchCompany[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<string>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, Result>>({});

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  // Sorted only by the header click: drafts are not an input, so typing keeps the order.
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = a[key], y = b[key];
      const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return d * dir;
    });
  }, [rows, sort]);
  const shown = filter === "all" ? sorted : sorted.filter((r) => r.status === filter);

  const clickHeader = (key: SortKey) =>
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const setDraft = (name: string, d: Draft) => setDrafts((all) => ({ ...all, [name]: { ...all[name], ...d } }));
  const editable = (r: BatchCompany) => r.status === "unreachable" || r.status === "no_slug" || !!drafts[r.name]?.edit;

  const retry = async (r: BatchCompany) => {
    const d = drafts[r.name] ?? {};
    const slug = d.slug?.trim();
    const body: { name: string; slug?: string; ats?: string } = { name: r.name };
    if (slug) body.slug = slug;
    if (editable(r)) body.ats = d.ats ?? defaultBoard(r);
    setRunning((m) => ({ ...m, [r.name]: true }));
    setResults((m) => { const n = { ...m }; delete n[r.name]; return n; });
    try {
      const { company, saved } = await api.retryCompany(batchId, body);
      let res: Result;
      if (company.status === "fetched") {
        res = { kind: "ok", text: saved.length > 0 ? "fetched, saved to preferences" : "fetched" };
      } else {
        res = { kind: "error", text: `${company.status}, not saved: ${company.error || "no postings"}` };
      }
      setResults((m) => ({ ...m, [r.name]: res }));
    } catch (e) {
      setResults((m) => ({ ...m, [r.name]: { kind: "error", text: (e as Error).message } }));
    } finally {
      setRunning((m) => { const n = { ...m }; delete n[r.name]; return n; });
    }
    onChanged();
  };

  return (
    <div className="panel">
      <div className="row spread">
        <div className="row">
          <h4>Companies</h4>
          {STATUSES.map((s) => <span key={s} className={statusChip(s)}>{s} {counts[s] ?? 0}</span>)}
        </div>
        <label className="field inline"><span>Status</span>
          <select aria-label="Filter companies by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">all</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <table className="tasks">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                <button type="button" className="btn ghost tiny" onClick={() => clickHeader(c.key)}>
                  {c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const d = drafts[r.name] ?? {};
            const busy = !!running[r.name];
            const res = results[r.name];
            return (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td>{r.board}</td>
                <td>
                  {editable(r) ? (
                    <div className="row">
                      <input aria-label={`Slug for ${r.name}`} className="mono" value={d.slug ?? r.slug}
                        onChange={(e) => setDraft(r.name, { slug: e.target.value })} />
                      <select aria-label={`Board for ${r.name}`} value={d.ats ?? defaultBoard(r)}
                        onChange={(e) => setDraft(r.name, { ats: e.target.value })}>
                        {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                    </div>
                  ) : (
                    <span className="mono">{r.slug}</span>
                  )}
                </td>
                <td>
                  <span className={statusChip(r.status)}>{r.status}</span>
                  {r.status === "unreachable" && r.error && <div className="muted small">{r.error}</div>}
                </td>
                <td>{r.postings}</td>
                <td>
                  {r.matched}
                  {r.titles && r.titles.length > 0 && (
                    <details>
                      <summary className="small">titles</summary>
                      <ul className="small">{r.titles.map((t, i) => <li key={i}>{t}</li>)}</ul>
                    </details>
                  )}
                </td>
                <td>{r.created}</td>
                <td>
                  <div className="row">
                    {!editable(r) && (
                      <button type="button" className="btn tiny" onClick={() => setDraft(r.name, { edit: true })}>Edit</button>
                    )}
                    <button type="button" className="btn tiny" disabled={busy} onClick={() => retry(r)}>
                      {busy ? "Searching…" : "Retry"}
                    </button>
                  </div>
                  {res && <div className={`small ${res.kind === "error" ? "bad" : "muted"}`}>{res.text}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

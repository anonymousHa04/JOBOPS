// Top bar: "Added skills". Every skill you added from Gaps answers (skills-extra.yaml), with its
// evidence, and Remove for one you do not really have. Bank skills are not listed (they come
// from your roles). Removing does not re-score by itself: Rescore all lights up for that.
import { useState } from "react";
import { api, ApiError } from "./api";
import type { AddedSkill } from "./api";

export function AddedSkills({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<AddedSkill[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.addedSkills().then(setList).catch((e: Error) => setErr("Could not read your added skills: " + e.message));
  const show = () => { setOpen(true); setNote(null); setErr(null); setList(null); void load(); };

  const remove = (name: string) => {
    if (!window.confirm(`Remove "${name}" from your added skills? Resumes are made without it from the next tailor.`)) return;
    setBusy(name);
    setErr(null);
    api.removeSkill(name)
      .then(() => { setNote(`Removed "${name}". Click Rescore all so scores use it; re-tailor jobs whose resume listed it.`); onDone(); return load(); })
      .catch((e: Error) => setErr(`Could not remove "${name}": ` + e.message))
      .finally(() => setBusy(null));
  };

  // Edit evidence: your note plus ticked bullets that show the skill, checked by the same rule as
  // the resume check; a weak one is saved only after you confirm.
  const [edit, setEdit] = useState<{ name: string; note: string; ticked: string[]; bullets: { id: string; text: string }[] } | null>(null);
  const startEdit = (s: AddedSkill) => {
    const note = s.evidence.replace(/^answer \d{4}-\d{2}-\d{2}(?: \([^)]*\))?:\s*/, "").replace(/\s*\((?:bullet [a-z0-9-]+(?:; )?)+\)\s*$/, "");
    const linked = [...s.evidence.matchAll(/bullet ([a-z0-9-]+)/g)].map((m) => m[1]);
    setEdit({ name: s.name, note, ticked: [...new Set(linked)], bullets: [] });
    api.skillCandidates(s.name, linked).then((bullets) => setEdit((e) => (e && e.name === s.name ? { ...e, bullets } : e))).catch(() => undefined);
  };
  const saveEdit = (confirm_weak = false) => {
    if (!edit) return;
    setBusy("edit:" + edit.name);
    setErr(null);
    api.editSkillEvidence(edit.name, edit.note, edit.ticked, confirm_weak)
      .then((r) => { setNote(`Evidence for "${r.name}" saved${r.weak ? " (still not backed: it stays blocked on resumes)" : ""}. Re-tailor jobs that list it.`); setEdit(null); onDone(); return load(); })
      .catch((e: Error) => {
        const data = e instanceof ApiError ? (e.data as { error?: string; message?: string }) : null;
        if (data?.error === "weak_evidence" && !confirm_weak && window.confirm(`${data.message}\n\nSave anyway? It stays blocked on your resume until it is backed.`)) { saveEdit(true); return; }
        setErr(data?.message ?? e.message);
      })
      .finally(() => setBusy(null));
  };

  const have = (list ?? []).filter((s) => s.status === "have");
  return (
    <>
      <button className="btn ghost" disabled={open} onClick={show}
        title="The skills you added from Gaps answers, with their evidence; remove one you do not really have.">
        Added skills
      </button>
      {note && !open && <span className="muted small">{note}</span>}
      {open && (
        <div className="delete-panel skip-delete">
          {!list && !err && <div className="muted small">Loading…</div>}
          {list && (
            <>
              <h4>Your added skills ({have.length})</h4>
              <div className="muted small">
                Added from Gaps answers; your bank's own skills are not listed. Keep only what you can defend in an interview.
              </div>
              {!have.length && <div className="muted small">None yet.</div>}
              <ul className="skip-list">
                {have.map((s) => (
                  <li key={s.name}>
                    <b>{s.name}</b>{" "}
                    {s.kind && <span className="chip">{s.kind === "same" ? "same thing" : "related work"}</span>}
                    {s.bullets.length > 0 && <span className="muted small"> bullets: {s.bullets.join(", ")}</span>}
                    {" "}<button className="btn tiny danger" disabled={busy !== null} onClick={() => remove(s.name)}>
                      {busy === s.name ? "Removing…" : "Remove"}
                    </button>
                    {" "}<button className="btn tiny" disabled={busy !== null} onClick={() => startEdit(s)}>Edit evidence</button>
                    {s.evidence && edit?.name !== s.name && <div className="muted small">{s.evidence.length > 300 ? s.evidence.slice(0, 300) + "…" : s.evidence}</div>}
                    {edit?.name === s.name && (
                      <div className="roles">
                        <textarea rows={3} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                          placeholder="What you did with it, in your own words" />
                        {edit.bullets.length > 0 && <div className="muted small">Bullets that show it (tick the ones that are this work):</div>}
                        {edit.bullets.map((b) => (
                          <label key={b.id} className="role-check" title={b.text}>
                            <input type="checkbox" checked={edit.ticked.includes(b.id)}
                              onChange={() => setEdit({ ...edit, ticked: edit.ticked.includes(b.id) ? edit.ticked.filter((x) => x !== b.id) : [...edit.ticked, b.id] })} />
                            {" "}<code>{b.id}</code> <span className="muted small">{b.text.length > 110 ? b.text.slice(0, 110) + "…" : b.text}</span>
                          </label>
                        ))}
                        <div>
                          <button className="btn tiny accent" disabled={busy !== null || !edit.note.trim()} onClick={() => saveEdit()}>{busy === "edit:" + s.name ? "Saving…" : "Save evidence"}</button>
                          <button className="btn ghost tiny" onClick={() => setEdit(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {note && <div className="muted small">{note}</div>}
              <div><button className="btn ghost tiny" onClick={() => setOpen(false)}>Close</button></div>
            </>
          )}
          {err && <div className="banner error">{err}</div>}
          {err && !list && <div><button className="btn ghost tiny" onClick={() => setOpen(false)}>Close</button></div>}
        </div>
      )}
    </>
  );
}

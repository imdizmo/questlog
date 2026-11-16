import { useState } from 'react';
import { colors } from '../../../shared/schedule';
import type { Milestone, Project } from '../../../shared/types';
import { useStore } from '../store';
import { dispatch } from '../api';
import { Dialog } from './Dialog';

interface Props {
  /** Creating: the day picked on the calendar. */
  day?: string;
  /** Editing: the milestone (the whole record is sent back). */
  milestone?: Milestone;
  /** Projects the person may manage; only these are offered. */
  projects: Project[];
  /** Projects to tick at first (the ones in view on Decks). */
  initial: Set<string>;
  admin: boolean;
  onClose: () => void;
}

export function MilestoneDialog({ day, milestone, projects, initial, admin, onClose }: Props) {
  const editing = !!milestone;
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const [specific, setSpecific] = useState(milestone ? !milestone.isGlobal : true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(milestone
    ? milestone.projectIds.filter((id) => projects.some((p) => p.id === id))
    : projects.filter((p) => initial.has(p.id)).map((p) => p.id)));
  // Projects the milestone covers that this dialog doesn't offer (archived, say): saving must not drop them.
  const kept = milestone ? milestone.projectIds.filter((id) => !projects.some((p) => p.id === id)) : [];
  const [name, setName] = useState(milestone?.name ?? '');
  const [date, setDate] = useState(milestone?.date ?? day ?? '');
  const [color, setColor] = useState<string>(milestone?.color ?? 'green');
  // Cards on this milestone, per project (only when editing).
  const perProject = new Map<string, number>();
  let total = 0;
  if (milestone) {
    for (const c of cards.values()) {
      if (c.milestoneId !== milestone.id || c.visibility === 'deleted') continue;
      total++;
      const pid = c.deckId ? decks.get(c.deckId)?.projectId : undefined;
      if (pid) perProject.set(pid, (perProject.get(pid) ?? 0) + 1);
    }
  }
  const count = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
  const toggle = (id: string, on: boolean, only: boolean) => setPicked((s) => {
    if (only) return new Set([id]);
    const n = new Set(s);
    if (on) n.add(id); else n.delete(id);
    return n;
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError('Give the milestone a title.');
    if (!date) return setError('Pick a date.');
    if (specific && picked.size + kept.length === 0) return setError('Pick at least one project.');
    setBusy(true);
    try {
      const body = { name: name.trim(), date, startDate: milestone?.startDate ?? null, color, isGlobal: !specific, projectIds: specific ? [...picked, ...kept] : [] };
      if (milestone) await dispatch('milestones', 'update', { id: milestone.id, ...body });
      else await dispatch('milestones', 'create', body);
      onClose();
    } catch { /* toast already shown */ } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={editing ? 'Edit milestone' : 'New milestone'} onClose={onClose} onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{editing ? 'Save Milestone' : 'Create Milestone'}</button>
      </>}
    >
      {error && <p className="form-error" role="alert">{error}</p>}
      <label className="radio">
        <input type="checkbox" checked={specific} disabled={!admin} onChange={(e) => setSpecific(e.target.checked)} /> Is project-specific
      </label>
      {specific && (
        <fieldset>
          <legend>Projects</legend>
          <div className="inline-options">
            {projects.map((p) => (
              <label key={p.id} className="radio">
                <input
                  type="checkbox" checked={picked.has(p.id)}
                  onChange={(e) => {
                    const ev = e.nativeEvent as MouseEvent;
                    toggle(p.id, e.target.checked, !!(ev.ctrlKey || ev.metaKey));
                  }}
                /> {p.name}{editing && <small className="muted"> {count(perProject.get(p.id) ?? 0)}</small>}
              </label>
            ))}
          </div>
          <p className="hint">Ctrl + Click selects target project and deselects all others</p>
        </fieldset>
      )}
      {editing && !specific && <p className="hint">{count(total)} on this milestone</p>}
      <label className="field"><span>Title</span><input data-autofocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
      <div className="field-row">
        <label className="field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field">
          <span>Color</span>
          <select value={color} onChange={(e) => setColor(e.target.value)}>{colors.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
      </div>
    </Dialog>
  );
}

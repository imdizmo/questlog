import { useState } from 'react';
import { addDays, colors } from '../../../shared/schedule';
import type { Project } from '../../../shared/types';
import { dispatch } from '../api';
import { hourLabel } from '../planning';
import { Dialog } from './Dialog';

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
const UPCOMING = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
const MOVES: { key: 'review' | 'blocked' | 'undone'; label: string }[] = [
  { key: 'review', label: 'Tasks in review' }, { key: 'blocked', label: 'Blocked tasks' }, { key: 'undone', label: 'Unfinished tasks' },
];
const DRAFT_KEY = 'jt.runSetupDraft';

interface Draft {
  name: string; label: string; weeks: number; start: string; upcoming: number; endHour: number; color: string;
  move: string[]; specific: boolean; projectIds: string[];
}

const readDraft = (): Partial<Draft> => {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') ?? {}; } catch { return {}; }
};
const writeDraft = (d: Draft | null) => {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage may be unavailable */ }
};

interface Props { today: string; projects: Project[]; initial: Set<string>; admin: boolean; onClose: () => void }

export function RunSetupDialog({ today, projects, initial, admin, onClose }: Props) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [d, setD] = useState<Draft>(() => {
    const saved = readDraft();
    const manageable = new Set(projects.map((p) => p.id));
    // A saved project the person can no longer manage (or that is gone) must not stay ticked.
    const ids = Array.isArray(saved.projectIds) ? saved.projectIds.filter((id) => manageable.has(id)) : projects.filter((p) => initial.has(p.id)).map((p) => p.id);
    return {
      name: typeof saved.name === 'string' ? saved.name : '',
      label: typeof saved.label === 'string' ? saved.label : '',
      weeks: WEEKS.includes(saved.weeks as number) ? (saved.weeks as number) : 2,
      // A saved start date in the past is stale: start today instead.
      start: typeof saved.start === 'string' && saved.start >= today ? saved.start : today,
      upcoming: UPCOMING.includes(saved.upcoming as number) ? (saved.upcoming as number) : 2,
      endHour: typeof saved.endHour === 'number' && saved.endHour >= 1 && saved.endHour <= 24 ? saved.endHour : 24,
      color: colors.includes(saved.color as never) ? (saved.color as string) : 'blue',
      move: Array.isArray(saved.move) ? saved.move.filter((m) => MOVES.some((x) => x.key === m)) : [],
      specific: admin ? saved.specific !== false : true,
      projectIds: ids,
    };
  });
  const [errors, setErrors] = useState<{ name?: string; label?: string; start?: string; projects?: string }>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => { const n = { ...x, ...patch }; writeDraft(n); return n; });

  const submit = async () => {
    const e: typeof errors = {};
    if (!/^\p{L}{1,5}$/u.test(d.name.trim())) e.name = 'Use 1 to 5 letters.';
    if (!d.label.includes('%RUN_NR%')) e.label = 'Add at least one variable';
    if (!d.start) e.start = 'Pick a start date.';
    else if (d.start < addDays(today, -366)) e.start = 'Start date can be at most a year back.';
    if (d.specific && d.projectIds.length === 0) e.projects = 'Pick at least one project.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await dispatch('sprints', 'createConfig', {
        name: d.name.trim(), runLabelTemplate: d.label.trim(), color: d.color, upcomingSprints: d.upcoming, sprintDurationWeeks: d.weeks,
        sprintStartDate: d.start, moveOnFinish: d.move, projectIds: d.specific ? d.projectIds : [], isGlobal: !d.specific, endHour: d.endHour, endHourTimezone: tz,
      });
      writeDraft(null);
      onClose();
    } catch { /* toast already shown */ } finally { setBusy(false); }
  };

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <Dialog
      title="Set up Sprints" onClose={onClose} onSubmit={submit} scroll
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>Create Sprints</button>
      </>}
    >
      <label className="radio">
        <input type="checkbox" checked={d.specific} disabled={!admin} onChange={(e) => set({ specific: e.target.checked })} /> Is project-specific
      </label>
      {d.specific && (
        <fieldset>
          <legend>Projects</legend>
          <div className="inline-options">
            {projects.map((p) => (
              <label key={p.id} className="radio">
                <input type="checkbox" checked={d.projectIds.includes(p.id)} onChange={(e) => set({ projectIds: toggle(d.projectIds, p.id, e.target.checked) })} /> {p.name}
              </label>
            ))}
          </div>
          {errors.projects && <p className="form-error" role="alert">{errors.projects}</p>}
        </fieldset>
      )}
      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input value={d.name} maxLength={5} onChange={(e) => set({ name: e.target.value })} aria-invalid={!!errors.name} />
          {errors.name && <small className="field-error" role="alert">{errors.name}</small>}
        </label>
        <label className="field">
          <span>Color</span>
          <select value={d.color} onChange={(e) => set({ color: e.target.value })}>{colors.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
      </div>
      <label className="field">
        <span>Sprint label</span>
        <input value={d.label} maxLength={100} placeholder="Sprint %RUN_NR%" onChange={(e) => set({ label: e.target.value })} aria-invalid={!!errors.label} />
        {errors.label && <small className="field-error" role="alert">{errors.label}</small>}
        <small className="muted">%RUN_NR% becomes the sprint number.</small>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Duration (weeks)</span>
          <select value={d.weeks} onChange={(e) => set({ weeks: Number(e.target.value) })}>{WEEKS.map((w) => <option key={w} value={w}>{w}</option>)}</select>
        </label>
        <label className="field">
          <span>Start date</span>
          <input type="date" value={d.start} onChange={(e) => set({ start: e.target.value })} />
          {errors.start && <small className="field-error" role="alert">{errors.start}</small>}
        </label>
        <label className="field">
          <span>Upcoming sprints</span>
          <select value={d.upcoming} onChange={(e) => set({ upcoming: Number(e.target.value) })}>{UPCOMING.map((w) => <option key={w} value={w}>{w}</option>)}</select>
        </label>
        <label className="field">
          <span>Finish at</span>
          <select value={d.endHour} onChange={(e) => set({ endHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <small className="muted">{tz}</small>
        </label>
      </div>
      <fieldset>
        <legend>When a sprint finishes, move to the next sprint</legend>
        <div className="inline-options">
          {MOVES.map((m) => (
            <label key={m.key} className="switch-row">
              <span className="switch"><input type="checkbox" checked={d.move.includes(m.key)} onChange={(e) => set({ move: toggle(d.move, m.key, e.target.checked) })} /><span className="track" /></span>
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}

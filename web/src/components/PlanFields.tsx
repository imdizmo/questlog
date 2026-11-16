import { useMemo, useState } from 'react';
import type { Card, Project } from '../../../shared/types';
import { workdaysBetween } from '../../../shared/schedule';
import { settingsOf, useStore } from '../store';
import { useMinuteClock } from '../clock';
import { coversProject, dayMon, localToday } from '../planning';
import { PlanPicker, type PlanOption } from './PlanPicker';

interface Choice { id: string; label: string; title: string }

/**
 * Quick buttons for a card's milestone and run (the next two upcoming of each) plus Pick.
 * Hidden entirely when the feature is off, or for a card without a project or a doc.
 */
export function PlanFields({ card, project, editable, update, kind, compact }: {
  card: Card;
  project: Project | undefined;
  editable: boolean;
  update: (patch: object) => void;
  kind: 'milestone' | 'run';
  compact?: boolean;
}) {
  const s = useStore((x) => x);
  useMinuteClock();
  const today = localToday();
  const settings = settingsOf(s);
  const [picking, setPicking] = useState(false);
  const enabled = kind === 'milestone' ? settings.milestonesEnabled : settings.sprintsEnabled;
  const pid = project?.id;

  const { quick, all, currentId } = useMemo(() => {
    const none = { quick: [] as Choice[], all: [] as PlanOption[], currentId: null as string | null };
    if (!pid) return none;
    if (kind === 'milestone') {
      const list = [...s.milestones.values()].filter((m) => coversProject(m, pid))
        .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.accountSeq - b.accountSeq);
      const n = (d: string | null) => (d ? workdaysBetween(today, d, settings.workdays) : null);
      const choice = (m: typeof list[number]): Choice => {
        const w = n(m.date);
        return { id: m.id, label: w === null ? m.name : w >= 0 ? `${m.name} ${w}d` : `${m.name} ${dayMon(m.date!)}`, title: m.date ? `${m.name}, ${m.date}` : m.name };
      };
      const upcoming = list.filter((m) => !m.date || m.date >= today).slice(0, 2);
      const cur = card.milestoneId ? list.find((m) => m.id === card.milestoneId) : undefined;
      const shown = cur && !upcoming.includes(cur) ? [cur, ...upcoming] : upcoming;
      return { quick: shown.map(choice), all: list.map((m) => ({ id: m.id, label: m.name, detail: m.date ?? undefined })), currentId: card.milestoneId };
    }
    const cfgs = new Map([...s.sprintConfigs.values()].filter((c) => !c.isArchived && coversProject(c, pid)).map((c) => [c.id, c]));
    const list = [...s.sprints.values()].filter((r) => cfgs.has(r.configId) && !r.isFinished).sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr);
    const running = list.find((r) => r.startDay <= today && today <= r.endDay);
    const next = list.find((r) => r.startDay > today);
    const cur = card.sprintId ? s.sprints.get(card.sprintId) : undefined;
    const base = [running, next].filter((r): r is NonNullable<typeof r> => !!r);
    const shown = cur && !base.includes(cur) ? [cur, ...base] : base;
    const choice = (r: typeof list[number]): Choice => ({
      id: r.id, title: `${r.label}, ${r.startDay} to ${r.endDay}`,
      label: r.startDay <= today ? `${r.label} ${Math.max(0, workdaysBetween(today, r.endDay, settings.workdays))}d` : `${r.label} ${dayMon(r.startDay)}`,
    });
    return { quick: shown.map(choice), all: list.map((r) => ({ id: r.id, label: r.label, detail: `${dayMon(r.startDay)} to ${dayMon(r.endDay)}` })), currentId: card.sprintId };
  }, [s.milestones, s.sprints, s.sprintConfigs, pid, kind, today, settings.workdays, card.milestoneId, card.sprintId]);

  if (!enabled || !pid || card.isDoc) return null;
  const field = kind === 'milestone' ? 'milestoneId' : 'sprintId';
  const noun = kind === 'milestone' ? 'milestone' : 'sprint';
  const set = (id: string | null) => update({ [field]: id });
  const label = kind === 'milestone' ? 'Milestone' : 'Sprint';

  if (!editable) {
    const cur = quick.find((c) => c.id === currentId);
    return cur ? <span className="badge" title={cur.title}>{cur.label}</span> : <span className="muted">No {noun}</span>;
  }
  return (
    <div className={compact ? 'plan-row compact' : 'plan-row'} role="group" aria-label={label}>
      {quick.map((c) => {
        const on = c.id === currentId;
        return (
          <button key={c.id} type="button" className={`plan-btn${on ? ' on' : ''}`} aria-pressed={on} title={on ? `${c.title} (click to remove)` : c.title}
            onClick={() => set(on ? null : c.id)}>{c.label}</button>
        );
      })}
      <button type="button" className="btn btn-sm" aria-label={`Pick ${noun}`} onClick={() => setPicking(true)}>Pick</button>
      {picking && <PlanPicker title={`Pick ${noun}`} options={all} value={currentId} onPick={set} onClose={() => setPicking(false)} />}
    </div>
  );
}

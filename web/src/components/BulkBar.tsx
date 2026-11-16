import { useMemo, useState, type ReactNode } from 'react';
import type { Card, Priority } from '../../../shared/types';
import { dispatch } from '../api';
import { settingsOf, useStore } from '../store';
import { coversProject, dayMon } from '../planning';
import { clearSelection, toggleSelected, selectRange, toggleGroup, useSelection } from '../selection';
import { ConfirmDialog } from './ConfirmDialog';
import { DeckPicker } from './DeckPicker';
import { EffortField } from './EffortField';
import { eligibleOwners } from './OwnerPicker';
import { PlanPicker, type PlanOption } from './PlanPicker';
import { PriorityButtons } from './PriorityButtons';
import { Icon } from './icons';

/** The checkbox on a tile or row. Shift+click selects the range from the anchor in the visible order. */
export function SelectBox({ id, order, title }: { id: string; order: readonly string[]; title: string }) {
  const { selected } = useSelection();
  const on = selected.has(id);
  return (
    <button type="button" className="select-btn" aria-label={`Select ${title}`} aria-pressed={on} title="Select (Shift+click for a range)"
      onClick={(e) => { if (e.shiftKey) selectRange(id, order); else toggleSelected(id); }}>
      <Icon name="check" size={13} />
    </button>
  );
}

/** A group header's Select: disabled until something is selected, then selects or clears the whole group. */
export function GroupSelect({ label, ids }: { label: string; ids: readonly string[] }) {
  const { selected } = useSelection();
  const all = ids.length > 0 && ids.every((x) => selected.has(x));
  return (
    <button type="button" className="btn btn-sm group-select" disabled={selected.size === 0} aria-pressed={all}
      aria-label={`Select group ${label}`} onClick={() => toggleGroup(ids)}>
      Select
    </button>
  );
}

/** A select that acts on change and snaps back to its placeholder. */
function Choose({ label, busy, children, onPick }: { label: string; busy: boolean; children: ReactNode; onPick: (v: string) => void }) {
  return (
    <select className="quick-select" aria-label={label} value="" disabled={busy} onChange={(e) => { if (e.target.value) onPick(e.target.value); }}>
      <option value="">{label}</option>
      {children}
    </select>
  );
}

interface Patch {
  status?: 'not_started' | 'started' | 'done';
  visibility?: 'default' | 'archived' | 'deleted';
  assigneeId?: string | null;
  priority?: Priority | null;
  effort?: number | null;
  milestoneId?: string | null;
  sprintId?: string | null;
  deckId?: string;
  addMasterTags?: string[];
  removeMasterTags?: string[];
}

/** Fixed at the bottom while cards are selected. Every action is one all-or-nothing `cards/bulkUpdate`. */
export function BulkBar({ cards }: { cards: ReadonlyMap<string, Card> }) {
  const s = useStore((x) => x);
  const { selected } = useSelection();
  const [busy, setBusy] = useState(false);
  // Bumped after each change so the effort box empties again.
  const [nonce, setNonce] = useState(0);
  const [picking, setPicking] = useState<'milestone' | 'run' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const settings = settingsOf(s);
  const count = selected.size;

  const picked = useMemo(() => [...selected].map((id) => cards.get(id)).filter((c): c is Card => !!c), [selected, cards]);
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of picked) { const p = c.deckId ? s.decks.get(c.deckId)?.projectId : undefined; if (p) ids.add(p); }
    return [...ids];
  }, [picked, s.decks]);
  const project = projectIds.length === 1 ? s.projects.get(projectIds[0]) : undefined;
  const allDocs = picked.length > 0 && picked.every((c) => c.isDoc);

  const plan = useMemo<Record<'milestone' | 'run', PlanOption[]>>(() => {
    const everywhere = (x: { isGlobal: boolean; projectIds: string[] }) => projectIds.every((p) => coversProject(x, p));
    return {
      milestone: [...s.milestones.values()].filter(everywhere)
        .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.accountSeq - b.accountSeq)
        .map((m) => ({ id: m.id, label: m.name, detail: m.date ?? undefined })),
      run: [...s.sprints.values()].filter((r) => !r.isFinished && s.sprintConfigs.get(r.configId) && !s.sprintConfigs.get(r.configId)!.isArchived && everywhere(s.sprintConfigs.get(r.configId)!))
        .sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr)
        .map((r) => ({ id: r.id, label: r.label, detail: `${dayMon(r.startDay)} to ${dayMon(r.endDay)}` })),
    };
  }, [s.milestones, s.sprints, s.sprintConfigs, projectIds]);

  if (!count) return null;

  const apply = async (patch: Patch) => {
    if (busy) return;
    setBusy(true);
    try { await dispatch('cards', 'bulkUpdate', { ids: [...selected], ...patch }); setNonce((n) => n + 1); } catch { /* toast shows the server's message */ } finally { setBusy(false); }
  };
  const owners = eligibleOwners(s, project);
  const tagNames = (project?.tags ?? []).map((t) => t.name);
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-count" role="status">{count} selected</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={clearSelection}>Clear</button>
      <span className="bulk-sep" aria-hidden />
      <div className="bulk-group" role="group" aria-label="Status">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ status: 'started' })}>Start</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ status: 'done' })}>Done</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ status: 'not_started' })}>Not started</button>
      </div>
      <Choose busy={busy} label="Owner" onPick={(v) => void apply({ assigneeId: v === '-' ? null : v })}>
        <option value="-">No owner</option>
        {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Choose>
      <PriorityButtons value={null} settings={settings} disabled={busy} onChange={(priority) => void apply({ priority })} />
      <EffortField key={nonce} value={null} settings={settings} disabled={busy} onChange={(effort) => void apply({ effort })} />
      {settings.milestonesEnabled && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPicking('milestone')}>Milestone</button>}
      {settings.sprintsEnabled && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPicking('run')}>Sprint</button>}
      <DeckPicker value={null} emptyLabel="Move to list" isDoc={allDocs} disabled={busy} onChange={(deckId) => void apply({ deckId })} />
      {project && tagNames.length > 0 && (
        <>
          <Choose busy={busy} label="Add tag" onPick={(t) => void apply({ addMasterTags: [t] })}>{tagNames.map((t) => <option key={t} value={t}>{t}</option>)}</Choose>
          <Choose busy={busy} label="Remove tag" onPick={(t) => void apply({ removeMasterTags: [t] })}>{tagNames.map((t) => <option key={t} value={t}>{t}</option>)}</Choose>
        </>
      )}
      <span className="bulk-sep" aria-hidden />
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ visibility: 'archived' })}>Archive</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void apply({ visibility: 'default' })}>Restore</button>
      <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>

      {picking && (
        <PlanPicker title={picking === 'milestone' ? 'Pick milestone' : 'Pick sprint'} options={plan[picking]} value={null}
          onPick={(id) => void apply(picking === 'milestone' ? { milestoneId: id } : { sprintId: id })} onClose={() => setPicking(null)} />
      )}
      {confirmDelete && (
        <ConfirmDialog title={`Delete ${count} ${count === 1 ? 'task' : 'tasks'}?`} confirmLabel="Delete" danger onClose={() => setConfirmDelete(false)}
          onConfirm={() => dispatch('cards', 'bulkUpdate', { ids: [...selected], visibility: 'deleted' }).then(() => {})}>
          <p>The selected tasks will be deleted.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

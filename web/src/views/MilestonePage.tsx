import { useMemo, useState, type DragEvent } from 'react';
import type { Card, Milestone, MilestoneZone } from '../../../shared/types';
import { dispatch } from '../api';
import { canEditContent, canManageProject, isAdmin, settingsOf, useStore, type State } from '../store';
import { useMinuteClock } from '../clock';
import { Link } from '../router';
import { usePageNavigate } from './HomePane';
import { BurnChart } from '../components/BurnChart';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Dialog } from '../components/Dialog';
import { LatestActivity } from '../components/LatestActivity';
import { MilestoneDialog } from '../components/MilestoneDialog';
import { usePlanTile } from '../components/PlanCardTile';
import { burnSeries, colorHex, localToday, weekdayDayMon, workdaysPhrase } from '../planning';

/** Whether I may change the milestone itself (edit, pin, delete, automations). */
function canManage(s: State, m: Milestone): boolean {
  if (m.isGlobal) return isAdmin(s);
  return m.projectIds.length > 0 && m.projectIds.every((id) => { const p = s.projects.get(id); return !!p && canManageProject(s, p); });
}

export function MilestonePage({ seq }: { seq: number }) {
  const go = usePageNavigate(); // in the pane beside Home, it stays there
  const s = useStore((x) => x);
  useMinuteClock();
  const today = localToday();
  const settings = settingsOf(s);
  const m = useMemo(() => [...s.milestones.values()].find((x) => x.accountSeq === seq), [s.milestones, seq]);
  const [dialog, setDialog] = useState<'edit' | 'delete' | 'auto' | null>(null);
  const [addingZone, setAddingZone] = useState(false);
  const [zoneName, setZoneName] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const tile = usePlanTile();

  if (!m || !settings.milestonesEnabled) {
    return (
      <main className="page" id="main">
        <h1>{m ? 'Milestones are switched off' : 'Milestone not found'}</h1>
        <p><Link href="/milestones">Back to the Timeline</Link></p>
      </main>
    );
  }

  const manage = canManage(s, m);
  const projectIds = m.isGlobal ? [...s.projects.values()].map((p) => p.id) : m.projectIds;
  const canEdit = projectIds.some((id) => { const p = s.projects.get(id); return !!p && canEditContent(s, p); });
  const zones = [...s.milestoneZones.values()].filter((z) => z.milestoneId === m.id).sort((a, b) => a.sortIndex - b.sortIndex);
  const cards = [...s.cards.values()].filter((c) => c.milestoneId === m.id && c.visibility === 'default').sort((a, b) => a.seq - b.seq);
  const visibleProjects = new Set(s.projects.keys());
  const points = burnSeries([...s.milestoneProgress.values()].filter((p) => p.milestoneId === m.id), visibleProjects);
  const columns: { zone: MilestoneZone | null; cards: Card[] }[] = [
    { zone: null, cards: cards.filter((c) => !c.milestoneZoneId || !zones.some((z) => z.id === c.milestoneZoneId)) },
    ...zones.map((z) => ({ zone: z, cards: cards.filter((c) => c.milestoneZoneId === z.id) })),
  ];

  const moveTo = (cardId: string, zoneId: string | null) => {
    if (s.cards.get(cardId)?.milestoneZoneId === zoneId || (zoneId === null && !s.cards.get(cardId)?.milestoneZoneId)) return;
    void dispatch('cards', 'update', { id: cardId, milestoneZoneId: zoneId }).catch(() => {});
  };
  const onDrop = (e: DragEvent, zoneId: string | null) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    if (id && s.cards.has(id)) moveTo(id, zoneId);
  };
  const addZone = async () => {
    const name = zoneName.trim();
    if (!name) return;
    try { await dispatch('milestoneZones', 'create', { milestoneId: m.id, name }); setZoneName(''); setAddingZone(false); } catch { /* toast */ }
  };

  return (
    <main className="page" id="main" data-testid="milestone-page">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link href="/milestones">Milestones</Link></p>
          <h1><i className="tl-diamond ms-mark" style={{ ['--c' as never]: colorHex(m.color) }} /> {m.name}</h1>
          <p className="muted" data-testid="milestone-when">
            {m.date ? `${weekdayDayMon(m.date)} — ${workdaysPhrase(today, m.date, settings.workdays)}` : 'No date'}
          </p>
        </div>
        {manage && (
          <div className="tl-tabs">
            <button type="button" className="btn" onClick={() => setDialog('edit')}>Edit</button>
            <button type="button" className={m.isPinned ? 'btn btn-active' : 'btn'} aria-pressed={m.isPinned}
              onClick={() => void dispatch('milestones', 'setPinned', { id: m.id, isPinned: !m.isPinned }).catch(() => {})}>Pin</button>
            <button type="button" className="btn" onClick={() => setDialog('auto')}>Automations</button>
            <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button>
          </div>
        )}
      </div>

      <BurnChart points={points} name={m.name} />

      <section aria-label="Zones" className="zones">
        {columns.map(({ zone, cards: list }) => (
          <div key={zone?.id ?? 'default'} className={`zone-col${over === (zone?.id ?? 'default') ? ' over' : ''}`} data-testid="zone-column"
            onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(zone?.id ?? 'default'); } : undefined}
            onDragLeave={() => setOver(null)}
            onDrop={canEdit ? (e) => onDrop(e, zone?.id ?? null) : undefined}>
            <header className="zone-head">
              <h2>{zone ? zone.name : 'Default Zone'} <span className="tab-count quiet">{list.length}</span></h2>
              {zone && canEdit && <ZoneActions zone={zone} />}
            </header>
            <ul className="zone-cards">
              {list.map((c) => (
                <li key={c.id} draggable={canEdit} onDragStart={(e) => { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; }}>
                  {tile(c)}
                  {canEdit && zones.length > 0 && (
                    <select className="zone-select" aria-label={`Zone for ${c.content.split('\n')[0].replace(/^#+\s*/, '').trim() || 'card'}`}
                      value={zone?.id ?? ''} onChange={(e) => moveTo(c.id, e.target.value || null)}>
                      <option value="">Default Zone</option>
                      {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {canEdit && (
          <div className="zone-col zone-add">
            {addingZone ? (
              <form onSubmit={(e) => { e.preventDefault(); void addZone(); }} className="zone-form">
                <input aria-label="Zone name" autoFocus maxLength={200} value={zoneName} onChange={(e) => setZoneName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAddingZone(false); } }} />
                <button type="submit" className="btn btn-sm btn-primary">Add</button>
              </form>
            ) : <button type="button" className="btn" onClick={() => setAddingZone(true)}>Add Zone</button>}
          </div>
        )}
      </section>

      {dialog === 'edit' && (
        <MilestoneDialog milestone={m} projects={[...s.projects.values()].filter((p) => !p.isArchived && canManageProject(s, p)).sort((a, b) => a.seq - b.seq)}
          initial={new Set()} admin={isAdmin(s)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title={`Delete milestone "${m.name}"?`} confirmLabel="Delete milestone" danger onClose={() => setDialog(null)}
          onConfirm={async () => { await dispatch('milestones', 'delete', { id: m.id }); go('/milestones'); }}>
          <p>{cards.length} task{cards.length === 1 ? '' : 's'} will leave the milestone. The tasks themselves stay.</p>
        </ConfirmDialog>
      )}
      {dialog === 'auto' && <MilestoneAutomations milestone={m} onClose={() => setDialog(null)} />}
      <LatestActivity key={m.id} milestoneId={m.id} href={`/milestones/${m.accountSeq}/activity`} />
    </main>
  );
}

/** Rename and remove for one zone. */
function ZoneActions({ zone }: { zone: MilestoneZone }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(zone.name);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    const n = name.trim();
    if (!n || n === zone.name) { setRenaming(false); return; }
    try { await dispatch('milestoneZones', 'update', { id: zone.id, name: n }); setRenaming(false); } catch { /* toast */ }
  };
  return (
    <span className="zone-actions">
      {renaming ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input aria-label={`New name for zone ${zone.name}`} autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); } }} />
        </form>
      ) : (
        <>
          <button type="button" className="link-btn" onClick={() => setRenaming(true)} aria-label={`Rename zone ${zone.name}`}>Rename</button>
          <button type="button" className="link-btn" onClick={() => setConfirm(true)} aria-label={`Delete zone ${zone.name}`}>Delete</button>
        </>
      )}
      {confirm && (
        <ConfirmDialog title={`Delete zone "${zone.name}"?`} confirmLabel="Delete zone" danger onClose={() => setConfirm(false)}
          onConfirm={() => dispatch('milestoneZones', 'delete', { id: zone.id })}>
          <p>Its tasks move to the Default Zone.</p>
        </ConfirmDialog>
      )}
    </span>
  );
}

/** Decks whose new cards go to this milestone. */
function MilestoneAutomations({ milestone, onClose }: { milestone: Milestone; onClose: () => void }) {
  const s = useStore((x) => x);
  const decks = [...s.decks.values()].filter((d) => (milestone.isGlobal || milestone.projectIds.includes(d.projectId))
    && (() => { const p = s.projects.get(d.projectId); return !!p && canManageProject(s, p); })())
    .sort((a, b) => a.title.localeCompare(b.title));
  const [busy, setBusy] = useState(false);
  const toggle = async (id: string, on: boolean) => {
    setBusy(true);
    try { await dispatch('decks', 'update', { id, autoMilestoneId: on ? milestone.id : null }); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="Milestone automations" onClose={onClose} actions={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p className="hint">New tasks created in a ticked list join {milestone.name}.</p>
      {decks.length === 0 && <p className="muted">No lists you manage are covered by this milestone.</p>}
      <div className="inline-options">
        {decks.map((d) => (
          <label key={d.id} className="radio">
            <input type="checkbox" checked={d.autoMilestoneId === milestone.id} disabled={busy} onChange={(e) => void toggle(d.id, e.target.checked)} /> {d.title}
          </label>
        ))}
      </div>
    </Dialog>
  );
}

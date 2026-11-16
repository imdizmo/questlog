import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card, Project } from '../../../shared/types';
import { dispatch } from '../api';
import { myCardTags, planAllows, roleOf, settingsOf, useEffortOn, useStore } from '../store';
import { showToast } from '../toast';
import { usePendingList } from '../pending';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { Menu } from './Menu';
import { eligibleOwners } from './OwnerPicker';
import { PriorityButtons } from './PriorityButtons';
import { EffortField } from './EffortField';
import { DueDateField } from './DueDateField';
import { TagToggles } from './TagToggles';
import { ProjectTagsDialog } from './ProjectTagsDialog';
import { PlanFields } from './PlanFields';

/** How many people get a one-click owner button; everyone else is under Pick. */
const QUICK_OWNERS = 5;

/** The card's Properties side tab: owner, priority, effort, due date, project and personal tags, presets. */
export function PropertiesPanel({ card, project, editable, update }: {
  card: Card;
  project: Project | undefined;
  editable: boolean;
  update: (patch: object) => void;
}) {
  const effortOn = useEffortOn();
  const s = useStore((x) => x);
  const settings = settingsOf(s);
  const [dialog, setDialog] = useState<'tags' | 'preset' | null>(null);
  const off = !editable;
  const task = !card.isDoc;
  const people = eligibleOwners(s, project);
  const quick = people.slice(0, QUICK_OWNERS);
  const owner = card.assigneeId ? s.users.get(card.assigneeId) : undefined;
  const canPreset = !!roleOf(s, s.me?.id) && roleOf(s, s.me?.id) !== 'observer';
  // Tags are sent as the whole array: quick toggles must build on each other, not on the store's last echo.
  const tags = usePendingList(card.masterTags ?? [], (masterTags) => dispatch('cards', 'update', { id: card.id, masterTags }));

  return (
    <div className="props-panel">
      {task && (
        <PropRow label="Owner">
          <div className="owner-row">
            {quick.map((u) => {
              const on = card.assigneeId === u.id;
              return (
                <button key={u.id} type="button" className={`owner-btn${on ? ' on' : ''}`} aria-pressed={on} disabled={off}
                  aria-label={`Owner ${u.name}`} title={on ? `${u.name} (click to remove)` : u.name}
                  onClick={() => update({ assigneeId: on ? null : u.id })}>
                  <span className="avatar sm" aria-hidden>{u.name.slice(0, 1).toUpperCase()}</span>
                  <span className="owner-name">{u.name.split(' ')[0]}</span>
                </button>
              );
            })}
            {editable ? (
              <Menu label="Pick owner" triggerClass="btn btn-sm" align="left" trigger={<>Pick <Icon name="chevron" size={14} /></>} items={[
                { label: 'No owner', disabled: !card.assigneeId, onSelect: () => update({ assigneeId: null }) },
                ...people.map((u) => ({ label: u.name, disabled: u.id === card.assigneeId, onSelect: () => update({ assigneeId: u.id }) })),
              ]} />
            ) : !owner && <span className="muted">No owner</span>}
            {owner && !quick.some((u) => u.id === owner.id) && <span className="badge">{owner.name}</span>}
          </div>
        </PropRow>
      )}

      {task && (
        <PropRow label="Priority">
          <PriorityButtons value={card.priority} settings={settings} disabled={off} onChange={(priority) => update({ priority })} />
        </PropRow>
      )}

      {task && effortOn && (
        <PropRow label="Effort">
          <EffortField value={card.effort} settings={settings} disabled={off} onChange={(effort) => update({ effort })} />
        </PropRow>
      )}

      {task && settings.dueDateEnabled && (
        <div className="prop-row">
          <DueDateField value={card.dueDate} disabled={off} locked={!planAllows(s, 'dueDates')} labelClass="prop-label" onChange={(dueDate) => update({ dueDate })} />
        </div>
      )}

      {task && project && settings.milestonesEnabled && (
        <PropRow label="Milestone"><PlanFields kind="milestone" card={card} project={project} editable={editable} update={update} /></PropRow>
      )}

      {task && project && settings.sprintsEnabled && (
        <PropRow label="Sprint"><PlanFields kind="run" card={card} project={project} editable={editable} update={update} /></PropRow>
      )}

      {project && (
        <PropRow label="Project tags" extra={editable && (
          <button type="button" className="link-btn" onClick={() => setDialog('tags')}>Edit tags</button>
        )}>
          <TagToggles tags={project.tags ?? []} value={tags.value} disabled={off} onChange={tags.change} />
        </PropRow>
      )}

      <PersonalTags card={card} />

      {task && canPreset && (
        <div className="prop-row prop-actions">
          <button type="button" className="btn btn-sm" onClick={() => setDialog('preset')}>
            <Icon name="plus" size={14} /> Save as preset
          </button>
          <span className="hint">Start new tasks from this task's properties.</span>
        </div>
      )}

      {dialog === 'tags' && project && <ProjectTagsDialog project={project} onClose={() => setDialog(null)} />}
      {dialog === 'preset' && <PresetDialog card={card} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PropRow({ label, extra, children }: { label: string; extra?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="prop-row" aria-labelledby={id}>
      <div className="prop-head">
        <h4 className="prop-label" id={id}>{label}</h4>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** Tags only I can see. Enter adds one; each chip has its own remove button. */
function PersonalTags({ card }: { card: Card }) {
  const stored = useStore((s) => myCardTags(s, card.id));
  const { value: mine, change } = usePendingList(stored, (tags) => dispatch('users', 'setCardTags', { cardId: card.id, tags }));
  const [text, setText] = useState('');
  const deleted = card.visibility === 'deleted';

  // Reads the input itself: state may lag behind when keys arrive faster than React renders.
  const add = (raw: string) => {
    const t = raw.trim().replace(/^#/, '');
    if (!t) return;
    if (t.length > 64) { showToast('Personal tags can be at most 64 characters.'); return; }
    setText('');
    change((cur) => (cur.includes(t) ? cur : [...cur, t]));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); add(e.currentTarget.value); }
  };

  return (
    <PropRow label="Personal tags">
      {mine.length > 0 && (
        <ul className="personal-tags" aria-label="Your personal tags">
          {mine.map((t) => (
            <li key={t} className="personal-chip">
              <span data-testid="personal-tag">{t}</span>
              <button type="button" className="chip-x" aria-label={`Remove personal tag ${t}`} disabled={deleted}
                onClick={() => change((cur) => cur.filter((x) => x !== t))}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input className="num-inline tag-input" aria-label="Add a personal tag" placeholder="Add a tag, then Enter" maxLength={64}
        value={text} disabled={deleted} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <p className="hint">Only you see these.</p>
    </PropRow>
  );
}

/**
 * Saves the card's priority, effort and tags as a named preset for new cards. Presets are workspace-wide,
 * so the text (which may come from a limited project) and the owner go in only when ticked.
 */
function PresetDialog({ card, onClose }: { card: Card; onClose: () => void }) {
  const [name, setName] = useState('');
  const [withText, setWithText] = useState(false);
  const [withOwner, setWithOwner] = useState(false);
  const noteId = useId();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await dispatch('presets', 'create', {
        name: n,
        data: {
          ...(withText && card.content ? { content: card.content } : {}),
          priority: card.priority, effort: card.effort, masterTags: card.masterTags ?? [],
          ...(withOwner && card.assigneeId ? { assigneeId: card.assigneeId } : {}),
        },
      });
      showToast(`Preset "${n}" saved`, 'info', 3000);
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="Save as preset" onClose={onClose} onSubmit={save} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Save preset</button>
    </>}>
      <label className="field">
        <span>Preset name</span>
        <input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="hint">New tasks can start from it in the Add task panel. It keeps this task's priority, Effort and tags.</p>
      <label className="check">
        <input type="checkbox" checked={withText} disabled={!card.content} aria-describedby={noteId} onChange={(e) => setWithText(e.target.checked)} />
        Include text
        {!card.content && <span className="check-note muted">This task has no text</span>}
      </label>
      <label className="check">
        <input type="checkbox" checked={withOwner} disabled={!card.assigneeId} aria-describedby={noteId} onChange={(e) => setWithOwner(e.target.checked)} />
        Include owner
        {!card.assigneeId && <span className="check-note muted">This task has no owner</span>}
      </label>
      <p className="hint" id={noteId}>Presets are visible to everyone in the workspace.</p>
    </Dialog>
  );
}

import { useEffect, useRef, useState } from 'react';
import { newEntry } from './wiki/GuidedStart';
import { dispatch } from '../api';
import { settingsOf, store, useStore } from '../store';
import { navigate } from '../router';
import { cardHref, deckPath, localToday } from '../cards';
import { campaignTypes, wikiPath } from '../wiki';
import { showToast } from '../toast';
import { taskList, whereText, type QuickKind, type QuickTarget } from '../quickTarget';
import { Icon, type IconName } from './icons';

interface Action { kind: QuickKind; icon: IconName; title: string; placeholder: string }
const ACTIONS: Action[] = [
  { kind: 'task', icon: 'task', title: 'New task', placeholder: 'What needs doing?' },
  { kind: 'list', icon: 'list', title: 'New list', placeholder: 'Name of the list' },
  { kind: 'entry', icon: 'doc', title: 'New wiki entry', placeholder: 'Name, e.g. Ser Odric Vane' },
  { kind: 'milestone', icon: 'flag', title: 'New milestone', placeholder: 'Name, e.g. Playtest 3' },
];

const inTwoWeeks = () => { const d = new Date(); d.setDate(d.getDate() + 14); return localToday(d); };

/**
 * The quick actions at the bottom of the sidebar (and of the folded rail): New task, New list, New wiki entry, New
 * milestone, each a small box that says where the new thing goes (web/src/quickTarget.ts) and makes it with
 * Questlog's own commands; then Collapse. Made things are announced with an Open button; the page stays where it is.
 */
export function QuickActions({ target, rail = false, onCollapse }: { target: QuickTarget; rail?: boolean; onCollapse?: () => void }) {
  const milestonesOn = useStore((s) => settingsOf(s).milestonesEnabled);
  const [open, setOpen] = useState<QuickKind | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const actions = ACTIONS.filter((a) => a.kind !== 'milestone' || milestonesOn);
  return (
    <div className={rail ? 'qa-rail' : 'qa-bar'} ref={wrap} role="toolbar" aria-label="Quick actions" aria-orientation={rail ? 'vertical' : 'horizontal'}>
      {actions.map((a) => (
        <button key={a.kind} type="button" className={rail ? 'ri' : 'qa'} data-quick={a.kind} aria-label={a.title} aria-expanded={open === a.kind}
          onClick={() => setOpen((o) => (o === a.kind ? null : a.kind))}>
          <Icon name={a.icon} size={17} /><span className={rail ? 'rtip' : 'qa-tip'} aria-hidden>{a.title}</span>
        </button>
      ))}
      {onCollapse && (
        <button type="button" className="qa" aria-label="Collapse the sidebar" onClick={onCollapse}>
          <Icon name="side" size={17} /><span className="qa-tip" aria-hidden>Collapse the sidebar</span>
        </button>
      )}
      {open && (
        <QuickBox action={ACTIONS.find((a) => a.kind === open)!} target={target} onClose={() => {
          // Back to the button that opened the box (Esc or Create).
          const button = wrap.current?.querySelector<HTMLElement>(`[data-quick="${open}"]`);
          setOpen(null);
          button?.focus();
        }} />
      )}
    </div>
  );
}

function QuickBox({ action, target, onClose }: { action: Action; target: QuickTarget; onClose: () => void }) {
  const s = useStore((x) => x);
  const [name, setName] = useState('');
  const [date, setDate] = useState(inTwoWeeks);
  const [typeId, setTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [action.kind]);
  const where = whereText(action.kind, s, target);
  const project = target.project;
  const types = project && action.kind === 'entry' ? campaignTypes(s.entryTypes, project.id) : [];
  const nowhere = !project ? 'Make a project first: there is nowhere to put it yet.'
    : action.kind === 'task' && !where ? `${project.name} has no task list yet: make a list first.` : null;

  const create = async () => {
    const title = name.trim();
    if (!title || busy || nowhere || !project) return;
    setBusy(true);
    try {
      let open: () => void;
      if (action.kind === 'task') {
        const deck = taskList(s, target)!;
        const r = await dispatch<{ id: string; accountSeq: number }>('cards', 'create', { deckId: deck.id, content: title });
        open = () => navigate(cardHref({ seq: r.accountSeq, content: title }, deck));
      } else if (action.kind === 'list') {
        const area = target.area ?? project.spaces[0];
        const r = await dispatch<{ id: string }>('decks', 'create', { title, projectId: project.id, ...(area ? { spaceId: area.id } : {}) });
        open = () => { const d = store.get().decks.get(r.id); if (d) navigate(deckPath(d)); };
      } else if (action.kind === 'entry') {
        // A type with a guided start asks its questions first (null: cancelled there).
        const type = typeId ? s.entryTypes.get(typeId) : undefined;
        const r = type ? await newEntry({ project, type, name: title })
          : await dispatch<{ id: string; key: string }>('wiki', 'createEntry', { projectId: project.id, typeId: null, name: title });
        if (!r) { setBusy(false); return; }
        open = () => navigate(`${wikiPath(project.seq)}/${r.key}`);
      } else {
        const r = await dispatch<{ id: string; accountSeq: number }>('milestones', 'create', {
          name: title, date, startDate: null, color: 'green', isGlobal: false, projectIds: [project.id],
        });
        open = () => navigate(`/milestones/${r.accountSeq}`);
      }
      showToast(`Made “${title}” in ${where}`, 'info', 6000, { label: 'Open', run: open });
      onClose();
    } catch {
      setBusy(false); // the reason is in a toast; the box stays for another try
    }
  };

  return (
    <div className="qa-pop" role="dialog" aria-label={action.title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <h4>{action.title}</h4>
      <input ref={input} type="text" value={name} placeholder={action.placeholder} aria-label={action.title} maxLength={200}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
      {action.kind === 'entry' && types.length > 0 && (
        <label className="qa-field">Type
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">Page</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {action.kind === 'milestone' && (
        <label className="qa-field">Date <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} /></label>
      )}
      <p className="qa-where" data-testid="quick-where">{nowhere ?? `Goes to: ${where}`}</p>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !!nowhere || !name.trim() || (action.kind === 'milestone' && !date)}
        onClick={() => void create()}>Create</button>
    </div>
  );
}

import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Card } from '../../../shared/types';
import { cardCode, titleOf } from '../../../shared/cards';
import { dispatch } from '../api';
import { canEditContent, projectVisible, store, useStore } from '../store';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/icons';
import { boardOfCard } from './boards';
import { useShownTitle } from '../translate';

const LIMIT = 50;
type Tab = 'find' | 'create';

/** Resolves once the card has arrived over the live socket (the node would otherwise flash "Card not available"). */
async function cardArrived(id: string, ms = 3000) {
  for (let waited = 0; waited < ms && !store.get().cards.has(id); waited += 50) await new Promise((r) => setTimeout(r, 50));
}

/**
 * "Card node": pick a card the person can see, or make a new one. Nothing is written to the board here;
 * `onChoose` gets the card id and the caller adds the node.
 */
export function CardNodeDialog({ host, onChoose, onClose, makeFrame }: {
  /** The board's host task (left out of the matches); null on Home. */
  host: Card | null; onChoose: (cardId: string) => void; onClose: () => void;
  /** On a storyline's board: "Create new" makes a frame (a wiki entry) from a title instead of a task. Returns its card id. */
  makeFrame?: (title: string) => Promise<string>;
}) {
  const [tab, setTab] = useState<Tab>('find');
  const base = useId();
  const tabs: Array<[Tab, string]> = [['find', 'Find existing'], ['create', 'Create new']];
  const onTabKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex(([t]) => t === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(tabs[next][0]);
    document.getElementById(`${base}-tab-${tabs[next][0]}`)?.focus();
  };
  return (
    <Dialog title="Add task" onClose={onClose}>
      <div role="tablist" aria-label="Task source" className="tabs" onKeyDown={onTabKey}>
        {tabs.map(([t, label]) => (
          <button key={t} id={`${base}-tab-${t}`} type="button" role="tab" className="tab" aria-selected={tab === t}
            aria-controls={`${base}-panel`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab}`}>
        {tab === 'find' ? <FindCard host={host} onChoose={onChoose} /> : <CreateCard host={host} onChoose={onChoose} makeFrame={makeFrame} />}
      </div>
    </Dialog>
  );
}

function FindCard({ host, onChoose }: { host: Card | null; onChoose: (id: string) => void }) {
  const shownTitle = useShownTitle();
  const s = useStore((x) => x);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const options = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    return [...s.cards.values()]
      .filter((c) => c.visibility !== 'deleted' && c.id !== host?.id)
      .filter((c) => !q || titleOf(c.content).toLowerCase().includes(q) || shownTitle(c).toLowerCase().includes(q) || cardCode(c.seq).toLowerCase().includes(q))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, LIMIT);
  }, [s.cards, query, host?.id]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = options[active]; if (c) onChoose(c.id); }
  };

  return (
    <div className="stack bpick">
      <div className="picker-search">
        <Icon name="search" size={15} />
        <input data-autofocus role="combobox" aria-label="Search tasks" placeholder="Search tasks by title or code"
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </div>
      {!query.trim() && <p className="hint">Recent tasks</p>}
      <ul id={listId} role="listbox" aria-label="Tasks" className="picker-list bpick-list">
        {options.map((c, i) => {
          const owner = c.assigneeId ? s.users.get(c.assigneeId)?.name : undefined;
          return (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={i === active ? 'picker-opt active' : 'picker-opt'}
              onMouseEnter={() => setActive(i)} onClick={() => onChoose(c.id)}>
              <span className="picker-opt-title">{shownTitle(c)}</span>
              {boardOfCard(s, c.id) && <span className="bpick-board" title="Has a board"><Icon name="frame" size={14} /><span className="sr-only">Has a board</span></span>}
              <span className="picker-sub">
                {taskId(c)}{owner ? ` · ${owner}` : ''}{c.effort !== null ? ` · ${c.effort} effort` : ''}
              </span>
            </li>
          );
        })}
        {options.length === 0 && <li role="presentation" className="picker-empty">No matching tasks</li>}
      </ul>
    </div>
  );
}

function CreateCard({ host, onChoose, makeFrame }: { host: Card | null; onChoose: (id: string) => void; makeFrame?: (title: string) => Promise<string> }) {
  const s = useStore((x) => x);
  const decks = useMemo(() => [...s.decks.values()]
    .filter((d) => {
      const p = s.projects.get(d.projectId);
      return !!p && !p.isArchived && projectVisible(s, p.id) && canEditContent(s, p) && d.deckType !== 'doc';
    })
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.sortIndex - b.sortIndex || a.seq - b.seq)
    .map((d) => ({ d, label: `${s.projects.get(d.projectId)!.name} – ${d.title}` })), [s]);
  // The host card's deck by default; the first deck that accepts cards when the host's does not.
  const [deckId, setDeckId] = useState(() => (host?.deckId && decks.some(({ d }) => d.id === host.deckId) ? host.deckId : decks[0]?.d.id ?? ''));
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    const content = title.trim();
    if (!content) { setError('Give the task a title.'); return; }
    if (!makeFrame && !deckId) { setError('There is no list you can add tasks to.'); return; }
    setBusy(true);
    setError('');
    try {
      const id = makeFrame ? await makeFrame(content) : (await dispatch<{ id: string }>('cards', 'create', { deckId, content })).id;
      await cardArrived(id);
      onChoose(id);
    } catch {
      setBusy(false);
      setError("Couldn't create the task.");
    }
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="field">
        <span>{makeFrame ? 'What happens' : 'Task title'}</span>
        <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      {!makeFrame && (
        <label className="field">
          <span>Create in</span>
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            {decks.map(({ d, label }) => <option key={d.id} value={d.id}>{label}</option>)}
          </select>
        </label>
      )}
      {error && <p role="alert" className="field-error">{error}</p>}
      <div className="bpick-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{makeFrame ? 'Create frame' : 'Create task'}</button>
      </div>
    </form>
  );
}

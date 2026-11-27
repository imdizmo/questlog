import { taskId } from '../taskId';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card } from '../../../shared/types';
import { InlineTitle } from './InlineTitle';
import { cardCode, derivedStatus, STATUS_LABEL, titleOf } from '../../../shared/cards';
import { dispatch } from '../api';
import { useStore } from '../store';
import { Link } from '../router';
import { cardHref, openByCard } from '../cards';
import { usePendingList } from '../pending';
import { childrenOf, heroCandidates, subCandidates } from '../relations';
import { CardPicker } from './CardPicker';
import { Icon } from './icons';
import { useShownTitle } from '../translate';

/** The "Sub cards" side tab: this card's hero, and its own sub cards (new or existing ones). */
export function SubCardsTab({ card, editable }: { card: Card; editable: boolean }) {
  const shownTitle = useShownTitle();
  const s = useStore((x) => x);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const deck = card.deckId ? s.decks.get(card.deckId) : undefined;
  const parent = card.parentCardId ? s.cards.get(card.parentCardId) : undefined;
  const parentDeck = parent?.deckId ? s.decks.get(parent.deckId) : undefined;
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);

  const stored = useMemo(() => childrenOf(s.cards.values(), card.id).map((c) => c.id), [s.cards, card.id]);
  // Children are written on the hero as one whole array: quick adds and removes build on each other.
  const kids = usePendingList(stored, (childCards) => dispatch('cards', 'update', { id: card.id, childCards }));
  const children = kids.value.map((id) => s.cards.get(id)).filter((c): c is Card => !!c);
  const q = query.trim().toLowerCase();
  const shown = q ? children.filter((c) => titleOf(c.content).toLowerCase().includes(q) || shownTitle(c).toLowerCase().includes(q) || cardCode(c.seq).toLowerCase().includes(q)) : children;

  if (card.isDoc) return <p className="muted">Lore can't have a main task or subtasks. Turn it into a task first.</p>;
  if (!deck) return <p className="muted">Put this task in a list to give it a main task or subtasks.</p>;
  const off = !editable || card.visibility === 'deleted';

  const createSub = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await dispatch('cards', 'create', { deckId: deck.id, content: text, parentCardId: card.id });
      setTitle('');
      input.current?.focus();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void createSub(e.currentTarget.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setTitle(''); }
  };

  return (
    <div className="props-panel rel-panel">
      <Section label="Main task" extra={!off && (
        <CardPicker label="Select main task" trigger={<>Select <Icon name="chevron" size={14} /></>}
          candidates={heroCandidates(s.cards.values(), s.decks, card)} empty="No tasks to choose from"
          onPick={(c) => void dispatch('cards', 'update', { id: card.id, parentCardId: c.id }).catch(() => {})} />
      )}>
        {parent ? (
          <ul className="rel-list" aria-label="Main task">
            <li className="rel-item">
              <Icon name="hero" size={16} />
              <Link href={cardHref(parent, parentDeck)} className="rel-title">{shownTitle(parent) ? <InlineTitle text={shownTitle(parent)} /> : 'Untitled'}</Link>
              <span className="code muted">{taskId(parent)}</span>
              {!off && (
                <button type="button" className="chip-x" aria-label={`Remove main task ${shownTitle(parent)}`} title="Remove main task"
                  onClick={() => void dispatch('cards', 'update', { id: card.id, parentCardId: null }).catch(() => {})}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </li>
          </ul>
        ) : <p className="muted">None. Pick one to make this a subtask.</p>}
      </Section>

      <Section label="Subtasks" extra={<span className="group-count">{children.length}</span>}>
        {(children.length > 0 || !off) && (
          <div className="rel-actions">
            {children.length > 0 && (
              <div className="picker-search rel-search">
                <Icon name="search" size={15} />
                <input aria-label="Search subtasks" placeholder="Search subtasks" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            )}
            {!off && (
              <>
                <button type="button" className="btn btn-sm" aria-expanded={adding} onClick={() => { setAdding((a) => !a); setTimeout(() => input.current?.focus()); }}>
                  <Icon name="plus" size={14} /> Add task
                </button>
                <CardPicker label="Add existing" trigger={<>Add existing <Icon name="chevron" size={14} /></>}
                  candidates={subCandidates(s.cards.values(), s.decks, card)} empty="No tasks to attach"
                  onPick={(c) => kids.change((cur) => (cur.includes(c.id) ? cur : [...cur, c.id]))} />
              </>
            )}
          </div>
        )}
        {adding && !off && (
          <input ref={input} className="num-inline rel-new" aria-label="New subtask title" placeholder="Title, then Enter (Esc closes)"
            maxLength={500} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} onKeyDown={onKey} />
        )}
        {children.length === 0 ? <p className="muted">No subtasks.</p> : (
          <ul className="rel-list" aria-label="Subtasks">
            {shown.map((c) => {
              const st = derivedStatus(c, open.get(c.id) ?? new Set());
              const t = shownTitle(c) || 'Untitled';
              return (
                <li key={c.id} className="rel-item">
                  {st && <span className={`status-badge status-${st}`} title={STATUS_LABEL[st]}><span className="sr-only">{STATUS_LABEL[st]}</span></span>}
                  <Link href={cardHref(c, c.deckId ? s.decks.get(c.deckId) : undefined)} className="rel-title">{shownTitle(c) ? <InlineTitle text={t} /> : t}</Link>
                  <span className="code muted">{taskId(c)}</span>
                  {!off && (
                    <button type="button" className="chip-x" aria-label={`Remove subtask ${t}`} title="Detach from this main task"
                      onClick={() => kids.change((cur) => cur.filter((x) => x !== c.id))}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              );
            })}
            {shown.length === 0 && <li className="muted">No subtasks match.</li>}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ label, extra, children }: { label: string; extra?: ReactNode; children: ReactNode }) {
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

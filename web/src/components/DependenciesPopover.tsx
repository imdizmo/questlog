import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Card } from '../../../shared/types';
import { cardCode, titleOf } from '../../../shared/cards';
import { dispatch } from '../api';
import { store, useStore } from '../store';
import { Link } from '../router';
import { cardHref } from '../cards';
import { usePendingList } from '../pending';
import { depCandidates, liveCardIds, lockedByCard, lockersOf } from '../relations';
import { CardPicker } from './CardPicker';
import { Icon } from './icons';
import { useShownTitle } from '../translate';

/** Only cards we still hold and that are not deleted (read at send time): the server refuses a deleted locker. */
const liveIds = (ids: string[]) => liveCardIds(store.get().cards, ids);

/**
 * The "in · out" dependency badge under a card's title. It opens a popover listing the cards that lock
 * this one (stored on this card as inDeps) and the cards this one locks (stored on each of them).
 */
export function DependencyBadge({ card, editable }: { card: Card; editable: boolean }) {
  const shownTitle = useShownTitle();
  const s = useStore((x) => x);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = useId();
  const off = !editable || card.visibility === 'deleted';

  const storedIn = useMemo(() => lockersOf(s.cardDeps.values(), card.id).sort(), [s.cardDeps, card.id]);
  const outIds = useMemo(() => lockedByCard(s.cardDeps.values(), card.id), [s.cardDeps, card.id]);
  // inDeps is one whole array: quick adds and removes build on each other.
  const ins = usePendingList(storedIn, (inDeps) => dispatch('cards', 'update', { id: card.id, inDeps: liveIds(inDeps) }));
  // The store's deps with this card's own lockers taken from the pending draft (just-picked ones count).
  const deps = useMemo(() => [
    ...[...s.cardDeps.values()].filter((d) => d.lockedCardId !== card.id),
    ...ins.value.map((l) => ({ lockedCardId: card.id, lockingCardId: l })),
  ], [s.cardDeps, ins.value, card.id]);
  const locking = ins.value.map((id) => s.cards.get(id)).filter((c): c is Card => !!c);
  const locked = outIds.map((id) => s.cards.get(id)).filter((c): c is Card => !!c);

  /** "Locked by this card" lives on the other card: rewrite its inDeps. */
  const setLocks = (target: Card, on: boolean) => {
    const cur = liveIds(lockersOf(s.cardDeps.values(), target.id));
    const inDeps = on ? [...new Set([...cur, card.id])] : cur.filter((x) => x !== card.id);
    void dispatch('cards', 'update', { id: target.id, inDeps }).catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    // Focus moves into the popover; Esc brings it back to the badge.
    pop.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const blocking = locking.filter((c) => c.status !== 'done').length;
  const deckOf = (c: Card) => (c.deckId ? s.decks.get(c.deckId) : undefined);
  const row = (c: Card, remove: () => void, what: string) => {
    const t = shownTitle(c) || 'Untitled';
    return (
      <li key={c.id} className={`rel-item${c.status === 'done' ? ' is-done' : ''}`}>
        <Icon name={c.status === 'done' ? 'check' : 'lock'} size={14} />
        <Link href={cardHref(c, deckOf(c))} className="rel-title">{t}</Link>
        <span className="code muted">{taskId(c)}</span>
        {!off && (
          <button type="button" className="chip-x" aria-label={`Remove ${what} ${t}`} onClick={remove}><Icon name="close" size={12} /></button>
        )}
      </li>
    );
  };

  return (
    <div className="dep-wrap" ref={wrap}>
      <button ref={button} type="button" className={`dep-badge${blocking ? ' locked' : ''}`} data-testid="dep-badge"
        aria-label={`Dependencies: ${locking.length} locking this task, ${locked.length} locked by this task`}
        title="Dependencies: locking · locked by this task" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}>
        <Icon name="lock" size={13} />
        <span>{locking.length} · {locked.length}</span>
      </button>
      {open && (
        <div id={popId} ref={pop} role="dialog" aria-label="Dependencies" className="dep-pop" tabIndex={-1}>
          <section className="dep-section">
            <div className="prop-head">
              <h4 className="prop-label">Locking dependencies</h4>
              {!off && (
                <CardPicker label="Add locking task" trigger={<><Icon name="plus" size={14} /> Add</>}
                  candidates={depCandidates(s.cards.values(), s.decks, card, deps, 'locking')} empty="No tasks to choose from"
                  onPick={(c) => ins.change((cur) => (cur.includes(c.id) ? cur : [...cur, c.id]))} />
              )}
            </div>
            <p className="hint">This task waits for these.</p>
            {locking.length ? (
              <ul className="rel-list" aria-label="Locking dependencies">
                {locking.map((c) => row(c, () => ins.change((cur) => cur.filter((x) => x !== c.id)), 'locking task'))}
              </ul>
            ) : <p className="muted">Nothing locks this task.</p>}
          </section>
          <section className="dep-section">
            <div className="prop-head">
              <h4 className="prop-label">Locked by this task</h4>
              {!off && (
                <CardPicker label="Add locked task" trigger={<><Icon name="plus" size={14} /> Add</>}
                  candidates={depCandidates(s.cards.values(), s.decks, card, deps, 'locked')} empty="No tasks to choose from"
                  onPick={(c) => setLocks(c, true)} />
              )}
            </div>
            <p className="hint">These wait for this task.</p>
            {locked.length ? (
              <ul className="rel-list" aria-label="Locked by this task">
                {locked.map((c) => row(c, () => setLocks(c, false), 'locked task'))}
              </ul>
            ) : <p className="muted">This task locks nothing.</p>}
          </section>
        </div>
      )}
    </div>
  );
}

import { taskId } from '../taskId';
import { useMemo } from 'react';
import { titleOf, cardCode } from '../../../shared/cards';
import { dispatch } from '../api';
import { cardHref, formatTime } from '../cards';
import { Link } from '../router';
import { useMinuteClock } from '../clock';
import { inboxRows, useStore } from '../store';
import { Icon } from '../components/icons';
import { useShownTitle } from '../translate';

const CONTEXT = { block: 'Blocker', review: 'Review', comment: 'Comment' } as const;

/** Threads waiting for me: unseen messages or a due reminder, minus the muted and snoozed. */
export function Inbox() {
  const shownTitle = useShownTitle();
  const state = useStore((s) => s);
  const now = useMinuteClock();
  const rows = useMemo(() => inboxRows(state, now), [state.notifications, state.resolvables, state.cards, state.me, now]);
  const act = (action: string, payload: object) => { void dispatch('resolvables', action, payload).catch(() => {}); };

  return (
    <main className="page page-narrow" id="main">
      <div className="page-head"><div><p className="eyebrow"><Link href="/decks">← Lists</Link></p><h1>Inbox</h1></div></div>
      {rows.length === 0 ? (
        <div className="empty"><h2>All caught up</h2><p>Threads you are part of show up here when they have something new.</p></div>
      ) : (
        <ul className="inbox-list" aria-label="Threads waiting for you">
          {rows.map(({ resolvable: r, card, note }) => {
            const deck = card.deckId ? state.decks.get(card.deckId) : undefined;
            const last = [...state.entries.values()].filter((e) => e.resolvableId === r.id).sort((a, b) => b.createdAt - a.createdAt)[0];
            const authors = note.unseenAuthors.map((id) => state.users.get(id)?.name ?? 'Someone');
            return (
              <li key={r.id} className="inbox-row" data-testid="inbox-row">
                <div className="inbox-main">
                  <div className="inbox-top">
                    <span className="badge">{CONTEXT[r.context]}</span>
                    <span className="code-chip">{taskId(card)}</span>
                    <strong>{shownTitle(card) || 'Untitled'}</strong>
                    {note.unseenEntryCount > 0 && <span className="tab-count" title="Unseen messages">{note.unseenEntryCount}</span>}
                  </div>
                  {last && (
                    <p className="inbox-last">
                      <span className="muted">{state.users.get(last.authorId)?.name ?? 'Someone'} · {formatTime(last.createdAt)}:</span> {last.content}
                    </p>
                  )}
                  {authors.length > 0 && <p className="muted inbox-authors">New from {[...new Set(authors)].join(', ')}</p>}
                </div>
                <div className="inbox-actions">
                  <Link href={`${cardHref(card, deck)}?tab=conversations`} className="btn btn-sm btn-primary">Open</Link>
                  <button type="button" className="btn btn-sm" onClick={() => act('snooze', { resolvableId: r.id })}>Snooze</button>
                  <button type="button" className="btn btn-sm" onClick={() => act('setMuted', { resolvableId: r.id, isMuted: true })}>Mute</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

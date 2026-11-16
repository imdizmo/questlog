import type { Card, Sprint, User } from '../../shared/types';
import { dispatch } from './api';
import type { State } from './store';

/** The cards in a person's Hand, in slot order (cards this client can't see are left out). */
export function handOf(s: State, userId: string): Card[] {
  return [...s.handCards.values()]
    .filter((h) => h.userId === userId)
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((h) => s.cards.get(h.cardId))
    .filter((c): c is Card => !!c && c.visibility !== 'deleted');
}

export const setBookmark = (userId: string, cardId: string, on: boolean) =>
  dispatch('bookmarks', on ? 'addCards' : 'removeCards', { userId, ids: [cardId] }).catch(() => {});

export const userName = (u: User | undefined) => u?.name ?? 'Someone';

/** Runs that are running on `today` (YYYY-MM-DD): started, not past their last day, not finished. */
export const currentRuns = (s: State, today: string): Sprint[] =>
  [...s.sprints.values()].filter((r) => !r.isFinished && r.startDay <= today && today <= r.endDay);

/** My open cards (owner me, not done) in the runs that are running today and visible to me. */
export function runCardsFor(s: State, userId: string, today = localToday()): Card[] {
  const ids = new Set(currentRuns(s, today).map((r) => r.id));
  if (!ids.size) return [];
  return [...s.cards.values()].filter((c) => !!c.sprintId && ids.has(c.sprintId) && c.assigneeId === userId && c.status !== 'done' && c.visibility === 'default');
}

/** My open cards in one run. */
export const myCardsInRun = (s: State, userId: string, runId: string): Card[] =>
  [...s.cards.values()].filter((c) => c.sprintId === runId && c.assigneeId === userId && c.status !== 'done' && c.visibility === 'default');

const localToday = () => new Date().toLocaleDateString('sv-SE');

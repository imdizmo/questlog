import type { AccountSettings, Card, Priority } from './types';

export const PRIORITY_ORDER: Priority[] = ['c', 'b', 'a'];

type Sets = Pick<AccountSettings, 'effortScale' | 'fallbackEffort'>;

export function effortScale(settings: Pick<AccountSettings, 'effortScale'>): number[] {
  switch (settings.effortScale) {
    case 'linear': return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    case 'exponential': return [0, 1, 2, 4, 8, 16];
    default: return [0, 1, 2, 3, 5, 8];
  }
}

export function cardEffort(card: Pick<Card, 'effort'>, settings: Pick<Sets, 'fallbackEffort'>): number {
  return card.effort ?? settings.fallbackEffort;
}

/** A hero's effort: its own (or fallback) plus every sub card's (or fallback). */
export function heroEffort(
  hero: Pick<Card, 'effort'>,
  children: Pick<Card, 'effort'>[],
  settings: Pick<Sets, 'fallbackEffort'>,
): number {
  return children.reduce((sum, c) => sum + cardEffort(c, settings), cardEffort(hero, settings));
}

export function priorityLabel(p: Priority, settings: Pick<AccountSettings, 'priorityLabels'>): string {
  return settings.priorityLabels[p];
}

/** Plain YYYY-MM-DD comparison; lexicographic order is chronological. */
export function isPastDate(day: string, today: string): boolean {
  return day < today;
}

export function isHero(cardId: string, cards: Pick<Card, 'id' | 'parentCardId'>[]): boolean {
  return cards.some((c) => c.parentCardId === cardId);
}

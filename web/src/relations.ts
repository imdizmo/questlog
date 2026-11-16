import type { Card, Deck } from '../../shared/types';
import type { CardDep } from './store';

type Decks = Map<string, Pick<Deck, 'id' | 'projectId'>>;
type Rel = Pick<Card, 'id' | 'deckId' | 'parentCardId' | 'isDoc' | 'visibility' | 'seq'>;

const projectOf = (decks: Decks, c: Pick<Card, 'deckId'>) => (c.deckId ? decks.get(c.deckId)?.projectId ?? null : null);

/** The card's sub cards (the store holds no deleted cards), in card-number order. */
export function childrenOf<C extends Rel>(cards: Iterable<C>, id: string): C[] {
  return [...cards].filter((c) => c.parentCardId === id).sort((a, b) => a.seq - b.seq);
}

/** Ids of the card's hero, the hero's hero, … (stops on a loop). */
function ancestors(byId: Map<string, Rel>, card: Rel): Set<string> {
  const out = new Set<string>();
  for (let p = card.parentCardId; p && !out.has(p); p = byId.get(p)?.parentCardId ?? null) out.add(p);
  return out;
}

/** Live task cards of the card's project, other than the card. Hierarchy and dependencies never cross projects. */
function sameProject<C extends Rel>(cards: C[], decks: Decks, card: Rel, tasksOnly: boolean): C[] {
  const p = projectOf(decks, card);
  if (!p) return [];
  return cards.filter((c) => c.id !== card.id && c.visibility === 'default' && (!tasksOnly || !c.isDoc) && projectOf(decks, c) === p);
}

/** Cards that may become this card's hero: not the card, its current hero, or anything below it (a loop). */
export function heroCandidates<C extends Rel>(all: Iterable<C>, decks: Decks, card: Rel): C[] {
  const cards = [...all];
  const byId = new Map<string, Rel>(cards.map((c) => [c.id, c]));
  return sameProject(cards, decks, card, true).filter((c) => c.id !== card.parentCardId && !ancestors(byId, c).has(card.id));
}

/** Cards that may be attached as sub cards: not the card's own heroes (a loop) and not its sub cards already. */
export function subCandidates<C extends Rel>(all: Iterable<C>, decks: Decks, card: Rel): C[] {
  const cards = [...all];
  const up = ancestors(new Map<string, Rel>(cards.map((c) => [c.id, c])), card);
  return sameProject(cards, decks, card, true).filter((c) => !up.has(c.id) && c.parentCardId !== card.id);
}

/** Every card reachable from `id` by following `next` (the start itself left out; stops on loops). */
function reach(deps: CardDep[], id: string, next: (d: CardDep, from: string) => string | null): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of deps) {
      const n = next(d, cur);
      if (n && n !== id && !out.has(n)) { out.add(n); stack.push(n); }
    }
  }
  return out;
}

/**
 * Cards that could lock this card ('locking') or that this card could lock ('locked'). Leaves out the ones
 * already linked that way, and every card that would close a loop: a new locker must not be something this
 * card already (transitively) locks, and a newly locked card must not (transitively) lock this card.
 */
export function depCandidates<C extends Rel>(all: Iterable<C>, decks: Decks, card: Rel, deps: Iterable<CardDep>, dir: 'locking' | 'locked'): C[] {
  const list = [...deps];
  const downstream = reach(list, card.id, (d, from) => (d.lockingCardId === from ? d.lockedCardId : null));
  const upstream = reach(list, card.id, (d, from) => (d.lockedCardId === from ? d.lockingCardId : null));
  const direct = dir === 'locking' ? lockersOf(list, card.id) : lockedByCard(list, card.id);
  const loop = dir === 'locking' ? downstream : upstream;
  return sameProject([...all], decks, card, false).filter((c) => !direct.includes(c.id) && !loop.has(c.id));
}

/** The ids whose card is in `cards` and not deleted (what a whole-array deps write may send). */
export const liveCardIds = (cards: Map<string, Pick<Card, 'visibility'>>, ids: string[]): string[] =>
  ids.filter((id) => { const c = cards.get(id); return !!c && c.visibility !== 'deleted'; });

/** Ids of the cards that lock this one (its inDeps). */
export const lockersOf = (deps: Iterable<CardDep>, id: string): string[] =>
  [...deps].filter((d) => d.lockedCardId === id).map((d) => d.lockingCardId);
/** Ids of the cards this one locks. */
export const lockedByCard = (deps: Iterable<CardDep>, id: string): string[] =>
  [...deps].filter((d) => d.lockingCardId === id).map((d) => d.lockedCardId);

/** Locking cards that are not done yet (what makes a card locked). */
export function unfinishedLockers<C extends Pick<Card, 'id' | 'status'>>(deps: Iterable<CardDep>, cards: Map<string, C>, id: string): C[] {
  return lockersOf(deps, id).map((l) => cards.get(l)).filter((c): c is C => !!c && c.status !== 'done');
}

export const subCountLabel = (n: number) => `${n} subtask${n === 1 ? '' : 's'}`;

/** 512 B, 2 KB, 5.3 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

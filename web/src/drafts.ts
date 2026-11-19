import { useSyncExternalStore } from 'react';

/**
 * Unsaved text drafts by person and card, so an editor that unmounts mid-edit (a wiki panel replaced, folded, closed, or made
 * the main entry) gets its text back, and its version, when the card's editor mounts again. Kept for this tab only,
 * at most MAX cards (the least recently touched go first); a draft is dropped when it is saved or cancelled, and all of
 * them when the session ends (store.reset: logout, an expired session, a disabled user), so the next person to sign in
 * on this tab never sees them. Keyed by user id too, as a second guard. No user (signed out): nothing is kept.
 */
export interface Draft { text: string; base: number }

const MAX = 20;
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const fn of [...listeners]) fn(); };

const keyOf = (userId: string, cardId: string) => `${userId}\u0000${cardId}`;

export const getDraft = (userId: string | null, cardId: string): Draft | undefined => (userId ? drafts.get(keyOf(userId, cardId)) : undefined);
export const hasDraft = (userId: string | null, cardId: string): boolean => !!userId && drafts.has(keyOf(userId, cardId));

export function keepDraft(userId: string | null, cardId: string, text: string, base: number): void {
  if (!userId) return;
  const key = keyOf(userId, cardId);
  const had = drafts.get(key);
  if (had && had.text === text && had.base === base) return;
  drafts.delete(key); // re-inserted last: the Map's order is the LRU order
  drafts.set(key, { text, base });
  let evicted = false;
  while (drafts.size > MAX) { drafts.delete(drafts.keys().next().value as string); evicted = true; }
  if (!had || evicted) emit();
}

export function dropDraft(userId: string | null, cardId: string): void {
  if (userId && drafts.delete(keyOf(userId, cardId))) emit();
}

/** Drops the drafts of cards `live` says are gone (deleted, or no longer in the store). */
export function pruneDrafts(live: (cardId: string) => boolean): void {
  let removed = false;
  for (const key of [...drafts.keys()]) {
    if (!live(key.slice(key.indexOf('\u0000') + 1))) { drafts.delete(key); removed = true; }
  }
  if (removed) emit();
}

/** Forgets every draft (the session ended). */
export function clearDrafts(): void {
  drafts.clear();
  emit();
}

/** Re-renders when a card gains or loses a draft (not on every keystroke). */
export const useDrafts = (): number =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);

/** For tests. */
export const draftCount = (): number => drafts.size;

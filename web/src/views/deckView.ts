import type { DeckView } from '../../../shared/order';

const viewKey = (deckId: string) => `default-search-list-${deckId}`;
const ARCHIVED_KEY = 'default-archived-decks';

/** The view I chose on this browser for a deck (storage may be unavailable or hold junk). */
export function readView(deckId: string): DeckView | null {
  try {
    const raw = localStorage.getItem(viewKey(deckId));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as DeckView) : null;
  } catch {
    return null;
  }
}

/** `null` clears the local choice. */
export function writeView(deckId: string, v: DeckView | null): void {
  try {
    if (v) localStorage.setItem(viewKey(deckId), JSON.stringify(v));
    else localStorage.removeItem(viewKey(deckId));
  } catch { /* a convenience only */ }
}

export function readArchived(): boolean {
  try {
    return localStorage.getItem(ARCHIVED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeArchived(b: boolean): void {
  try {
    localStorage.setItem(ARCHIVED_KEY, String(b));
  } catch { /* a convenience only */ }
}

/** Same view, ignoring unset optional flags and key order. */
export function sameView(a: DeckView, b: DeckView): boolean {
  const flat = (v: DeckView) => JSON.stringify([
    v.prop, v.isReversed, v.mode, !!v.isCompact, !!v.hideEmpty,
    (v.secondary ?? []).map((k) => [k.prop, k.isReversed]),
  ]);
  return flat(a) === flat(b);
}

import { useSyncExternalStore } from 'react';
import { showToast } from './toast';

/** The server takes at most this many cards in one bulk update. */
export const MAX_SELECTED = 500;

export interface Selection { selected: ReadonlySet<string>; anchor: string | null }

let state: Selection = { selected: new Set(), anchor: null };
const listeners = new Set<() => void>();

function set(selected: Set<string>, anchor: string | null) {
  if (selected.size > MAX_SELECTED) {
    showToast(`You can change at most ${MAX_SELECTED} tasks at once.`);
    selected = new Set([...selected].slice(0, MAX_SELECTED));
  }
  state = { selected, anchor };
  // Lets the stylesheet keep every Select button visible while anything is selected.
  document.body.classList.toggle('has-selection', selected.size > 0);
  for (const fn of [...listeners]) fn();
}

export const getSelection = (): Selection => state;
export const useSelection = (): Selection =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSelection);

export function clearSelection(): void {
  if (state.selected.size || state.anchor !== null) set(new Set(), null);
}

/** Plain click: flips one card and makes it the anchor for the next Shift+click. */
export function toggleSelected(id: string): void {
  const next = new Set(state.selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  set(next, id);
}

/** Shift+click: selects everything between the anchor and `id` in the visible order. Without a usable anchor it toggles. */
export function selectRange(id: string, order: readonly string[]): void {
  const a = state.anchor === null ? -1 : order.indexOf(state.anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) { toggleSelected(id); return; }
  const next = new Set(state.selected);
  for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
  set(next, state.anchor);
}

/** A group header's Select: selects all of `ids`, or clears them when they were all selected already. */
export function toggleGroup(ids: readonly string[]): void {
  const next = new Set(state.selected);
  const all = ids.length > 0 && ids.every((x) => next.has(x));
  for (const x of ids) { if (all) next.delete(x); else next.add(x); }
  set(next, state.anchor);
}

/** Drops cards that left the list (archived, filtered out, deleted). */
export function pruneSelection(visible: ReadonlySet<string>): void {
  const keep = [...state.selected].filter((x) => visible.has(x));
  if (keep.length === state.selected.size) return;
  set(new Set(keep), state.anchor !== null && visible.has(state.anchor) ? state.anchor : null);
}

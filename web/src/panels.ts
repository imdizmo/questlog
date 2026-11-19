/**
 * Side-by-side panels in the wiki: entries opened to the right of the entry page, kept in the URL as
 * `?panels=<segment>,<segment>` (entry keys or `$code`s, the last segment of their wiki path), oldest first.
 * Pure helpers; the stack itself is components/wiki/EntryStack.tsx.
 */

export const PANELS_PARAM = 'panels';
/** Panels shown at full size; older ones fold to a narrow strip (so at most this + the main entry are mounted). */
export const PANELS_SHOWN = 3;
/** Panels kept in the URL at most; a longer list (hand-written) keeps its newest. */
export const PANELS_MAX = 12;

/** A key or a `$code`: what entryPath puts after `/wiki/<seq>/`. Anything else in the list is dropped. */
const SEGMENT = /^(\$[0-9a-z]+|[A-Za-z0-9_.-]{1,80})$/;

/** `?panels=` value → segments, oldest first: empty and malformed items and repeats dropped, at most PANELS_MAX. */
export function parsePanels(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const s = raw.trim();
    if (SEGMENT.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(-PANELS_MAX);
}

/** Segments → the `?panels=` value; null when there are none (the parameter goes away). */
export function serialisePanels(list: readonly string[]): string | null {
  const clean = parsePanels(list.join(','));
  return clean.length ? clean.join(',') : null;
}

/**
 * A search string (`?a=1&panels=x`) with `panels` replaced by `list`; '' when nothing is left. Commas and `$` stay
 * readable in the address bar (both are allowed unescaped in a query).
 */
export function withPanels(search: string, list: readonly string[]): string {
  const q = new URLSearchParams(search);
  const v = serialisePanels(list);
  if (v === null) q.delete(PANELS_PARAM);
  else q.set(PANELS_PARAM, v);
  const s = q.toString().replace(/%2C/gi, ',').replace(/%24/g, '$');
  return s ? `?${s}` : '';
}

/**
 * Opening `target` from column `from` (0 = the main entry, 1… = panels) of `[main, ...panels]`: like a column
 * browser, the panels right of `from` are replaced by the target. When it is already open at or left of `from`, or is
 * the very next panel, nothing changes (null), and the caller just brings it into view.
 */
export function openFrom(main: string, panels: readonly string[], from: number, target: string): string[] | null {
  const cols = [main, ...panels];
  const at = cols.indexOf(target);
  if (at !== -1 && (at <= from || at === from + 1)) return null;
  return [...panels.slice(0, Math.max(0, from)), target].slice(-PANELS_MAX);
}

/** Closing column `i` (≥ 1) of `[main, ...panels]`: that panel only; the others keep their place. */
export const closePanel = (panels: readonly string[], i: number): string[] => panels.filter((_, j) => j !== i - 1);

/**
 * "Open full page" on column `i` (≥ 1): it becomes the main entry and the others stay open as panels, in their order
 * (the old main entry first).
 */
export function promotePanel(main: string, panels: readonly string[], i: number): { main: string; panels: string[] } {
  const cols = [main, ...panels];
  const next = cols[i];
  return { main: next, panels: cols.filter((_, j) => j !== i) };
}

/** Column sizes (px) for fitColumns; the CSS uses the same strip width and gap. */
export const STACK = { gap: 12, strip: 40, mainMin: 520, panelMin: 300, panelPref: 440, panelMax: 640 } as const;

/**
 * How the stack fits a row `width` px wide with `panels` panels: the first `strips` columns (the main entry is column 0,
 * then the oldest panels) fold to a titled strip, the rest show in full at `panelWidth` (the main entry, when full,
 * takes what is left, at least STACK.mainMin). Never more than PANELS_SHOWN full panels; columns fold from the left
 * until every full one fits, so no column is ever cut off; the newest panel always stays full.
 * `width` 0 (not measured yet) counts as unlimited.
 */
export function fitColumns(width: number, panels: number): { strips: number; panelWidth: number } {
  if (panels <= 0) return { strips: 0, panelWidth: 0 };
  const w = width > 0 ? width : Infinity;
  const { gap, strip, mainMin, panelMin, panelPref, panelMax } = STACK;
  const first = panels > PANELS_SHOWN ? panels - PANELS_SHOWN + 1 : 0;
  for (let k = first; k <= panels; k++) {
    const full = panels - (k === 0 ? 0 : k - 1);
    const mainFull = k === 0;
    const usable = w - k * (strip + gap) - (mainFull ? mainMin + gap : 0) - (full - 1) * gap;
    const each = Math.floor(Math.min(mainFull ? panelPref : panelMax, usable / full));
    if (each >= panelMin || k === panels) return { strips: k, panelWidth: Number.isFinite(each) ? Math.max(each, 240) : panelPref };
  }
  return { strips: panels, panelWidth: panelMin };
}

/** Esc's way to the wiki's stack: the mounted EntryStack registers how to close its rightmost panel. */
let closer: (() => boolean) | null = null;
/** Registers the closer; the returned function unregisters it (only if it is still the current one). */
export function setPanelCloser(fn: () => boolean): () => void {
  closer = fn;
  return () => { if (closer === fn) closer = null; };
}
/** Closes the rightmost panel of the stack on screen; false when there is none (nothing happens). */
export const closeRightmostPanel = (): boolean => closer?.() ?? false;

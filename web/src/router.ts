import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type Route =
  | { name: 'root' }
  | { name: 'setup' }
  | { name: 'login' }
  | { name: 'join'; token: string }
  | { name: 'decks' }
  | { name: 'inbox' }
  | { name: 'milestones' }
  | { name: 'milestone'; seq: number }
  | { name: 'run'; seq: number }
  | { name: 'milestoneActivity'; seq: number }
  | { name: 'runActivity'; seq: number }
  | { name: 'deck'; deckSeq: number; slug: string }
  | { name: 'activity' }
  | { name: 'deckActivity'; deckSeq: number; slug: string }
  | { name: 'deckCard'; deckSeq: number; slug: string; code: string; cardSlug: string }
  | { name: 'vision' }
  | { name: 'visionBoard'; seq: number }
  | { name: 'card'; code: string; cardSlug: string }
  // The redesign's shell: Home (the vision board in the next phase), a new tab's page.
  | { name: 'home' }
  | { name: 'newTab' }
  // Wiki of a project (by its seq, as /decks/activity?project= does); an entry by its key, or `$code` for keyless Lore.
  | { name: 'wiki' }
  | { name: 'wikiProject'; projectSeq: number }
  | { name: 'wikiEntry'; projectSeq: number; entry: string }
  | { name: 'wikiType'; projectSeq: number; typeKey: string }
  | { name: 'wikiKind'; projectSeq: number; typeKey: string }
  | { name: 'wikiNew'; projectSeq: number; typeKey: string }
  | { name: 'wikiView'; projectSeq: number; view: string }
  // The Wiki's Types page (/view/types), with a type open (/types/<key>).
  | { name: 'wikiTypes'; projectSeq: number; typeKey: string | null }
  // Assets of a project (web/src/views/assets/), by the project's seq like the Wiki.
  | { name: 'assets' }
  | { name: 'assetsProject'; projectSeq: number }
  // Open Decks: public pages, no session needed (web/src/views/open/)
  | { name: 'openGallery' }
  | { name: 'openConfirm'; token: string }
  | { name: 'openProject'; urlName: string }
  | { name: 'openDeck'; urlName: string; seq: number }
  | { name: 'openCard'; urlName: string; code: string }
  | { name: 'notFound'; path: string };

/** The public Open Decks routes: rendered without the workspace (no snapshot, no live socket). */
export const OPEN_ROUTES: ReadonlySet<Route['name']> = new Set(['openGallery', 'openConfirm', 'openProject', 'openDeck', 'openCard']);

export interface Location { route: Route; show: string | null; query: URLSearchParams; path: string }

/** "12-some-slug" → [12, "some-slug"]; the slug part is optional and only decorative. */
const seqSlug = (s: string): [number, string] | null => {
  const m = /^(\d+)(?:-(.*))?$/.exec(s);
  return m ? [Number(m[1]), m[2] ?? ''] : null;
};
/** "1a3-some-slug" → ["1a3", "some-slug"]; card codes are lowercase base-31 without b d i l o. */
const codeSlug = (s: string): [string, string] | null => {
  const m = /^([0-9a-z]+?)(?:-(.*))?$/.exec(s);
  return m ? [m[1], m[2] ?? ''] : null;
};

export function parse(path: string): Route {
  let parts: string[];
  try {
    parts = path.replace(/\/+$/, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: 'notFound', path }; // malformed %-escape
  }
  const [a, b, c, d, e] = parts;
  if (parts.length === 0) return { name: 'root' };
  if (a === 'setup' && parts.length === 1) return { name: 'setup' };
  if (a === 'login' && parts.length === 1) return { name: 'login' };
  if (a === 'join' && b && parts.length === 2) return { name: 'join', token: b };
  if (a === 'inbox' && parts.length === 1) return { name: 'inbox' };
  if (a === 'home' && parts.length === 1) return { name: 'home' };
  if (a === 'new' && parts.length === 1) return { name: 'newTab' };
  if (a === 'milestones' && parts.length === 1) return { name: 'milestones' };
  if (a === 'milestones' && b === 'run' && c && /^\d+$/.test(c) && d === 'activity' && parts.length === 4) return { name: 'runActivity', seq: Number(c) };
  if (a === 'milestones' && b && /^\d+$/.test(b) && c === 'activity' && parts.length === 3) return { name: 'milestoneActivity', seq: Number(b) };
  if (a === 'milestones' && b === 'run' && c && /^\d+$/.test(c) && parts.length === 3) return { name: 'run', seq: Number(c) };
  if (a === 'milestones' && b && /^\d+$/.test(b) && parts.length === 2) return { name: 'milestone', seq: Number(b) };
  if (a === 'decks') {
    if (parts.length === 1) return { name: 'decks' };
    if (b === 'activity' && parts.length === 2) return { name: 'activity' };
    const ds = seqSlug(b);
    if (ds && c === 'activity' && parts.length === 3) return { name: 'deckActivity', deckSeq: ds[0], slug: ds[1] };
    if (ds && parts.length === 2) return { name: 'deck', deckSeq: ds[0], slug: ds[1] };
    const cs = d ? codeSlug(d) : null;
    if (ds && c === 'card' && cs && !e) return { name: 'deckCard', deckSeq: ds[0], slug: ds[1], code: cs[0], cardSlug: cs[1] };
  }
  if (a === 'open') {
    if (parts.length === 1) return { name: 'openGallery' };
    if (b === 'confirm' && c && parts.length === 3) return { name: 'openConfirm', token: c };
    if (b && /^[a-z0-9-]+$/.test(b)) {
      if (parts.length === 2) return { name: 'openProject', urlName: b };
      if (c === 'deck' && d && /^\d+$/.test(d) && parts.length === 4) return { name: 'openDeck', urlName: b, seq: Number(d) };
      const cs = d ? codeSlug(d) : null;
      if (c === 'card' && cs && parts.length === 4) return { name: 'openCard', urlName: b, code: cs[0] };
    }
  }
  if (a === 'vision' && parts.length === 1) return { name: 'vision' };
  if (a === 'vision' && b && /^\d+$/.test(b) && Number(b) > 0 && parts.length === 2) return { name: 'visionBoard', seq: Number(b) };
  if (a === 'wiki') {
    if (parts.length === 1) return { name: 'wiki' };
    if (b && /^\d+$/.test(b) && Number(b) > 0) {
      if (parts.length === 2) return { name: 'wikiProject', projectSeq: Number(b) };
      if (c === 'type' && d && parts.length === 4) return { name: 'wikiType', projectSeq: Number(b), typeKey: d };
      if (c === 'kind' && d && parts.length === 4) return { name: 'wikiKind', projectSeq: Number(b), typeKey: d };
      if (c === 'new' && d && parts.length === 4) return { name: 'wikiNew', projectSeq: Number(b), typeKey: d };
      if (c === 'view' && d === 'types' && parts.length === 4) return { name: 'wikiTypes', projectSeq: Number(b), typeKey: null };
      if (c === 'types' && d && parts.length === 4) return { name: 'wikiTypes', projectSeq: Number(b), typeKey: d };
      if (c === 'view' && d && parts.length === 4) return { name: 'wikiView', projectSeq: Number(b), view: d };
      if (c && parts.length === 3) return { name: 'wikiEntry', projectSeq: Number(b), entry: c };
    }
  }
  if (a === 'assets' && parts.length === 1) return { name: 'assets' };
  if (a === 'assets' && b && /^\d+$/.test(b) && Number(b) > 0 && parts.length === 2) return { name: 'assetsProject', projectSeq: Number(b) };
  if (a === 'card' && b && parts.length === 2) {
    const cs = codeSlug(b);
    if (cs) return { name: 'card', code: cs[0], cardSlug: cs[1] };
  }
  return { name: 'notFound', path };
}

const hasWindow = typeof window !== 'undefined';
let current: Location = hasWindow ? read() : { route: { name: 'root' }, show: null, query: new URLSearchParams(), path: '/' };
const listeners = new Set<() => void>();

function read(): Location {
  const query = new URLSearchParams(location.search);
  return { route: parse(location.pathname), show: query.get('show'), query, path: location.pathname };
}
function update() {
  current = read();
  for (const fn of [...listeners]) fn();
}

/**
 * The tabs (web/src/tabRuntime.ts) keep each tab's own back and forward. While they run, every navigate() goes to the
 * active tab (which may answer with another tab's page: the Home tab stays home), and the browser's back and forward
 * step through the active tab's pages. Each history entry carries a serial that only grows, so a popstate tells back
 * from forward; the address bar always shows the active tab's page.
 */
export interface HistoryKeeper {
  /** A navigation in the active tab; returns the page to show. */
  go(url: string, replace: boolean): string;
  /** The browser's back (-1) or forward (1); returns the page to show, or null when the tab had nowhere to go. */
  pop(dir: -1 | 1): string | null;
}
let keeper: HistoryKeeper | null = null;
let serial = 0;
/** The next popstate is our own undo of a step the active tab could not take. */
let undoing = false;
const nextSerial = () => (serial = Math.max(Date.now(), serial + 1));
const here = () => location.pathname + location.search + location.hash;

export function setHistoryKeeper(k: HistoryKeeper | null): void {
  keeper = k;
  if (k && hasWindow) {
    const s = (history.state as { qlSerial?: unknown } | null)?.qlSerial;
    if (typeof s === 'number') serial = Math.max(serial, s);
    else history.replaceState({ qlSerial: nextSerial() }, '', here());
  }
}

/** Shows `url` without a history step (a tab switch, a tab's back or forward). */
export function showUrl(url: string): void {
  if (url !== here()) history.replaceState({ qlSerial: serial }, '', url);
  update();
}

if (hasWindow) window.addEventListener('popstate', (e) => {
  if (keeper) {
    const s = (e.state as { qlSerial?: unknown } | null)?.qlSerial;
    if (undoing) {
      undoing = false;
      if (typeof s === 'number') serial = s;
      return;
    }
    if (typeof s !== 'number') {
      // An entry the app did not make (a #fragment link, a script's pushState): a visit in the active tab.
      const show = keeper.go(here(), false);
      history.replaceState({ qlSerial: nextSerial() }, '', show);
    } else {
      const dir = s > serial ? 1 : -1;
      const show = keeper.pop(dir);
      if (show === null) {
        // Back on a tab's first page (no tab it came from): step the browser back where it was, so the browser's own
        // history is not used up by steps that do nothing.
        undoing = true;
        history.go(-dir);
        return;
      }
      serial = s;
      history.replaceState({ qlSerial: serial }, '', show);
    }
  }
  update();
});

/**
 * Home's split pane (web/src/views/HomePane.tsx) takes in some navigations while it shows a page: given one, it answers
 * the address to show instead (Home's, with the page in the pane), or null to let it be.
 */
let detour: ((url: URL, replace: boolean) => string | null) | null = null;
export function setDetour(fn: typeof detour): void { detour = fn; }

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  let url = new URL(to, location.origin);
  const instead = detour?.(url, !!opts.replace);
  if (instead) url = new URL(instead, location.origin);
  if (url.origin !== location.origin) return; // never another site (history would refuse it anyway)
  if (url.pathname + url.search === location.pathname + location.search) return;
  let show = url.pathname + url.search + url.hash;
  if (keeper) show = keeper.go(show, !!opts.replace);
  if (show === here()) { update(); return; }
  if (opts.replace) history.replaceState({ qlSerial: serial }, '', show);
  else history.pushState({ qlSerial: nextSerial() }, '', show);
  update();
}

/** Sets or clears one query parameter (e.g. `show=accountSettings`) on the current path. */
export function setQuery(key: string, value: string | null): void {
  const q = new URLSearchParams(location.search);
  if (value === null) q.delete(key);
  else q.set(key, value);
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ''));
}

export const useLocation = (): Location =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => current);

/** Opens a page in a new tab in the background (set by the tabs while they run). */
let tabOpener: ((href: string) => void) | null = null;
export function setTabOpener(fn: ((href: string) => void) | null): void { tabOpener = fn; }
export function openInTab(href: string): boolean {
  if (!tabOpener) return false;
  tabOpener(href);
  return true;
}
/** Ctrl/⌘+click or a middle click: a new tab (in the app while the tabs run, else the browser's). */
export const isNewTabClick = (e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  (e.button === 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) || e.button === 1;

/**
 * In-app link: a real <a href> (copy link works) that routes without reloading. Ctrl/⌘+click and a middle click open
 * the page in a new tab beside the others.
 */
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented || props.target) return;
    if (isNewTabClick(e) && openInTab(props.href)) { e.preventDefault(); return; }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.href);
  };
  const onAuxClick = (e: MouseEvent<HTMLAnchorElement>) => {
    props.onAuxClick?.(e);
    if (e.defaultPrevented || props.target || e.button !== 1) return;
    if (openInTab(props.href)) e.preventDefault();
  };
  return createElement('a', { ...props, onClick, onAuxClick });
}

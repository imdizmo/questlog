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
  // Wiki of a project (by its seq, as /decks/activity?project= does); an entry by its key, or `$code` for keyless Lore.
  | { name: 'wiki' }
  | { name: 'wikiProject'; projectSeq: number }
  | { name: 'wikiEntry'; projectSeq: number; entry: string }
  | { name: 'wikiType'; projectSeq: number; typeKey: string }
  | { name: 'wikiKind'; projectSeq: number; typeKey: string }
  | { name: 'wikiNew'; projectSeq: number; typeKey: string }
  | { name: 'wikiView'; projectSeq: number; view: string }
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
      if (c === 'view' && d && parts.length === 4) return { name: 'wikiView', projectSeq: Number(b), view: d };
      if (c && parts.length === 3) return { name: 'wikiEntry', projectSeq: Number(b), entry: c };
    }
  }
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
if (hasWindow) window.addEventListener('popstate', update);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  if (url.pathname + url.search === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', url.pathname + url.search + url.hash);
  else history.pushState(null, '', url.pathname + url.search + url.hash);
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

/** In-app link: a real <a href> (middle-click, copy link work) that routes without reloading. */
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || props.target) return;
    e.preventDefault();
    navigate(props.href);
  };
  return createElement('a', { ...props, onClick });
}

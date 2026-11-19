/**
 * Home's split view (web/src/views/HomePane.tsx): a page opened from Home's work or "Recently worked on" shows in a pane
 * on Home's right, in the same tab. The page is in Home's address, `/home?side=/decks/4-creatures`, so the tab's Back
 * and Forward step through it and a reload keeps it; the page's own query (`?panel=`, `?panels=`, `?search=`) sits
 * beside `side`, where the page reads it as it would on its own. Pure, unit tested (tests/web-home-split.test.ts).
 */
import { OPEN_ROUTES, parse, type Route } from './router';

export const SIDE = 'side';
/** Home's own query: kept when the pane's page changes; the rest belongs to the page. */
const HOME_KEYS = new Set(['board', SIDE]);
/** Pages that never show in the pane: Home itself, a new tab's page, redirects and the signed-out ones. */
const NOT_BESIDE = new Set<Route['name']>(['home', 'newTab', 'vision', 'visionBoard', 'setup', 'login', 'join', ...OPEN_ROUTES]);

export const PANE_MIN = 360;
export const HOME_MIN = 360;
export const PANE_DEFAULT = 560;
/** Below this window width the pane covers Home. */
export const NARROW = 900;

/**
 * A same-site path as the browser would resolve it, or null: one with dot segments (`/.//evil.example/x` resolves to
 * `//evil.example/x`, another site), a query, a malformed escape: anything that would not stay the same.
 */
function plainPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) return null;
  try {
    const u = new URL(path, 'http://x');
    // Compared decoded: `ö` and `%C3%B6` are the same path; a dot segment that went away is not.
    return u.origin === 'http://x' && !u.pathname.startsWith('//') && decodeURI(u.pathname) === decodeURI(path) ? u.pathname : null;
  } catch { return null; } // a malformed %-escape
}

/** The page a same-site path shows beside Home, or null (another site, Home itself, a page that can't sit there). */
export function besideRoute(path: string): Route | null {
  const p = plainPath(path);
  if (!p || p.startsWith('/api/')) return null;
  const r = parse(p);
  return NOT_BESIDE.has(r.name) ? null : r;
}

/** The pane's page from Home's query: its path and route, or null when there is none (or it can't show there). */
export function sideOf(query: URLSearchParams): { path: string; route: Route } | null {
  const path = plainPath(query.get(SIDE) ?? '');
  const route = path ? besideRoute(path) : null;
  return path && route ? { path, route } : null;
}

const write = (q: URLSearchParams) => {
  const s = q.toString().replace(/%2F/gi, '/'); // `side=/decks/4` reads better than `side=%2Fdecks%2F4`, and is the same
  return `/home${s ? `?${s}` : ''}`;
};

/**
 * Home's address with `href` in the pane (null: the pane closed): Home's board kept, the page's own query beside `side`.
 * `href` may carry Home's query too (a page that adds `location.search` to its own path): Home's keys in it are dropped.
 */
export function withSide(homeSearch: string, href: string | null): string {
  const home = new URLSearchParams(homeSearch);
  const q = new URLSearchParams();
  const board = home.get('board');
  if (board) q.set('board', board);
  if (href) {
    const u = new URL(href, 'http://x');
    q.set(SIDE, u.pathname);
    for (const [k, v] of u.searchParams) if (!HOME_KEYS.has(k)) q.append(k, v);
  }
  return write(q);
}

/** Home's address with another board picked (null: Home's own), the page beside it kept. */
export function withBoard(homeSearch: string, board: number | null): string {
  const q = new URLSearchParams(homeSearch);
  if (board) q.set('board', String(board)); else q.delete('board');
  return write(q);
}

/** The pane's page as an address of its own (for its own tab): its path and its query, without Home's. */
export function paneUrl(homeSearch: string): string | null {
  const home = new URLSearchParams(homeSearch);
  const side = sideOf(home);
  if (!side) return null;
  const q = new URLSearchParams();
  for (const [k, v] of home) if (!HOME_KEYS.has(k)) q.append(k, v);
  const s = q.toString();
  return side.path + (s ? `?${s}` : '');
}

/** The pane's width, so neither it nor Home gets too small; with no room for both, the pane's least. */
export function clampPane(w: number, total: number): number {
  const most = Math.max(PANE_MIN, total - HOME_MIN);
  return Math.round(Math.min(most, Math.max(PANE_MIN, Number.isFinite(w) ? w : PANE_DEFAULT)));
}

/** The pane's width after a key on the divider (it sits on the pane's left: Left widens it), or null for another key. */
export function paneKey(key: string, w: number, total: number, big: boolean): number | null {
  const step = big ? 120 : 24;
  switch (key) {
    case 'ArrowLeft': return clampPane(w + step, total);
    case 'ArrowRight': return clampPane(w - step, total);
    case 'Home': return clampPane(PANE_MIN, total);
    case 'End': return clampPane(total - HOME_MIN, total);
    default: return null;
  }
}

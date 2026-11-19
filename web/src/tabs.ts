/**
 * The tabs beside the workspace switcher: each tab is one Questlog page with its own back and forward. Pure functions
 * over an immutable list (web/src/tabRuntime.ts connects them to the router and the person's preferences), so the rules
 * are unit tested on their own (tests/web-tabs.test.ts):
 * - the Home tab is pinned first and stays home: a page opened from it opens in a tab of its own (or the tab already
 *   showing it); a change of only the query (a dialog, the workspace menu) stays on Home;
 * - at most TAB_CAP tabs: opening one more closes the oldest unpinned tab, and says which;
 * - each tab keeps its newest HIST_MAX pages in memory and HIST_SAVED of them across a restart.
 */
export const TAB_CAP = 12;
export const HIST_MAX = 20;
export const HIST_SAVED = 8;
/** Longer addresses are not saved (a long search); the tab keeps them until the page is closed. */
export const URL_SAVED_MAX = 512;
export const HOME_URL = '/home';
export const NEW_TAB_URL = '/new';
/** The saved tabs stay well under the server's cap for one preference (shared/prefs.ts MAX_PREF_BYTES, 32 KB). */
export const SAVED_MAX_BYTES = 24 * 1024;

/** `opener`: the tab this one was opened from; Back on a tab's first page goes back to it. */
export interface Tab { id: string; hist: string[]; at: number; pinned: boolean; home: boolean; opener?: string }
export interface Tabs { list: Tab[]; active: string }
/** The result of opening something: `closed` is the page of a tab the cap closed. */
export interface Step { tabs: Tabs; closed?: string }

export const current = (t: Tab): string => t.hist[t.at];
/** "/decks/3-x?search=a#b" → "/decks/3-x". */
export const pathOf = (url: string): string => url.replace(/[?#].*$/, '');
const sameSite = (u: unknown): u is string => typeof u === 'string' && /^\/(?!\/)/.test(u) && !/[\s\\]/.test(u);

const homeTab = (id: () => string): Tab => ({ id: id(), hist: [HOME_URL], at: 0, pinned: true, home: true });
const pageTab = (url: string, id: () => string, pinned = false): Tab => ({ id: id(), hist: [url], at: 0, pinned, home: false });
const activeOf = (t: Tabs): Tab => t.list.find((x) => x.id === t.active) ?? t.list[0];
const replaceTab = (t: Tabs, tab: Tab): Tabs => ({ ...t, list: t.list.map((x) => (x.id === tab.id ? tab : x)) });

/** First start: Home, and the page asked for in its own tab (unless that is Home). */
export function freshTabs(url: string, id: () => string): Tabs {
  const home = homeTab(id);
  if (pathOf(url) === HOME_URL) return { list: [{ ...home, hist: [url] }], active: home.id };
  const page = pageTab(url, id);
  return { list: [home, page], active: page.id };
}

/**
 * A page in a new tab, in front or behind. Past TAB_CAP the oldest unpinned tab closes; only when every other tab is
 * pinned does the one showing close, and then the new tab comes to the front in its place; when every tab is pinned, the
 * oldest pinned one closes (never Home).
 */
export function openTab(t: Tabs, url: string, focus: boolean, id: () => string): Step {
  const tab = { ...pageTab(url, id), opener: t.active };
  let list = [...t.list, tab];
  let closed: string | undefined;
  if (list.length > TAB_CAP) {
    const i = list.findIndex((x) => !x.pinned && x.id !== tab.id && x.id !== (focus ? '' : t.active));
    let j = i >= 0 ? i : list.findIndex((x) => !x.pinned && x.id !== tab.id);
    // Everything pinned: the cap still holds (memory stays bounded); the oldest pinned tab goes, never Home.
    if (j < 0) j = list.findIndex((x) => !x.home && x.id !== tab.id);
    if (j >= 0) {
      closed = current(list[j]);
      list = list.filter((_, k) => k !== j);
    }
  }
  const active = focus || !list.some((x) => x.id === t.active) ? tab.id : t.active;
  return { tabs: { list, active }, closed };
}

/** A link or navigate() in the active tab (see the module comment for Home). */
export function visit(t: Tabs, url: string, replace: boolean, id: () => string): Step {
  const tab = activeOf(t);
  if (tab.home && pathOf(url) !== pathOf(current(tab))) {
    const there = t.list.find((x) => current(x) === url);
    if (there) return { tabs: { ...t, active: there.id } };
    return openTab(t, url, true, id);
  }
  if (current(tab) === url) return { tabs: t };
  let hist: string[];
  if (replace) hist = tab.hist.map((u, i) => (i === tab.at ? url : u));
  else hist = [...tab.hist.slice(0, tab.at + 1), url].slice(-HIST_MAX);
  const at = replace ? tab.at : hist.length - 1;
  return { tabs: replaceTab({ ...t, active: tab.id }, { ...tab, hist, at }) };
}

/** Closes a tab (Home never); the active one hands over to its right neighbour, else its left one. */
export function closeTab(t: Tabs, tabId: string): Tabs {
  const i = t.list.findIndex((x) => x.id === tabId);
  if (i < 0 || t.list[i].home) return t;
  const list = t.list.filter((x) => x.id !== tabId);
  if (!list.length) return t;
  const active = t.active === tabId ? (list[i] ?? list[i - 1]).id : t.active;
  return { list, active };
}

export const switchTab = (t: Tabs, tabId: string): Tabs => (t.list.some((x) => x.id === tabId) && t.active !== tabId ? { ...t, active: tabId } : t);

export function togglePin(t: Tabs, tabId: string): Tabs {
  const tab = t.list.find((x) => x.id === tabId);
  return !tab || tab.home ? t : replaceTab(t, { ...tab, pinned: !tab.pinned });
}

/** The tab the active one was opened from, while it is still open. */
const openerOf = (t: Tabs): Tab | undefined => { const o = activeOf(t).opener; return o ? t.list.find((x) => x.id === o) : undefined; };
const walk = (t: Tabs, by: -1 | 1): Tabs => {
  const tab = activeOf(t);
  const at = tab.at + by;
  if (at < 0) { const o = openerOf(t); return o ? switchTab(t, o.id) : t; }
  return at >= tab.hist.length ? t : replaceTab(t, { ...tab, at });
};
/** Back in the tab; on its first page, back to the tab it was opened from (none: nothing changes). */
export const goBack = (t: Tabs): Tabs => walk(t, -1);
export const goForward = (t: Tabs): Tabs => walk(t, 1);
export const canGo = (t: Tabs, by: -1 | 1): boolean => {
  const tab = activeOf(t);
  const at = tab.at + by;
  return by < 0 ? at >= 0 || !!openerOf(t) : at < tab.hist.length;
};

/** Ctrl+Tab and Ctrl+Shift+Tab: the next or previous tab, round. */
export function cycle(t: Tabs, dir: 1 | -1): Tabs {
  const i = t.list.findIndex((x) => x.id === t.active);
  return switchTab(t, t.list[(i + dir + t.list.length) % t.list.length].id);
}

/** Alt+1…8: that tab; Alt+9: the last one, as in browsers. */
export function nth(t: Tabs, n: number): Tabs {
  const tab = n === 9 ? t.list[t.list.length - 1] : t.list[n - 1];
  return tab ? switchTab(t, tab.id) : t;
}

/** What is kept across a restart: the newest HIST_SAVED pages of each tab, short addresses only, under `maxBytes` of JSON. */
export function saveTabs(t: Tabs, maxBytes = SAVED_MAX_BYTES): unknown {
  const v = savedShape(t);
  // Too big for the server's cap: the oldest pages of the longest histories go first (the page showing always stays).
  while (bytes(v) > maxBytes) {
    const longest = v.tabs.reduce((a, b) => (b.hist.length > a.hist.length ? b : a));
    if (longest.hist.length <= 1) break;
    if (longest.at > 0) { longest.hist.shift(); longest.at--; } else longest.hist.pop();
  }
  return v;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
interface SavedTab { hist: string[]; at: number; pinned: boolean; home: boolean }
function savedShape(t: Tabs): { v: 1; active: number; tabs: SavedTab[] } {
  return {
    v: 1,
    active: t.list.findIndex((x) => x.id === t.active),
    tabs: t.list.map((x) => {
      const keep = x.hist.map((u, i) => ({ u, i })).filter((e) => e.u.length <= URL_SAVED_MAX);
      const upto = keep.filter((e) => e.i <= x.at);
      const from = Math.max(0, upto.length - HIST_SAVED);
      const hist = keep.slice(from, from + HIST_SAVED).map((e) => e.u);
      const at = Math.max(0, Math.min(hist.length - 1, upto.length - 1 - from));
      return { hist: hist.length ? hist : [x.home ? HOME_URL : current(x).slice(0, URL_SAVED_MAX)], at, pinned: x.pinned, home: x.home };
    }),
  };
}

/** The saved tabs, checked (anything malformed or off-site dropped), then the address the page was opened at shown in them. */
export function restoreTabs(saved: unknown, url: string, id: () => string): Step {
  const s = saved as { tabs?: unknown; active?: unknown } | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.tabs)) return { tabs: freshTabs(url, id) };
  const home = homeTab(id);
  const list: Tab[] = [home];
  let active = home.id;
  s.tabs.forEach((raw, i) => {
    const r = raw as { hist?: unknown; at?: unknown; pinned?: unknown; home?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.hist)) return;
    const hist = r.hist.filter(sameSite).slice(-HIST_MAX);
    if (!hist.length) return;
    const at = typeof r.at === 'number' && Number.isInteger(r.at) ? Math.max(0, Math.min(hist.length - 1, r.at)) : hist.length - 1;
    if (r.home === true) { home.hist = hist; home.at = at; if (s.active === i) active = home.id; return; }
    if (list.length >= TAB_CAP) return;
    const tab: Tab = { id: id(), hist, at, pinned: r.pinned === true, home: false };
    list.push(tab);
    if (s.active === i) active = tab.id;
  });
  const t: Tabs = { list, active };
  // The tab that was active, when it shows the address (another tab may show the same page).
  if (current(activeOf(t)) === url) return { tabs: t };
  const there = list.find((x) => current(x) === url);
  if (there) return { tabs: { ...t, active: there.id } };
  return visit(t, url, false, id);
}

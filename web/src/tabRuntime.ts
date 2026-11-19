/**
 * The tabs at work: the reducer (web/src/tabs.ts) wired to the router (every navigate() and the browser's back and
 * forward land in the active tab; the address bar shows the active tab's page), to the toasts, and to two copies:
 * - this window's own tabs, in sessionStorage, which a reload of the window comes back to;
 * - the person's server copy (preferences), which only a new window starts from. Each window writes its tabs there,
 *   keeping the pins another window had that this one never closed or unpinned, so two windows don't undo each other's
 *   pins (the rest of the server copy is simply the window that changed last).
 * One set of tabs per page; startTabs when the shell mounts, stopTabs when it goes (logout), which also drops the
 * listeners and the kept scroll positions.
 */
import { useSyncExternalStore } from 'react';
import {
  canGo, closeTab, current, cycle, goBack, goForward, nth, NEW_TAB_URL, openTab, restoreTabs, saveTabs, switchTab, togglePin, visit,
  TAB_CAP, type Step, type Tabs,
} from './tabs';
import { setHistoryKeeper, setTabOpener, showUrl } from './router';
import { prefs } from './prefs';
import { showToast } from './toast';

let tabs: Tabs | null = null;
let label: (url: string) => string = (u) => u;
const listeners = new Set<() => void>();
/** Scroll position of each tab that is not showing (only open tabs; dropped with them). */
const scrolls = new Map<string, number>();
let n = 0;
const newId = () => `t${Date.now().toString(36)}${(++n).toString(36)}`;

const activeUrl = (t: Tabs) => current(t.list.find((x) => x.id === t.active) ?? t.list[0]);

type Saved = { v: 1; active: number; tabs: { hist: string[]; at: number; pinned: boolean; home: boolean }[] };
let windowKey = 'ql.tabs';
/** Pinned pages of the server copy this window started with, and pages this window unpinned or closed while pinned. */
let otherPins: string[] = [];
const dropped = new Set<string>();

const readWindow = (): unknown => { try { return JSON.parse(sessionStorage.getItem(windowKey) ?? 'null'); } catch { return null; } };
const writeWindow = (v: unknown) => { try { sessionStorage.setItem(windowKey, JSON.stringify(v)); } catch { /* storage blocked: the server copy only */ } };

/** The server copy: this window's tabs, plus the other windows' pins it never touched (within the cap). */
export function forServer(mine: Saved, pins: readonly string[], gone: ReadonlySet<string>): Saved {
  const have = new Set(mine.tabs.map((x) => x.hist[x.at]));
  const extra = pins.filter((u) => !have.has(u) && !gone.has(u)).slice(0, Math.max(0, TAB_CAP - mine.tabs.length));
  return extra.length ? { ...mine, tabs: [...mine.tabs, ...extra.map((u) => ({ hist: [u], at: 0, pinned: true, home: false }))] } : mine;
}

function persist(t: Tabs): void {
  const mine = saveTabs(t) as Saved;
  writeWindow(mine);
  prefs.set('tabs', forServer(mine, otherPins, dropped));
}

function set(next: Tabs): void {
  const prev = tabs;
  if (!prev || next === prev) return;
  if (next.active !== prev.active && typeof window !== 'undefined') scrolls.set(prev.active, window.scrollY);
  for (const id of [...scrolls.keys()]) if (!next.list.some((x) => x.id === id)) scrolls.delete(id);
  // A pinned tab that goes, or loses its pin, is not brought back from another window's pins.
  for (const x of prev.list) {
    const now = next.list.find((y) => y.id === x.id);
    if (x.pinned && (!now || !now.pinned)) dropped.add(current(x));
    if (now?.pinned && !x.pinned) dropped.delete(current(now));
  }
  tabs = next;
  persist(next);
  for (const fn of [...listeners]) fn();
}

function applyStep(step: Step): void {
  set(step.tabs);
  if (step.closed !== undefined) showToast(`${TAB_CAP} tabs is the most: closed the oldest, ${label(step.closed)}`, 'info', 4000);
}

/** After a change that did not come through navigate(): show the active tab's page. */
function show(): void {
  if (tabs) showUrl(activeUrl(tabs));
}

/** `serverSaved`: the person's server copy; `who`: their id (this window's copy is kept per person). */
export function startTabs(serverSaved: unknown, url: string, labelOf: (url: string) => string, who = ''): void {
  label = labelOf;
  windowKey = `ql.tabs.${who}`;
  dropped.clear();
  const s = serverSaved as Partial<Saved> | null;
  otherPins = Array.isArray(s?.tabs) ? s.tabs.filter((x) => x?.pinned && !x.home && Array.isArray(x.hist)).map((x) => x.hist[x.at] ?? x.hist[0]).filter((u): u is string => typeof u === 'string') : [];
  // A reload of this window comes back to its own tabs; a new window starts from the server copy.
  const mineSaved = readWindow();
  const step = restoreTabs(mineSaved ?? serverSaved, url, newId);
  tabs = step.tabs;
  persist(tabs);
  setHistoryKeeper({
    go(u, replace) {
      applyStep(visit(tabs!, u, replace, newId));
      return activeUrl(tabs!);
    },
    pop(dir) {
      const next = dir < 0 ? goBack(tabs!) : goForward(tabs!);
      if (next === tabs) return null; // nothing to go to: the router undoes the browser's step
      set(next);
      return activeUrl(tabs!);
    },
  });
  setTabOpener((href) => tabActions.open(href, false));
  show();
  for (const fn of [...listeners]) fn();
}

export function stopTabs(): void {
  setHistoryKeeper(null);
  setTabOpener(null);
  tabs = null;
  scrolls.clear();
  for (const fn of [...listeners]) fn();
}

export const tabActions = {
  switchTo(id: string) { if (tabs) { set(switchTab(tabs, id)); show(); } },
  close(id: string) { if (tabs) { set(closeTab(tabs, id)); show(); } },
  pin(id: string) { if (tabs) set(togglePin(tabs, id)); },
  /** A page in a new tab: in front, or behind with a short note saying so. */
  open(url: string, focus: boolean) {
    if (!tabs) return;
    const was = tabs.active;
    applyStep(openTab(tabs, url, focus, newId));
    // In front, or behind when the cap closed the tab showing (then the new one takes its place).
    if (focus || tabs.active !== was) show();
    if (!focus) showToast(`Opened ${label(url)} in a new tab`, 'info', 2600);
  },
  newTab() { this.open(NEW_TAB_URL, true); },
  back() { if (tabs) { set(goBack(tabs)); show(); } },
  forward() { if (tabs) { set(goForward(tabs)); show(); } },
  canGo(by: -1 | 1): boolean { return !!tabs && canGo(tabs, by); },
  cycle(dir: 1 | -1) { if (tabs) { set(cycle(tabs, dir)); show(); } },
  nth(i: number) { if (tabs) { set(nth(tabs, i)); show(); } },
  closeActive() { if (tabs) this.close(tabs.active); },
};

/** Where the tab now showing was scrolled to when it was left (0 for a new one). */
export const scrollOf = (tabId: string): number => scrolls.get(tabId) ?? 0;

export const useTabs = (): Tabs | null =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => tabs);

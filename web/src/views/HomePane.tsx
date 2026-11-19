import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { navigate, setDetour, useLocation, type Route } from '../router';
import { useStore } from '../store';
import { tabLabel } from '../tabLabel';
import { besideRoute, clampPane, NARROW, PANE_MIN, paneKey, paneUrl, sideOf, withSide } from '../homeSplit';
import { useHomePrefs } from '../homePrefs';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/icons';

/**
 * Home's split view (the address rules: web/src/homeSplit.ts). A plain click or Enter on Home's work or a "Recently
 * worked on" row shows that page in a pane on Home's right, in the same tab; Home stays on the left (refitted). The pane
 * renders the page as the shell would (App.tsx's ShellBody), so the pages are not forked:
 * - a plain click on a link in the pane changes the pane's page; so does a navigate() made while a click in the pane is
 *   handled, a navigate() that replaces (a page keeping its own address canonical: the slug, a dropped `?tab=`), and a
 *   page's own usePageNavigate() (what it does after an await: a deleted list goes to the Overview, there);
 * - its <main> loses id="main" and its landmark, its <h1> is read as level 2 (Home keeps the page's main and h1);
 * - a page's own keys (Deck's `o`/`t`, a task's `z`/`s`, the board's Esc and Delete) answer only on their side
 *   (keysHere): the side the focus is on, or, with the focus on nothing, the side last pressed on. The pane's body takes
 *   the focus when clicked, and its heading when its page changes (Back and Forward too), so the focus rarely is nowhere.
 * The divider is dragged or moved with the arrow keys (Shift: further; Home and End: the ends), its width kept per
 * person (web/src/homePrefs.ts). Below NARROW the pane covers Home, with "Back to Home".
 */

/** True inside the pane (a page there knows its keys are only its side's). */
export const InPane = createContext(false);

/** What opened the pane, on Home's side: the focus goes back there when it closes. */
let opener: HTMLElement | null = null;
/** The next page shown in the pane takes the focus (to its heading). */
let focusNext = false;
/** A click in the pane is being handled: a navigate() it makes stays in the pane (cleared once the click is done). */
let paneClick = false;
/** The last press was in the pane (keysHere's answer while the focus is on nothing). */
let pressedInPane = false;

/** Shows `href` in the pane as its new page (from a page in the pane, or the app's keys acting on it). */
export function paneNavigate(href: string, opts: { replace?: boolean } = {}): void {
  navigate(withSide(location.search, href), opts);
}

/**
 * navigate() for a page: in the pane (while it is still open), a page that can sit beside Home goes there. For what a
 * page does after an await, which no click marks any more (a deleted list goes to the Overview; a new entry opens).
 */
export function usePageNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const inPane = useContext(InPane);
  return useCallback((to, opts) => {
    const u = new URL(to, location.origin);
    if (inPane && sideOf(new URLSearchParams(location.search)) && besideRoute(u.pathname)) paneNavigate(u.pathname + u.search, opts);
    else navigate(to, opts);
  }, [inPane]);
}

/** Shows `href` in the pane beside Home (a page that can't sit there opens as before); `from`: what opened it. */
export function openSide(href: string, from: Element | null): void {
  if (!besideRoute(new URL(href, location.origin).pathname)) { navigate(href); return; }
  if (from instanceof HTMLElement && !from.closest('.home-pane')) opener = from;
  const to = withSide(location.search, href);
  // Already there: only the focus moves.
  if (to === location.pathname + location.search) { document.getElementById('home-pane-title')?.focus({ preventScroll: true }); return; }
  focusNext = true;
  navigate(to);
}

/** A plain click (or Enter) on one of Home's links opens its page beside Home; Ctrl/⌘ and middle clicks go on to a tab. */
export function sideClick(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute('href');
  if (!href || !besideRoute(new URL(href, location.origin).pathname)) return;
  e.preventDefault();
  openSide(href, e.currentTarget);
}

/**
 * A page's own key: while Home has a page beside it, only one pressed on that page's side; with the focus on nothing,
 * the side last pressed on (so Delete in the pane never reaches Home's shared board).
 */
export function keysHere(e: KeyboardEvent, inPane: boolean): boolean {
  if (!document.querySelector('.home-pane')) return true;
  const t = e.target as Element | null;
  if (!t || t === document.body || t === document.documentElement || !t.closest) return pressedInPane === inPane;
  return !!t.closest('.home-pane') === inPane;
}

const narrowQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(max-width: ${NARROW}px)`) : null;
const useNarrow = () => useSyncExternalStore((fn) => {
  narrowQuery?.addEventListener('change', fn);
  return () => narrowQuery?.removeEventListener('change', fn);
}, () => !!narrowQuery?.matches);

/** Home shares the width with a page beside it (not when the pane covers it). */
export const useSplit = (): boolean => {
  const open = !!sideOf(useLocation().query);
  return useNarrow() ? false : open;
};

/** Home (`children`, its <main>) and, when the address names one, the page beside it. */
export function HomeSplit({ children, page }: { children: ReactNode; page: (r: Route) => ReactNode }) {
  const side = sideOf(useLocation().query);
  const open = !!side;
  const [hp, setHp] = useHomePrefs();
  const narrow = useNarrow();
  const cover = open && narrow;
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const [total, setTotal] = useState(0);
  // The width while it is being dragged or keyed, saved when that ends.
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ id: number; x: number; w: number } | null>(null);
  const w = clampPane(live ?? hp.pane, total);
  const title = useStore((s) => (side ? tabLabel(s, side.path).label : ''));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setTotal(el.clientWidth);
    const ro = new ResizeObserver(() => setTotal(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Home, under the pane that covers it, is out of reach.
  useEffect(() => {
    const home = ref.current?.firstElementChild as HTMLElement | null;
    if (home) home.inert = cover;
  }, [cover]);

  // Navigations made from the pane's page go to the pane (see the module comment); the rest leave Home as before. Set
  // while Home is up, before any page in the pane runs its effects; with it goes what this Home held on to.
  useLayoutEffect(() => {
    setDetour((url, replace) => {
      if (url.pathname === '/home' || !(replace || paneClick) || !sideOf(new URLSearchParams(location.search)) || !besideRoute(url.pathname)) return null;
      return withSide(location.search, url.pathname + url.search);
    });
    const onDown = (e: PointerEvent) => { pressedInPane = !!(e.target as Element).closest?.('.home-pane'); };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      setDetour(null);
      document.removeEventListener('pointerdown', onDown, true);
      opener = null;
      focusNext = false;
      pressedInPane = false;
    };
  }, []);

  // Opening moves the focus to the pane's heading, and so does another page there when the focus is on nothing or on the
  // pane itself (Back, Forward); closing (Close, Back to Home, the tab's Back) returns it to what opened it.
  useEffect(() => {
    const a = document.activeElement;
    const nowhere = !a || a === document.body || a === bodyRef.current; // never from a field the person is typing in
    if (side && (focusNext || nowhere)) { headRef.current?.focus({ preventScroll: true }); pressedInPane = true; }
    focusNext = false;
  }, [side?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) return;
    const back = opener;
    opener = null;
    if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus({ preventScroll: true });
  }, [open]);

  // The page's own <main id="main"> and <h1>: Home has those (see the module comment). Pages swap their <main> as they load.
  useLayoutEffect(() => {
    const b = bodyRef.current;
    if (!b) return;
    const fix = () => {
      for (const m of b.querySelectorAll('main')) {
        if (m.id === 'main') m.removeAttribute('id');
        if (m.getAttribute('role') !== 'none') m.setAttribute('role', 'none');
      }
      for (const h of b.querySelectorAll('h1:not([aria-level])')) h.setAttribute('aria-level', '2');
    };
    fix();
    const mo = new MutationObserver(fix);
    mo.observe(b, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [open]);

  const close = () => navigate(withSide(location.search, null));
  const ownTab = () => {
    const url = paneUrl(location.search);
    if (!url) return;
    opener = null;
    navigate(withSide(location.search, null), { replace: true });
    navigate(url); // from the Home tab: a tab of its own, in front
  };
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    paneClick = true;
    setTimeout(() => { paneClick = false; }, 0);
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || !e.currentTarget.contains(a) || a.target || a.hasAttribute('download')) return;
    const u = new URL(a.getAttribute('href')!, location.href);
    if (u.origin !== location.origin || !besideRoute(u.pathname)) return;
    e.preventDefault();
    focusNext = true;
    navigate(withSide(location.search, u.pathname + u.search));
  };
  const save = () => {
    if (live === null) return;
    if (live !== hp.pane) setHp({ pane: live });
    setLive(null);
  };

  return (
    <div ref={ref} className={`home-split${open ? ' open' : ''}${cover ? ' is-over' : ''}`} style={open ? { ['--pane-w' as string]: `${w}px` } : undefined}>
      {children}
      {open && !cover && (
        <div className={drag.current ? 'home-divider drag' : 'home-divider'} role="separator" aria-orientation="vertical" tabIndex={0}
          aria-label="Width of the page beside Home" aria-controls="home-pane" aria-valuemin={PANE_MIN} aria-valuemax={clampPane(total, total)} aria-valuenow={w}
          title="Drag, or use the arrow keys, to change the width"
          onKeyDown={(e) => { const n = paneKey(e.key, w, total, e.shiftKey); if (n !== null) { e.preventDefault(); setLive(n); } }}
          onKeyUp={save} onBlur={save}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, w };
            setLive(w);
          }}
          onPointerMove={(e) => { const d = drag.current; if (d && d.id === e.pointerId) setLive(clampPane(d.w - (e.clientX - d.x), total)); }}
          onPointerUp={() => { drag.current = null; save(); }}
          onPointerCancel={() => { drag.current = null; save(); }} />
      )}
      {side && (
        <section className="home-pane" id="home-pane" aria-labelledby="home-pane-title">
          <header className="home-pane-head">
            {cover && <button type="button" className="btn btn-ghost btn-sm" onClick={close}><Icon name="back" size={14} />Back to Home</button>}
            <h2 id="home-pane-title" ref={headRef} tabIndex={-1}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Open in its own tab" title="Open in its own tab" onClick={ownTab}><Icon name="external" size={16} /></button>
            {!cover && <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={close}><Icon name="close" size={16} /></button>}
          </header>
          <div className="home-pane-body" ref={bodyRef} tabIndex={-1} onClickCapture={onBodyClick}>
            <InPane.Provider value={true}>
              <ErrorBoundary what="This page" resetKey={side.path} asPage>{page(side.route)}</ErrorBoundary>
            </InPane.Provider>
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GuidedStartHost } from './components/wiki/GuidedStart';
import { api, dispatch } from './api';
import { isAdmin, settingsOf, store, useStore } from './store';
import { Link, navigate, OPEN_ROUTES, setQuery, useLocation, type Route } from './router';
import { useToasts, dismissToast } from './toast';
import { Icon, Mark } from './components/icons';
import { Menu } from './components/Menu';
import { QuestMenu } from './components/QuestMenu';
import { Dialog } from './components/Dialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Setup } from './views/Setup';
import { Login } from './views/Login';
import { Join } from './views/Join';
import { Decks } from './views/Decks';
import { Deck } from './views/Deck';
import { CardView, shortcutTarget } from './views/Card';
import { Activity } from './views/Activity';
import { Inbox } from './views/Inbox';
import { MyTasks } from './views/MyTasks';
import { Sidebar } from './components/Sidebar';
import { oldBoardUrl, visionHref } from './board/boards';
import { TimerWidget } from './components/TimerWidget';
import { handOf } from './hand';
import { keepSearch } from './cards';
import { closeRightmostPanel } from './panels';
import { toggleTimer, trackingOn } from './timeTracking';
import { seqFromCode } from '../../shared/cards';
import { WorkspaceMenu } from './components/WorkspaceMenu';
import { legacyMenu } from './workspaceMenu';
import { useTutorialPaused } from './guides';
import { ApiTokens } from './views/settings/ApiTokens';
import { EmailPrefs } from './views/settings/Email';
import { Members } from './views/Members';
import { MyAccount } from './views/MyAccount';
import { resetTailscale, useTailscale } from './tailscale';
import { Timeline } from './views/Timeline';
import { MilestonePage } from './views/MilestonePage';
import { RunPage } from './views/RunPage';
import { Wiki } from './views/Wiki';
import { Assets } from './views/assets/Assets';
import { SearchBox } from './components/SearchBox';
import { focusSearchBox, SEARCH_INPUT_ID } from './search';
import { ShortcutPanel } from './components/ShortcutPanel';
import { clearSelection, getSelection } from './selection';
import { keysOf } from './shortcuts';
import { Palette } from './components/Palette';
import { isPaletteKey, pushRecent, recentOfRoute, setPaletteOpener } from './palette';
import { WorkspaceDisabled } from './views/settings/DangerZone';
import { OpenApp } from './views/open/OpenApp';
import { resetOpenDecks } from './openDecks';
import { setWorkspaceKind } from './workspaceKind';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { TabBar } from './components/TabBar';
import { scrollOf, startTabs, stopTabs, tabActions, useTabs } from './tabRuntime';
import { tabLabel } from './tabLabel';
import { IS_MAC } from './linkIgnores';
import { NewTabPage } from './views/ShellPages';
import { Home } from './views/Home';
import { paneNavigate } from './views/HomePane';
import { sideOf } from './homeSplit';
import { SuggestionDialog } from './components/SuggestionDialog';
import { ReadLangPrompt } from './components/ReadLangPrompt';
import { checkSuggestions, useSuggestionTarget } from './suggestions';
import { loadPrefs, prefs, resetPrefs, usePrefsReady } from './prefs';

const PUBLIC = new Set<Route['name']>(['setup', 'login', 'join']);

export function App() {
  const loc = useLocation();
  const status = useStore((s) => s.status);
  /** null while asking the server whether a workspace exists. */
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  /** Disabled in the Danger Zone: as the server said at load, or as the store learnt since (423, socket close 4423). */
  const [disabledAtLoad, setDisabledAtLoad] = useState(false);
  const disabled = disabledAtLoad || status === 'disabled';

  useEffect(() => {
    api.status().then((r) => { setDisabledAtLoad(r.disabled === true); setIsSetup(r.setup); setWorkspaceKind(r.workspace); }).catch(() => setIsSetup(true));
  }, []);

  const route = loc.route;
  // Open Decks pages are for anyone: no login redirect, no workspace store.
  const isOpen = OPEN_ROUTES.has(route.name);
  const isPublic = PUBLIC.has(route.name) || isOpen;

  // Redirects: no workspace → setup; workspace but no session → login. (After login and setup we land on /decks; `/` is the Hand.)
  useEffect(() => {
    if (isSetup === null || disabled) return;
    if (!isSetup && route.name !== 'setup') navigate('/setup', { replace: true });
    else if (isSetup && route.name === 'setup') navigate('/login', { replace: true });
    else if (!isPublic && status === 'unauthenticated') {
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    }
  }, [isSetup, route.name, isPublic, status, disabled]);

  // The live connection runs while we are on a signed-in screen.
  useEffect(() => {
    if (isSetup && !isPublic && !disabledAtLoad) store.start();
  }, [isSetup, isPublic, disabledAtLoad]);

  const signedIn = () => { setIsSetup(true); store.start(); };

  let body;
  if (isSetup === null) body = <Splash />;
  else if (disabled) body = <WorkspaceDisabled />;
  else if (isOpen && isSetup) body = <OpenApp route={route} />;
  else if (route.name === 'setup') body = <Setup onDone={signedIn} />;
  else if (route.name === 'login') body = <Login onDone={signedIn} />;
  else if (route.name === 'join') body = <Join token={route.token} onDone={signedIn} />;
  else if (status !== 'ready') body = status === 'error' ? <LoadError /> : <Splash />;
  // A crash anywhere in the shell (sidebar, top bar) shows a message instead of a blank page; the address resets it.
  else body = <ErrorBoundary what="Questlog" resetKey={loc.path} asPage><Shell route={route} show={loc.show} /></ErrorBoundary>;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {body}
      <Toasts />
      {status === 'ready' && <GuidedStartHost />}
    </>
  );
}

/** Overlays opened by `?show=…` on top of any signed-in page. */
const ADMIN_OVERLAYS = new Set(['members']);

/** The timezone is sent at most once per page load. */
let zoneSynced = false;

const NAV_SHORTCUTS: Record<string, () => string> = {
  Digit1: () => '/', Digit2: () => '/decks', Digit3: () => '/milestones', Digit4: () => '/home', // Home is the vision board now (the old boards: the workspace switcher's menu)
};

const LOGOUT_TS = 'Log out (Tailscale signs you back in on this device)';
const HELP_KEY = keysOf('help');
const SEARCH_KEY = keysOf('search');
const INBOX_KEY = keysOf('nav.inbox');

/** Saved tabs are taken as they are; web/src/tabs.ts restoreTabs checks them. */
const anything = (v: unknown): v is unknown => v !== undefined;

/**
 * The signed-in screen waits for the person's preferences (the sidebar and the tabs come from them), then starts the
 * tabs: from then on every page opens in a tab (web/src/tabRuntime.ts).
 */
function Shell(props: { route: Route; show: string | null }) {
  const me = useStore((s) => s.me);
  const prefsReady = usePrefsReady();
  useEffect(() => { if (me?.id) void loadPrefs(me.id); }, [me?.id]);
  const tabs = useTabs();
  useLayoutEffect(() => {
    if (!prefsReady) return;
    startTabs(prefs.get('tabs', anything, null), location.pathname + location.search + location.hash, (url) => tabLabel(store.get(), url).label, me?.id ?? '');
    return () => stopTabs();
  }, [prefsReady]);
  if (!prefsReady || !tabs) return <Splash />;
  return <ShellReady {...props} tabId={tabs.active} />;
}

/**
 * The tab keys: Alt+1…9 picks a tab (9: the last) when the person is not typing (not on a Mac). Ctrl+T, Ctrl+W and
 * Ctrl+Tab are browsers' own keys (a page never gets them there); the desktop app's window passes them on, so there they
 * open, close and cycle tabs.
 */
function useTabKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Not while typing (Alt+digit types [ ] | { } on some layouts), and never on a Mac, where Option+digit is a character.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code) && !IS_MAC && shortcutTarget(e, true)) {
        e.preventDefault();
        tabActions.nth(Number(e.code.slice(5)));
        return;
      }
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'Tab') { e.preventDefault(); tabActions.cycle(e.shiftKey ? -1 : 1); return; }
      if (e.shiftKey) return;
      if (e.code === 'KeyT') { e.preventDefault(); tabActions.newTab(); }
      else if (e.code === 'KeyW') { e.preventDefault(); tabActions.closeActive(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
}

function ShellReady({ route, show, tabId }: { route: Route; show: string | null; tabId: string }) {
  const me = useStore((s) => s.me);
  useTabKeys();
  // Only the active tab's page is mounted; a tab shown again gets back the scroll position it was left at.
  useLayoutEffect(() => { window.scrollTo(0, scrollOf(tabId)); }, [tabId]);
  const admin = useStore(isAdmin);
  const ts = useTailscale();
  const accountItem = ts?.enabled ? [{ label: 'My account', onSelect: () => setQuery('show', 'myAccount') }] : [];
  const logoutLabel = ts?.sessionVia === 'tailscale' ? LOGOUT_TS : 'Log out';
  const closeOverlay = () => setQuery('show', null);
  const loc = useLocation();
  const menu = loc.query.get('menu');
  const tutorialPaused = useTutorialPaused();
  const suggestTo = useSuggestionTarget();
  const [suggesting, setSuggesting] = useState(false);
  // The Suggestion button's show rule, once the person is signed in (the forward on This computer needs the session).
  useEffect(() => {
    if (!me?.id) return;
    api.status().then((r) => checkSuggestions(r.suggestions)).catch(() => checkSuggestions(null));
  }, [me?.id]);
  // The old Workspace settings dialog (`?show=accountSettings`, billing's return link) opens the menu now.
  useEffect(() => {
    const to = legacyMenu(show, loc.query);
    if (!to) return;
    const q = new URLSearchParams(loc.query);
    q.delete('show');
    q.set('menu', to);
    navigate(`${loc.path}?${q}`, { replace: true });
  }, [show, loc.query, loc.path]);
  // The shortcut panel is `?show=shortcuts`, so the deck header's button can open it too.
  const helpOpen = show === 'shortcuts';
  const setHelpOpen = (open: boolean) => setQuery('show', open ? 'shortcuts' : null);
  // Keep my timezone current (once per load, only when it differs; failures don't matter).
  const myZone = me?.timezone;
  useEffect(() => {
    if (!me) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone !== myZone && !zoneSynced) {
      zoneSynced = true;
      void dispatch('users', 'update', { id: me.id, timezone: zone }).catch(() => {});
    }
  }, [me?.id, myZone]);
  const helpRef = useRef(false);
  helpRef.current = helpOpen;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => {
    setPaletteOpener((q) => { setPaletteQuery(q); setPaletteOpen(true); });
    return () => setPaletteOpener(null);
  }, []);
  // Ctrl/⌘+K opens (or closes) the palette from anywhere, typing in an editor included: it listens in the capture
  // phase, before CodeMirror and inputs, and takes the key from the browser (its own Ctrl+K is the address bar search).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) { setPaletteQuery(''); setPaletteOpen((o) => !o); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  // Pages opened become the palette's recents (per device).
  useEffect(() => {
    const ref = recentOfRoute(store.get(), route);
    if (ref) pushRecent(ref);
  }, [loc.path]);
  // `i` opens the inbox, `/` focuses the search box, Shift+1/2/3 go to Hand/Decks/Timeline, unless the person is typing or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The shortcut panel is a dialog, so `?` has to be let through to close it again.
      if (e.key === HELP_KEY && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && helpRef.current) { e.preventDefault(); setHelpOpen(false); return; }
      if (!shortcutTarget(e)) return;
      if (e.key === HELP_KEY) { e.preventDefault(); setHelpOpen(true); return; }
      if (e.key === INBOX_KEY) { e.preventDefault(); navigate('/inbox'); return; }
      if (e.key === SEARCH_KEY) { e.preventDefault(); focusSearchBox(); return; }
      const to = e.shiftKey ? NAV_SHORTCUTS[e.code] : undefined;
      if (to) { e.preventDefault(); navigate(to()); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Esc closes the innermost open thing, one per press: the shortcut panel and other dialogs and the search menu handle
  // their own Esc (so we stand aside while one is open or the search box has focus), then the selection, then the
  // `?panel=` side panel, then the wiki's rightmost `?panels=` panel, then the open card panel. It listens on window, after every document-level Esc handler
  // (popovers, pickers) has had its turn and marked the key handled.
  // On Home with a page beside it, the keys act on that page (web/src/views/HomePane.tsx).
  const side = route.name === 'home' ? sideOf(loc.query) : null;
  const pageRoute = side?.route ?? route;
  const stateRef = useRef({ route: pageRoute, panel: loc.query.get('panel'), inPane: !!side });
  stateRef.current = { route: pageRoute, panel: loc.query.get('panel'), inPane: !!side };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !shortcutTarget(e)) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sbox') || document.activeElement?.id === SEARCH_INPUT_ID) return;
      const { route: r, panel, inPane } = stateRef.current;
      if (getSelection().selected.size) { clearSelection(); return; }
      if (panel) { setQuery('panel', null); return; }
      // The wiki's side-by-side panels: the rightmost one on screen closes (a history step, like opening it).
      if (r.name === 'wikiEntry' && closeRightmostPanel()) return;
      if (r.name === 'deckCard') (inPane ? paneNavigate : navigate)(keepSearch(`/decks/${r.deckSeq}`));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Alt+P starts or stops my timer on the open card, or on Hand slot 1 elsewhere (works with focus on the page body).
  const routeRef = useRef(pageRoute);
  routeRef.current = pageRoute;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== 'KeyP' || !shortcutTarget(e, true)) return;
      const s = store.get();
      if (!s.me || !trackingOn(s)) return;
      e.preventDefault();
      const r = routeRef.current;
      let id: string | undefined;
      if (r.name === 'card' || r.name === 'deckCard') {
        const seq = seqFromCode(r.code);
        id = [...s.cards.values()].find((c) => c.seq === seq)?.id;
      } else id = handOf(s, s.me.id)[0]?.id;
      if (id) void toggleTimer(s, id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const logout = async () => {
    await resetPrefs(); // what is waiting is sent while the session still works
    try { await api.logout(); } catch { /* the session is gone either way */ }
    store.reset('unauthenticated');
    resetTailscale();
    resetOpenDecks();
    zoneSynced = false; // the next person to sign in gets their own sync
    navigate('/login', { replace: true });
  };
  return (
    <div className="shell">
      <header className="topbar">
        <WorkspaceSwitcher />
        <TabBar />
        <SearchBox />
        <div className="topbar-end">
          {suggestTo && (
            <button type="button" className="btn btn-ghost topbar-suggest" title="Tell the team what to improve, fix or add"
              onClick={() => setSuggesting(true)}>Suggestion</button>
          )}
          {!tutorialPaused && <QuestMenu />}
          <Menu label="Account menu" trigger={<Icon name="gear" />} items={[
            { label: admin ? 'Workspace settings' : 'Settings', onSelect: () => setQuery('menu', admin ? 'workspace' : 'preferences') },
            ...(admin ? [{ label: 'Members', onSelect: () => setQuery('show', 'members') }] : []),
            { label: 'API tokens', onSelect: () => setQuery('show', 'apiTokens') },
            { label: 'Email notifications', onSelect: () => setQuery('show', 'emailSettings') },
            ...accountItem,
          ]} />
          <span className="avatar" aria-hidden>{(me?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="me-name">{me?.name}</span>
          <button type="button" className="icon-btn" aria-label="See shortcuts" title={`See shortcuts (${HELP_KEY})`} aria-keyshortcuts={HELP_KEY} onClick={() => setHelpOpen(true)}>?</button>
          <button type="button" className="icon-btn" aria-label={logoutLabel} title={logoutLabel} onClick={logout}><Icon name="logout" /></button>
        </div>
      </header>
      <div className="shell-body">
        <ErrorBoundary what="The sidebar" resetKey={loc.path}><Sidebar route={route} /></ErrorBoundary>
        <div className="shell-main"><ErrorBoundary key={tabId} what="This page" resetKey={loc.path} asPage><ShellBody route={route} /></ErrorBoundary></div>
      </div>
      <TimerWidget />
      {helpOpen && <ShortcutPanel onClose={() => setHelpOpen(false)} />}
      {suggesting && suggestTo && <SuggestionDialog target={suggestTo} onClose={() => setSuggesting(false)} />}
      {paletteOpen && <Palette route={route} initial={paletteQuery} onClose={() => setPaletteOpen(false)} />}
      {menu !== null && <WorkspaceMenu value={menu} />}
      <ReadLangPrompt />
      {show === 'apiTokens' && (
        <Dialog title="API tokens" wide scroll onClose={closeOverlay} actions={<button type="button" className="btn btn-ghost" onClick={closeOverlay}>Close</button>}>
          <ApiTokens />
        </Dialog>
      )}
      {show === 'emailSettings' && (
        <Dialog title="Email notifications" onClose={closeOverlay} actions={<button type="button" className="btn btn-ghost" onClick={closeOverlay}>Close</button>}>
          <EmailPrefs />
        </Dialog>
      )}
      {show === 'myAccount' && <MyAccount onClose={closeOverlay} />}
      {admin && show === 'members' && <Members onClose={closeOverlay} />}
      {!admin && show && ADMIN_OVERLAYS.has(show) && <NotAllowed onClose={closeOverlay} />}
    </div>
  );
}

/** `/vision` and `/vision/<seq>`, from before the boards moved onto Home: there instead, with that board picked. */
function OldBoardLink({ seq }: { seq: number | null }) {
  const loc = useLocation();
  useEffect(() => { navigate(oldBoardUrl(seq, loc.query, visionHref()), { replace: true }); }, [seq, loc.query]);
  return <main className="page" id="main" aria-busy="true" />;
}

function ShellBody({ route }: { route: Route }) {
  switch (route.name) {
    case 'root':
      return <MyTasks />;
    case 'vision':
      return <OldBoardLink seq={null} />;
    case 'visionBoard':
      return <OldBoardLink seq={route.seq} />;
    case 'milestones':
      return <Timeline />;
    case 'milestone':
      return <MilestonePage seq={route.seq} />;
    case 'run':
      return <RunPage seq={route.seq} />;
    case 'milestoneActivity':
      return <Activity milestoneSeq={route.seq} />;
    case 'runActivity':
      return <Activity runSeq={route.seq} />;
    case 'decks':
      return <Decks />;
    case 'inbox':
      return <Inbox />;
    case 'deck':
      return <Deck seq={route.deckSeq} />;
    case 'activity':
      return <Activity />;
    case 'deckActivity':
      return <Activity deckSeq={route.deckSeq} />;
    case 'deckCard':
      return <Deck seq={route.deckSeq} cardCode={route.code} />;
    case 'wiki':
    case 'wikiProject':
    case 'wikiEntry':
    case 'wikiType':
    case 'wikiKind':
    case 'wikiNew':
    case 'wikiView':
    case 'wikiTypes':
      return <Wiki route={route} />;
    case 'assets':
    case 'assetsProject':
      return <Assets route={route} />;
    case 'card':
      return <main className="page page-narrow" id="main"><CardView code={route.code} inDeck={false} /></main>;
    case 'home':
      return <Home page={(r) => <ShellBody route={r} />} />;
    case 'newTab':
      return <NewTabPage />;
    default:
      return <Placeholder title="Page not found" />;
  }
}

function Placeholder({ title }: { title: string }) {
  return (
    <main className="page" id="main">
      <div className="page-head"><div><p className="eyebrow"><Link href="/decks">← Lists</Link></p><h1>{title}</h1></div></div>
    </main>
  );
}

function NotAllowed({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Admins only" onClose={onClose} actions={<button type="button" className="btn btn-primary" onClick={onClose}>OK</button>}>
      <p>Only workspace admins can open this. Ask one of them if something needs changing.</p>
    </Dialog>
  );
}

function Splash() {
  return <main className="splash" id="main" aria-busy="true"><Mark size={40} /></main>;
}

function LoadError() {
  return (
    <main className="splash" id="main">
      <p>Can't load your workspace right now.</p>
      <button type="button" className="btn" onClick={() => void store.load()}>Try again</button>
      {/* Open Decks guests have an account but no workspace: they get here when they sign in through /login. */}
      <button type="button" className="btn btn-ghost" onClick={() => { void api.logout().catch(() => {}).finally(() => { store.reset('unauthenticated'); navigate('/login', { replace: true }); }); }}>Log out</button>
    </main>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <span>{t.text}</span>
          {t.action && <button type="button" className="btn btn-sm" onClick={() => { dismissToast(t.id); t.action!.run(); }}>{t.action.label}</button>}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon name="close" size={16} /></button>
        </div>
      ))}
    </div>
  );
}

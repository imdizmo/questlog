import { useEffect, useRef, useState } from 'react';
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
import { VisionBoardView, VisionHome } from './views/Vision';
import { visionHref } from './board/boards';
import { TimerWidget } from './components/TimerWidget';
import { handOf } from './hand';
import { keepSearch } from './cards';
import { toggleTimer, trackingOn } from './timeTracking';
import { seqFromCode } from '../../shared/cards';
import { AccountSettings } from './views/AccountSettings';
import { ApiTokens } from './views/settings/ApiTokens';
import { EmailPrefs } from './views/settings/Email';
import { Members } from './views/Members';
import { Timeline } from './views/Timeline';
import { MilestonePage } from './views/MilestonePage';
import { RunPage } from './views/RunPage';
import { Wiki } from './views/Wiki';
import { SearchBox } from './components/SearchBox';
import { focusSearchBox, SEARCH_INPUT_ID } from './search';
import { ShortcutPanel } from './components/ShortcutPanel';
import { clearSelection, getSelection } from './selection';
import { keysOf } from './shortcuts';
import { WorkspaceDisabled } from './views/settings/DangerZone';
import { OpenApp } from './views/open/OpenApp';
import { resetOpenDecks } from './openDecks';

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
    api.status().then((r) => { setDisabledAtLoad(r.disabled === true); setIsSetup(r.setup); }).catch(() => setIsSetup(true));
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
  else body = <Shell route={route} show={loc.show} />;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {body}
      <Toasts />
    </>
  );
}

/** Overlays opened by `?show=…` on top of any signed-in page. */
const ADMIN_OVERLAYS = new Set(['accountSettings', 'members']);

/** The timezone is sent at most once per page load. */
let zoneSynced = false;

const NAV_SHORTCUTS: Record<string, () => string> = {
  Digit1: () => '/', Digit2: () => '/decks', Digit3: () => '/milestones', Digit4: () => visionHref(),
};

const HELP_KEY = keysOf('help');
const SEARCH_KEY = keysOf('search');
const INBOX_KEY = keysOf('nav.inbox');

function Shell({ route, show }: { route: Route; show: string | null }) {
  const me = useStore((s) => s.me);
  const workspace = useStore((s) => s.account?.name);
  const admin = useStore(isAdmin);
  const closeOverlay = () => setQuery('show', null);
  const loc = useLocation();
  // The shortcut panel is `?show=shortcuts`, so the deck header's button can open it too.
  const helpOpen = show === 'shortcuts';
  const setHelpOpen = (open: boolean) => setQuery('show', open ? 'shortcuts' : null);
  const vision = useStore((s) => settingsOf(s).visionBoardEnabled);
  // Re-read when boards change, so the link follows a deleted or newly created board.
  useStore((s) => s.visionBoards);
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
  const visionRef = useRef(vision);
  visionRef.current = vision; // Shift+4 is off with the feature, like its nav link
  const helpRef = useRef(false);
  helpRef.current = helpOpen;
  // `i` opens the inbox, `/` focuses the search box, Shift+1/2/3 go to Hand/Decks/Timeline, unless the person is typing or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The shortcut panel is a dialog, so `?` has to be let through to close it again.
      if (e.key === HELP_KEY && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && helpRef.current) { e.preventDefault(); setHelpOpen(false); return; }
      if (!shortcutTarget(e)) return;
      if (e.key === HELP_KEY) { e.preventDefault(); setHelpOpen(true); return; }
      if (e.key === INBOX_KEY) { e.preventDefault(); navigate('/inbox'); return; }
      if (e.key === SEARCH_KEY) { e.preventDefault(); focusSearchBox(); return; }
      const to = e.shiftKey && (e.code !== 'Digit4' || visionRef.current) ? NAV_SHORTCUTS[e.code] : undefined;
      if (to) { e.preventDefault(); navigate(to()); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Esc closes the innermost open thing, one per press: the shortcut panel and other dialogs and the search menu handle
  // their own Esc (so we stand aside while one is open or the search box has focus), then the selection, then the
  // `?panel=` side panel, then the open card panel. It listens on window, after every document-level Esc handler
  // (popovers, pickers) has had its turn and marked the key handled.
  const stateRef = useRef({ route, panel: loc.query.get('panel') });
  stateRef.current = { route, panel: loc.query.get('panel') };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !shortcutTarget(e)) return;
      if ((e.target as HTMLElement | null)?.closest?.('.sbox') || document.activeElement?.id === SEARCH_INPUT_ID) return;
      const { route: r, panel } = stateRef.current;
      if (getSelection().selected.size) { clearSelection(); return; }
      if (panel) { setQuery('panel', null); return; }
      if (r.name === 'deckCard') navigate(keepSearch(`/decks/${r.deckSeq}`));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Alt+P starts or stops my timer on the open card, or on Hand slot 1 elsewhere (works with focus on the page body).
  const routeRef = useRef(route);
  routeRef.current = route;
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
    try { await api.logout(); } catch { /* the session is gone either way */ }
    store.reset('unauthenticated');
    resetOpenDecks();
    zoneSynced = false; // the next person to sign in gets their own sync
    navigate('/login', { replace: true });
  };
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/decks" className="brand" aria-label={`${workspace ?? 'Workspace'} home`}>
          <Mark />
          <span className="brand-name">{workspace}</span>
        </Link>
        <SearchBox />
        <div className="topbar-end">
          <QuestMenu />
          {admin ? (
            <Menu label="Workspace menu" trigger={<Icon name="gear" />} items={[
              { label: 'Workspace settings', onSelect: () => setQuery('show', 'accountSettings') },
              { label: 'Members', onSelect: () => setQuery('show', 'members') },
              { label: 'Email notifications', onSelect: () => setQuery('show', 'emailSettings') },
            ]} />
          ) : (
            <Menu label="Account menu" trigger={<Icon name="gear" />} items={[
              { label: 'API tokens', onSelect: () => setQuery('show', 'apiTokens') },
              { label: 'Email notifications', onSelect: () => setQuery('show', 'emailSettings') },
            ]} />
          )}
          <span className="avatar" aria-hidden>{(me?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="me-name">{me?.name}</span>
          <button type="button" className="icon-btn" aria-label="See shortcuts" title={`See shortcuts (${HELP_KEY})`} aria-keyshortcuts={HELP_KEY} onClick={() => setHelpOpen(true)}>?</button>
          <button type="button" className="icon-btn" aria-label="Log out" title="Log out" onClick={logout}><Icon name="logout" /></button>
        </div>
      </header>
      <div className="shell-body">
        <Sidebar route={route} />
        <div className="shell-main"><ErrorBoundary what="This page" resetKey={loc.path} asPage><ShellBody route={route} /></ErrorBoundary></div>
      </div>
      <TimerWidget />
      {helpOpen && <ShortcutPanel onClose={() => setHelpOpen(false)} />}
      {admin && show === 'accountSettings' && <AccountSettings onClose={closeOverlay} />}
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
      {admin && show === 'members' && <Members onClose={closeOverlay} />}
      {!admin && show && ADMIN_OVERLAYS.has(show) && <NotAllowed onClose={closeOverlay} />}
    </div>
  );
}

function ShellBody({ route }: { route: Route }) {
  switch (route.name) {
    case 'root':
      return <MyTasks />;
    case 'vision':
      return <VisionHome />;
    case 'visionBoard':
      return <VisionBoardView seq={route.seq} />;
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
      return <Wiki route={route} />;
    case 'card':
      return <main className="page page-narrow" id="main"><CardView code={route.code} inDeck={false} /></main>;
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
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon name="close" size={16} /></button>
        </div>
      ))}
    </div>
  );
}

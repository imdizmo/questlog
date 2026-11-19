import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react';
import { derivedStatus } from '../../../shared/cards';
import { inboxRows, store, useStore } from '../store';
import { Link, useLocation, type Route } from '../router';
import { openByCard } from '../cards';
import { useMinuteClock } from '../clock';
import { encodeChips, savedSearchName } from '../../../shared/search';
import { useSearchCtx } from '../search';
import { prefs, usePref } from '../prefs';
import { setFold, sideRows, type ListStats, type SideRow } from '../sideTree';
import { quickTarget, type Picked } from '../quickTarget';
import { openPalette } from '../palette';
import { tabActions } from '../tabRuntime';
import { Icon, type IconName } from './icons';
import { QuickActions } from './QuickActions';
import { SideRail } from './SideRail';

const NO_FOLDS: Record<string, boolean> = {};
const WIKI = new Set<Route['name']>(['wiki', 'wikiProject', 'wikiEntry', 'wikiType', 'wikiKind', 'wikiNew', 'wikiView']);
const MILESTONES = new Set<Route['name']>(['milestones', 'milestone', 'run', 'milestoneActivity', 'runActivity']);

/** The person's sidebar choices (per person, server-side: web/src/prefs.ts). */
export interface SidePrefs { folded: boolean; pages: 'list' | 'icons' }
const SIDE_DEFAULT: SidePrefs = { folded: false, pages: 'list' };
const validSide = (v: unknown): v is SidePrefs => {
  const x = v as Partial<SidePrefs> | null;
  return !!x && typeof x.folded === 'boolean' && (x.pages === 'list' || x.pages === 'icons');
};
const validFolds = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');
export const setSidePrefs = (p: SidePrefs) => prefs.set('sidebar', p, true);

/** A main page of the sidebar (and of the folded rail). */
export interface MainPage { href: string; label: string; icon: IconName; current: boolean; keys?: string; badge?: number }

/**
 * The main pages, in their order. Home is the vision board of the workspace: it took the Vision board's place here; the
 * old boards stay at /vision, reachable from the workspace switcher's menu while the feature is on.
 */
export function useMainPages(route: Route): MainPage[] {
  const now = useMinuteClock();
  const inboxCount = useStore((s) => inboxRows(s, now).length);
  const pages: MainPage[] = [
    { href: '/home', label: 'Home', icon: 'home', current: route.name === 'home', keys: 'Shift+4' },
    { href: '/', label: 'My tasks', icon: 'user', current: route.name === 'root', keys: 'Shift+1' },
    { href: '/inbox', label: 'Inbox', icon: 'inbox', current: route.name === 'inbox', keys: 'i', badge: inboxCount },
    { href: '/decks', label: 'Overview', icon: 'grid', current: route.name === 'decks', keys: 'Shift+2' },
    { href: '/milestones', label: 'Milestones', icon: 'flag', current: MILESTONES.has(route.name), keys: 'Shift+3' },
  ];
  pages.push(
    { href: '/wiki', label: 'Wiki', icon: 'book', current: WIKI.has(route.name) },
    { href: '/assets', label: 'Assets', icon: 'asset', current: route.name === 'assets' || route.name === 'assetsProject' },
    { href: '/decks/activity', label: 'Activity', icon: 'pulse', current: route.name === 'activity' },
  );
  return pages;
}

/** Done and total tasks per list, for the rings and open counts. */
export function useListStats(): ListStats {
  const cards = useStore((s) => s.cards);
  const resolvables = useStore((s) => s.resolvables);
  return useMemo(() => {
    const open = openByCard(resolvables.values());
    const m: ListStats = new Map();
    for (const c of cards.values()) {
      if (!c.deckId || c.isDoc || c.visibility !== 'default') continue;
      const e = m.get(c.deckId) ?? { total: 0, done: 0 };
      e.total += 1;
      if (derivedStatus(c, open.get(c.id) ?? new Set()) === 'done') e.done += 1;
      m.set(c.deckId, e);
    }
    return m;
  }, [cards, resolvables]);
}

/** "↗": opens the row's page in a new tab, in the background. */
export function NewTabButton({ href }: { href: string }) {
  return (
    <button type="button" className="side-nt" aria-label="Open in a new tab" title="Open in a new tab"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); tabActions.open(href, false); }}>
      <Icon name="external" size={13} />
    </button>
  );
}

const marked = (label: string, hit?: [number, number]): ReactNode =>
  hit ? <>{label.slice(0, hit[0])}<mark>{label.slice(hit[0], hit[1])}</mark>{label.slice(hit[1])}</> : label;

/**
 * The left sidebar: a find box that filters the tree as you type (Enter takes the words on to the Ctrl/⌘+K palette),
 * the main pages (as a list or an icon row), saved filters, one folding tree per project (areas, lists, the wiki by
 * type), and quick actions at the bottom. Folded, it is a rail of icons (web/src/components/SideRail.tsx). Every choice
 * is kept per person.
 */
export function Sidebar({ route }: { route: Route }) {
  const side = usePref('sidebar', validSide, SIDE_DEFAULT);
  const folds = usePref('sideFolds', validFolds, NO_FOLDS);
  const [q, setQ] = useState('');
  // The tree follows the box a moment later on a big workspace: typing never waits for it.
  const dq = useDeferredValue(q);
  /** Folds clicked while a search holds rows open: they apply to this search only and are not saved. */
  const [searchFolds, setSearchFolds] = useState<{ q: string; folds: Record<string, boolean> }>({ q: '', folds: {} });
  const overrides = searchFolds.q === dq.trim() ? searchFolds.folds : NO_FOLDS;
  const [picked, setPicked] = useState<Picked | null>(null);
  const find = useRef<HTMLInputElement>(null);
  const loc = useLocation();
  const pages = useMainPages(route);
  const stats = useListStats();
  const projects = useStore((s) => s.projects);
  const decks = useStore((s) => s.decks);
  const entryTypes = useStore((s) => s.entryTypes);
  const cards = useStore((s) => s.cards);
  const savedSearches = useStore((s) => s.savedSearches);
  const ctx = useSearchCtx();
  const rows = useMemo(() => sideRows({ projects, decks, entryTypes, cards }, stats, dq, folds, overrides), [projects, decks, entryTypes, cards, stats, dq, folds, overrides]);
  const target = quickTarget(store.get(), route, picked);
  const saved = [...savedSearches.values()].sort((a, b) => a.createdAt - b.createdAt);

  const setFolded = (folded: boolean) => setSidePrefs({ ...side, folded });
  if (side.folded) {
    return <SideRail route={route} target={target} onOpen={(focusFind) => { setFolded(false); if (focusFind) requestAnimationFrame(() => find.current?.focus()); }} />;
  }

  // The address as the rows spell theirs; a malformed %-escape (/wiki/1/%E0) matches no row instead of throwing.
  let here = loc.path;
  try { here = decodeURI(loc.path); } catch { /* left as typed */ }
  const deckSeq = route.name === 'deck' || route.name === 'deckCard' || route.name === 'deckActivity' ? route.deckSeq : null;
  const isCurrent = (r: SideRow) => (r.kind === 'list' ? decks.get(r.deckId!)?.seq === deckSeq : !!r.href && here === r.href);
  const toggle = (r: SideRow) => {
    const term = dq.trim();
    if (term) setSearchFolds({ q: term, folds: { ...overrides, [r.id]: !r.open } });
    else prefs.set('sideFolds', setFold(folds, r.id, !r.open), true);
    if (r.kind === 'project' || r.kind === 'area') setPicked({ projectId: r.projectId, areaId: r.areaId });
  };
  const shownSaved = saved.map((x) => ({ x, name: savedSearchName(x.tokens, ctx.suggest, x.forceOr) })).filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="side-find">
        <span className="side-find-ico" aria-hidden><Icon name="search" size={15} /></span>
        <input ref={find} type="search" value={q} placeholder="Find a list, page or task" autoComplete="off" aria-label="Find in the sidebar"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); }
            if (e.key === 'Enter' && q.trim()) { e.preventDefault(); openPalette(q.trim()); }
          }} />
        <kbd aria-hidden>Ctrl K</kbd>
      </div>
      <nav className={side.pages === 'icons' ? 'side-pages icons' : 'side-pages'} aria-label="Main">
        {pages.map((p) => (
          <div key={p.label} className="side-item">
            <Link href={p.href} className="side-row" title={p.label} aria-current={p.current ? 'page' : undefined} aria-keyshortcuts={p.keys}>
              <Icon name={p.icon} size={17} />
              <span className="side-name">{p.label}</span>
              {!!p.badge && <span className="nav-badge" data-testid="inbox-badge">{p.badge}</span>}
            </Link>
            {side.pages === 'list' && <NewTabButton href={p.href} />}
          </div>
        ))}
        <button type="button" className="side-pages-mode" title={side.pages === 'list' ? 'Show the main pages as an icon row' : 'Show the main pages as a list'}
          aria-label={side.pages === 'list' ? 'Main pages as an icon row' : 'Main pages as a list'}
          onClick={() => setSidePrefs({ ...side, pages: side.pages === 'list' ? 'icons' : 'list' })}>
          <Icon name={side.pages === 'list' ? 'grid' : 'list'} size={13} />
        </button>
      </nav>
      <div className="side-scroll">
        {shownSaved.length > 0 && (
          <nav className="side-tree" aria-label="Filters">
            <p className="side-grp">Filters</p>
            {shownSaved.map(({ x, name }) => (
              <Link key={x.id} href={`/decks?search=${encodeChips(x.tokens, x.forceOr)}`} className="side-row l1f" title={name}>
                <Icon name="search" size={15} /><span className="side-name">{name}</span>
              </Link>
            ))}
          </nav>
        )}
        <nav className="side-tree" aria-label="Projects">
          <p className="side-grp">Projects</p>
          {rows.map((r) => {
            if (r.kind === 'project' || r.kind === 'area') {
              const sel = picked?.projectId === r.projectId && (r.kind === 'project' ? picked.areaId === undefined : picked.areaId === r.areaId);
              return (
                <button key={r.id} type="button" className={`side-row l${r.level} side-fold${sel ? ' picked' : ''}`} aria-expanded={r.open}
                  title={r.label} onClick={() => toggle(r)}>
                  <span className="side-tw" aria-hidden><Icon name="chevron" size={13} /></span>
                  {r.kind === 'project' && <Icon name="folder" size={16} />}
                  <span className="side-name">{marked(r.label, r.hit)}</span>
                </button>
              );
            }
            if (r.kind === 'more' && !r.href) return <p key={r.id} className="side-empty side-more">{r.label}</p>;
            const current = isCurrent(r);
            return (
              <div key={r.id} className={`side-item l${r.level}`}>
                {r.open !== undefined
                  ? <button type="button" className="side-tw" aria-expanded={r.open} aria-label={`${r.open ? 'Fold' : 'Unfold'} ${r.label}`} onClick={() => toggle(r)}><Icon name="chevron" size={13} /></button>
                  : <span className="side-tw leaf" aria-hidden />}
                <Link href={r.href} className={`side-row ${r.kind}`} title={r.label} aria-current={current ? 'page' : undefined}
                  aria-label={r.kind === 'list' ? `${r.label}, ${r.count} open` : undefined}>
                  {r.kind === 'list' && <span className="side-ring" style={{ ['--p' as string]: r.total ? Math.round(((r.done ?? 0) / r.total) * 100) : 0 }} aria-hidden />}
                  {r.kind === 'wiki' && <Icon name="book" size={16} />}
                  {(r.kind === 'type' || r.kind === 'entry') && <Icon name={r.kind === 'type' ? 'tag' : 'doc'} size={15} />}
                  <span className="side-name">{marked(r.label, r.hit)}</span>
                  {r.count !== undefined && <span className="side-count">{r.count}</span>}
                </Link>
                {r.kind !== 'more' && <NewTabButton href={r.href} />}
              </div>
            );
          })}
          {dq && rows.length === 0 && shownSaved.length === 0 && (
            <p className="side-empty">Nothing called <b>{dq}</b> in the sidebar. Press Enter to search tasks too, or use the buttons below to make it.</p>
          )}
          {!dq && rows.length === 0 && <p className="side-empty">No projects yet. Make one on the Overview page.</p>}
        </nav>
      </div>
      <QuickActions target={target} onCollapse={() => setFolded(true)} />
    </aside>
  );
}

import { useMemo, useState } from 'react';
import { derivedStatus } from '../../../shared/cards';
import { inboxRows, settingsOf, useStore } from '../store';
import { Link, type Route } from '../router';
import { deckPath, openByCard } from '../cards';
import { spaceLabel } from '../spaces';
import { visionHref } from '../board/boards';
import { useMinuteClock } from '../clock';
import { encodeChips, savedSearchName } from '../../../shared/search';
import { useSearchCtx } from '../search';

const KEY = 'ql.sidebar';
const WIKI = new Set<Route['name']>(['wiki', 'wikiProject', 'wikiEntry', 'wikiType', 'wikiKind', 'wikiNew', 'wikiView']);
const MILESTONES = new Set<Route['name']>(['milestones', 'milestone', 'run', 'milestoneActivity', 'runActivity']);

/** The left sidebar: every page, then every project's lists by area. Collapses to a strip; the choice is kept per browser. */
export function Sidebar({ route }: { route: Route }) {
  const s = useStore((x) => x);
  const now = useMinuteClock();
  const [slim, setSlim] = useState(() => { try { return localStorage.getItem(KEY) === 'slim'; } catch { return false; } });
  const toggle = () => setSlim((v) => { try { localStorage.setItem(KEY, v ? 'wide' : 'slim'); } catch { /* private window */ } return !v; });
  const vision = settingsOf(s).visionBoardEnabled;
  const ctx = useSearchCtx();
  const saved = [...s.savedSearches.values()].sort((a, b) => a.createdAt - b.createdAt);
  const inboxCount = inboxRows(s, now).length;
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  const stats = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>();
    for (const c of s.cards.values()) {
      if (!c.deckId || c.isDoc || c.visibility !== 'default') continue;
      const e = m.get(c.deckId) ?? { total: 0, done: 0 };
      e.total += 1;
      if (derivedStatus(c, open.get(c.id) ?? new Set()) === 'done') e.done += 1;
      m.set(c.deckId, e);
    }
    return m;
  }, [s.cards, open]);
  const projects = [...s.projects.values()].filter((p) => !p.isArchived).sort((a, b) => a.seq - b.seq);
  const decks = [...s.decks.values()].sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq);
  const deckSeq = route.name === 'deck' || route.name === 'deckCard' || route.name === 'deckActivity' ? route.deckSeq : null;
  const item = (href: string, label: string, current: boolean, extra?: React.ReactNode, keys?: string) => (
    <Link href={href} className="side-link" title={label} aria-current={current ? 'page' : undefined} aria-keyshortcuts={keys}>
      <span className="side-name">{slim ? label.slice(0, 2) : label}</span>{extra}
    </Link>
  );
  return (
    <aside className={slim ? 'sidebar slim' : 'sidebar'}>
      <button type="button" className="side-link side-toggle" onClick={toggle} aria-expanded={!slim} aria-label={slim ? 'Widen the sidebar' : 'Collapse the sidebar'}>
        <span className="side-name">{slim ? '»' : '« Collapse'}</span>
      </button>
      <nav className="side-nav" aria-label="Main">
        {item('/decks', 'Overview', route.name === 'decks', undefined, 'Shift+2')}
        {item('/', 'My tasks', route.name === 'root', undefined, 'Shift+1')}
        <Link href="/inbox" className="side-link inbox-link" title="Inbox" aria-current={route.name === 'inbox' ? 'page' : undefined} aria-keyshortcuts="i">
          <span className="side-name">{slim ? 'In' : 'Inbox'}</span>
          {inboxCount > 0 && <span className="nav-badge" data-testid="inbox-badge">{inboxCount}</span>}
        </Link>
        {item('/milestones', 'Milestones', MILESTONES.has(route.name), undefined, 'Shift+3')}
        {vision && item(visionHref(s), 'Vision board', route.name === 'vision' || route.name === 'visionBoard', undefined, 'Shift+4')}
        {item('/wiki', 'Wiki', WIKI.has(route.name))}
        {item('/decks/activity', 'Activity', route.name === 'activity')}
      </nav>
      {saved.length > 0 && (
        <nav className="side-nav" aria-label="Filters">
          <p className="side-head">Filters</p>
          {saved.map((x) => {
            const name = savedSearchName(x.tokens, ctx.suggest, x.forceOr);
            return <Link key={x.id} href={`/decks?search=${encodeChips(x.tokens, x.forceOr)}`} className="side-link" title={name}><span className="side-name">{slim ? name.slice(0, 2) : name}</span></Link>;
          })}
        </nav>
      )}
      {projects.map((p) => {
        const mine = decks.filter((d) => d.projectId === p.id);
        if (!mine.length) return null;
        return (
          <nav key={p.id} className="side-nav" aria-label={`${p.name} lists`}>
            <p className="side-head" title={p.name}>{p.name}</p>
            {p.spaces.map((sp) => {
              const inArea = mine.filter((d) => d.spaceId === sp.id);
              if (!inArea.length) return null;
              return (
                <div key={sp.id} className="side-area">
                  {p.spaces.length > 1 && <p className="side-sub">{spaceLabel(sp)}</p>}
                  {inArea.map((d) => {
                    const st = stats.get(d.id) ?? { total: 0, done: 0 };
                    const left = st.total - st.done;
                    return (
                      <Link key={d.id} href={deckPath(d)} className="side-link" title={d.title} aria-current={d.seq === deckSeq ? 'page' : undefined}
                        aria-label={`${d.title}, ${left} open`}>
                        <span className="side-ring" style={{ ['--p' as string]: st.total ? Math.round((st.done / st.total) * 100) : 0 }} aria-hidden />
                        <span className="side-name">{slim ? '' : d.title}</span>
                        <span className="side-count">{left}</span>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        );
      })}
    </aside>
  );
}

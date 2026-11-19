import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Link, type Route } from '../router';
import { deckPath } from '../cards';
import { wikiPath } from '../wiki';
import { projectPrefix } from '../taskId';
import { spaceLabel } from '../spaces';
import type { QuickTarget } from '../quickTarget';
import { Icon } from './icons';
import { QuickActions } from './QuickActions';
import { useListStats, useMainPages } from './Sidebar';

/** Project tile colours, in turn (theme.css --graph-*). */
const TILE = ['var(--graph-0)', 'var(--graph-1)', 'var(--graph-2)', 'var(--graph-3)', 'var(--graph-4)', 'var(--graph-5)', 'var(--graph-7)'];

/**
 * The folded sidebar: a rail of icons. Open and find at the top, the main pages (Inbox keeps its count), one tile per
 * project that opens that project's lists beside the rail, and the quick actions at the bottom. Every icon names
 * itself on hover and to screen readers.
 */
export function SideRail({ route, target, onOpen }: { route: Route; target: QuickTarget; onOpen: (focusFind: boolean) => void }) {
  const pages = useMainPages(route);
  const projectsMap = useStore((s) => s.projects);
  const decks = useStore((s) => s.decks);
  const cards = useStore((s) => s.cards);
  const stats = useListStats();
  const projects = useMemo(() => [...projectsMap.values()].filter((p) => !p.isArchived).sort((a, b) => a.seq - b.seq), [projectsMap]);
  const [fly, setFly] = useState<string | null>(null);
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!fly) return;
    const onDown = (e: MouseEvent) => { if (!rail.current?.contains(e.target as Node)) setFly(null); };
    // Esc closes the flyout and puts focus back on its project's tile.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const tile = rail.current?.querySelector<HTMLElement>(`[data-tile="${fly}"]`);
      setFly(null);
      tile?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [fly]);

  const deckSeq = route.name === 'deck' || route.name === 'deckCard' || route.name === 'deckActivity' ? route.deckSeq : null;
  const currentProject = deckSeq !== null ? [...decks.values()].find((d) => d.seq === deckSeq)?.projectId
    : 'projectSeq' in route ? projects.find((p) => p.seq === route.projectSeq)?.id : undefined;
  const flyProject = fly ? projectsMap.get(fly) : undefined;
  const hasLore = (pid: string) => {
    for (const c of cards.values()) if (c.isDoc && c.visibility !== 'deleted' && c.deckId && decks.get(c.deckId)?.projectId === pid) return true;
    return false;
  };

  return (
    <aside className="sidebar slim" aria-label="Sidebar" ref={rail}>
      <div className="side-rail" role="toolbar" aria-orientation="vertical" aria-label="Folded sidebar">
        <button type="button" className="ri" aria-label="Open the sidebar" onClick={() => onOpen(false)}>
          <Icon name="side" size={17} /><span className="rtip" aria-hidden>Open the sidebar</span>
        </button>
        <button type="button" className="ri" aria-label="Find (Ctrl K)" onClick={() => onOpen(true)}>
          <Icon name="search" size={16} /><span className="rtip" aria-hidden>Find (Ctrl K)</span>
        </button>
        <hr />
        <nav className="rail-pages" aria-label="Main">
          {pages.map((p) => (
            <Link key={p.label} href={p.href} className="ri" aria-label={p.label} aria-current={p.current ? 'page' : undefined} aria-keyshortcuts={p.keys}>
              <Icon name={p.icon} size={17} />
              {!!p.badge && <span className="ri-badge" data-testid="inbox-badge">{p.badge}</span>}
              <span className="rtip" aria-hidden>{p.label}</span>
            </Link>
          ))}
        </nav>
        <hr />
        {projects.map((p, i) => (
          <button key={p.id} type="button" className="ri" data-tile={p.id} aria-label={p.name} aria-haspopup="true" aria-expanded={fly === p.id}
            aria-current={currentProject === p.id ? 'page' : undefined} onClick={() => setFly((f) => (f === p.id ? null : p.id))}>
            <span className="ptile" style={{ background: TILE[i % TILE.length] }} aria-hidden>{projectPrefix(p.name)}</span>
            <span className="rtip" aria-hidden>{p.name}</span>
          </button>
        ))}
        <span className="rail-grow" />
        <QuickActions target={target} rail />
      </div>
      {flyProject && (
        <nav className="side-fly" aria-label={`${flyProject.name} lists`}>
          <h4><span className="ptile" style={{ background: TILE[projects.indexOf(flyProject) % TILE.length] }} aria-hidden>{projectPrefix(flyProject.name)}</span>{flyProject.name}</h4>
          {flyProject.spaces.map((sp) => {
            const lists = [...decks.values()].filter((d) => d.projectId === flyProject.id && d.spaceId === sp.id).sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq);
            if (!lists.length) return null;
            return (
              <div key={sp.id} className="fly-area">
                {flyProject.spaces.length > 1 && <p className="side-grp">{spaceLabel(sp)}</p>}
                {lists.map((d) => {
                  const st = stats.get(d.id) ?? { total: 0, done: 0 };
                  return (
                    <Link key={d.id} href={deckPath(d)} className="side-row list" aria-current={d.seq === deckSeq ? 'page' : undefined}
                      aria-label={`${d.title}, ${st.total - st.done} open`} onClick={() => setFly(null)}>
                      <span className="side-ring" style={{ ['--p' as string]: st.total ? Math.round((st.done / st.total) * 100) : 0 }} aria-hidden />
                      <span className="side-name">{d.title}</span><span className="side-count">{st.total - st.done}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
          {hasLore(flyProject.id) && (
            <>
              <p className="side-grp">More</p>
              <Link href={wikiPath(flyProject.seq)} className="side-row" onClick={() => setFly(null)}><Icon name="book" size={16} /><span className="side-name">Wiki</span></Link>
            </>
          )}
        </nav>
      )}
    </aside>
  );
}

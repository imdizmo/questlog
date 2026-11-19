import { useMemo } from 'react';
import { useStore } from '../store';
import { Link } from '../router';
import { Icon, type IconName } from '../components/icons';
import { hitView, readRecent, recentHits } from '../palette';

/** A few places to start, on Home and the New tab page. */
const START: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'My tasks', icon: 'user' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox' },
  { href: '/decks', label: 'Overview', icon: 'grid' },
  { href: '/milestones', label: 'Milestones', icon: 'flag' },
  { href: '/wiki', label: 'Wiki', icon: 'book' },
];

function Places({ withHome }: { withHome?: boolean }) {
  const s = useStore((x) => x);
  const recent = useMemo(() => recentHits(s, readRecent()).slice(0, 6), [s.cards, s.decks, s.projects]);
  const places = withHome ? [{ href: '/home', label: 'Home', icon: 'home' as IconName }, ...START] : START;
  return (
    <div className="start-places">
      <section aria-labelledby="start-places">
        <h2 id="start-places" className="start-head">Places to start</h2>
        <nav className="start-list" aria-label="Places to start">
          {places.map((p) => <Link key={p.href} href={p.href} className="start-row"><Icon name={p.icon} size={17} /><span>{p.label}</span></Link>)}
        </nav>
      </section>
      {recent.length > 0 && (
        <section aria-labelledby="start-recent">
          <h2 id="start-recent" className="start-head">Recent pages</h2>
          <nav className="start-list" aria-label="Recent pages">
            {recent.map((h) => {
              const v = hitView(s, h);
              if (!v) return null;
              return (
                <Link key={`${h.kind}:${h.id}`} href={v.href} className="start-row">
                  <Icon name={h.kind === 'list' ? 'list' : h.kind === 'project' ? 'folder' : h.kind === 'task' ? 'task' : 'doc'} size={17} />
                  <span>{h.title}</span>{v.sub && <span className="start-sub">{v.sub}</span>}
                </Link>
              );
            })}
          </nav>
        </section>
      )}
    </div>
  );
}

/** What "+" opens: places to start and recent pages. */
export function NewTabPage() {
  return (
    <main className="page shell-page" id="main">
      <div className="page-head"><div><p className="eyebrow">New tab</p><h1>Open something</h1>
        <p className="hint">Pick a page, click anything in the sidebar, or press <kbd>Ctrl K</kbd> to find it.</p></div></div>
      <Places withHome />
    </main>
  );
}

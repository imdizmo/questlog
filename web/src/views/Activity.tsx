import { useEffect, useRef, useState } from 'react';
import { ACTIVITY_FILTERS, mergeProperties, type ActivityFilter, type ActivityItem } from '../../../shared/activity';
import { api } from '../api';
import { projectVisible, useStore } from '../store';
import { Link, useLocation } from '../router';
import { deckPath } from '../cards';
import { ActivityList } from '../components/ActivityList';

const FILTER_LABEL: Record<ActivityFilter, string> = {
  newCards: 'New Tasks',
  workflow: 'Workflow state changes',
  done: 'Done Tasks',
  attachments: 'Attachments',
  properties: 'Properties',
  content: 'Content Changes',
  conversations: 'Conversations',
};

/** Activity of one deck (`deckSeq`), milestone (`milestoneSeq`), run (`runSeq`) or, without them, of a project (the first one in view, with a picker). */
export function Activity({ deckSeq, milestoneSeq, runSeq }: { deckSeq?: number; milestoneSeq?: number; runSeq?: number }) {
  if (milestoneSeq !== undefined || runSeq !== undefined) return <PlanActivity milestoneSeq={milestoneSeq} runSeq={runSeq} />;
  return <DeckActivity deckSeq={deckSeq} />;
}

function PlanActivity({ milestoneSeq, runSeq }: { milestoneSeq?: number; runSeq?: number }) {
  const m = useStore((x) => milestoneSeq === undefined ? undefined : [...x.milestones.values()].find((y) => y.accountSeq === milestoneSeq));
  const r = useStore((x) => runSeq === undefined ? undefined : [...x.sprints.values()].find((y) => y.accountSeq === runSeq));
  const name = m?.name ?? r?.label;
  const back = milestoneSeq !== undefined ? `/milestones/${milestoneSeq}` : `/milestones/run/${runSeq}`;
  if (!m && !r) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/milestones">← Timeline</Link></p><h1>{milestoneSeq !== undefined ? 'Milestone not found' : 'Sprint not found'}</h1></div></div>
      </main>
    );
  }
  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link href="/milestones">Milestones</Link></p>
          <h1>Activity for {name}</h1>
        </div>
        <div className="deck-actions"><Link href={back} className="btn">Back to Tasks</Link></div>
      </div>
      <Feed key={(m ?? r)!.id} scope={m ? { milestoneId: m.id } : { sprintId: r!.id }} />
    </main>
  );
}

function DeckActivity({ deckSeq }: { deckSeq?: number }) {
  const s = useStore((x) => x);
  const deck = deckSeq !== undefined ? [...s.decks.values()].find((d) => d.seq === deckSeq) : undefined;
  const projects = [...s.projects.values()].filter((p) => !p.isArchived && projectVisible(s, p.id)).sort((a, b) => a.seq - b.seq);
  const wanted = Number(useLocation().query.get('project'));
  const [picked, setPicked] = useState<string | null>(null);
  const project = deck ? s.projects.get(deck.projectId)
    : projects.find((p) => p.id === picked) ?? projects.find((p) => p.seq === wanted) ?? projects[0];

  if (deckSeq !== undefined && !deck) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/decks">← Lists</Link></p><h1>List not found</h1></div></div>
      </main>
    );
  }
  if (!deck && !project) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/decks">← Lists</Link></p><h1>Activity</h1></div></div>
        <p className="muted">No projects in view.</p>
      </main>
    );
  }
  const scope = deck ? { deckId: deck.id } : { projectId: project!.id };
  const name = deck ? deck.title : project!.name;
  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link href="/decks">Lists</Link>{deck && project && <> / {project.name}</>}</p>
          <h1>Activity for {name}</h1>
        </div>
        <div className="deck-actions">
          {!deck && projects.length > 1 && (
            <select aria-label="Project" value={project!.id} onChange={(e) => setPicked(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <Link href={deck ? deckPath(deck) : '/decks'} className="btn">Back to Tasks</Link>
        </div>
      </div>
      <Feed key={deck?.id ?? project!.id} scope={scope} />
    </main>
  );
}

function Feed({ scope }: { scope: { deckId?: string; projectId?: string; milestoneId?: string; sprintId?: string } }) {
  const [filters, setFilters] = useState<ActivityFilter[]>([]);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);

  const load = (before: string | null, append: boolean, g: number) => {
    setBusy(true);
    api.activity({ ...scope, before, filters }).then((r) => {
      if (g !== gen.current) return;
      // Pages are cut at arbitrary points, so merge again across the seam (same cards/people within the window).
      setItems((prev) => (append ? mergeProperties([...prev, ...r.items.filter((n) => !prev.some((p) => p.id === n.id))]) : r.items));
      setNext(r.next);
      setState('ready');
    }).catch(() => { if (g === gen.current) setState('error'); })
      .finally(() => { if (g === gen.current) setBusy(false); });
  };
  useEffect(() => {
    const g = ++gen.current;
    setState('loading'); setItems([]); setNext(null);
    load(null, false, g);
    return () => { gen.current++; };
  }, [filters.join(',')]);

  const toggle = (f: ActivityFilter) => setFilters((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
  return (
    <>
      <div className="seg activity-filters" role="group" aria-label="Filters">
        {ACTIVITY_FILTERS.map((f) => (
          <button key={f} type="button" className={filters.includes(f) ? 'chip on' : 'chip'} aria-pressed={filters.includes(f)} onClick={() => toggle(f)}>
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      {state === 'error' && <p className="muted">Couldn't load the activity.</p>}
      {state === 'loading' && <p className="muted" aria-busy="true">Loading…</p>}
      {state === 'ready' && items.length === 0 && !next && <div className="empty"><p>Nothing here yet.</p></div>}
      {items.length > 0 && <ActivityList items={items} />}
      {state === 'ready' && next && (
        <button type="button" className="btn" disabled={busy} onClick={() => load(next, true, gen.current)}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}

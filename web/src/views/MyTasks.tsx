import { useMemo } from 'react';
import type { Card } from '../../../shared/types';
import { derivedStatus } from '../../../shared/cards';
import { settingsOf, useStore } from '../store';
import { Link } from '../router';
import { deckPath, openByCard } from '../cards';
import { CardTile } from '../components/CardTile';
import { HandSidebar } from '../components/HandSidebar';
import { useMinuteClock } from '../clock';
import { myTodayTotal, trackingOn, useTickNow } from '../timeTracking';
import { formatDuration } from '../../../shared/duration';

/** Everything assigned to me that is not done, list by list. Replaces the hand: nothing to pick, nothing to fill. */
export function MyTasks() {
  const s = useStore((x) => x);
  const settings = settingsOf(s);
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  const byDeck = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const c of s.cards.values()) {
      if (c.assigneeId !== s.me?.id || !c.deckId || c.isDoc || c.visibility !== 'default') continue;
      if (derivedStatus(c, open.get(c.id) ?? new Set()) === 'done') continue;
      const l = m.get(c.deckId);
      if (l) l.push(c); else m.set(c.deckId, [c]);
    }
    for (const l of m.values()) l.sort((a, b) => (a.priority ?? 'z').localeCompare(b.priority ?? 'z') || a.sortIndex - b.sortIndex);
    return m;
  }, [s.cards, s.me?.id, open]);
  const decks = [...s.decks.values()].filter((d) => byDeck.has(d.id)).sort((a, b) => a.projectId.localeCompare(b.projectId) || a.sortIndex - b.sortIndex);
  const total = [...byDeck.values()].reduce((n, l) => n + l.length, 0);
  const minute = useMinuteClock();
  const now = Math.max(useTickNow(), minute);
  return (
    <main className="page" id="main">
      <div className="page-head"><div><p className="eyebrow">Yours</p><h1>My tasks</h1></div><p className="muted">{total} open{trackingOn(s) && <> · <span data-testid="hand-tracked">{formatDuration(myTodayTotal(s, now))} h</span> today</>}</p></div>
      <div className="hand-layout">
      <div>
      {total === 0 ? (
        <div className="empty"><h2>Nothing assigned to you</h2><p>Open a task and set yourself as its owner, and it shows up here until it is done.</p></div>
      ) : decks.map((d) => (
        <section key={d.id} className="card-group" aria-label={d.title}>
          <div className="group-bar">
            <h3 className="group-head"><Link href={deckPath(d)}>{d.title}</Link></h3>
            <span className="group-stats">{s.projects.get(d.projectId)?.name}</span>
          </div>
          <ul className="card-list" aria-label={`${d.title} tasks`}>
            {byDeck.get(d.id)!.map((c) => (
              <li key={c.id}>
                <CardTile card={c} deck={d} open={open.get(c.id) ?? new Set()} owner={s.me ?? undefined} settings={settings}
                  projectTags={s.projects.get(d.projectId)?.tags} compact />
              </li>
            ))}
          </ul>
        </section>
      ))}
      </div>
      {s.me && <HandSidebar userId={s.me.id} />}
      </div>
    </main>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../../../shared/activity';
import { api } from '../api';
import { useStore } from '../store';
import { Link } from '../router';
import { ActivityList } from './ActivityList';

const WANT = 5;
const MAX_REQUESTS = 3;

/** First five entries of a deck's, milestone's or run's feed. Follows `next` a few times (pages may be short), refreshes 1 s after live card or thread changes of the deck. */
export function LatestActivity({ deckId, milestoneId, sprintId, href }: { deckId?: string; milestoneId?: string; sprintId?: string; href: string }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Changes whenever a card of this deck or one of its threads/entries changes; nothing else moves it.
  const signature = useStore((s) => {
    const ids = new Set<string>();
    const parts: string[] = [];
    const inScope = (c: { deckId: string | null; milestoneId: string | null; sprintId: string | null }) =>
      deckId ? c.deckId === deckId : milestoneId ? c.milestoneId === milestoneId : c.sprintId === sprintId;
    for (const c of s.cards.values()) if (inScope(c)) { ids.add(c.id); parts.push(`${c.id}:${c.version}:${c.visibility}`); }
    const res = new Set<string>();
    for (const r of s.resolvables.values()) if (ids.has(r.cardId)) { res.add(r.id); parts.push(`r${r.id}${r.isClosed ? 'x' : ''}`); }
    for (const e of s.entries.values()) if (res.has(e.resolvableId)) parts.push(`e${e.id}`);
    return parts.join('|');
  });
  const first = useRef(true);

  useEffect(() => {
    let alive = true;
    const fetchIt = async () => {
      try {
        let got: ActivityItem[] = [];
        let before: string | null = null;
        for (let n = 0; n < MAX_REQUESTS; n++) {
          const r = await api.activity({ deckId, milestoneId, sprintId, before });
          got = got.concat(r.items);
          before = r.next;
          if (got.length >= WANT || !before) break;
        }
        if (alive) { setItems(got.slice(0, WANT)); setFailed(false); }
      } catch { if (alive) setFailed(true); }
    };
    const t = setTimeout(() => void fetchIt(), first.current ? 0 : 1000);
    first.current = false;
    return () => { alive = false; clearTimeout(t); };
  }, [deckId, milestoneId, sprintId, signature]);

  return (
    <section className="latest-activity" aria-label="Latest activity">
      <div className="latest-head">
        <h3 className="group-head">Latest activity</h3>
        <Link href={href}>See all</Link>
      </div>
      {items === null ? (failed ? <p className="muted">Couldn't load the activity.</p> : <p className="muted" aria-busy="true">Loading…</p>)
        : items.length === 0 ? <p className="muted">Nothing yet.</p>
        : <ActivityList items={items} compact />}
    </section>
  );
}

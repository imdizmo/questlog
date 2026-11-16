import { taskId } from '../taskId';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cardCode, titleOf } from '../../../shared/cards';
import type { Card } from '../../../shared/types';
import { cardHref, localToday } from '../cards';
import { useMinuteClock } from '../clock';
import { currentRuns, myCardsInRun, userName } from '../hand';
import { workdaysBetween } from '../../../shared/schedule';
import { localToday as planToday } from '../planning';
import { Link } from '../router';
import { inboxRows, settingsOf, useStore } from '../store';
import { useOpenDecks } from '../openDecks';

const DAY = 86_400_000;
const DONE_DAYS = 14;
const CAP = 50;

function CardLinks({ cards, empty }: { cards: Card[]; empty: string }) {
  const decks = useStore((s) => s.decks);
  if (!cards.length) return <p className="muted widget-empty">{empty}</p>;
  return (
    <ul className="widget-list">
      {cards.slice(0, CAP).map((c) => (
        <li key={c.id}>
          <Link href={cardHref(c, c.deckId ? decks.get(c.deckId) : undefined)}>
            <span className="code-chip">{taskId(c)}</span> {titleOf(c.content) || 'Untitled'}
          </Link>
          {c.dueDate && <span className="muted"> {c.dueDate}</span>}
        </li>
      ))}
    </ul>
  );
}

function Widget({ id, title, count, children }: { id: string; title: ReactNode; count?: number; children?: ReactNode }) {
  return (
    <section className="widget" data-testid={`widget-${id}`} aria-label={typeof title === 'string' ? title : id}>
      <h2>{title}{count !== undefined && <span className="tab-count quiet">{count}</span>}</h2>
      {children}
    </section>
  );
}

interface UpvoteStats { visitsThisWeek: number; top: { cardId: string; seq: number; title: string; upvotes: number }[] }

/** Upvote Stats: the most upvoted cards of shared projects (Open Decks, guests and team) and this week's visits. */
function UpvoteStatsWidget() {
  const shared = [...useOpenDecks().values()].some((o) => o.enabled);
  const cards = useStore((x) => x.cards);
  const decks = useStore((x) => x.decks);
  const [stats, setStats] = useState<UpvoteStats | null>(null);
  useEffect(() => {
    if (!shared) return;
    let alive = true;
    fetch('/api/open-stats', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setStats(j); }).catch(() => {});
    return () => { alive = false; };
  }, [shared]);
  if (!shared || !stats) return null;
  return (
    <Widget id="upvotes" title="Upvote Stats">
      <p className="muted widget-empty" data-testid="visits-week">{stats.visitsThisWeek} {stats.visitsThisWeek === 1 ? 'visit' : 'visits'} this week</p>
      {stats.top.length ? (
        <ul className="widget-list">
          {stats.top.map((t) => {
            const c = cards.get(t.cardId);
            return (
              <li key={t.cardId}>
                <span className="upvote-count" title={`${t.upvotes} upvotes`}>▲ {t.upvotes}</span>{' '}
                {c ? <Link href={cardHref(c, c.deckId ? decks.get(c.deckId) : undefined)}>{t.title}</Link> : <span>{t.title}</span>}
              </li>
            );
          })}
        </ul>
      ) : <p className="muted widget-empty">No upvotes yet.</p>}
    </Widget>
  );
}

/** The widgets beside the Hand. Everything but Done Cards and Team Hands is about me, so it hides on a teammate's Hand. */
export function HandSidebar({ userId }: { userId: string }) {
  const s = useStore((x) => x);
  const now = useMinuteClock();
  const meId = s.me!.id;
  const mine = userId === meId;
  const [doneOpen, setDoneOpen] = useState(false);

  const done = useMemo(() => [...s.donePile.values()]
    .filter((d) => d.userId === userId && d.doneAt >= now - DONE_DAYS * DAY)
    .sort((a, b) => b.doneAt - a.doneAt)
    .map((d) => s.cards.get(d.cardId))
    .filter((c): c is Card => !!c && c.visibility !== 'deleted'), [s.donePile, s.cards, userId, now]);
  const bookmarks = useMemo(() => [...s.bookmarks.values()]
    .filter((b) => b.userId === meId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((b) => s.cards.get(b.cardId))
    .filter((c): c is Card => !!c && c.visibility !== 'deleted'), [s.bookmarks, s.cards, meId]);
  const conversations = useMemo(() => inboxRows(s, now), [s.notifications, s.resolvables, s.cards, s.me, now]);
  const dueEnabled = settingsOf(s).dueDateEnabled;
  const due = useMemo(() => {
    if (!dueEnabled) return [];
    const limit = localToday(new Date(now + 7 * DAY));
    return [...s.cards.values()]
      .filter((c) => c.assigneeId === meId && c.status !== 'done' && c.visibility === 'default' && c.dueDate && c.dueDate <= limit)
      .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : a.seq - b.seq));
  }, [s.cards, meId, dueEnabled, now]);
  const snoozing = useMemo(() => {
    const out: Card[] = [];
    for (const n of s.notifications.values()) {
      if (n.userId !== meId || n.snoozeUntil === null || n.snoozeUntil <= now) continue;
      const r = s.resolvables.get(n.resolvableId);
      const c = r && !r.isClosed ? s.cards.get(r.cardId) : undefined;
      if (c && c.visibility !== 'deleted' && !out.includes(c)) out.push(c);
    }
    return out;
  }, [s.notifications, s.resolvables, s.cards, meId, now]);
  const settings = settingsOf(s);
  const runs = useMemo(() => (settings.sprintsEnabled ? currentRuns(s, planToday()).sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr) : []),
    [s.sprints, settings.sprintsEnabled, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinned = useMemo(() => (settings.milestonesEnabled ? [...s.milestones.values()].filter((m) => m.isPinned).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999')) : []),
    [s.milestones, settings.milestonesEnabled]);

  return (
    <aside className="hand-side" aria-label="My tasks widgets">
      <Widget id="done" title={
        <button type="button" className="widget-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
          Done Tasks <span className="tab-count quiet">{done.length}</span>
        </button>}>
        {doneOpen && <CardLinks cards={done} empty="Nothing finished in the last 14 days." />}
      </Widget>
      {mine && (
        <>
          <Widget id="conversations" title="Conversations" count={conversations.length}>
            <Link href="/inbox">{conversations.length ? 'Open your messages' : 'No messages waiting'}</Link>
          </Widget>
          <Widget id="due" title="Due Tasks" count={due.length}>
            {dueEnabled ? <CardLinks cards={due} empty="Nothing due this week." /> : <p className="muted widget-empty">Due dates are switched off.</p>}
          </Widget>
          <Widget id="bookmarks" title="Bookmarks" count={bookmarks.length}>
            <CardLinks cards={bookmarks} empty="Bookmark a task from its More options menu." />
          </Widget>
          <Widget id="snoozing" title={`${snoozing.length} snoozing`}>
            <CardLinks cards={snoozing} empty="No snoozed conversations." />
          </Widget>
          {settings.sprintsEnabled && runs.length === 0 && (
            <Widget id="run" title="Sprint"><p className="muted widget-empty">No sprint yet.</p></Widget>
          )}
          {runs.map((r) => {
            const mine = myCardsInRun(s, meId, r.id);
            const left = Math.max(0, workdaysBetween(planToday(), r.endDay, settings.workdays));
            return (
              <Widget key={r.id} id={`run-${r.id}`} title={`Sprint ${r.runNr}`} count={mine.length}>
                <Link href={`/milestones/run/${r.accountSeq}`}>{r.label}</Link>
                <span className="muted"> {left}d left</span>
                <CardLinks cards={mine} empty="No open tasks of yours in this sprint." />
              </Widget>
            );
          })}
          <UpvoteStatsWidget />
          {pinned.length > 0 && (
            <Widget id="milestones" title="Milestones" count={pinned.length}>
              <ul className="widget-list">
                {pinned.map((m) => (
                  <li key={m.id}>
                    <Link href={`/milestones/${m.accountSeq}`}>{m.name}</Link>
                    {m.date && <span className="muted"> {Math.max(0, workdaysBetween(planToday(), m.date, settings.workdays))}d</span>}
                  </li>
                ))}
              </ul>
            </Widget>
          )}
        </>
      )}
    </aside>
  );
}

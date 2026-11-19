import { useEffect, useState } from 'react';
import type { AccountSettings, Card, CardHistory, CardStatus, Deck, HistoryChange, Priority, User, Visibility } from '../../../shared/types';
import { DEFAULT_SETTINGS } from '../../../shared/types';
import { titleOf } from '../../../shared/cards';
import { commitHref, commitLabel } from '../../../shared/activity';
import { api } from '../api';
import { formatTime } from '../cards';
import { canManageProject, isAdmin, useStore } from '../store';
import { formatDuration } from '../../../shared/duration';
import { dispatch } from '../api';
import { AddTimeForm } from './AddTimeForm';
import { useCardTime } from '../timeTracking';
import { trackingOn } from '../timeTracking';

interface Names {
  users: Map<string, User>;
  decks: Map<string, Deck>;
  /** For naming related cards (hero, sub cards, dependencies). */
  cards?: Map<string, Pick<Card, 'id' | 'content'>>;
  priorityLabels?: AccountSettings['priorityLabels'];
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Our wording for one change: a short label plus optional detail (from → to, or the quoted message). */
export function describeChange(c: HistoryChange, n: Names): { label: string; detail?: string; href?: string } {
  const user = (id: unknown) => (typeof id === 'string' ? n.users.get(id)?.name ?? 'someone' : 'nobody');
  const deck = (id: unknown) => (typeof id === 'string' ? n.decks.get(id)?.title ?? 'another list' : 'no list');
  const prio = (p: unknown) => (typeof p === 'string' ? (n.priorityLabels ?? DEFAULT_SETTINGS.priorityLabels)[p as Priority] ?? p : 'none');
  const card = (id: unknown) => {
    const c = typeof id === 'string' ? n.cards?.get(id) : undefined;
    return c ? titleOf(c.content) || 'Untitled' : 'a task';
  };
  /** "+Key −Map" for a whole-array change of card ids. */
  const cardDiff = (from: unknown, to: unknown) => {
    const [a, b] = [list(from), list(to)];
    return [...b.filter((x) => !a.includes(x)).map((x) => `+${card(x)}`), ...a.filter((x) => !b.includes(x)).map((x) => `−${card(x)}`)].join(' ') || undefined;
  };
  const val = (v: unknown) => (v === null || v === undefined ? 'none' : String(v));
  switch (c.kind) {
    case 'created': return { label: 'Created' };
    case 'content': return { label: 'Edited text' };
    case 'title': return { label: 'Renamed', detail: `${String(c.from)} → ${String(c.to)}` };
    case 'deck': return { label: 'Moved', detail: `${deck(c.from)} → ${deck(c.to)}` };
    case 'owner': return { label: c.to ? 'Owner set' : 'Owner removed', detail: `${user(c.from)} → ${user(c.to)}` };
    case 'status': {
      const to = c.to as CardStatus;
      if (to === 'started') return { label: 'Started' };
      if (to === 'done') return { label: 'Marked done' };
      return { label: c.from === 'done' ? 'Reopened' : 'Stopped' };
    }
    case 'blocked': return { label: 'Blocked', detail: c.quote };
    case 'unblocked': return { label: 'Unblocked', detail: c.quote };
    case 'reviewOpened': return { label: 'Review requested', detail: c.quote };
    case 'reviewClosed': return { label: 'Review closed', detail: c.quote };
    case 'commentOpened': return { label: 'Comment thread opened', detail: c.quote };
    case 'commentClosed': return { label: 'Comment thread closed', detail: c.quote };
    case 'snoozed': return { label: 'Snoozed', detail: 'No activity for a while' };
    case 'unsnoozed': return { label: 'Woke up' };
    case 'visibility': {
      const to = c.to as Visibility;
      return { label: to === 'archived' ? 'Archived' : to === 'deleted' ? 'Deleted' : 'Restored' };
    }
    case 'doc': return { label: c.to ? 'Turned into lore' : 'Turned into task' };
    case 'priority': return { label: c.to ? 'Priority set' : 'Priority removed', detail: `${prio(c.from)} → ${prio(c.to)}` };
    case 'effort': return { label: c.to === null || c.to === undefined ? 'Effort removed' : 'Effort set', detail: `${val(c.from)} → ${val(c.to)}` };
    case 'dueDate': return { label: c.to ? 'Due date set' : 'Due date removed', detail: `${val(c.from)} → ${val(c.to)}` };
    case 'tags': {
      const from = list(c.from);
      const to = list(c.to);
      const added = to.filter((t) => !from.includes(t)).map((t) => `+#${t}`);
      const removed = from.filter((t) => !to.includes(t)).map((t) => `−#${t}`);
      return { label: 'Tags changed', detail: [...added, ...removed].join(' ') || undefined };
    }
    case 'deps': return { label: 'Dependencies changed', detail: cardDiff(c.from, c.to) };
    case 'parent': return c.to ? { label: 'Main task set', detail: card(c.to) } : { label: 'Main task removed', detail: card(c.from) };
    case 'children': return { label: 'Subtasks changed', detail: cardDiff(c.from, c.to) };
    case 'commit': return { label: `Referenced in commit ${commitLabel(c.to)}`, href: commitHref(c.to) ?? undefined };
    case 'file': return c.to ? { label: 'Attachment added', detail: val(c.to) } : { label: 'Attachment removed', detail: val(c.from) };
    case 'entry': return { label: 'Lore fields changed', detail: [c.type ? 'type' : '', c.key ? `key ${val(c.key.from)} → ${val(c.key.to)}` : '', c.parent ? (c.parent.to ? `filed under ${card(c.parent.to)}` : 'moved to top level') : '', ...(c.fields ?? [])].filter(Boolean).join(', ') || undefined };
    case 'block': return { label: `${c.title ?? 'A block'} changed` };
    case 'aliases': {
      const from = list(c.from);
      const to = list(c.to);
      const parts = [...to.filter((t) => !from.includes(t)).map((t) => `+${t}`), ...from.filter((t) => !to.includes(t)).map((t) => `−${t}`)];
      return { label: 'Aliases changed', detail: parts.join(', ') || undefined };
    }
    case 'linkIgnores': {
      const from = list(c.from);
      const to = list(c.to);
      const added = to.filter((t) => !from.includes(t));
      const removed = from.filter((t) => !to.includes(t));
      return added.length ? { label: 'Not a link here', detail: added.join(', ') } : { label: 'Link turned back on', detail: removed.join(', ') || undefined };
    }
    default: return { label: String((c as HistoryChange).kind) };
  }
}

/** Card history, newest first. Reloads whenever the card's version moves. */
export function HistoryTab({ cardId, version, users, decks, cards, priorityLabels }: { cardId: string; version: number } & Names) {
  const [rows, setRows] = useState<CardHistory[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api.history(cardId).then((r) => { if (alive) { setRows(r); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [cardId, version]);

  if (failed && !rows) return <p className="muted">Couldn't load the history.</p>;
  if (!rows) return <p className="muted" aria-busy="true">Loading…</p>;
  return (
    <>
    <TimeSection cardId={cardId} users={users} />
    <ol className="history">
      {rows.flatMap((row) => row.changes.map((c, i) => {
        const d = describeChange(c, { users, decks, cards, priorityLabels });
        return (
          <li key={`${row.version}-${i}`} className="history-item" data-testid="history-item">
            <div className="history-line">
              <span className="history-label" data-testid="history-label">{d.label}</span>
              {c.kind !== 'commit' && <span className="muted">by {row.changerId === 'system' ? 'System' : users.get(row.changerId)?.name ?? 'someone'}</span>}
              <time className="muted history-time" dateTime={new Date(row.at).toISOString()}>{formatTime(row.at)}</time>
            </div>
            {d.href && <p className="history-detail"><a href={d.href} target="_blank" rel="noopener noreferrer">View commit</a></p>}
            {d.detail && <p className={c.quote ? 'history-quote' : 'history-detail'}>{d.detail}</p>}
          </li>
        );
      }))}
    </ol>
    </>
  );
}

/** Add Time and the tracked segments of this card (only with time tracking on). */
function TimeSection({ cardId, users }: { cardId: string; users: Map<string, User> }) {
  const s = useStore((x) => x);
  const on = trackingOn(s);
  const time = useCardTime(cardId, on);
  // Until the server list arrives, the snapshot's segments (30 days) stand in.
  const segs = time ? time.segments : [...s.timeSegments.values()].filter((t) => t.cardId === cardId).sort((a, b) => b.startedAt - a.startedAt);
  if (!on) return null;
  const card = s.cards.get(cardId);
  const deck = card?.deckId ? s.decks.get(card.deckId) : undefined;
  const project = deck ? s.projects.get(deck.projectId) : undefined;
  const manage = project ? canManageProject(s, project) : isAdmin(s);
  return (
    <section aria-label="Tracked time">
      <AddTimeForm cardId={cardId} />
      {time && <p className="muted" data-testid="time-total">Total {formatDuration(time.totalMs)} h</p>}
      <ul className="time-list">
        {segs.map((t) => (
          <li key={t.id} className="time-seg" data-testid="time-segment">
            <span>{users.get(t.userId)?.name ?? 'someone'}</span>
            <time className="muted" dateTime={new Date(t.startedAt).toISOString()}>{new Date(t.startedAt).toLocaleDateString()}</time>
            <strong>{t.durationInMs === null ? 'running' : formatDuration(t.durationInMs)}</strong>
            {(t.userId === s.me?.id || manage) && (
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Delete time entry"
                onClick={() => void dispatch('timeTracking', 'delete', { id: t.id }).catch(() => {})}>Delete</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

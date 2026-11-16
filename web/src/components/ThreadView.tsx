import { useState } from 'react';
import type { Reaction, Resolvable, ResolvableEntry, ResolvableNotification, User } from '../../../shared/types';
import { dispatch } from '../api';
import { formatTime } from '../cards';
import { GUARDIAN_TIP } from '../store';
import { Icon } from './icons';
import { ReactionBar } from './ReactionBar';

interface Props {
  resolvable: Resolvable;
  entries: ResolvableEntry[];
  reactions: Reaction[];
  users: Map<string, User>;
  meId: string | undefined;
  /** My notification row for this thread, when there is one. */
  note?: ResolvableNotification;
  /** I may write in and close open threads of this card. */
  canAct: boolean;
  /** A closed thread (loaded on demand): read-only, so no reply, edit, snooze or reaction changes. */
  closed?: boolean;
  /** The card's deck is guarded and I am not a guardian: closing a review as done is off. */
  guarded?: boolean;
  now: number;
}

const KIND: Record<string, { label: string; icon: 'block' | 'review' }> = {
  block: { label: 'Blocker', icon: 'block' },
  review: { label: 'Review', icon: 'review' },
  comment: { label: 'Comment', icon: 'review' },
};

/** One thread with its messages, reactions, reply box, snooze and the buttons that close it. */
export function ThreadView({ resolvable: r, entries, reactions, users, meId, note, canAct, closed, guarded, now }: Props) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const run = async (action: string, payload: object) => {
    setBusy(true);
    try { await dispatch('resolvables', action, payload); return true; } catch { return false; } finally { setBusy(false); }
  };
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  const kind = KIND[r.context];
  const snoozed = !!note && note.snoozeUntil !== null && note.snoozeUntil > now;
  const sendReply = async () => {
    const text = reply.trim();
    if (!text || busy) return;
    if (await run('comment', { resolvableId: r.id, content: text })) setReply('');
  };
  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    if (await run('editEntry', { entryId: editing.id, content: editing.text.trim() })) setEditing(null);
  };

  return (
    <section className={`thread thread-${r.context}${closed ? ' thread-closed' : ''}`} data-testid={closed ? 'closed-thread' : 'thread'} aria-label={kind.label}>
      <header className="thread-head">
        <Icon name={kind.icon} size={16} />
        <span className="thread-kind">{kind.label}</span>
        <span className="muted">opened by {users.get(r.creatorId)?.name ?? 'someone'}{closed ? ' · closed' : ''}</span>
        {!closed && note && (
          <span className="thread-head-end">
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
              onClick={() => void run('snooze', snoozed ? { resolvableId: r.id, until: null } : { resolvableId: r.id })}>
              {snoozed ? 'Clear snooze' : 'Snooze for 3 days'}
            </button>
          </span>
        )}
      </header>
      <ol className="thread-entries">
        {sorted.map((e) => {
          const mine = e.authorId === meId;
          const ownReactions = reactions.filter((x) => x.entryId === e.id);
          return (
            <li key={e.id} className="entry" data-testid="entry">
              <div className="entry-meta">
                <span className="avatar sm" aria-hidden>{(users.get(e.authorId)?.name ?? '?').slice(0, 1).toUpperCase()}</span>
                <strong>{users.get(e.authorId)?.name ?? 'Unknown'}</strong>
                <time className="muted" dateTime={new Date(e.createdAt).toISOString()}>{formatTime(e.createdAt)}</time>
                {e.version > 1 && <span className="muted">(edited)</span>}
                {mine && canAct && !closed && editing?.id !== e.id && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing({ id: e.id, text: e.content })}>Edit</button>
                )}
              </div>
              {editing?.id === e.id ? (
                <div className="entry-edit">
                  <textarea aria-label="Edit message" rows={3} autoFocus value={editing.text}
                    onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void saveEdit(); }
                      if (ev.key === 'Escape') { ev.stopPropagation(); setEditing(null); }
                    }} />
                  <div className="row">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy || !editing.text.trim()} onClick={() => void saveEdit()}>Save</button>
                  </div>
                </div>
              ) : (
                <p className="entry-text">{e.content}</p>
              )}
              <ReactionBar entryId={e.id} reactions={ownReactions} meId={meId} users={users} disabled={closed || !canAct} />
            </li>
          );
        })}
      </ol>
      {canAct && !closed && (
        <>
          <div className="thread-reply">
            <textarea aria-label="Reply" rows={2} placeholder="Write a reply. Ctrl+Enter sends." value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendReply(); } }} />
            <button type="button" className="btn btn-sm" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>Reply</button>
          </div>
          <div className="thread-actions">
            {r.context === 'block' ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void run('close', { id: r.id })}><Icon name="check" size={16} /> Unblock this task</button>
            ) : r.context === 'review' ? (
              <>
                <button type="button" className="btn btn-primary" disabled={busy || !!guarded} title={guarded ? GUARDIAN_TIP : undefined}
                  onClick={() => void run('close', { id: r.id, markCardDone: true })}><Icon name="check" size={16} /> Close review and mark as done</button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run('close', { id: r.id })}>Cancel review</button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void run('close', { id: r.id })}><Icon name="check" size={16} /> Close this thread</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

import { useState } from 'react';
import { dispatch } from '../api';
import { canManageProject, canViewProject, isAdmin, people as peopleOf, useStore } from '../store';
import { formatDuration, MAX_SEGMENT_MS, parseDuration } from '../../../shared/duration';

import { userName } from '../hand';
import { endsInFuture } from '../timeTracking';

type When = 'today' | 'yesterday' | 'pick';
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** When the entry starts: today ends now; any other day is noon local on that day. */
export function startedAtFor(when: When, picked: string, durationMs: number, now = Date.now()): number | null {
  if (when === 'today') return Math.max(new Date(now).setHours(0, 0, 0, 0), now - durationMs);
  const day = new Date(now);
  if (when === 'yesterday') day.setDate(day.getDate() - 1);
  else {
    const m = picked.match(/^(\d{4})-(\d\d)-(\d\d)$/);
    if (!m) return null;
    day.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return day.setHours(12, 0, 0, 0);
}

/** Manual time entry: USER, DATE, DURATION (parsed as you type). */
export function AddTimeForm({ cardId }: { cardId: string }) {
  const s = useStore((x) => x);
  const meId = s.me!.id;
  const card = s.cards.get(cardId);
  const deck = card?.deckId ? s.decks.get(card.deckId) : undefined;
  const project = deck ? s.projects.get(deck.projectId) : undefined;
  const manage = project ? canManageProject(s, project) : isAdmin(s);
  const people = manage ? peopleOf(s.users).filter((u) => u.id === meId || !project || canViewProject(s, u.id, project.id)) : [];
  const [userId, setUserId] = useState(meId);
  const [when, setWhen] = useState<When>('today');
  const [picked, setPicked] = useState(ymd(new Date()));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ms = parseDuration(text);
  const valid = ms !== null && ms > 0 && ms <= MAX_SEGMENT_MS;
  const startedAt = valid ? startedAtFor(when, picked, ms) : null;
  const future = valid && startedAt !== null && endsInFuture(startedAt, ms);

  const add = async () => {
    if (!valid || startedAt === null || endsInFuture(startedAt, ms)) return;
    setBusy(true);
    try {
      await dispatch('timeTracking', 'create', { startedAt, durationInMs: ms, cardId, userId });
      setText('');
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <form className="add-time" data-testid="add-time" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      {people.length > 1 && (
        <label>User
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {people.map((u) => <option key={u.id} value={u.id}>{u.id === meId ? 'Me' : userName(u)}</option>)}
          </select>
        </label>
      )}
      <div role="group" aria-label="Date" className="add-time-date">
        {(['today', 'yesterday', 'pick'] as const).map((w) => (
          <button key={w} type="button" className={`btn btn-sm${when === w ? ' btn-active' : ''}`} aria-pressed={when === w} onClick={() => setWhen(w)}>
            {w === 'today' ? 'Today' : w === 'yesterday' ? 'Yesterday' : 'Pick'}
          </button>
        ))}
        {when === 'pick' && <input type="date" aria-label="Pick a date" value={picked} max={ymd(new Date())} onChange={(e) => setPicked(e.target.value)} />}
      </div>
      <label>Duration
        <input value={text} placeholder="2h, 1:30, 45m" aria-invalid={text !== '' && !valid} onChange={(e) => setText(e.target.value)} />
      </label>
      <span className="muted" aria-live="polite">{text === '' ? '' : !valid ? 'Not a duration' : future ? 'That would end in the future' : `= ${formatDuration(ms!)} h`}</span>
      <button type="submit" className="btn btn-primary" disabled={!valid || startedAt === null || future || busy}>Add</button>
    </form>
  );
}

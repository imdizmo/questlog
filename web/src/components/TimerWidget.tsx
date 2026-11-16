import { useEffect, useState } from 'react';
import { titleOf } from '../../../shared/cards';
import { myCardTotal, myRunning, useCardTime, setTicking, startTimer, stopTimer, trackingOn, formatClock, useTickNow } from '../timeTracking';
import { useStore } from '../store';
import { Icon } from '../components/icons';

/** Floating bottom-left timer: total of my time on the last-tracked card. Close hides it until the next start. */
export function TimerWidget() {
  const s = useStore((x) => x);
  const on = trackingOn(s);
  const running = myRunning(s);
  const runId = running?.id;
  const runCard = running?.cardId;
  const [last, setLast] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => { setTicking(on && !!runId); return () => setTicking(false); }, [on, runId]);
  useEffect(() => { if (runId && runCard) { setLast(runCard); setClosed(false); } }, [runId, runCard]);
  const now = useTickNow();
  const card = last ? s.cards.get(last) : undefined;
  const shown = on && !closed && !!card && card.visibility !== 'deleted';
  const time = useCardTime(shown ? last : null);
  if (!shown || !card) return null;
  const mine = running?.cardId === card.id ? running : undefined;
  // The server total counts a running timer up to the fetch; the clock adds what has passed since.
  const total = time ? time.totalMs + (mine ? Math.max(0, now - Math.max(time.fetchedAt, mine.startedAt)) : 0) : 0;
  return (
    <div className="timer-widget" data-testid="timer-widget" role="region" aria-label="Timer">
      <span className="timer-text">TOTAL {formatClock(total)} on {titleOf(card.content) || 'Untitled'}</span>
      {mine
        ? <button type="button" className="btn btn-sm btn-active" onClick={() => void stopTimer(mine.id)}><Icon name="stop" size={14} /> Stop</button>
        : <button type="button" className="btn btn-sm" onClick={() => void startTimer(s.me!.id, card.id)}><Icon name="play" size={14} /> Start</button>}
      <button type="button" className="icon-btn" aria-label="Close" onClick={() => setClosed(true)}><Icon name="close" size={14} /></button>
    </div>
  );
}

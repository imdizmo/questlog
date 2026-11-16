import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, dispatch } from './api';
import { settingsOf, useStore, type State } from './store';
import type { TimeSegment } from '../../shared/types';

// One shared 1 s interval: it runs only while one of my timers does and is cleared otherwise.
let nowValue = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** Called by the app shell whenever "do I have a running timer" changes. */
export function setTicking(on: boolean): void {
  if (on && !timer) {
    nowValue = Date.now();
    listeners.forEach((l) => l());
    timer = setInterval(() => { nowValue = Date.now(); listeners.forEach((l) => l()); }, 1000);
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
}
/** Date.now() as of the last tick (fixed while nothing runs). */
export function useTickNow(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => nowValue);
}

export const trackingOn = (s: State): boolean => settingsOf(s).timeTrackingMode !== null;

export function myRunning(s: State): TimeSegment | undefined {
  const me = s.me?.id;
  for (const t of s.timeSegments.values()) if (t.userId === me && t.durationInMs === null) return t;
  return undefined;
}
/** Elapsed ms of a segment, a running one counting up to `now`. */
export const segMs = (t: TimeSegment, now: number): number => t.durationInMs ?? Math.max(0, now - t.startedAt);

export function myCardTotal(s: State, cardId: string, now: number): number {
  let sum = 0;
  for (const t of s.timeSegments.values()) if (t.userId === s.me?.id && t.cardId === cardId) sum += segMs(t, now);
  return sum;
}
/** My tracked time inside the local day of `now` (a segment that crosses midnight counts only its part in that day). */
export function myTodayTotal(s: State, now: number): number {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const end = new Date(start).setDate(new Date(start).getDate() + 1);
  let sum = 0;
  for (const t of s.timeSegments.values()) {
    if (t.userId !== s.me?.id) continue;
    const to = Math.min(t.startedAt + segMs(t, now), end, now);
    sum += Math.max(0, to - Math.max(t.startedAt, start));
  }
  return sum;
}

/** An entry may end at most a minute from now (the server uses the same slack). */
export const FUTURE_SLACK_MS = 60_000;
export const endsInFuture = (startedAt: number, durationMs: number, now = Date.now()): boolean => startedAt + durationMs > now + FUTURE_SLACK_MS;

/** h:mm:ss */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
/** mm:ss, or h:mm:ss past the hour. */
export function formatShort(ms: number): string {
  const t = Math.floor(ms / 1000);
  return t >= 3600 ? formatClock(ms) : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export const startTimer = (userId: string, cardId: string) => dispatch('timeTracking', 'start', { userId, cardId }).catch(() => {});
export const stopTimer = (id: string) => dispatch('timeTracking', 'stop', { id }).catch(() => {});
/** Alt+P: stop my timer on this card, or start one. */
export function toggleTimer(s: State, cardId: string): Promise<unknown> {
  const run = myRunning(s);
  return run && run.cardId === cardId ? stopTimer(run.id) : startTimer(s.me!.id, cardId);
}

export interface CardTime { totalMs: number; segments: TimeSegment[]; fetchedAt: number }

/**
 * All-time total and newest segments of a card from the server (the snapshot only holds 30 days).
 * Fetched when the card is shown and again (debounced) whenever the card's segments change in the store.
 */
export function useCardTime(cardId: string | null, enabled = true): CardTime | null {
  const sig = useStore((s) => {
    if (!cardId) return '';
    let x = '';
    for (const t of s.timeSegments.values()) if (t.cardId === cardId) x += `${t.id}:${t.durationInMs};`;
    return x;
  });
  const [data, setData] = useState<{ id: string; v: CardTime } | null>(null);
  useEffect(() => {
    if (!cardId || !enabled) return;
    let alive = true;
    const h = setTimeout(() => {
      api.cardTime(cardId).then((r) => { if (alive) setData({ id: cardId, v: { ...r, fetchedAt: Date.now() } }); }).catch(() => {});
    }, data?.id === cardId ? 400 : 0);
    return () => { alive = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, enabled, sig]);
  return data && data.id === cardId ? data.v : null;
}

import { useSyncExternalStore } from 'react';
import { useStore } from './store';

/**
 * Pausing the tutorial (the workspace menu's Guides section): while paused, its button leaves the top bar. Per person
 * and per device; progress is kept either way, the server still records each step done.
 */
const keyOf = (userId: string) => `ql.tutorialPaused.${userId}`;
const listeners = new Set<() => void>();
let version = 0;

export function tutorialPaused(userId: string | undefined): boolean {
  if (!userId) return false;
  try { return localStorage.getItem(keyOf(userId)) === '1'; } catch { return false; }
}

export function setTutorialPaused(userId: string, paused: boolean): void {
  try {
    if (paused) localStorage.setItem(keyOf(userId), '1');
    else localStorage.removeItem(keyOf(userId));
  } catch { /* no storage: nothing to keep */ }
  version++;
  for (const fn of [...listeners]) fn();
}

export function useTutorialPaused(): boolean {
  const me = useStore((s) => s.me?.id);
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);
  return tutorialPaused(me);
}

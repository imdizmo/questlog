import { useSyncExternalStore } from 'react';

/** The app's look on this device (the workspace menu's Look section): dark, light, or whatever the computer uses. */
export type Look = 'dark' | 'light' | 'system';
export const LOOKS: readonly Look[] = ['dark', 'light', 'system'];
const KEY = 'ql.look';

const hasWindow = typeof window !== 'undefined';
const listeners = new Set<() => void>();
let current: Look = hasWindow ? read() : 'dark';

function read(): Look {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch { return 'dark'; }
}

const systemLight = () => hasWindow && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

/** What the page shows for a look: `system` follows the computer. */
export const resolveLook = (l: Look, prefersLight: boolean): 'dark' | 'light' => (l === 'system' ? (prefersLight ? 'light' : 'dark') : l);

/** Puts the resolved look on <html data-look>, where theme.css picks it up. */
export function applyLook(): void {
  if (!hasWindow) return;
  document.documentElement.dataset.look = resolveLook(current, systemLight());
}

export function setLook(l: Look): void {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* private window: this page load only */ }
  applyLook();
  for (const fn of [...listeners]) fn();
}

/** Runs once at start: applies the saved look and follows the computer while it is `system`. */
export function startLook(): void {
  applyLook();
  if (hasWindow && typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyLook);
}

export const useLook = (): Look =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => current);

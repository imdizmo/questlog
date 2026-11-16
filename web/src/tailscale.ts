import { useEffect, useState } from 'react';
import { api, type TailscaleInfo as TailscaleState } from './api';

let current: TailscaleState | null = null;
const listeners = new Set<(s: TailscaleState | null) => void>();

/** Reads the state again (after linking or unlinking). A failure keeps the last known state. */
export async function refreshTailscale(): Promise<TailscaleState | null> {
  try {
    current = await api.tailscale();
    listeners.forEach((l) => l(current));
  } catch { /* keep what we had */ }
  return current;
}

/** The Tailscale state, fetched once per mount while nobody has it yet. `null` until it arrives. */
export function useTailscale(): TailscaleState | null {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    if (!current) void refreshTailscale();
    else setS(current);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

/** Forget the state (log out: the next person has their own). */
export function resetTailscale() { current = null; listeners.forEach((l) => l(null)); }

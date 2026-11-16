import { useEffect, useRef, useState } from 'react';

export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Same members, any order (the server may echo a whole array sorted while a draft appends). */
export const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
};

/**
 * With no write in flight, the draft can go once the store holds the same members, or once the store
 * moved on from what it held when the last write finished (someone else wrote, or the write was refused).
 */
export const shouldRelease = (stored: readonly string[], draft: readonly string[], settled: readonly string[] | null) =>
  sameSet(stored, draft) || (settled !== null && !sameSet(stored, settled));

/**
 * A whole-array field (tags) edited faster than the server echoes it back. Changes build on a local
 * draft, not on the store, and are sent one after another, so quick clicks never drop each other.
 * The draft is let go once every write is done and the store has caught up (or moved on): its value
 * has the draft's members (in any order), or differs from what it was when the last write finished. A failed write
 * drops the draft, and the store's value shows again.
 */
export function usePendingList(stored: string[], send: (next: string[]) => Promise<unknown>) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);
  const st = useRef({ inflight: 0, chain: Promise.resolve() as Promise<unknown>, settled: null as string[] | null });
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const sendRef = useRef(send);
  sendRef.current = send;
  // The newest value, updated as soon as a change is made (React may not have re-rendered between two clicks).
  const latest = useRef<string[]>(draft ?? stored);
  latest.current = draft ?? stored;

  useEffect(() => {
    const s = st.current;
    if (draft === null || s.inflight > 0) return;
    if (shouldRelease(stored, draft, s.settled)) setDraft(null);
  }, [stored, draft, tick]);

  /** Takes the new list, or a function of the newest one (use that for toggles). */
  const change = (arg: string[] | ((cur: string[]) => string[])) => {
    const s = st.current;
    const next = typeof arg === 'function' ? arg(latest.current) : arg;
    if (sameList(next, latest.current)) return;
    latest.current = next;
    setDraft(next);
    s.inflight++;
    s.chain = s.chain
      .then(() => sendRef.current(next))
      .then(() => true, () => false)
      .then((ok) => {
        s.inflight--;
        if (s.inflight > 0) return;
        s.settled = [...storedRef.current];
        if (!ok) setDraft(null);
        setTick((t) => t + 1);
      });
  };

  return { value: draft ?? stored, change, pending: draft !== null };
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { Point, Rect } from '../../../shared/board';
import type { User } from '../../../shared/types';
import { useStore } from '../store';

/**
 * Awareness state of one client, as sent: `{cursor:{id:userId, pos}, selection:{id:userId, nodeIds}}`. The server
 * refuses a state whose `id` is not the sender's user, so what arrives here names its real sender.
 */
export const CURSOR_INTERVAL_MS = 50; // 20 updates per second at most
export const MAX_SELECTED = 50;
const MAX_PEERS = 100;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Peer { userId: string; user: User; cursor: Point | null; nodeIds: string[] }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One awareness state from the wire, or null. Everything in it is untrusted. */
export function readPeerState(state: unknown): { userId: string; cursor: Point | null; nodeIds: string[] } | null {
  if (!isObject(state)) return null;
  const { cursor, selection } = state;
  let userId: string | null = null;
  let pos: Point | null = null;
  let nodeIds: string[] = [];
  if (isObject(cursor) && typeof cursor.id === 'string') {
    userId = cursor.id;
    if (isObject(cursor.pos) && finite(cursor.pos.x) && finite(cursor.pos.y)) pos = { x: cursor.pos.x, y: cursor.pos.y };
  }
  if (isObject(selection) && typeof selection.id === 'string') {
    if (userId !== null && userId !== selection.id) return null; // two owners in one state: not ours
    userId = selection.id;
    if (Array.isArray(selection.nodeIds)) {
      nodeIds = [...new Set(selection.nodeIds.filter((n): n is string => typeof n === 'string' && NODE_ID.test(n)))].slice(0, MAX_SELECTED);
    }
  }
  return userId === null ? null : { userId, cursor: pos, nodeIds };
}

/**
 * Everyone else on the board who is a known user (an unknown id is not drawn), one entry per user, not me.
 * Re-renders only the calling component, and only when what is drawn changed: our own awareness updates and
 * repeated identical states are ignored.
 */
export function usePeers(awareness: Awareness | null): Peer[] {
  const users = useStore((s) => s.users);
  const meId = useStore((s) => s.me?.id);
  const [read, setRead] = useState<{ sig: string; states: NonNullable<ReturnType<typeof readPeerState>>[] }>({ sig: '[]', states: [] });
  useEffect(() => {
    if (!awareness) { setRead((r) => (r.sig === '[]' ? r : { sig: '[]', states: [] })); return; }
    const load = () => {
      const states: NonNullable<ReturnType<typeof readPeerState>>[] = [];
      let seen = 0;
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID || seen++ >= MAX_PEERS) return;
        const p = readPeerState(st);
        if (p) states.push(p);
      });
      const sig = JSON.stringify(states);
      setRead((r) => (r.sig === sig ? r : { sig, states }));
    };
    const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      if ([...added, ...updated, ...removed].some((id) => id !== awareness.clientID)) load();
    };
    load();
    awareness.on('change', onChange);
    return () => { awareness.off('change', onChange); };
  }, [awareness]);
  return useMemo(() => {
    const byUser = new Map<string, Peer>();
    for (const st of read.states) {
      const user = users.get(st.userId);
      if (!user || st.userId === meId) continue; // another tab of mine is not "someone else"
      const prev = byUser.get(st.userId);
      if (prev && (prev.cursor || !st.cursor)) continue; // two tabs: prefer the one with a cursor
      byUser.set(st.userId, { userId: st.userId, user, cursor: st.cursor, nodeIds: st.nodeIds });
    }
    return [...byUser.values()];
  }, [read, users, meId]);
}

/** Local presence: announces who we are, throttles the pointer, follows the selection, retracts on unmount. */
export function useLocalPresence(awareness: Awareness | null, meId: string | undefined, selectedIds: string[]) {
  const pending = useRef<Point | null | undefined>(undefined);
  const lastSent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = selectedIds.join(',');

  const flush = useCallback(() => {
    timer.current = null;
    const p = pending.current;
    if (p === undefined || !awareness || !meId) return;
    pending.current = undefined;
    lastSent.current = Date.now();
    awareness.setLocalStateField('cursor', p === null ? null : { id: meId, pos: { x: Math.round(p.x), y: Math.round(p.y) } });
  }, [awareness, meId]);

  /** Board coordinates, or null when the pointer left. At most CURSOR_INTERVAL_MS between sends; the last position always lands. */
  const setCursor = useCallback((p: Point | null) => {
    pending.current = p;
    if (timer.current !== null) return;
    const wait = lastSent.current + CURSOR_INTERVAL_MS - Date.now();
    if (wait <= 0 || p === null) flush();
    else timer.current = setTimeout(flush, wait);
  }, [flush]);

  useEffect(() => {
    if (!awareness || !meId) return;
    awareness.setLocalStateField('selection', { id: meId, nodeIds: key ? key.split(',').slice(0, MAX_SELECTED) : [] });
  }, [awareness, meId, key]);

  // The awareness machinery re-announces the state about every 15 s on its own; this only retracts it on leave.
  useEffect(() => {
    if (!awareness || !meId) return;
    return () => {
      if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
      pending.current = undefined;
      awareness.setLocalStateField('cursor', null);
      awareness.setLocalStateField('selection', null);
    };
  }, [awareness, meId]);

  return { setCursor };
}

/** Same user, same colour, on every client. */
export function colorOf(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 75% 62%)`;
}

const initial = (u: User) => (u.name.trim().slice(0, 1) || '?').toUpperCase();

/** Cursors and selection outlines of the other people, in board units: it goes inside the board layer. */
export const PresenceLayer = memo(function PresenceLayer({ awareness, rects, scale }: { awareness: Awareness | null; rects: Map<string, Rect>; scale: number }) {
  const peers = usePeers(awareness);
  return (
    <div className="bpresence" aria-hidden>
      {peers.flatMap((p) => {
        const color = colorOf(p.userId);
        return p.nodeIds.flatMap((id) => {
          const r = rects.get(id);
          return r ? [<div key={`${p.userId}:${id}`} className="bpeer-outline" data-peer-outline={id} data-peer={p.userId}
            style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, height: r.h, outlineColor: color, outlineWidth: 2 / scale }} />] : [];
        });
      })}
      {peers.map((p) => p.cursor && (
        <div key={p.userId} className="bpeer-cursor" data-peer-cursor={p.userId}
          style={{ transform: `translate(${p.cursor.x}px, ${p.cursor.y}px) scale(${1 / scale})`, ['--peer' as string]: colorOf(p.userId) }}>
          <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1 L1 15 L5 11.5 L8 17 L10.5 16 L7.5 10.5 L13 10 Z" fill="currentColor" /></svg>
          <span className="bpeer-name"><b>{initial(p.user)}</b>{p.user.name}</span>
        </div>
      ))}
    </div>
  );
});

/** Header: the people on the board, you first. */
export const PresenceStack = memo(function PresenceStack({ awareness }: { awareness: Awareness | null }) {
  const peers = usePeers(awareness);
  const me = useStore((s) => s.me);
  const all = [...(me ? [{ userId: me.id, name: `${me.name} (you)`, initial: initial(me) }] : []),
    ...peers.map((p) => ({ userId: p.userId, name: p.user.name, initial: initial(p.user) }))];
  return (
    <ul className="presence-stack" aria-label="On this board">
      {all.map((u) => (
        <li key={u.userId}>
          <span className="avatar sm" role="img" aria-label={u.name} title={u.name} style={{ borderColor: colorOf(u.userId) }}>{u.initial}</span>
        </li>
      ))}
    </ul>
  );
});

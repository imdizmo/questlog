import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export type BoardStatus = 'connecting' | 'online' | 'offline';

export interface BoardConnection {
  doc: Y.Doc;
  awareness: Awareness;
  status: () => BoardStatus;
  /** Why the connection ended for good (4401/4403/4404/4409), or null. */
  reason: () => string | null;
  /** Calls `fn` on every status or reason change; returns the unsubscribe function. */
  subscribe: (fn: () => void) => () => void;
  /** Closes the socket and destroys the doc. */
  destroy: () => void;
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
export const BACKOFF_FIRST = 1000;
export const BACKOFF_MAX = 30_000;
/** The backoff starts over only after a connection has stayed open this long. */
export const HEALTHY_MS = 10_000;

/** Close codes after which retrying cannot help; the text is shown to the person. */
export const FINAL_CLOSE: Record<number, string> = {
  4401: 'Your session ended. Log in again.',
  4403: "You don't have access to this map.",
  4404: 'This map no longer exists.',
  4410: "This map's task was deleted. Restore the task to open the map again.",
  4409: 'Boards are switched off in the workspace settings.',
  // Resending the same local state would be rejected again, so only a fresh connection (new doc) can recover.
  4413: 'Map is too large to save; reload',
  // A frame over the server's message limit: resending the same unsent changes would be cut again.
  1009: 'Too many unsaved changes to send at once; reload',
};

/** The delay before reconnect attempt number `attempt` (0-based): 1 s, doubling, capped at 30 s. */
export const backoff = (attempt: number): number => Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** attempt);

const REMOTE = Symbol('remote');

/**
 * Yjs client for one board room: y-protocols sync and awareness over a binary websocket, reconnecting with
 * backoff. The server decides who may write; our updates are simply dropped there when we may not.
 */
export function connectBoard(boardId: string): BoardConnection {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // A fresh awareness starts at clock 0, which y-protocols peers ignore; the second set makes it 1.
  awareness.setLocalState({});
  const listeners = new Set<() => void>();
  let status: BoardStatus = 'connecting';
  let reason: string | null = null;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let healthy: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const set = (s: BoardStatus, r: string | null = reason) => {
    if (s === status && r === reason) return;
    status = s;
    reason = r;
    for (const fn of [...listeners]) fn();
  };
  const send = (data: Uint8Array) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data as Uint8Array<ArrayBuffer>); };
  const frame = (type: number, write: (e: encoding.Encoder) => void) => {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, type);
    write(e);
    return encoding.toUint8Array(e);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) send(frame(MSG_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
  };
  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === REMOTE) return;
    const ids = [...added, ...updated, ...removed];
    send(frame(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, ids))));
  };
  doc.on('update', onDocUpdate);
  awareness.on('update', onAwareness);

  const open = () => {
    timer = null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/api/rooms/vision-board/${encodeURIComponent(boardId)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      send(frame(MSG_SYNC, (e) => syncProtocol.writeSyncStep1(e, doc)));
      if (awareness.getLocalState() !== null) {
        // The server retracted our state when the last socket closed, so re-announce with a newer clock.
        awareness.setLocalState(awareness.getLocalState()); // its update event sends it
      }
    };
    sock.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      // The server only talks to rooms it accepted us into, so the first frame means we are in.
      if (status !== 'online') {
        set('online', null);
        // A server that accepts and then rejects must keep growing the delay, so only a lasting connection resets it.
        healthy = setTimeout(() => { healthy = null; attempt = 0; }, HEALTHY_MS);
      }
      try {
        const d = decoding.createDecoder(new Uint8Array(ev.data));
        const type = decoding.readVarUint(d);
        if (type === MSG_SYNC) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MSG_SYNC);
          // The server's answer to our step 1 carries the whole board: from here `doc.whenSynced` holds.
          if (syncProtocol.readSyncMessage(d, reply, doc, REMOTE) === syncProtocol.messageYjsSyncStep2 && !doc.isSynced) doc.emit('sync', [true, doc]);
          if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply));
        } else if (type === MSG_AWARENESS) {
          applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), REMOTE);
        }
      } catch (e) {
        console.error('[jt] vision board message', e);
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (healthy !== null) { clearTimeout(healthy); healthy = null; }
      // Everyone else's cursors went with the socket; ours is re-announced on reconnect.
      const others = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID);
      if (others.length) removeAwarenessStates(awareness, others, REMOTE);
      if (destroyed) return;
      const final = FINAL_CLOSE[ev.code];
      if (final) return set('offline', final);
      set('offline', null);
      timer = setTimeout(() => { set('connecting'); open(); }, backoff(attempt++));
    };
  };
  open();

  return {
    doc,
    awareness,
    status: () => status,
    reason: () => reason,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      if (healthy !== null) clearTimeout(healthy);
      listeners.clear();
      const sock = ws;
      ws = null;
      if (sock) { sock.onclose = null; sock.onmessage = null; sock.close(); }
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwareness);
      awareness.destroy();
      doc.destroy();
    },
  };
}

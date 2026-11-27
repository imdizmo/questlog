import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Db } from './db';
import type { ChangeEvent } from './dispatch';
import { anyBoardRow, boardAccess } from './boards';
import { accountRow } from './commands/rows';
import { now } from './auth';
import { AppError } from './errors';

/** Memory bounds of the realtime vision-board rooms. */
export const ROOM_LIMITS = {
  /** 20, not 50: a full 5 MB doc takes ~32 MB of heap, so the worst case stays near 650 MB on a shared desktop. */
  maxRooms: 20,
  maxSocketsPerRoom: 20,
  /**
   * The Home board is one room for the whole workspace, one socket per open Home tab. A socket costs its awareness
   * (at most maxAwarenessClients x maxAwarenessStateBytes) plus what is queued for it, cut at maxBufferedBytes only
   * for a stalled reader; 200 idle sockets are a few MB. The Home room is also always let in past maxRooms (one more).
   */
  maxSocketsPerHomeRoom: 200,
  maxDocBytes: 5 * 1024 * 1024,
  /**
   * How much the encoded doc may grow per update byte before the exact size is measured. Scattered single-character
   * deletes split items and grow the encoding by up to ~8x the update size (measured with yjs 13.6.27); 16 leaves a
   * margin. This only decides when to measure: save() is the hard guarantee that no doc over the cap is persisted.
   */
  updateGrowthFactor: 16,
  maxMessageBytes: 1024 * 1024,
  unloadMs: 30_000,
  saveDebounceMs: 2_000,
  /** Awareness client ids one socket may own, and the UTF-8 size of one awareness state (JSON). */
  maxAwarenessClients: 4,
  maxAwarenessStateBytes: 16 * 1024,
  /** A socket whose unsent output grows past this is too slow and is closed. */
  maxBufferedBytes: 8 * 1024 * 1024,
};

export const CLOSE = {
  noSession: 4401,
  forbidden: 4403,
  noBoard: 4404,
  /** The host card was deleted (it can be restored, so the board is not gone). */
  cardDeleted: 4410,
  tooLarge: 4413,
  featureOff: 4409,
  busy: 4503,
  messageTooBig: 1009,
  badMessage: 1007,
  slow: 1013,
} as const;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface RoomSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Drop the connection without a close handshake (a superseded socket). */
  terminate?(): void;
  readonly bufferedAmount?: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}
/** Looked up at call time, so tests can fake the global timers. Unref'd: a pending save or unload never keeps the process alive (closeAll saves on shutdown). */
const globalTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
    t?.unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

interface Member {
  userId: string;
  session: string | null;
  canEdit: boolean;
  /** Awareness client ids this socket has announced; removed for everyone when it leaves. */
  clients: Set<number>;
}

export class Room {
  doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly members = new Map<RoomSocket, Member>();
  /** Updates refused because the socket may not edit (kept for tests and diagnostics). */
  droppedUpdates = 0;
  dirty = false;
  /** Encoded size of the stored BLOB (what a reload returns to). */
  savedBytes = 0;
  /** Last exactly measured encoded size. */
  exactBytes = 0;
  /** When to measure next: exactBytes plus updateGrowthFactor x the update bytes applied since (an estimate, not a guarantee). */
  sizeBound = 0;
  saveTimer: unknown = null;
  unloadTimer: unknown = null;

  constructor(readonly boardId: string, readonly cardId: string | null, blob: Uint8Array | null) {
    this.doc = docFrom(blob);
    this.savedBytes = this.exactBytes = this.sizeBound = blob?.byteLength ?? 0;
    // Awareness only borrows a doc for its own clientID; a separate one survives reload().
    this.awareness = new awarenessProtocol.Awareness(new Y.Doc());
    this.awareness.setLocalState(null); // the server has no presence of its own
  }

  /** Replace the doc with the saved one (pending changes are discarded). */
  reload(blob: Uint8Array | null): void {
    this.doc.destroy();
    this.doc = docFrom(blob);
    this.savedBytes = this.exactBytes = this.sizeBound = blob?.byteLength ?? 0;
    this.dirty = false;
  }

  destroy(): void {
    this.awareness.doc.destroy(); // also destroys the awareness (it listens for its doc's destroy)
    this.doc.destroy();
  }
}

function docFrom(blob: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc({ gc: true });
  if (blob && blob.byteLength) Y.applyUpdate(doc, blob);
  return doc;
}

/** An update that carries no structs and no deletions (what a client with nothing new answers to sync step 1). */
const isEmptyUpdate = (u: Uint8Array) => u.byteLength === 2 && u[0] === 0 && u[1] === 0;

function message(type: number, write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

/**
 * The live Yjs rooms of vision boards: one Y.Doc per loaded board, relayed between the board's sockets,
 * saved to vision_boards.doc (debounced, and on unload), with edits gated by boardAccess.
 * Bounded: ROOM_LIMITS (rooms LRU among the empty ones, sockets per room, doc size, message size).
 */
export class RoomHub {
  /** Loaded rooms in least-recently-used order (first = oldest). */
  private rooms = new Map<string, Room>();
  private bySocket = new Map<RoomSocket, Room>();
  private timers: Timers;

  constructor(private db: Db, opts: { timers?: Timers } = {}) {
    this.timers = opts.timers ?? globalTimers;
  }

  private enabled(): boolean {
    return (accountRow(this.db).settings as { visionBoardEnabled?: boolean }).visionBoardEnabled !== false;
  }

  private loadBlob(boardId: string): Uint8Array | null {
    const r = this.db.prepare('SELECT doc FROM vision_boards WHERE id=?').get(boardId) as { doc: Uint8Array | null } | undefined;
    return r?.doc ?? null;
  }

  /**
   * Authenticate and add a socket to a board's room, or close it:
   * 4401 no session, 4409 feature off (not for Home), 4404 no board, 4403 no view access, 4503 room or hub full.
   */
  connect(socket: RoomSocket, user: { id: string } | null, session: string | null, boardId: string): boolean {
    if (!user) return refuse(socket, CLOSE.noSession, 'unauthenticated');
    const board = anyBoardRow(this.db, boardId);
    if (board?.kind !== 'home' && !this.enabled()) return refuse(socket, CLOSE.featureOff, 'feature_disabled');
    if (!board) return refuse(socket, CLOSE.noBoard, 'not_found');
    const level = boardAccess(this.db, user, board);
    if (level === 'none') return refuse(socket, CLOSE.forbidden, 'forbidden');
    const room = this.open(boardId);
    if (!room) return refuse(socket, CLOSE.busy, 'too_many_rooms');
    return this.join(room, socket, { id: user.id }, session, level === 'edit');
  }

  /** The loaded room of a board, loading it (and evicting the least recently used empty room) if needed. Null when all rooms are busy or the board is gone. */
  open(boardId: string): Room | null {
    const loaded = this.rooms.get(boardId);
    if (loaded) {
      this.rooms.delete(boardId);
      this.rooms.set(boardId, loaded);
      return loaded;
    }
    const home = (this.db.prepare('SELECT kind FROM vision_boards WHERE id=?').get(boardId) as { kind: string } | undefined)?.kind === 'home';
    // maxRooms counts the card boards; Home never waits for one of them to go idle.
    if (!home && [...this.rooms.values()].filter((x) => x.cardId !== null).length >= ROOM_LIMITS.maxRooms) {
      const idle = [...this.rooms.values()].find((x) => x.members.size === 0 && x.cardId !== null);
      if (!idle) return null;
      this.unload(idle);
    }
    const r = this.db.prepare('SELECT card_id, doc FROM vision_boards WHERE id=?').get(boardId) as { card_id: string | null; doc: Uint8Array | null } | undefined;
    if (!r) return null;
    const room = new Room(boardId, r.card_id, r.doc);
    this.rooms.set(boardId, room);
    return room;
  }

  join(room: Room, socket: RoomSocket, user: { id: string }, session: string | null, canEdit: boolean): boolean {
    const cap = room.cardId === null ? ROOM_LIMITS.maxSocketsPerHomeRoom : ROOM_LIMITS.maxSocketsPerRoom;
    if (room.members.size >= cap) return refuse(socket, CLOSE.busy, 'room_full');
    if (room.unloadTimer !== null) {
      this.timers.clearTimeout(room.unloadTimer);
      room.unloadTimer = null;
    }
    room.members.set(socket, { userId: user.id, session, canEdit, clients: new Set() });
    this.bySocket.set(socket, room);
    this.send(socket, message(MSG_SYNC, (e) => syncProtocol.writeSyncStep1(e, room.doc)));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) this.send(socket, message(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states))));
    return true;
  }

  /** The socket closed or errored: forget it, retract its awareness, and start the unload countdown if the room is empty. */
  leave(socket: RoomSocket): void {
    const room = this.bySocket.get(socket);
    if (!room) return;
    this.bySocket.delete(socket);
    const m = room.members.get(socket);
    room.members.delete(socket);
    // Only ids the awareness accepted have a clock: an update still at clock 0 (a fresh y-protocols client) is ignored,
    // and encoding a removal for it would throw out of the socket's close handler.
    const ids = m ? [...m.clients].filter((id) => room.awareness.meta.has(id)) : [];
    if (m && ids.length) {
      awarenessProtocol.removeAwarenessStates(room.awareness, ids, null);
      const out = message(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids)));
      for (const s of [...room.members.keys()]) this.send(s, out);
      // y-protocols keeps a clock per client id ever seen; drop it, or a busy room grows one entry per page load.
      for (const id of ids) room.awareness.meta.delete(id);
    }
    if (room.members.size === 0 && this.rooms.get(room.boardId) === room) this.scheduleUnload(room);
  }

  private drop(socket: RoomSocket, code: number, reason: string): void {
    this.leave(socket);
    try { socket.close(code, reason); } catch { /* already closed */ }
  }

  private send(socket: RoomSocket, data: Uint8Array): void {
    if ((socket.bufferedAmount ?? 0) > ROOM_LIMITS.maxBufferedBytes) return this.drop(socket, CLOSE.slow, 'slow_consumer');
    try {
      socket.send(data);
    } catch {
      this.leave(socket);
    }
  }

  private broadcast(room: Room, from: RoomSocket | null, data: Uint8Array): void {
    for (const s of [...room.members.keys()]) if (s !== from) this.send(s, data);
  }

  /** One binary websocket message from a member. */
  message(socket: RoomSocket, data: Uint8Array): void {
    const room = this.bySocket.get(socket);
    const m = room?.members.get(socket);
    if (!room || !m) return;
    if (data.byteLength > ROOM_LIMITS.maxMessageBytes) return this.drop(socket, CLOSE.messageTooBig, 'message_too_big');
    try {
      const d = decoding.createDecoder(data);
      const type = decoding.readVarUint(d);
      if (type === MSG_SYNC) {
        const sub = decoding.readVarUint(d);
        if (sub === syncProtocol.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(d);
          this.send(socket, message(MSG_SYNC, (e) => syncProtocol.writeSyncStep2(e, room.doc, sv)));
        } else if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
          const update = decoding.readVarUint8Array(d);
          if (isEmptyUpdate(update)) return;
          if (!m.canEdit) {
            room.droppedUpdates++;
            return;
          }
          this.applyUpdate(room, socket, update);
        } else {
          this.drop(socket, CLOSE.badMessage, 'bad_message');
        }
      } else if (type === MSG_AWARENESS) {
        this.applyAwareness(room, socket, m, decoding.readVarUint8Array(d));
      } else {
        this.drop(socket, CLOSE.badMessage, 'bad_message');
      }
    } catch {
      this.drop(socket, CLOSE.badMessage, 'bad_message');
    }
  }

  private applyUpdate(room: Room, socket: RoomSocket, update: Uint8Array): void {
    try {
      Y.applyUpdate(room.doc, update, socket);
    } catch {
      return this.reject(room, socket, CLOSE.badMessage, 'bad_update');
    }
    room.sizeBound += update.byteLength * ROOM_LIMITS.updateGrowthFactor;
    if (room.sizeBound > ROOM_LIMITS.maxDocBytes) {
      // Over the cap is allowed only if the doc did not grow (a board stored over the cap can still shrink).
      const exact = Y.encodeStateAsUpdate(room.doc).byteLength;
      if (exact > ROOM_LIMITS.maxDocBytes && exact > room.exactBytes) return this.reject(room, socket, CLOSE.tooLarge, 'doc_too_large');
      room.exactBytes = room.sizeBound = exact;
    }
    room.dirty = true;
    if (room.saveTimer !== null) this.timers.clearTimeout(room.saveTimer);
    room.saveTimer = this.timers.setTimeout(() => {
      room.saveTimer = null;
      try { this.save(room); } catch (e) { console.error('[jt] vision board save failed', e); }
    }, ROOM_LIMITS.saveDebounceMs);
    this.broadcast(room, socket, message(MSG_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
  }

  /**
   * The update was applied but must not stay: close its socket and reload the doc from the last save. The update was
   * never relayed; the other sockets get a fresh sync step 1 so editors send back what the reload lost.
   */
  private reject(room: Room, socket: RoomSocket, code: number, reason: string): void {
    this.drop(socket, code, reason);
    this.rollback(room);
  }

  /** Back to the stored BLOB; remaining sockets get a fresh sync step 1. */
  private rollback(room: Room): void {
    if (room.saveTimer !== null) {
      this.timers.clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    room.reload(this.loadBlob(room.boardId));
    this.broadcast(room, null, message(MSG_SYNC, (e) => syncProtocol.writeSyncStep1(e, room.doc)));
  }

  private applyAwareness(room: Room, socket: RoomSocket, m: Member, update: Uint8Array): void {
    // Validate before applying: bounded state size, a bounded number of client ids per socket, user ids in the state
    // are the socket's own, and a client id held by another socket is taken over only from the same user (a reconnect).
    const d = decoding.createDecoder(update);
    const n = decoding.readVarUint(d);
    const ids: number[] = [];
    const superseded = new Set<RoomSocket>();
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarUint(d);
      decoding.readVarUint(d); // clock
      const state = decoding.readVarString(d);
      if (Buffer.byteLength(state) > ROOM_LIMITS.maxAwarenessStateBytes) return this.drop(socket, CLOSE.tooLarge, 'awareness_too_large');
      if (!ownState(JSON.parse(state), m.userId)) return this.drop(socket, CLOSE.badMessage, 'awareness_user');
      for (const [s, other] of room.members) {
        if (s === socket || !other.clients.has(id)) continue;
        if (other.userId !== m.userId) return this.drop(socket, CLOSE.badMessage, 'awareness_spoof');
        superseded.add(s);
      }
      ids.push(id);
    }
    if (new Set([...m.clients, ...ids]).size > ROOM_LIMITS.maxAwarenessClients) return this.drop(socket, CLOSE.badMessage, 'awareness_clients');
    for (const s of superseded) {
      // The same user reconnected while the old socket still looked alive: the ids move to the new socket (so leave()
      // does not retract them), the old socket is cut.
      const old = room.members.get(s)!;
      for (const id of ids) old.clients.delete(id);
      this.leave(s);
      try { if (s.terminate) s.terminate(); else s.close(CLOSE.badMessage, 'superseded'); } catch { /* already gone */ }
    }
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);
    for (const id of ids) m.clients.add(id);
    this.broadcast(room, socket, message(MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, update)));
  }

  private save(room: Room): void {
    if (room.saveTimer !== null) {
      this.timers.clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    if (!room.dirty) return;
    const u = Y.encodeStateAsUpdate(room.doc);
    // Hard cap: never persist a doc over the cap unless it is no bigger than the stored one (a board stored over the cap shrinking).
    if (u.byteLength > ROOM_LIMITS.maxDocBytes && u.byteLength > room.savedBytes) {
      console.warn(`[jt] vision board ${room.boardId}: ${u.byteLength} bytes is over the cap, rolled back to the last save`);
      return this.rollback(room);
    }
    this.db.prepare('UPDATE vision_boards SET doc=?, doc_bytes=?, updated_at=? WHERE id=?').run(u, u.byteLength, now(), room.boardId);
    room.dirty = false;
    room.savedBytes = room.exactBytes = room.sizeBound = u.byteLength;
  }

  private scheduleUnload(room: Room): void {
    if (room.unloadTimer !== null) this.timers.clearTimeout(room.unloadTimer);
    room.unloadTimer = this.timers.setTimeout(() => {
      room.unloadTimer = null;
      try {
        if (room.members.size === 0) this.unload(room);
      } catch (e) {
        console.error('[jt] vision board unload failed', e);
      }
    }, ROOM_LIMITS.unloadMs);
  }

  /** Save, close remaining sockets, free the doc and awareness, forget the room. */
  private unload(room: Room, code: number = CLOSE.busy, reason = 'unloaded'): void {
    if (this.rooms.get(room.boardId) !== room) return;
    for (const s of [...room.members.keys()]) this.drop(s, code, reason);
    if (room.unloadTimer !== null) this.timers.clearTimeout(room.unloadTimer);
    room.unloadTimer = null;
    try {
      this.save(room);
    } finally {
      this.rooms.delete(room.boardId);
      room.destroy();
    }
  }

  /**
   * A server-side edit (boardHooks.edit): applied to the board's room (loaded if need be), relayed to its sockets and
   * saved at once. `write` must not throw half-way (validate first); if it does, the room goes back to its last save.
   * 503 busy when every room is in use, 413 too_large past the doc cap.
   */
  edit(boardId: string, write: (doc: Y.Doc) => void): void {
    const room = this.open(boardId);
    if (!room) throw new AppError(503, 'busy');
    try {
      const before = Y.encodeStateVector(room.doc);
      try {
        room.doc.transact(() => write(room.doc), 'server');
      } catch (e) {
        this.rollback(room);
        throw e;
      }
      // The same rule as save(), so what is reported as done is also what gets saved.
      const exact = Y.encodeStateAsUpdate(room.doc).byteLength;
      if (exact > ROOM_LIMITS.maxDocBytes && exact > room.savedBytes) {
        this.rollback(room);
        throw new AppError(413, 'too_large', { maxBytes: ROOM_LIMITS.maxDocBytes });
      }
      room.exactBytes = room.sizeBound = exact;
      room.dirty = true;
      const update = Y.encodeStateAsUpdate(room.doc, before);
      this.broadcast(room, null, message(MSG_SYNC, (e) => syncProtocol.writeUpdate(e, update)));
      this.save(room);
    } finally {
      // A room this edit loaded (nobody has it open) is let go again, also when the edit failed.
      if (room.members.size === 0 && this.rooms.get(boardId) === room) this.scheduleUnload(room);
    }
  }

  /** Close every socket of a board with `code` and unload its room (saved if the row still exists). */
  closeBoard(boardId: string, code: number): void {
    const room = this.rooms.get(boardId);
    if (room) this.unload(room, code, 'closed');
  }

  /**
   * Re-check a loaded board after a state, card, project or membership change: the room closes when the board is
   * gone (4404) or the feature is off (4409, never for Home); sockets whose session ended (4401) or whose access became
   * none (4403, or 4410 when the host card was deleted) close; the rest get their canEdit updated.
   */
  refreshAccess(boardId: string): void {
    const room = this.rooms.get(boardId);
    if (!room) return;
    const board = anyBoardRow(this.db, boardId);
    if (board?.kind !== 'home' && !this.enabled()) return this.closeBoard(boardId, CLOSE.featureOff);
    if (!board) return this.closeBoard(boardId, CLOSE.noBoard);
    for (const [s, m] of [...room.members]) {
      if (!this.alive(m)) {
        this.drop(s, CLOSE.noSession, 'session_ended');
        continue;
      }
      const level = boardAccess(this.db, { id: m.userId }, board);
      // A member had access until now, so telling them the card was deleted reveals nothing new.
      if (level === 'none') {
        if (this.hostDeleted(room.cardId)) this.drop(s, CLOSE.cardDeleted, 'card_deleted');
        else this.drop(s, CLOSE.forbidden, 'forbidden');
      } else m.canEdit = level === 'edit';
    }
  }

  private hostDeleted(cardId: string | null): boolean {
    return !!cardId && (this.db.prepare('SELECT visibility v FROM cards WHERE id=?').get(cardId) as { v: string } | undefined)?.v === 'deleted';
  }

  refreshAll(): void {
    for (const id of [...this.rooms.keys()]) this.refreshAccess(id);
  }

  private alive(m: Member): boolean {
    const u = this.db.prepare('SELECT disabled d FROM users WHERE id=?').get(m.userId) as { d: number } | undefined;
    if (!u || u.d) return false;
    if (m.session === null) return true;
    const s = this.db.prepare('SELECT expires_at e FROM sessions WHERE token_hash=?').get(m.session) as { e: number } | undefined;
    return !!s && s.e > now();
  }

  /** Logout: close this session's sockets. */
  closeSession(sessionHash: string): void {
    for (const [s, room] of [...this.bySocket]) {
      if (room.members.get(s)?.session === sessionHash) this.drop(s, CLOSE.noSession, 'logged_out');
    }
  }

  /**
   * Committed change events (every LiveHub.publish): access-relevant models re-check every loaded room; a card event
   * re-checks the rooms of that card. Board state changes and deletes arrive through boardHooks instead.
   */
  onEvents(events: ChangeEvent[]): void {
    if (this.rooms.size === 0) return;
    const cards = new Set<string>();
    for (const ev of events) {
      switch (ev.model) {
        case 'account': case 'user': case 'accountRole': case 'project': case 'projectAccess': case 'deck':
          return this.refreshAll();
        case 'card':
          cards.add((ev.row as { id: string }).id);
      }
    }
    if (cards.size) for (const room of [...this.rooms.values()]) if (room.cardId && cards.has(room.cardId)) this.refreshAccess(room.boardId);
  }

  /** Server shutdown: save and free every room. */
  closeAll(): void {
    for (const room of [...this.rooms.values()]) this.unload(room, 1001, 'server_closing');
  }

  // ---- introspection (tests, diagnostics) ----
  /** The doc of a loaded room (without loading it or touching the LRU order). */
  liveDoc(boardId: string): Y.Doc | undefined {
    return this.rooms.get(boardId)?.doc;
  }

  loadedIds(): string[] {
    return [...this.rooms.keys()];
  }

  inspect(boardId: string): { sockets: number; droppedUpdates: number; doc: Y.Doc; awarenessClients: number } | undefined {
    const r = this.rooms.get(boardId);
    return r && { sockets: r.members.size, droppedUpdates: r.droppedUpdates, doc: r.doc, awarenessClients: r.awareness.meta.size };
  }
}

/** An awareness state may only name its own user as cursor/selection owner (`{cursor:{id}}`, `{selection:{id}}`). */
function ownState(state: unknown, userId: string): boolean {
  if (state === null || typeof state !== 'object') return true;
  const s = state as { cursor?: { id?: unknown } | null; selection?: { id?: unknown } | null };
  for (const k of [s.cursor, s.selection]) if (k && typeof k === 'object' && 'id' in k && k.id !== userId) return false;
  return true;
}

function refuse(socket: RoomSocket, code: number, reason: string): false {
  try { socket.close(code, reason); } catch { /* already closed */ }
  return false;
}

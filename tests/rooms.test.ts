import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { openDb, newId, type Db } from '../server/db';
import { buildApp, HEARTBEAT_MS } from '../server/app';
import { ROOM_LIMITS } from '../server/rooms';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 60_000 });

const HOST = 'localhost:8780';
const ORIGIN = `http://${HOST}`;
let db: Db;
let app: FastifyInstance;
let port: number;
let owner: string;
let projectId: string;
let deckId: string;
const clients: RoomClient[] = [];

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { host: HOST, cookie, 'content-type': 'application/json' } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const mkUser = async (name: string, role: string, access: string[] = []) => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?, ?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
};
const mkBoard = async () => {
  const cardId = (await ok('cards/create', { content: 'C', deckId })).id as string;
  return (await ok('visionBoard/createBoard', { cardId })).id as string;
};
const boardRow = (id: string) => db.prepare('SELECT doc, doc_bytes, updated_at FROM vision_boards WHERE id=?').get(id) as { doc: Uint8Array | null; doc_bytes: number; updated_at: number };
const rooms = () => (app as any).rooms as { inspect(id: string): { sockets: number; droppedUpdates: number; doc: Y.Doc; awarenessClients: number } | undefined; loadedIds(): string[] };

/** Polls without timers (setTimeout may be faked), on the real clock. */
const until = async (fn: () => boolean, ms = 3000) => {
  const end = performance.now() + ms;
  while (performance.now() < end && !fn()) await new Promise((r) => setImmediate(r));
  return fn();
};
const nodesOf = (d: Y.Doc) => d.getMap<any>('nodes');

/** A minimal y-protocols client: answers sync, sends its own updates, keeps awareness. */
class RoomClient {
  doc = new Y.Doc();
  awareness: awarenessProtocol.Awareness;
  ws: WebSocket;
  synced = false;
  closeCode: number | null = null;
  opened: Promise<void>;
  closed: Promise<number>;
  constructor(boardId: string, cookie: string, o: { clientID?: number; autoPong?: boolean } = {}) {
    if (o.clientID !== undefined) this.doc.clientID = o.clientID;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/vision-board/${boardId}`, { headers: { Host: HOST, Cookie: cookie, Origin: ORIGIN }, autoPong: o.autoPong ?? true });
    this.ws.binaryType = 'nodebuffer';
    clients.push(this);
    this.closed = new Promise((res) => this.ws.on('close', (code) => { this.closeCode = code; res(code); }));
    this.opened = new Promise((res) => { this.ws.on('open', () => res()); this.ws.on('close', () => res()); this.ws.on('error', () => res()); });
    this.ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.ws.on('message', (data: Buffer) => {
      const d = decoding.createDecoder(new Uint8Array(data));
      const e = encoding.createEncoder();
      const t = decoding.readVarUint(d);
      if (t === 0) {
        encoding.writeVarUint(e, 0);
        const st = syncProtocol.readSyncMessage(d, e, this.doc, 'remote');
        if (st === syncProtocol.messageYjsSyncStep2) this.synced = true;
        if (encoding.length(e) > 1) this.ws.send(encoding.toUint8Array(e));
      } else if (t === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), 'remote');
      }
    });
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || this.ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
      if (origin === 'remote' || this.ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.ws.send(encoding.toUint8Array(e));
    });
  }
  async ready() {
    await this.opened;
    expect(await until(() => this.synced || this.closeCode !== null)).toBe(true);
    expect(this.closeCode).toBe(null);
    return this;
  }
  setText(id: string, value: string) {
    nodesOf(this.doc).set(id, { type: 'text', value, pos: { x: 0, y: 0, w: 100, h: 40, parent: null } });
  }
  dispose() {
    this.awareness.destroy();
    this.doc.destroy();
    this.ws.terminate();
  }
}
const open = (boardId: string, cookie = owner, o: { clientID?: number; autoPong?: boolean } = {}) => new RoomClient(boardId, cookie, o).ready();
const sleepReal = (ms: number) => until(() => false, ms);
/** A text node whose value is 4.5 MB of 900 kB map entries plus a 100 k-char Y.Text, sent message by message. */
async function nearCap(a: RoomClient, b: string) {
  for (let i = 0; i < 5; i++) {
    a.setText(`big${i}`, 'x'.repeat(900_000));
    expect(await until(() => nodesOf(rooms().inspect(b)!.doc).has(`big${i}`), 10_000)).toBe(true);
  }
  a.doc.getText('t').insert(0, 'x'.repeat(100_000));
  expect(await until(() => rooms().inspect(b)!.doc.getText('t').length === 100_000, 10_000)).toBe(true);
}
/** Every other character of the Y.Text deleted in one update (~150 kB): splits items, grows the encoding ~6x the update. */
const scatteredDeletes = (a: RoomClient) => {
  const t = a.doc.getText('t');
  a.doc.transact(() => { for (let i = 39_999; i >= 0; i--) t.delete(i * 2, 1); });
};
const closeCodeOf = async (boardId: string, cookie: string) => {
  const c = new RoomClient(boardId, cookie);
  return c.closed;
};

async function start(existing?: Db) {
  _resetLimiter();
  db = existing ?? openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await start();
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.dispose();
  await app.close();
});

describe('vision board rooms', () => {
  it('two editors converge on a text node', async () => {
    const b = await mkBoard();
    const member = await mkUser('mem', 'member', [projectId]);
    const a = await open(b);
    const m = await open(b, member);
    a.setText('n1', 'hello');
    expect(await until(() => nodesOf(m.doc).get('n1')?.value === 'hello')).toBe(true);
    m.setText('n2', 'world');
    expect(await until(() => nodesOf(a.doc).get('n2')?.value === 'world')).toBe(true);
    // a late joiner gets everything through sync
    const late = await open(b, member);
    expect(await until(() => nodesOf(late.doc).size === 2)).toBe(true);
    expect(nodesOf(rooms().inspect(b)!.doc).toJSON()).toEqual(nodesOf(a.doc).toJSON());
  });

  it("a read-only viewer's update is dropped and not relayed", async () => {
    const b = await mkBoard();
    const obs = await mkUser('obs', 'observer', [projectId]);
    const a = await open(b);
    const v = await open(b, obs);
    v.setText('bad', 'nope');
    expect(await until(() => rooms().inspect(b)!.droppedUpdates === 1)).toBe(true);
    a.setText('good', 'yes');
    expect(await until(() => nodesOf(v.doc).get('good')?.value === 'yes')).toBe(true);
    expect(nodesOf(a.doc).has('bad')).toBe(false);
    expect(nodesOf(rooms().inspect(b)!.doc).has('bad')).toBe(false);
    // awareness from a viewer is still relayed
    v.awareness.setLocalStateField('cursor', { x: 5, y: 6 });
    expect(await until(() => a.awareness.getStates().get(v.doc.clientID)?.cursor?.x === 5)).toBe(true);
  });

  it('locking the board while connected stops further writes', async () => {
    const b = await mkBoard();
    const a = await open(b);
    a.setText('n1', 'before');
    expect(await until(() => nodesOf(rooms().inspect(b)!.doc).has('n1'))).toBe(true);
    await ok('visionBoard/updateBoard', { id: b, state: 'locked' });
    a.setText('n2', 'after');
    expect(await until(() => rooms().inspect(b)!.droppedUpdates === 1)).toBe(true);
    expect(nodesOf(rooms().inspect(b)!.doc).has('n2')).toBe(false);
    expect(a.closeCode).toBe(null); // still a viewer
    await ok('visionBoard/deleteBoard', { id: b });
    expect(await a.closed).toBe(4404);
    expect(rooms().inspect(b)).toBeUndefined();
  });

  it('losing project access closes with 4403; removing the project closes the room with 4404', async () => {
    const b = await mkBoard();
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const member = await mkUser('mem', 'member', [projectId]);
    const memberId = (db.prepare("SELECT id FROM users WHERE email='mem@x.io'").get() as { id: string }).id;
    const a = await open(b);
    const m = await open(b, member);
    await ok('projects/setAccess', { projectId, userId: memberId, access: null });
    expect(await m.closed).toBe(4403);
    expect(a.closeCode).toBe(null);
    await ok('projects/delete', { id: projectId });
    expect(await a.closed).toBe(4404);
    expect(rooms().loadedIds()).toEqual([]);
  });

  it('deleting the host task closes members with 4410 (not the generic 4403)', async () => {
    const b = await mkBoard();
    const a = await open(b);
    const cardId = (db.prepare('SELECT card_id FROM vision_boards WHERE id=?').get(b) as { card_id: string }).card_id;
    await ok('cards/update', { id: cardId, visibility: 'deleted' });
    expect(await a.closed).toBe(4410);
  });

  it('the doc survives a server restart (BLOB)', async () => {
    const b = await mkBoard();
    const a = await open(b);
    a.setText('n1', 'persisted');
    expect(await until(() => nodesOf(rooms().inspect(b)!.doc).has('n1'))).toBe(true);
    for (const c of clients.splice(0)) c.dispose();
    await app.close();
    expect(boardRow(b).doc_bytes).toBeGreaterThan(0);
    await start(db);
    const again = await open(b);
    expect(await until(() => nodesOf(again.doc).get('n1')?.value === 'persisted')).toBe(true);
  });

  it('a user without project access gets 4403', async () => {
    const b = await mkBoard();
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const stranger = await mkUser('str', 'member');
    expect(await closeCodeOf(b, stranger)).toBe(4403);
    expect(await closeCodeOf(b, '')).toBe(4401);
    expect(await closeCodeOf('nope', owner)).toBe(4404);
    // foreign Origin, missing Origin, and a percent-encoded path that still routes to the room: all refused at upgrade
    for (const [path, origin] of [[`/api/rooms/vision-board/${b}`, 'http://evil.example'], [`/api/rooms/vision-board/${b}`, null], [`/api/%72ooms/vision-board/${b}`, 'http://evil.example'], ['/api/pu%73h', 'http://evil.example']] as const) {
      const xo = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Host: HOST, Cookie: owner, ...(origin ? { Origin: origin } : {}) } });
      expect(await new Promise((res) => { xo.on('unexpected-response', (_q, r) => res(r.statusCode)); xo.on('error', () => {}); }), `${path} ${origin}`).toBe(403);
      xo.terminate();
    }
    db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.visionBoardEnabled', json('false'))").run();
    expect(await closeCodeOf(b, owner)).toBe(4409);
    expect(rooms().loadedIds()).toEqual([]);
    // the encoded path does reach the room route (so the Origin check is what refused it above): here it gets the room's own 4409
    const ok2 = new WebSocket(`ws://127.0.0.1:${port}/api/%72ooms/vision-board/${b}`, { headers: { Host: HOST, Cookie: owner, Origin: ORIGIN } });
    expect(await new Promise((res) => { ok2.on('close', (code) => res(code)); ok2.on('unexpected-response', (_q, r) => res(r.statusCode)); })).toBe(4409);
    ok2.terminate();
  });

  it('an empty room unloads after 30 s (fake timers) and the doc is saved', async () => {
    const b = await mkBoard();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = await open(b);
    a.setText('n1', 'one');
    expect(await until(() => nodesOf(rooms().inspect(b)!.doc).has('n1'))).toBe(true);
    expect(boardRow(b).doc).toBe(null);
    vi.advanceTimersByTime(2000); // debounced save
    expect(boardRow(b).doc_bytes).toBeGreaterThan(0);
    a.setText('n2', 'two');
    expect(await until(() => nodesOf(rooms().inspect(b)!.doc).has('n2'))).toBe(true);
    a.dispose();
    expect(await until(() => rooms().inspect(b)!.sockets === 0)).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(rooms().loadedIds()).toEqual([b]);
    vi.advanceTimersByTime(1_000);
    expect(rooms().loadedIds()).toEqual([]);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, boardRow(b).doc!);
    expect(Object.keys(nodesOf(saved).toJSON()).sort()).toEqual(['n1', 'n2']);
    expect(boardRow(b).doc_bytes).toBe(boardRow(b).doc!.byteLength);
  });

  it('opening 21 rooms with one idle evicts the idle one (max 20 loaded)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(await mkBoard());
    const idle = await open(ids[0]);
    idle.setText('n1', 'idle');
    expect(await until(() => nodesOf(rooms().inspect(ids[0])!.doc).has('n1'))).toBe(true);
    idle.dispose();
    expect(await until(() => rooms().inspect(ids[0])!.sockets === 0)).toBe(true);
    for (let i = 1; i < 20; i++) await open(ids[i]);
    expect(rooms().loadedIds()).toHaveLength(20);
    await open(ids[20]);
    expect(rooms().loadedIds()).toHaveLength(20);
    expect(rooms().inspect(ids[0])).toBeUndefined();
    expect(boardRow(ids[0]).doc_bytes).toBeGreaterThan(0); // saved on eviction
    // all 20 busy: the next room is refused
    expect(ROOM_LIMITS.maxRooms).toBe(20);
    expect(await closeCodeOf(ids[21], owner)).toBe(4503);
  });

  it('a 6 MB update closes with 4413 and nothing is saved', async () => {
    const b = await mkBoard();
    const a = await open(b);
    const chunk = 'x'.repeat(900_000); // each message stays under the 1 MiB frame cap
    for (let i = 0; i < 7 && a.closeCode === null; i++) {
      a.setText(`big${i}`, chunk);
      await until(() => a.closeCode !== null || nodesOf(rooms().inspect(b)!.doc).has(`big${i}`), 5000);
    }
    expect(await a.closed).toBe(4413);
    expect(boardRow(b).doc).toBe(null);
    expect(boardRow(b).doc_bytes).toBe(0);
    expect(nodesOf(rooms().inspect(b)!.doc).size).toBe(0); // reloaded from the last save (empty)
    // a single message over 1 MiB is refused by the socket itself
    const c = await open(b);
    c.setText('huge', 'y'.repeat(1_100_000));
    expect(await c.closed).toBe(1009);
  });

  it('/api/push closes on a 2 KiB message', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/push`, { headers: { Host: HOST, Cookie: owner, Origin: ORIGIN } });
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    await new Promise<void>((res) => ws.on('open', () => res()));
    ws.send('x'.repeat(512)); // small messages are fine
    ws.send('x'.repeat(2048));
    expect(await closed).toBe(1009);
  });
  it('heartbeat: a socket that stops answering pings is cut (rooms and push), live ones stay', async () => {
    const b = await mkBoard();
    for (const c of clients.splice(0)) c.dispose();
    await app.close();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await start(db);
    const live = await open(b);
    const dead = await open(b, owner, { autoPong: false });
    const push = new WebSocket(`ws://127.0.0.1:${port}/api/push`, { headers: { Host: HOST, Cookie: owner, Origin: ORIGIN }, autoPong: false });
    const pushClosed = new Promise<number>((res) => push.on('close', (code) => res(code)));
    await new Promise<void>((res) => push.on('open', () => res()));
    vi.advanceTimersByTime(HEARTBEAT_MS); // ping
    await sleepReal(200); // pongs travel
    vi.advanceTimersByTime(HEARTBEAT_MS); // no pong since the last ping: terminated
    expect(await dead.closed).toBe(1006);
    expect(await pushClosed).toBe(1006);
    expect(await until(() => rooms().inspect(b)!.sockets === 1)).toBe(true);
    expect(live.closeCode).toBe(null);
  });

  it('a reconnect of the same user takes over its awareness client id; another user cannot', async () => {
    const b = await mkBoard();
    const member = await mkUser('mem', 'member', [projectId]);
    const watcher = await open(b, member);
    const old = await open(b, owner, { clientID: 4242 });
    old.awareness.setLocalStateField('name', 'old');
    expect(await until(() => watcher.awareness.getStates().get(4242)?.name === 'old')).toBe(true);
    // the old connection is still a member on the server (no close seen yet) when the client reconnects
    const fresh = await open(b, owner, { clientID: 4242 });
    fresh.awareness.setLocalStateField('name', 'fresh0'); // a real provider keeps its awareness clock across reconnects
    fresh.awareness.setLocalStateField('name', 'fresh');
    expect(await old.closed).toBe(1006); // superseded: terminated
    expect(fresh.closeCode).toBe(null);
    expect(await until(() => rooms().inspect(b)!.sockets === 2)).toBe(true);
    expect(await until(() => watcher.awareness.getStates().get(4242)?.name === 'fresh')).toBe(true);
    // a different user announcing the same id is refused
    const thief = await open(b, member, { clientID: 4242 });
    thief.awareness.setLocalStateField('name', 'thief');
    expect(await thief.closed).toBe(1007);
    expect(fresh.closeCode).toBe(null);
    // naming another user as cursor owner is refused too
    const liar = await open(b, member, { clientID: 77 });
    liar.awareness.setLocalStateField('cursor', { id: 'someone-else', x: 1, y: 1 });
    expect(await liar.closed).toBe(1007);
  });

  it('awareness bookkeeping of a client that left is dropped (a busy room does not grow per page load)', async () => {
    const b = await mkBoard();
    const watcher = await open(b);
    for (let i = 0; i < 5; i++) {
      const c = await open(b, owner, { clientID: 9000 + i });
      c.awareness.setLocalStateField('name', `c${i}`);
      expect(await until(() => watcher.awareness.getStates().get(9000 + i)?.name === `c${i}`)).toBe(true);
      c.ws.terminate();
      expect(await until(() => rooms().inspect(b)!.sockets === 1)).toBe(true);
      expect(await until(() => !watcher.awareness.getStates().has(9000 + i))).toBe(true);
    }
    watcher.awareness.setLocalStateField('name', 'w');
    expect(await until(() => rooms().inspect(b)!.awarenessClients === 1)).toBe(true);
  });

  it('a client whose first awareness update is at clock 0 can leave without taking the server down', async () => {
    const b = await mkBoard();
    const c = await open(b, owner, { clientID: 31337 });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    const u = encoding.createEncoder();
    encoding.writeVarUint(u, 1); // one client
    encoding.writeVarUint(u, 31337);
    encoding.writeVarUint(u, 0); // clock 0: y-protocols ignores it
    encoding.writeVarString(u, JSON.stringify({ name: 'zero' }));
    encoding.writeVarUint8Array(e, encoding.toUint8Array(u));
    c.ws.send(encoding.toUint8Array(e));
    await sleepReal(100);
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    c.ws.terminate(); // not dispose(): that would retract the awareness first
    expect(await until(() => rooms().inspect(b)!.sockets === 0)).toBe(true);
    await sleepReal(200);
    process.off('uncaughtException', onError);
    expect(errors).toEqual([]); // a throw in the close handler is uncaught
    await open(b); // the room still serves
  });

  it('a viewer whose sync step 2 carries content has it dropped', async () => {
    const b = await mkBoard();
    const obs = await mkUser('obs', 'observer', [projectId]);
    const v = new RoomClient(b, obs);
    v.setText('offline', 'edit'); // local state before connecting: sent in reply to the server's sync step 1
    await v.ready();
    expect(await until(() => rooms().inspect(b)!.droppedUpdates >= 1)).toBe(true);
    expect(nodesOf(rooms().inspect(b)!.doc).has('offline')).toBe(false);
  });

  it('scattered deletes cannot push the doc over 5 MB (4413), and nothing over the cap is saved', async () => {
    const b = await mkBoard();
    const a = await open(b);
    await nearCap(a, b);
    scatteredDeletes(a);
    expect(await a.closed).toBe(4413);
    for (const c of clients.splice(0)) c.dispose();
    await app.close(); // saves whatever the room holds
    expect(boardRow(b).doc_bytes).toBeLessThanOrEqual(ROOM_LIMITS.maxDocBytes);
    await start(db);
  });

  it('save() refuses a doc over the cap even when the estimate missed it', async () => {
    const b = await mkBoard();
    const factor = ROOM_LIMITS.updateGrowthFactor;
    ROOM_LIMITS.updateGrowthFactor = 0; // the estimate never triggers a measurement
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a = await open(b);
      await nearCap(a, b);
      scatteredDeletes(a);
      expect(await until(() => rooms().inspect(b)!.doc.getText('t').length === 60_000, 10_000)).toBe(true);
      a.dispose();
      expect(await until(() => rooms().inspect(b)!.sockets === 0)).toBe(true);
      vi.advanceTimersByTime(ROOM_LIMITS.saveDebounceMs);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
      expect(boardRow(b).doc).toBe(null); // never persisted over the cap
      expect(nodesOf(rooms().inspect(b)!.doc).size).toBe(0); // rolled back to the last save
    } finally {
      ROOM_LIMITS.updateGrowthFactor = factor;
    }
  });

  it('a board stored over the cap rejects growth but accepts a shrinking delete', async () => {
    const b = await mkBoard();
    const big = new Y.Doc();
    for (let i = 0; i < 6; i++) nodesOf(big).set(`big${i}`, { type: 'text', value: 'x'.repeat(950_000) });
    const blob = Y.encodeStateAsUpdate(big);
    big.destroy();
    expect(blob.byteLength).toBeGreaterThan(ROOM_LIMITS.maxDocBytes);
    db.prepare('UPDATE vision_boards SET doc=?, doc_bytes=? WHERE id=?').run(blob, blob.byteLength, b);
    const grow = await open(b);
    expect(await until(() => nodesOf(grow.doc).size === 6, 10_000)).toBe(true);
    grow.setText('more', 'x');
    expect(await grow.closed).toBe(4413);
    const shrink = await open(b);
    expect(await until(() => nodesOf(shrink.doc).size === 6, 10_000)).toBe(true);
    nodesOf(shrink.doc).delete('big0');
    expect(await until(() => !nodesOf(rooms().inspect(b)!.doc).has('big0'))).toBe(true);
    expect(shrink.closeCode).toBe(null);
    for (const c of clients.splice(0)) c.dispose();
    await app.close();
    expect(boardRow(b).doc_bytes).toBeLessThan(ROOM_LIMITS.maxDocBytes);
    await start(db);
  });
});

describe('the Home board room', () => {
  const home = async (cookie = owner) => (await ok('visionBoard/openHome', {}, cookie)).id as string;
  const hub = () => (app as any).rooms as { refreshAll(): void };

  it('members edit, observers only see, guests never get in; the vision-board setting does not switch it off', async () => {
    const h = await home();
    const member = await mkUser('mem', 'member');
    const observer = await mkUser('obs', 'observer');
    const guest = await mkUser('gst', 'guest');
    const a = await open(h);
    const m = await open(h, member);
    m.setText('n1', 'hello');
    expect(await until(() => nodesOf(a.doc).get('n1')?.value === 'hello')).toBe(true);
    const o = await open(h, observer);
    expect(await until(() => nodesOf(o.doc).get('n1')?.value === 'hello')).toBe(true);
    o.setText('n2', 'nope');
    expect(await until(() => rooms().inspect(h)!.droppedUpdates === 1)).toBe(true);
    expect(nodesOf(a.doc).has('n2')).toBe(false);
    expect(await closeCodeOf(h, guest)).toBe(4403);
    db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.visionBoardEnabled', json('false'))").run();
    hub().refreshAll();
    const late = await open(h, member);
    expect(nodesOf(late.doc).get('n1')?.value).toBe('hello');
    expect(a.closeCode).toBe(null);
  });

  it('takes more than 20 tabs, and opens while 20 card boards are busy', async () => {
    const h = await home();
    // 25 sockets on Home: past a card board's 20
    for (let i = 0; i < 25; i++) await open(h);
    expect(rooms().inspect(h)!.sockets).toBe(25);
    expect(ROOM_LIMITS.maxSocketsPerHomeRoom).toBeGreaterThan(ROOM_LIMITS.maxSocketsPerRoom);
    for (const c of clients.splice(0)) c.dispose();
    expect(await until(() => rooms().inspect(h)?.sockets === 0)).toBe(true);
    (app as any).rooms.closeBoard(h, 4503);
    // 20 busy card boards: Home still opens; a 21st card board is still refused
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push(await mkBoard());
    for (let i = 0; i < 20; i++) await open(ids[i]);
    await open(h);
    expect(rooms().loadedIds()).toHaveLength(21);
    expect(await closeCodeOf(ids[20], owner)).toBe(4503);
  });

  it('a member made observer stops editing at once', async () => {
    const h = await home();
    const member = await mkUser('mem', 'member');
    const m = await open(h, member);
    db.prepare("UPDATE account_roles SET role='observer' WHERE role='member'").run();
    hub().refreshAll();
    m.setText('x', 'late');
    expect(await until(() => rooms().inspect(h)!.droppedUpdates === 1)).toBe(true);
    expect(m.closeCode).toBe(null);
  });
});

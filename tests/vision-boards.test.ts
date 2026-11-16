import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { dispatch as run } from '../server/dispatch';
import { boardAccess, boardHooks } from '../server/boards';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;
let projectId: string;
let deckId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const hdr = (cookie: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie, ...extra });
const dispatch = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie, { 'content-type': 'application/json' }) });
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await dispatch(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const fail = async (name: string, payload: unknown, status: number, code?: string, cookie = owner) => {
  const r = await dispatch(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(status);
  if (code) expect(r.json().error).toBe(code);
};
const mkUser = async (name: string, access: string[] = []) => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
  return { id, cookie };
};
const snap = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/snapshot', headers: hdr(cookie) })).json();
const mkCard = async (d = deckId, extra: object = {}) => (await ok('cards/create', { content: 'C', deckId: d, ...extra })).id as string;
const card = (id: string) => db.prepare('SELECT * FROM cards WHERE id=?').get(id) as any;
const limitProject = (id: string) => db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(id);

const user = (id: string) => ({ id });
const mkBoard = async (c?: string, cookie = owner) => {
  const cardId = c ?? await mkCard();
  return { cardId, ...(await ok('visionBoard/createBoard', { cardId }, cookie)) as { id: string; accountSeq: number } };
};
const board = (id: string) => db.prepare('SELECT * FROM vision_boards WHERE id=?').get(id) as any;
const bdef = (id: string) => ({ id, cardId: board(id).card_id, creatorId: board(id).creator_id, state: board(id).state });

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('vision boards', () => {
  it('createBoard returns accountSeq 1 then 2', async () => {
    expect((await mkBoard()).accountSeq).toBe(1);
    expect((await mkBoard()).accountSeq).toBe(2);
    const s = await snap(owner);
    expect(s.visionBoards).toHaveLength(2);
    expect(s.visionBoards[0]).toMatchObject({ accountSeq: 1, state: 'default' });
    expect(s.visionBoards[0].doc).toBeUndefined();
  });

  it('second board on the same task -> 409 already_exists with the id', async () => {
    const b = await mkBoard();
    const r = await dispatch('visionBoard/createBoard', { cardId: b.cardId });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'already_exists', data: { id: b.id } });
  });

  it('observer cannot create (403)', async () => {
    const c = await mkCard();
    const obs = await mkUser('obs', [projectId]);
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(obs.id);
    await fail('visionBoard/createBoard', { cardId: c }, 403, 'forbidden', obs.cookie);
    expect(db.prepare('SELECT COUNT(*) n FROM vision_boards').get()).toMatchObject({ n: 0 });
  });

  it('visionBoardEnabled false -> 409 feature_disabled on every command', async () => {
    const b = await mkBoard();
    await ok('accounts/update', { settings: { visionBoardEnabled: false } });
    await fail('visionBoard/createBoard', { cardId: await mkCard() }, 409, 'feature_disabled');
    await fail('visionBoard/updateBoard', { id: b.id, state: 'locked' }, 409, 'feature_disabled');
    await fail('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [], forceOr: false } }, 409, 'feature_disabled');
    await fail('visionBoard/deleteBoard', { id: b.id }, 409, 'feature_disabled');
  });

  it('boardAccess: default -> editors edit; read_only -> only creator edits; locked -> nobody edits; deleted host task -> none', async () => {
    const mem = await mkUser('mem', [projectId]);
    const obs = await mkUser('obs', [projectId]);
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(obs.id);
    const out = await mkUser('out');
    limitProject(projectId);
    const b = await mkBoard();
    const me = (await snap(owner)).me.id as string;
    const acc = (u: string) => boardAccess(db, user(u), bdef(b.id));
    expect([acc(mem.id), acc(obs.id), acc(me), acc(out.id)]).toEqual(['edit', 'view', 'edit', 'none']);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'read_only' });
    expect([acc(mem.id), acc(obs.id), acc(me)]).toEqual(['view', 'view', 'edit']);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'locked' });
    expect([acc(mem.id), acc(me)]).toEqual(['view', 'view']);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'default' });
    await ok('cards/update', { id: b.cardId, visibility: 'archived' });
    expect(acc(mem.id)).toBe('edit');
    await ok('cards/update', { id: b.cardId, visibility: 'deleted' });
    expect([acc(mem.id), acc(me)]).toEqual(['none', 'none']);
    await ok('cards/update', { id: b.cardId, visibility: 'default' });
    expect(acc(mem.id)).toBe('edit');
  });

  it('read_only board: other members cannot add queries, creator can', async () => {
    const mem = await mkUser('mem', [projectId]);
    const b = await mkBoard();
    const q = { type: 'filter', tokens: [], forceOr: false };
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: q }, mem.cookie);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'read_only' });
    await fail('visionBoard/createQuery', { cardId: b.cardId, query: q }, 403, 'forbidden', mem.cookie);
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: q });
  });

  it('updateBoard / deleteBoard by a non-creator member -> 403; creator and project manager succeed', async () => {
    const mem = await mkUser('mem', [projectId]);
    const prod = await mkUser('prod', [projectId]);
    db.prepare("UPDATE project_access SET project_role='producer' WHERE user_id=?").run(prod.id);
    const b = await mkBoard(undefined, mem.cookie);
    const other = await mkUser('other', [projectId]);
    await fail('visionBoard/updateBoard', { id: b.id, state: 'locked' }, 403, 'forbidden', other.cookie);
    await fail('visionBoard/deleteBoard', { id: b.id }, 403, 'forbidden', other.cookie);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'read_only' }, mem.cookie);
    await ok('visionBoard/updateBoard', { id: b.id, state: 'locked' }, prod.cookie);
    expect(board(b.id).state).toBe('locked');
    await ok('visionBoard/deleteBoard', { id: b.id }, prod.cookie);
    expect(board(b.id)).toBeUndefined();
    await fail('visionBoard/deleteBoard', { id: b.id }, 404, 'not_found');
  });

  it('a creator who lost edit access to the host task can no longer update or delete the board', async () => {
    const mem = await mkUser('mem', [projectId]);
    const b = await mkBoard(undefined, mem.cookie);
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(mem.id);
    await fail('visionBoard/updateBoard', { id: b.id, state: 'locked' }, 403, 'forbidden', mem.cookie);
    await fail('visionBoard/deleteBoard', { id: b.id }, 403, 'forbidden', mem.cookie);
    expect(board(b.id).state).toBe('default');
    // the project manager path is unchanged
    await ok('visionBoard/updateBoard', { id: b.id, state: 'locked' });
  });

  it('updateBoard and deleteBoard call the room hooks after commit', async () => {
    const changed = vi.fn(); const deleted = vi.fn();
    boardHooks.onChange = changed; boardHooks.onDelete = deleted;
    try {
      const b = await mkBoard();
      await ok('visionBoard/updateBoard', { id: b.id, state: 'locked' });
      expect(changed).toHaveBeenCalledWith(b.id);
      await ok('visionBoard/deleteBoard', { id: b.id });
      expect(deleted).toHaveBeenCalledWith(b.id);
    } finally { boardHooks.onChange = () => {}; boardHooks.onDelete = () => {}; }
  });

  it('createQuery stores tokens; prevQueryId is ignored', async () => {
    const b = await mkBoard();
    const tokens = [{ category: 'status', value: 'done', isNegated: false }];
    const a = await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens, forceOr: true } });
    // prevQueryId was dropped: any editor could delete a query another node still uses
    const c = await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [], forceOr: false }, prevQueryId: a.id });
    const rows = (await snap(owner)).visionQueries;
    expect(rows.map((x: any) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect(rows.find((x: any) => x.id === a.id)).toMatchObject({ cardId: b.cardId, query: { type: 'filter', tokens, forceOr: true } });
    // limits and unknown boards
    const many = Array.from({ length: 21 }, () => ({ category: 'content', value: 'x', isNegated: false }));
    await fail('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: many, forceOr: false } }, 400, 'invalid_payload');
    await fail('visionBoard/createQuery', { cardId: await mkCard(), query: { type: 'filter', tokens: [], forceOr: false } }, 404, 'not_found');
  });

  it('createQuery rejects tokens the client cannot match (unknown category, bad value, op where none applies)', async () => {
    const b = await mkBoard();
    const bad = [
      { category: 'x', value: null, isNegated: false },
      { category: 'status', value: 'nope', isNegated: false },
      { category: 'card', value: null, isNegated: true },
      { category: 'sprintConfig', value: 'cfg', isNegated: false },
      { category: 'deck', value: 'a b', isNegated: false },
      { category: 'status', value: 'done', isNegated: false, op: 'gte' },
    ];
    for (const t of bad) {
      await fail('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [t], forceOr: false } }, 400, 'invalid_payload');
    }
    expect(db.prepare('SELECT COUNT(*) n FROM vision_queries').get()).toEqual({ n: 0 });
    const good = [
      { category: 'effort', value: '3', isNegated: false, op: 'gte' },
      { category: 'priority', value: null, isNegated: true, op: 'eq' },
      { category: 'owner', value: null, isNegated: false },
      { category: 'sprintConfig', value: `${newId()}:current`, isNegated: false },
      { category: 'content', value: 'hello world', isNegated: false },
    ];
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: good, forceOr: false } });
  });

  it('createQuery stops at 500 recent queries per host task', async () => {
    const b = await mkBoard();
    const b2 = await mkBoard();
    const ins = db.prepare('INSERT INTO vision_queries (id, card_id, creator_id, query, created_at) VALUES (?,?,?,?,?)');
    const q = JSON.stringify({ type: 'filter', tokens: [], forceOr: false });
    for (let i = 0; i < 499; i++) ins.run(newId(), b.cardId, 'u', q, Date.now());
    const query = { type: 'filter', tokens: [], forceOr: false };
    await ok('visionBoard/createQuery', { cardId: b.cardId, query });
    await fail('visionBoard/createQuery', { cardId: b.cardId, query }, 409, 'limit_reached');
    await ok('visionBoard/createQuery', { cardId: b2.cardId, query }); // another card has its own budget
  });

  describe('createQuery collects unused queries', () => {
    const query = { type: 'filter', tokens: [], forceOr: false };
    const qjson = JSON.stringify(query);
    const HOUR = 60 * 60 * 1000;
    const insert = (cardId: string, createdAt: number) => {
      const id = newId();
      db.prepare('INSERT INTO vision_queries (id, card_id, creator_id, query, created_at) VALUES (?,?,?,?,?)').run(id, cardId, 'u', qjson, createdAt);
      return id;
    };
    const ids = (cardId: string) => new Set((db.prepare('SELECT id FROM vision_queries WHERE card_id=?').all(cardId) as { id: string }[]).map((r) => r.id));
    const addFilter = (doc: Y.Doc, nodeId: string, queryId: string | null, type = 'filter') => {
      const y = new Y.Map<unknown>();
      y.set('type', type);
      y.set('value', { queryId, mode: 'horBar' });
      y.set('pos', { x: 0, y: 0, w: 200, h: 100, parent: null });
      doc.getMap('nodes').set(nodeId, y);
    };
    const storeDoc = (boardId: string, fill: (d: Y.Doc) => void) => {
      const d = new Y.Doc();
      fill(d);
      const u = Y.encodeStateAsUpdate(d);
      d.destroy();
      db.prepare('UPDATE vision_boards SET doc=?, doc_bytes=? WHERE id=?').run(u, u.byteLength, boardId);
    };

    it('keeps referenced (stored doc) and recent ones, removes the rest with a live event; normal use never hits the cap', async () => {
      const b = await mkBoard();
      const old = Date.now() - 2 * HOUR;
      const used = insert(b.cardId, old);
      const recent = insert(b.cardId, Date.now() - HOUR / 2);
      // a text node carrying a queryId does not count, only filter nodes do
      const notFilter = insert(b.cardId, old);
      const stale = Array.from({ length: 498 }, () => insert(b.cardId, old));
      storeDoc(b.id, (d) => { addFilter(d, 'n1', used); addFilter(d, 'n2', notFilter, 'text'); addFilter(d, 'n3', null); });
      const actor = db.prepare('SELECT id, email, name FROM users LIMIT 1').get() as any;
      const r = run(db, actor, 'visionBoard/createQuery', { cardId: b.cardId, query });
      expect(ids(b.cardId)).toEqual(new Set([used, recent, (r.payload as { id: string }).id]));
      const removed = r.events.filter((e: any) => e.model === 'visionQuery' && e.op === 'remove').map((e: any) => e.row.id);
      expect(new Set(removed)).toEqual(new Set([notFilter, ...stale]));
    });

    it('reads the live room doc when the board is loaded (unsaved edits count)', async () => {
      const b = await mkBoard();
      const old = Date.now() - 2 * HOUR;
      const inStored = insert(b.cardId, old);
      const inLive = insert(b.cardId, old);
      storeDoc(b.id, (d) => addFilter(d, 'n1', inStored));
      const room = app.rooms.open(b.id)!;
      // the live doc moved on: n1 now points at another query, not yet saved
      room.doc.transact(() => addFilter(room.doc, 'n1', inLive));
      await ok('visionBoard/createQuery', { cardId: b.cardId, query });
      const left = ids(b.cardId);
      expect(left.has(inLive)).toBe(true);
      expect(left.has(inStored)).toBe(false);
    });

    it('deleteBoard removes its queries, so a new board on the task starts empty', async () => {
      const b = await mkBoard();
      const other = await mkBoard();
      await ok('visionBoard/createQuery', { cardId: b.cardId, query });
      const keep = (await ok('visionBoard/createQuery', { cardId: other.cardId, query })).id;
      await ok('visionBoard/deleteBoard', { id: b.id });
      expect(ids(b.cardId).size).toBe(0);
      expect(ids(other.cardId)).toEqual(new Set([keep]));
    });
  });

  it('boards of a hidden project are not in the snapshot nor routed', async () => {
    const b = await mkBoard();
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [], forceOr: false } });
    const mem = await mkUser('mem');
    limitProject(projectId);
    const s = await snap(mem.cookie);
    expect(s.visionBoards).toEqual([]);
    expect(s.visionQueries).toEqual([]);
    // live: a socket of the hidden user gets nothing, a viewer gets the board event
    const { LiveHub } = await import('../server/live');
    const hub = new LiveHub(db);
    const got: Record<string, any[]> = { out: [], viewer: [] };
    const viewer = await mkUser('viewer', [projectId]);
    hub.add({ send: (d) => got.out.push(JSON.parse(d)), close() {} }, { id: mem.id });
    hub.add({ send: (d) => got.viewer.push(JSON.parse(d)), close() {} }, { id: viewer.id });
    const row = { id: b.id, cardId: b.cardId };
    hub.publish('a1', [{ model: 'visionBoard', op: 'upsert', row }, { model: 'visionQuery', op: 'upsert', row: { id: 'q', cardId: b.cardId } }]);
    expect(got.out).toEqual([]);
    expect(got.viewer[0].events.map((e: any) => e.model)).toEqual(['visionBoard', 'visionQuery']);
    // a deleted host card routes nowhere
    await ok('cards/update', { id: b.cardId, visibility: 'deleted' });
    got.viewer.length = 0;
    hub.publish('a2', [{ model: 'visionBoard', op: 'upsert', row }]);
    expect(got.viewer).toEqual([]);
  });

  it('a deleted host task hides its board; restoring brings it back', async () => {
    const b = await mkBoard();
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [], forceOr: false } });
    await ok('cards/update', { id: b.cardId, visibility: 'deleted' });
    expect(board(b.id)).toBeTruthy();
    let s = await snap(owner);
    expect([s.visionBoards, s.visionQueries]).toEqual([[], []]);
    await fail('visionBoard/updateBoard', { id: b.id, state: 'locked' }, 404, 'not_found');
    const actor = db.prepare('SELECT id, email, name FROM users LIMIT 1').get() as any;
    const r = run(db, actor, 'cards/update', { id: b.cardId, visibility: 'default' });
    expect(r.events.filter((e: any) => e.model === 'visionBoard' || e.model === 'visionQuery').map((e: any) => e.model).sort()).toEqual(['visionBoard', 'visionQuery']);
    s = await snap(owner);
    expect(s.visionBoards).toHaveLength(1);
    expect(s.visionQueries).toHaveLength(1);
  });

  it('removing a project removes its boards and queries', async () => {
    const b = await mkBoard();
    await ok('visionBoard/createQuery', { cardId: b.cardId, query: { type: 'filter', tokens: [], forceOr: false } });
    await ok('projects/delete', { id: projectId });
    expect(board(b.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM vision_queries').get()).toMatchObject({ n: 0 });
  });
});

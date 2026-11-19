import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { anyBoardRow, boardAccess, homeBoardId } from '../server/boards';
import type { FastifyInstance } from 'fastify';

const MIGRATIONS = join(__dirname, '../server/migrations');
const HOME_MIGRATION = '039_home_board.sql';

/** sha256 of every row of a table (BLOBs as hex), in id order: the same before and after means nothing changed. */
function tableHash(db: DatabaseSync, sql: string): string {
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  const plain = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])));
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}

describe('migration 039 (Home board)', () => {
  it('keeps every card, list and board row and doc byte-identical, and allows one Home board without a host card', () => {
    const dir = join(homedir(), '.cache/gametracker/scratch');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `home-board-${newId()}.db`);
    try {
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d+_.*\.sql$/.test(x) && x < HOME_MIGRATION).sort()) {
        raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
        raw.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, 0)').run(f);
      }
      raw.exec("INSERT INTO projects (id,seq,name,spaces_json,created_at) VALUES ('p',1,'P','[]',0)");
      raw.exec("INSERT INTO decks (id, seq, project_id, space_id, title, deck_type, sort_index, created_at) VALUES ('d',1,'p',1,'D','task',0,0)");
      const doc = new Y.Doc();
      doc.getMap('nodes').set('n', new Y.Map([['type', 'text'], ['value', { content: 'hi' }]]));
      const blob = Y.encodeStateAsUpdate(doc);
      for (const i of [1, 2, 3]) {
        raw.prepare('INSERT INTO cards (id, seq, deck_id, creator_id, content, created_at, last_updated_at) VALUES (?,?,?,?,?,0,0)').run(`c${i}`, i, 'd', 'u', `Card ${i}`);
      }
      raw.prepare("INSERT INTO vision_boards (id, account_seq, card_id, creator_id, state, doc, doc_bytes, created_at, updated_at) VALUES ('b1',1,'c1','u','default',?,?,1,2)").run(blob, blob.byteLength);
      raw.prepare("INSERT INTO vision_boards (id, account_seq, card_id, creator_id, state, doc, doc_bytes, created_at, updated_at) VALUES ('b2',2,'c2','u','locked',NULL,0,3,4)").run();
      const boards = 'SELECT id, account_seq, card_id, creator_id, state, doc, doc_bytes, created_at, updated_at FROM vision_boards ORDER BY id';
      const before = { cards: tableHash(raw, 'SELECT * FROM cards ORDER BY id'), decks: tableHash(raw, 'SELECT * FROM decks ORDER BY id'), boards: tableHash(raw, boards) };
      raw.close();

      const db = openDb(path);
      const after = { cards: tableHash(db, 'SELECT * FROM cards ORDER BY id'), decks: tableHash(db, 'SELECT * FROM decks ORDER BY id'), boards: tableHash(db, boards) };
      expect(after).toEqual(before);
      expect((db.prepare("SELECT doc FROM vision_boards WHERE id='b1'").get() as { doc: Uint8Array }).doc).toEqual(blob);
      expect((db.prepare('SELECT kind FROM vision_boards ORDER BY id').all() as { kind: string }[]).map((r) => r.kind)).toEqual(['card', 'card']);
      // A card board still needs its card, and still goes with it.
      expect(() => db.prepare("INSERT INTO vision_boards (id, kind, account_seq, card_id, creator_id, created_at, updated_at) VALUES ('x','card',9,NULL,'u',0,0)").run()).toThrow(/CHECK/);
      expect(() => db.prepare("INSERT INTO vision_boards (id, kind, account_seq, card_id, creator_id, created_at, updated_at) VALUES ('x','home',9,'c3','u',0,0)").run()).toThrow(/CHECK/);
      db.prepare("DELETE FROM cards WHERE id='c2'").run();
      expect(db.prepare("SELECT 1 FROM vision_boards WHERE id='b2'").get()).toBeUndefined();
      // One Home board, with no host card.
      const h = homeBoardId(db, 'u');
      expect(homeBoardId(db, 'other')).toBe(h);
      expect(anyBoardRow(db, h)).toMatchObject({ kind: 'home', cardId: null, creatorId: 'u' });
      expect(() => db.prepare("INSERT INTO vision_boards (id, kind, account_seq, card_id, creator_id, created_at, updated_at) VALUES ('h2','home',10,NULL,'u',0,0)").run()).toThrow(/UNIQUE/);
      db.close();
    } finally {
      for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
    }
  });
});

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const send = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { host: HOST, cookie, 'content-type': 'application/json' } });
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await send(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const mkUser = async (name: string, role: string) => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?, ?)').run(id, role);
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
  return { id, cookie };
};

describe('the Home board', () => {
  beforeEach(async () => {
    _resetLimiter();
    db = openDb(':memory:');
    app = buildApp({ db, hosts: [HOST] });
    const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
    owner = cookieOf(r);
  });
  afterEach(async () => { await app.close(); });

  it('is made on first open, once, and is the same board for everyone', async () => {
    const mem = await mkUser('mem', 'member');
    const a = await ok('visionBoard/openHome', {});
    const b = await ok('visionBoard/openHome', {}, mem.cookie);
    expect(a.id).toBe(b.id);
    expect((db.prepare("SELECT COUNT(*) n FROM vision_boards WHERE kind='home'").get() as { n: number }).n).toBe(1);
    // The board numbers of card boards are untouched: Home is 0, the first card board is still 1.
    const projectId = (await ok('projects/create', { name: 'P' })).id;
    const deckId = (await ok('decks/create', { title: 'D', projectId })).id;
    const cardId = (await ok('cards/create', { content: 'C', deckId })).id;
    expect((await ok('visionBoard/createBoard', { cardId })).accountSeq).toBe(1);
  });

  it('access per role: owner, admin and member edit; observer sees; guest none', async () => {
    const id = (await ok('visionBoard/openHome', {})).id as string;
    const row = anyBoardRow(db, id)!;
    const ownerId = (db.prepare("SELECT user_id u FROM account_roles WHERE role='owner'").get() as { u: string }).u;
    expect(boardAccess(db, { id: ownerId }, row)).toBe('edit');
    for (const [role, level] of [['admin', 'edit'], ['member', 'edit'], ['observer', 'view'], ['guest', 'none']] as const) {
      const u = await mkUser(role, role);
      expect(boardAccess(db, { id: u.id }, row), role).toBe(level);
      const r = await send('visionBoard/openHome', {}, u.cookie);
      if (level === 'none') expect(r.statusCode).toBeGreaterThanOrEqual(403);
      else expect(r.json().payload).toEqual({ id, canEdit: level === 'edit' });
    }
    // A token confined to projects never reaches Home.
    expect(boardAccess(db, { id: ownerId, via: 'token', scopes: ['read', 'write'], projectIds: ['p'], tokenRole: 'producer' }, row)).toBe('none');
  });

  it('is there with vision boards switched off; it cannot be locked, deleted or given queries', async () => {
    db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.visionBoardEnabled', json('false'))").run();
    const id = (await ok('visionBoard/openHome', {})).id as string;
    db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.visionBoardEnabled', json('true'))").run();
    expect((await send('visionBoard/updateBoard', { id, state: 'locked' })).statusCode).toBe(404);
    expect((await send('visionBoard/deleteBoard', { id })).statusCode).toBe(404);
    expect(anyBoardRow(db, id)?.kind).toBe('home');
  });

  it('is not in the snapshot (the client asks for it)', async () => {
    await ok('visionBoard/openHome', {});
    const snap = (await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie: owner } })).json();
    expect(snap.visionBoards ?? []).toEqual([]);
  });
});

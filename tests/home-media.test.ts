import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, newId, toCamel, type Db } from '../server/db';
import { dispatch } from '../server/dispatch';
import { buildSnapshot } from '../server/snapshot';
import type { User } from '../shared/types';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { MAX_QUERIES_PER_CARD, QUERY_UNDO_WINDOW_MS } from '../server/commands/visionBoards';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const MIGRATIONS = join(__dirname, '../server/migrations');
const MEDIA_MIGRATION = '040_home_media.sql';

/** sha256 of every row a query returns (BLOBs as hex): the same before and after means nothing changed. */
function tableHash(db: DatabaseSync, sql: string): string {
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  const plain = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])));
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}
/** The columns files and vision_queries had before migration 040, rowid included. */
const FILES_ROWS = 'SELECT rowid, id, card_id, uploader_id, name, mime, size, created_at, asset_id FROM files ORDER BY id';
const QUERY_ROWS = 'SELECT rowid, id, card_id, creator_id, query, created_at FROM vision_queries ORDER BY id';

describe('migration 040 (Home pictures and Smart Nodes per project)', () => {
  it('keeps every file and query row byte-identical, and wants exactly one of card and project', () => {
    const dir = join(homedir(), '.cache/gametracker/scratch');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `home-media-${newId()}.db`);
    try {
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d+_.*\.sql$/.test(x) && x < MEDIA_MIGRATION).sort()) {
        raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
        raw.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, 0)').run(f);
      }
      raw.exec("INSERT INTO projects (id,seq,name,spaces_json,created_at) VALUES ('p',1,'P','[]',0)");
      raw.exec("INSERT INTO decks (id, seq, project_id, space_id, title, deck_type, sort_index, created_at) VALUES ('d',1,'p',1,'D','task',0,0)");
      for (const i of [1, 2]) raw.prepare('INSERT INTO cards (id, seq, deck_id, creator_id, content, created_at, last_updated_at) VALUES (?,?,?,?,?,0,0)').run(`c${i}`, i, 'd', 'u', `Card ${i}`);
      // Rowids out of id order (covers order by rowid), a deleted row's gap, an asset copy, odd names.
      raw.exec("INSERT INTO files (rowid,id,card_id,uploader_id,name,mime,size,created_at) VALUES (7,'fa','c1','u','a ü.png','image/png',10,5)");
      raw.exec("INSERT INTO files (rowid,id,card_id,uploader_id,name,mime,size,created_at,asset_id) VALUES (3,'fb','c2','u','b.glb','model/gltf-binary',20,5,'as1')");
      raw.exec("INSERT INTO files (rowid,id,card_id,uploader_id,name,mime,size,created_at) VALUES (9,'fc','c1','u','c','application/octet-stream',1,6)");
      raw.exec(`INSERT INTO vision_queries (id,card_id,creator_id,query,created_at) VALUES ('q1','c1','u','{"type":"filter","tokens":[],"forceOr":false}',1)`);
      raw.exec(`INSERT INTO vision_queries (id,card_id,creator_id,query,created_at) VALUES ('q2','c2','u','{"type":"filter","tokens":[{"category":"content","value":"x","isNegated":true}],"forceOr":true}',2)`);
      const before = { files: tableHash(raw, FILES_ROWS), queries: tableHash(raw, QUERY_ROWS), cards: tableHash(raw, 'SELECT * FROM cards ORDER BY id') };
      raw.close();

      const db = openDb(path);
      const after = { files: tableHash(db, FILES_ROWS), queries: tableHash(db, QUERY_ROWS), cards: tableHash(db, 'SELECT * FROM cards ORDER BY id') };
      expect(after).toEqual(before);
      expect((db.prepare('SELECT COUNT(*) n FROM files WHERE project_id IS NOT NULL').get() as { n: number }).n).toBe(0);
      // Exactly one owner.
      expect(() => db.exec("INSERT INTO files (id,card_id,project_id,uploader_id,name,mime,size,created_at) VALUES ('x',NULL,NULL,'u','n','m',1,0)")).toThrow(/CHECK/);
      expect(() => db.exec("INSERT INTO files (id,card_id,project_id,uploader_id,name,mime,size,created_at) VALUES ('x','c1','p','u','n','m',1,0)")).toThrow(/CHECK/);
      expect(() => db.exec("INSERT INTO vision_queries (id,card_id,project_id,creator_id,query,created_at) VALUES ('x',NULL,NULL,'u','{}',0)")).toThrow(/CHECK/);
      expect(() => db.exec("INSERT INTO vision_queries (id,card_id,project_id,creator_id,query,created_at) VALUES ('x','c1','p','u','{}',0)")).toThrow(/CHECK/);
      expect(() => db.exec("INSERT INTO files (id,project_id,uploader_id,name,mime,size,created_at) VALUES ('x','nope','u','n','m',1,0)")).toThrow(/FOREIGN KEY/);
      db.exec("INSERT INTO files (id,project_id,uploader_id,name,mime,size,created_at) VALUES ('fp','p','u','n','image/png',1,0)");
      db.exec("INSERT INTO vision_queries (id,project_id,creator_id,query,created_at) VALUES ('qp','p','u','{}',0)");
      // Still going with their card; the project's own go with the project.
      db.exec("DELETE FROM cards WHERE id='c2'");
      expect(db.prepare("SELECT id FROM files WHERE id='fb'").get()).toBeUndefined();
      expect(db.prepare("SELECT id FROM vision_queries WHERE id='q2'").get()).toBeUndefined();
      db.exec("DELETE FROM cards; DELETE FROM decks; DELETE FROM projects WHERE id='p'");
      expect(db.prepare('SELECT COUNT(*) n FROM files').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) n FROM vision_queries').get()).toEqual({ n: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.close();
    } finally {
      for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
    }
  });
});

const HOST = 'localhost:8780';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const QUERY = { type: 'filter', tokens: [{ category: 'content', value: 'dragon', isNegated: false }], forceOr: false };
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let projectId: string;

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
const upload = (project: string, cookie = owner, body: Buffer = PNG, type = 'image/png') =>
  app.inject({ method: 'POST', url: `/api/home/files?projectId=${encodeURIComponent(project)}&name=pic.png`, payload: body, headers: { host: HOST, cookie, 'content-type': type } });
const getFile = (id: string, cookie = owner) => app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { host: HOST, cookie } });
const snapshot = async (cookie = owner) => (await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie } })).json();
const me = () => toCamel<User>(db.prepare("SELECT * FROM users WHERE email='o@x.io'").get() as Record<string, unknown>);
const homeQuery = (project: string, cookie = owner) => send('visionBoard/createQuery', { projectId: project, query: QUERY }, cookie);

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `home-media-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 1 });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Home's pictures, kept for a project", () => {
  it('owner and member upload; the observer sees (with no project access) but cannot add; a guest gets nothing', async () => {
    const mem = await mkUser('mem', 'member');
    const obs = await mkUser('obs', 'observer');
    const guest = await mkUser('guest', 'guest');
    const a = await upload(projectId);
    expect(a.statusCode, a.body).toBe(200);
    const b = await upload(projectId, mem.cookie);
    expect(b.statusCode, b.body).toBe(200);
    const row = db.prepare('SELECT card_id, project_id, mime FROM files WHERE id=?').get(a.json().id);
    expect(row).toEqual({ card_id: null, project_id: projectId, mime: 'image/png' });
    expect((await upload(projectId, obs.cookie)).statusCode).toBe(403);
    expect([403, 404]).toContain((await upload(projectId, guest.cookie)).statusCode);
    for (const c of [owner, mem.cookie, obs.cookie]) {
      const dl = await getFile(a.json().id, c);
      expect(dl.statusCode).toBe(200);
      expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
    }
    expect([403, 404]).toContain((await getFile(a.json().id, guest.cookie)).statusCode);
    // Not an attachment of anything: no card history, no file rows in anyone's snapshot.
    expect((await snapshot()).files).toEqual([]);
    expect((await upload(projectId, owner, Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await upload('nope')).statusCode).toBe(404);
  });

  it('refuses a limited or archived project; a picture already on Home stays shown, like the rest of Home', async () => {
    const mem = await mkUser('mem', 'member');
    const id = (await upload(projectId)).json().id as string;
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await upload(projectId)).statusCode).toBe(404);
    expect((await upload(projectId, mem.cookie)).statusCode).toBe(404);
    expect((await getFile(id, mem.cookie)).statusCode).toBe(200);
    db.prepare("UPDATE projects SET visibility='full', is_archived=1 WHERE id=?").run(projectId);
    expect((await upload(projectId)).statusCode).toBe(404);
    expect((await getFile(id, mem.cookie)).statusCode).toBe(200);
  });
});

describe("Home's Smart Node queries, kept for a project", () => {
  it('owner and member create; observer refused; guest and limited/archived projects not found', async () => {
    const mem = await mkUser('mem', 'member');
    const obs = await mkUser('obs', 'observer');
    const guest = await mkUser('guest', 'guest');
    const q = (await homeQuery(projectId)).json().payload.id as string;
    expect((await homeQuery(projectId, mem.cookie)).statusCode).toBe(200);
    expect(db.prepare('SELECT card_id, project_id FROM vision_queries WHERE id=?').get(q)).toEqual({ card_id: null, project_id: projectId });
    expect((await homeQuery(projectId, obs.cookie)).statusCode).toBe(403);
    expect([403, 404]).toContain((await homeQuery(projectId, guest.cookie)).statusCode);
    expect((await homeQuery('nope')).statusCode).toBe(404);
    // Exactly one of cardId and projectId.
    expect((await send('visionBoard/createQuery', { query: QUERY })).statusCode).toBe(400);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await homeQuery(projectId)).statusCode).toBe(404);
    db.prepare("UPDATE projects SET visibility='full', is_archived=1 WHERE id=?").run(projectId);
    expect((await homeQuery(projectId)).statusCode).toBe(404);
  });

  it('works with vision boards switched off (Home is always there)', async () => {
    db.prepare("UPDATE account SET settings_json=json_set(settings_json, '$.visionBoardEnabled', json('false'))").run();
    expect((await homeQuery(projectId)).statusCode).toBe(200);
  });

  it('collects unused old queries per project and caps them per project', async () => {
    const other = (await ok('projects/create', { name: 'Q' })).id as string;
    const old = Date.now() - QUERY_UNDO_WINDOW_MS - 1000;
    const insert = db.prepare('INSERT INTO vision_queries (id, project_id, creator_id, query, created_at) VALUES (?,?,?,?,?)');
    for (let i = 0; i < MAX_QUERIES_PER_CARD; i++) insert.run(`old${i}`, other, 'u', JSON.stringify(QUERY), Date.now());
    expect((await homeQuery(other)).json()).toMatchObject({ error: 'limit_reached' });
    // The cap is per project: another project still has room.
    expect((await homeQuery(projectId)).statusCode).toBe(200);
    db.prepare('UPDATE vision_queries SET created_at=? WHERE project_id=?').run(old, other);
    expect((await homeQuery(other)).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) n FROM vision_queries WHERE project_id=?').get(other) as { n: number }).n).toBe(1);
  });

  it("is in the snapshot of everyone who sees Home (as Home's doc is), not of a guest or a project-confined token", async () => {
    const mem = await mkUser('mem', 'member');
    const obs = await mkUser('obs', 'observer');
    const guest = await mkUser('guest', 'guest');
    const q = (await homeQuery(projectId)).json().payload.id as string;
    for (const c of [owner, mem.cookie, obs.cookie]) {
      expect((await snapshot(c)).visionQueries.map((x: any) => [x.id, x.projectId, x.cardId])).toEqual([[q, projectId, null]]);
    }
    expect((await snapshot(guest.cookie)).visionQueries ?? []).toEqual([]);
    // A card board's queries still follow their host card only.
    const deckId = (await ok('decks/create', { title: 'D', projectId })).id;
    const cardId = (await ok('cards/create', { content: 'C', deckId })).id;
    await ok('visionBoard/createBoard', { cardId });
    const cq = (await ok('visionBoard/createQuery', { cardId, query: QUERY })).id as string;
    expect((await snapshot(obs.cookie)).visionQueries.map((x: any) => x.id)).toEqual([q]);
    expect((await snapshot(mem.cookie)).visionQueries.map((x: any) => x.id)).toEqual([q, cq]);
    expect(buildSnapshot(db, { ...me(), via: 'token', scopes: ['read'], projectIds: [projectId], tokenRole: null, tokenId: 't' } as any).visionQueries.map((x: any) => x.id)).toEqual([cq]);
  });
});

describe('deleting the project', () => {
  it("removes Home's pictures (from disk too) and queries for it, and nothing of another project", async () => {
    const other = (await ok('projects/create', { name: 'Q' })).id as string;
    const pic = (await upload(projectId)).json().id as string;
    const keep = (await upload(other)).json().id as string;
    const deckId = (await ok('decks/create', { title: 'D', projectId })).id;
    const cardId = (await ok('cards/create', { content: 'C', deckId })).id;
    const att = (await app.inject({ method: 'POST', url: `/api/cards/${cardId}/files?name=a.png`, payload: PNG, headers: { host: HOST, cookie: owner, 'content-type': 'image/png' } })).json().id as string;
    const q = (await homeQuery(projectId)).json().payload.id as string;
    const q2 = (await homeQuery(other)).json().payload.id as string;
    for (const id of [pic, keep, att]) expect(existsSync(join(dir, id))).toBe(true);
    const { events } = dispatch(db, me(), 'projects/delete', { id: projectId });
    // Home's viewers drop the query: the remove carries no filter, only what routes it.
    expect(events.filter((e) => e.model === 'visionQuery')).toEqual([{ model: 'visionQuery', op: 'remove', row: { id: q, projectId } }]);
    for (let i = 0; i < 50 && (existsSync(join(dir, pic)) || existsSync(join(dir, att))); i++) await new Promise((res) => setTimeout(res, 10));
    expect(existsSync(join(dir, pic))).toBe(false);
    expect(existsSync(join(dir, att))).toBe(false);
    expect(existsSync(join(dir, keep))).toBe(true);
    expect((db.prepare('SELECT id FROM files').all() as { id: string }[]).map((x) => x.id)).toEqual([keep]);
    expect((db.prepare('SELECT id FROM vision_queries').all() as { id: string }[]).map((x) => x.id)).toEqual([q2]);
    expect((await getFile(pic)).statusCode).toBe(404);
  });
});

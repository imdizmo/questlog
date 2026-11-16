import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { dispatch as run } from '../server/dispatch';
import type { FastifyInstance } from 'fastify';

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
const mkUser = async (role: string, email: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
  return { id, cookie };
};
const mkCard = async (title = 'C', extra: Record<string, unknown> = {}) => (await ok('cards/create', { content: title, deckId, ...extra })).id as string;
const entries = (rid: string) => db.prepare('SELECT * FROM resolvable_entries WHERE resolvable_id=? ORDER BY created_at, rowid').all(rid) as any[];

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('comment thread', () => {
  it('opens on a hero without changing status, replies, closes, and rejects replies after close', async () => {
    const hero = await mkCard('Hero');
    await mkCard('Child', { parentCardId: hero });
    const before = (db.prepare('SELECT status s FROM cards WHERE id=?').get(hero) as any).s;
    const { id: rid } = await ok('resolvables/create', { cardId: hero, context: 'comment', content: 'first' });
    expect((db.prepare('SELECT status s FROM cards WHERE id=?').get(hero) as any).s).toBe(before);
    expect(entries(rid)).toHaveLength(1);
    const t0 = (db.prepare('SELECT latest_entry_at t FROM resolvables WHERE id=?').get(rid) as any).t;
    expect(t0).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 5));
    const { id: eid } = await ok('resolvables/comment', { resolvableId: rid, content: 'second' });
    expect(eid).toBeTruthy();
    expect(entries(rid)).toHaveLength(2);
    expect((db.prepare('SELECT latest_entry_at t FROM resolvables WHERE id=?').get(rid) as any).t).toBeGreaterThan(t0);
    await ok('resolvables/close', { id: rid });
    expect((db.prepare('SELECT status s FROM cards WHERE id=?').get(hero) as any).s).toBe(before);
    const kinds = (db.prepare('SELECT changes_json j FROM card_history WHERE card_id=?').all(hero) as any[]).flatMap((r) => JSON.parse(r.j));
    expect(kinds).toContainEqual({ kind: 'commentOpened', quote: 'first' });
    expect(kinds).toContainEqual({ kind: 'commentClosed', quote: 'first' });
    expect((await dispatch('resolvables/comment', { resolvableId: rid, content: 'late' })).statusCode).toBe(409);
  });
  it('is allowed on done tasks', async () => {
    const c = await mkCard();
    db.prepare("UPDATE cards SET status='done' WHERE id=?").run(c);
    await ok('resolvables/create', { cardId: c, context: 'comment', content: 'hi' });
  });
});

describe('entry rules', () => {
  it('edit is author-only and bumps version; reactions are idempotent and own-only', async () => {
    const c = await mkCard();
    const mate = await mkUser('member', 'm@x.io', [projectId]);
    const { id: rid, entryId } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    const r1 = await dispatch('resolvables/editEntry', { entryId, content: 'nope' }, mate.cookie);
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error ?? r1.json().code).toBe('not_author');
    await ok('resolvables/editEntry', { entryId, content: 'edited' });
    const e = entries(rid)[0];
    expect(e.version).toBe(2);
    expect(e.content).toBe('edited');
    expect(e.last_changed_at).toBeGreaterThan(0);

    const a = await ok('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍' } });
    const b = await ok('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍' } });
    expect(b.id).toBe(a.id);
    expect(db.prepare('SELECT COUNT(*) c FROM resolvable_reactions').get()).toEqual({ c: 1 });
    expect((await dispatch('resolvables/addReaction', { entryId, value: { type: 'emoji', value: 'ok' } })).statusCode).toBe(400);
    expect((await dispatch('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '' } })).statusCode).toBe(400);
    expect((await dispatch('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍 👍' } })).statusCode).toBe(400);
    expect((await dispatch('resolvables/removeReaction', { id: a.id }, mate.cookie)).statusCode).toBe(403);
    await ok('resolvables/removeReaction', { id: a.id });
    expect(db.prepare('SELECT COUNT(*) c FROM resolvable_reactions').get()).toEqual({ c: 0 });
  });
  it('rejects edits and reactions on closed threads', async () => {
    const c = await mkCard();
    const { id: rid, entryId } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    await ok('resolvables/close', { id: rid });
    expect((await dispatch('resolvables/editEntry', { entryId, content: 'y' })).statusCode).toBe(409);
    expect((await dispatch('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍' } })).statusCode).toBe(409);
  });
});

describe('observer', () => {
  it("can't post, edit or react", async () => {
    const c = await mkCard();
    const obs = await mkUser('observer', 'ob@x.io', [projectId]);
    expect((await dispatch('resolvables/create', { cardId: c, context: 'comment', content: 'x' }, obs.cookie)).statusCode).toBe(403);
    const { id: rid, entryId } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    expect((await dispatch('resolvables/comment', { resolvableId: rid, content: 'y' }, obs.cookie)).statusCode).toBe(403);
    expect((await dispatch('resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍' } }, obs.cookie)).statusCode).toBe(403);
  });
});

describe('closed threads read', () => {
  it('returns closed threads with entries and reactions, newest first; 404 without access', async () => {
    const c = await mkCard();
    const out = await mkUser('observer', 'out@x.io');
    const mk = async (t: string) => {
      const r = await ok('resolvables/create', { cardId: c, context: 'comment', content: t });
      await ok('resolvables/addReaction', { entryId: r.entryId, value: { type: 'emoji', value: '🎉' } });
      await ok('resolvables/close', { id: r.id });
      await new Promise((x) => setTimeout(x, 3));
      return r.id as string;
    };
    const a = await mk('one'), b = await mk('two');
    await ok('resolvables/create', { cardId: c, context: 'comment', content: 'open' });
    const res = await app.inject({ method: 'GET', url: `/api/cards/${c}/threads?closed=1`, headers: hdr(owner) });
    expect(res.statusCode).toBe(200);
    const { threads } = res.json();
    expect(threads.map((t: any) => t.resolvable.id)).toEqual([b, a]);
    expect(threads[0].entries).toHaveLength(1);
    expect(threads[0].reactions).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/cards/${c}/threads?closed=1`, headers: hdr(out.cookie) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/cards/nope/threads?closed=1`, headers: hdr(owner) })).statusCode).toBe(404);
  });
  it('snapshot carries reactions for open threads only', async () => {
    const c = await mkCard();
    const o = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'o' });
    await ok('resolvables/addReaction', { entryId: o.entryId, value: { type: 'emoji', value: '🎉' } });
    const k = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'k' });
    await ok('resolvables/addReaction', { entryId: k.entryId, value: { type: 'emoji', value: '🎉' } });
    await ok('resolvables/close', { id: k.id });
    const s = (await app.inject({ method: 'GET', url: '/api/snapshot', headers: hdr(owner) })).json();
    expect(s.reactions.map((r: any) => r.entryId)).toEqual([o.entryId]);
  });
});

describe('reaction live', () => {
  it('reaches viewers of the project only, including removals', async () => {
    const c = await mkCard();
    const viewer = await mkUser('member', 'v@x.io', [projectId]);
    const outsider = await mkUser('observer', 'o2@x.io');
    const { entryId } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    const me = db.prepare('SELECT * FROM users WHERE email=?').get('o@x.io') as any;
    const hub = new LiveHub(db);
    const got: Record<string, any[]> = { viewer: [], outsider: [] };
    hub.add({ send: (s) => got.viewer.push(...JSON.parse(s).events), close() {} }, { id: viewer.id });
    hub.add({ send: (s) => got.outsider.push(...JSON.parse(s).events), close() {} }, { id: outsider.id });
    const actor = { id: me.id } as any;
    const add = run(db, actor, 'resolvables/addReaction', { entryId, value: { type: 'emoji', value: '👍' } });
    hub.publish('1', add.events);
    expect(got.viewer.some((e) => e.model === 'reaction' && e.op === 'upsert')).toBe(true);
    expect(got.outsider).toHaveLength(0);
    const rm = run(db, actor, 'resolvables/removeReaction', { id: (add.payload as any).id });
    hub.publish('2', rm.events);
    const ev = got.viewer.find((e) => e.model === 'reaction' && e.op === 'remove');
    expect(ev.row).toMatchObject({ entryId, cardId: c });
    expect(got.outsider).toHaveLength(0);
  });
});

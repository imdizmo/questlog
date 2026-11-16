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
const mkUser = async (name: string, access: string[] = []) => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
  return { id, cookie };
};
const mkCard = async (title = 'C') => (await ok('cards/create', { content: title, deckId })).id as string;
const note = (userId: string, rid: string) => {
  const r = db.prepare('SELECT * FROM resolvable_notifications WHERE user_id=? AND resolvable_id=?').get(userId, rid) as any;
  return r ? { ...r, authors: JSON.parse(r.unseen_authors_json) } : undefined;
};
const snap = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/snapshot', headers: hdr(cookie) })).json();

let ownerId: string;
beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users WHERE email=?').get('o@x.io') as any).id;
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });


const subs = (s: any) => ({ c: s.cardSubscriptions, d: s.deckSubscriptions, g: s.deckGuardians });
const mkDeck = async (title = 'E') => (await ok('decks/create', { title, projectId })).id as string;

describe('watching a task', () => {
  it('add is idempotent, private to me, and feeds notifications', async () => {
    const m = await mkUser('mia', [projectId]);
    const c = await mkCard();
    const a = await ok('watchings/addCard', { cardId: c }, m.cookie);
    const b = await ok('watchings/addCard', { cardId: c }, m.cookie);
    expect(a.id).toBe(b.id);
    expect((await snap(m.cookie)).cardSubscriptions).toHaveLength(1);
    expect((await snap(owner)).cardSubscriptions).toEqual([]);
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'hi' });
    expect(note(m.id, rid)).toBeTruthy();
    await ok('watchings/removeCard', { cardId: c }, m.cookie);
    expect((await snap(m.cookie)).cardSubscriptions).toEqual([]);
    const { id: rid2 } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'again' });
    expect(note(m.id, rid2)).toBeUndefined();
  });
  it('cannot watch a task you cannot see', async () => {
    const out = await mkUser('zed');
    const c = await mkCard();
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await dispatch('watchings/addCard', { cardId: c }, out.cookie)).statusCode).toBe(404);
  });
  it('subscribeCreator watches on create', async () => {
    const c = (await ok('cards/create', { content: 'W', deckId, subscribeCreator: true })).id;
    expect((await snap(owner)).cardSubscriptions.map((x: any) => x.cardId)).toEqual([c]);
  });
  it('losing project access hides the subscription rows', async () => {
    const m = await mkUser('mia', [projectId]);
    const c = await mkCard();
    await ok('watchings/addCard', { cardId: c }, m.cookie);
    await ok('watchings/addDeck', { deckId, userId: m.id }, m.cookie);
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(m.id);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const s = await snap(m.cookie);
    expect(subs(s)).toEqual({ c: [], d: [], g: [] });
  });
});

describe('list subscriptions', () => {
  it('a member cannot subscribe someone else; an admin can, and it routes to the target only', async () => {
    const m = await mkUser('mia', [projectId]);
    const b = await mkUser('bob', [projectId]);
    expect((await dispatch('watchings/addDeck', { deckId, userId: b.id }, m.cookie)).statusCode).toBe(403);
    const hub = new LiveHub(db);
    const gotB: any[] = [], gotM: any[] = [];
    hub.add({ send: (s) => gotB.push(...JSON.parse(s).events), close() {} }, { id: b.id });
    hub.add({ send: (s) => gotM.push(...JSON.parse(s).events), close() {} }, { id: m.id });
    const r = run(db, { id: ownerId } as any, 'watchings/addDeck', { deckId, userId: b.id });
    hub.publish('1', r.events);
    expect(gotB.filter((e) => e.model === 'deckSubscription')).toHaveLength(1);
    expect(gotM.filter((e) => e.model === 'deckSubscription')).toHaveLength(0);
    const r2 = run(db, { id: ownerId } as any, 'watchings/removeDeck', { deckId, userId: b.id });
    hub.publish('2', r2.events);
    expect(gotB.filter((e) => e.model === 'deckSubscription' && e.op === 'remove')).toHaveLength(1);
    expect(gotM.filter((e) => e.model === 'deckSubscription')).toHaveLength(0);
  });
  it('the target must be able to view the project; a member can subscribe themself', async () => {
    const m = await mkUser('mia', [projectId]);
    const out = await mkUser('zed');
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await dispatch('watchings/addDeck', { deckId, userId: out.id })).statusCode).toBe(400);
    await ok('watchings/addDeck', { deckId, userId: m.id }, m.cookie);
  });
  it('subscribers get thread rows', async () => {
    const m = await mkUser('mia', [projectId]);
    await ok('watchings/addDeck', { deckId, userId: m.id }, m.cookie);
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    expect(note(m.id, rid)).toBeTruthy();
  });
});

describe('guardians', () => {
  let g: { id: string; cookie: string }, m: { id: string; cookie: string }, c: string;
  beforeEach(async () => {
    g = await mkUser('gus', [projectId]);
    m = await mkUser('mia', [projectId]);
    await ok('decks/update', { id: deckId, guardiansEnabled: true, guardianIds: [g.id] });
    c = await mkCard();
  });
  it('blocks non-guardians from done, archive and moving out; allows guardians and moving in', async () => {
    const other = await mkDeck();
    const r = await dispatch('cards/update', { id: c, status: 'done' }, m.cookie);
    expect([r.statusCode, r.json().error]).toEqual([403, 'guardian_only']);
    expect((await dispatch('cards/update', { id: c, visibility: 'archived' }, m.cookie)).statusCode).toBe(403);
    expect((await dispatch('cards/update', { id: c, deckId: other }, m.cookie)).statusCode).toBe(403);
    expect((await dispatch('cards/bulkUpdate', { ids: [c], status: 'done' }, m.cookie)).json().error).toBe('guardian_only');
    expect(db.prepare('SELECT status FROM cards WHERE id=?').get(c)).toEqual({ status: 'not_started' });
    await ok('cards/update', { id: c, status: 'done' }, g.cookie);
    const c2 = (await ok('cards/create', { content: 'Z', deckId: other })).id;
    await ok('cards/update', { id: c2, deckId }, m.cookie);
  });
  it('deleting a guarded list is guardian-only; guardians and unguarded lists are fine', async () => {
    const r = await dispatch('decks/delete', { id: deckId }, m.cookie);
    expect([r.statusCode, r.json().error]).toEqual([403, 'guardian_only']);
    expect(db.prepare('SELECT 1 x FROM decks WHERE id=?').get(deckId)).toBeTruthy();
    expect(db.prepare('SELECT visibility v FROM cards WHERE id=?').get(c)).toEqual({ v: 'default' });
    const free = await mkDeck('free');
    await ok('decks/delete', { id: free }, m.cookie);
    await ok('decks/delete', { id: deckId }, g.cookie);
    expect(db.prepare('SELECT 1 x FROM decks WHERE id=?').get(deckId)).toBeUndefined();
  });
  it('a list whose guardians are all gone can be deleted by anyone who can edit', async () => {
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(g.id);
    await ok('decks/delete', { id: deckId }, m.cookie);
  });
  it('deckGuardian rows go to the project viewers, not to outsiders', async () => {
    const out = await mkUser('zed');
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const hub = new LiveHub(db);
    const got = (u: { id: string }) => { const a: any[] = []; hub.add({ send: (x) => a.push(...JSON.parse(x).events), close() {} }, u); return a; };
    const gotM = got(m), gotG = got(g), gotOut = got(out);
    const r = run(db, { id: ownerId } as any, 'decks/update', { id: deckId, guardianIds: [g.id, m.id] });
    hub.publish('1', r.events);
    const rows = (a: any[]) => a.filter((e) => e.model === 'deckGuardian');
    expect(rows(gotM).length).toBeGreaterThan(0);
    expect(rows(gotG).length).toBeGreaterThan(0);
    expect(rows(gotOut)).toHaveLength(0);
  });
  it('a hero in a guarded list still auto-completes when a non-guardian completes its subtasks elsewhere', async () => {
    const other = await mkDeck('free');
    const sub = (await ok('cards/create', { content: 'sub', deckId: other, parentCardId: c }, m.cookie)).id as string;
    await ok('cards/update', { id: sub, status: 'done' }, m.cookie);
    expect(db.prepare('SELECT status FROM cards WHERE id=?').get(c)).toEqual({ status: 'done' });
  });
  it('bulk is atomic', async () => {
    const other = await mkDeck();
    const free = (await ok('cards/create', { content: 'F', deckId: other })).id;
    expect((await dispatch('cards/bulkUpdate', { ids: [free, c], status: 'done' }, m.cookie)).statusCode).toBe(403);
    expect(db.prepare('SELECT status FROM cards WHERE id=?').get(free)).toEqual({ status: 'not_started' });
  });
  it('blocks closing a review with markCardDone', async () => {
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'review', content: 'look' }, m.cookie);
    expect((await dispatch('resolvables/close', { id: rid, markCardDone: true }, m.cookie)).json().error).toBe('guardian_only');
    await ok('resolvables/close', { id: rid, markCardDone: true }, g.cookie);
  });
  it('a review in a guarded list gives every active guardian a row', async () => {
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'review', content: 'look' }, m.cookie);
    expect(note(g.id, rid)).toBeTruthy();
    const { id: rid2 } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'chat' }, m.cookie);
    expect(note(g.id, rid2)).toBeUndefined();
  });
  it('only managers set guardians, and guardians must see the project', async () => {
    expect((await dispatch('decks/update', { id: deckId, guardianIds: [m.id] }, m.cookie)).statusCode).toBe(403);
    const out = await mkUser('zed');
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await dispatch('decks/update', { id: deckId, guardianIds: [out.id] })).statusCode).toBe(400);
  });
  it('guardian rows and list flag reach the snapshot', async () => {
    const s = await snap(m.cookie);
    expect(s.deckGuardians).toEqual([{ deckId, userId: g.id }]);
    expect(s.decks.find((d: any) => d.id === deckId).guardiansEnabled).toBe(true);
  });
  it('lockout: a disabled or access-less guardian no longer guards', async () => {
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(g.id);
    await ok('cards/update', { id: c, status: 'done' }, m.cookie);
  });
  it('lockout: guardian loses project access', async () => {
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(g.id);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    await ok('cards/update', { id: c, status: 'done' }, owner);
  });
});

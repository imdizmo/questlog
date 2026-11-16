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



const hand = (uid: string) => (db.prepare('SELECT card_id c FROM hand_cards WHERE user_id=? ORDER BY sort_index').all(uid) as any[]).map((r) => r.c as string);
const idx = (uid: string) => (db.prepare('SELECT sort_index s FROM hand_cards WHERE user_id=? ORDER BY sort_index').all(uid) as any[]).map((r) => r.s as number);
const mkDeck = async () => (await ok('decks/create', { title: 'S', projectId })).id as string;
const mkIn = async (d: string, title = 'C') => (await ok('cards/create', { content: title, deckId: d })).id as string;

describe('hand queue', () => {
  it('add and order', async () => {
    const [a, b, c] = [await mkCard('a'), await mkCard('b'), await mkCard('c')];
    await ok('handQueue/addCards', { cardIds: [a, b, c], userId: ownerId });
    expect(idx(ownerId)).toEqual([1, 2, 3]);
    expect(hand(ownerId)).toEqual([a, b, c]);
    await ok('handQueue/reorder', { userId: ownerId, cardIds: [c, a, b] });
    expect(hand(ownerId)).toEqual([c, a, b]);
    expect(idx(ownerId)).toEqual([1, 2, 3]);
    const stale = await dispatch('handQueue/reorder', { userId: ownerId, cardIds: [c, a] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error ?? stale.json().code).toBe('stale_hand');
    const d = await mkCard('d');
    await ok('handQueue/addCards', { cardIds: [d], userId: ownerId, slot: 2 });
    expect(hand(ownerId)).toEqual([c, d, a, b]);
    await ok('handQueue/removeCards', { cardIds: [d], userId: ownerId });
    expect(hand(ownerId)).toEqual([c, a, b]);
    expect(idx(ownerId)).toEqual([1, 2, 3]);
  });
  it('hand full', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await mkCard(`k${i}`));
    await ok('accounts/update', { settings: { maxHandSlots: 7 } });
    await ok('handQueue/addCards', { cardIds: ids, userId: ownerId });
    const more = await mkCard('x');
    const r = await dispatch('handQueue/addCards', { cardIds: [more], userId: ownerId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error ?? r.json().code).toBe('hand_full');
    expect(hand(ownerId)).toHaveLength(7);
  });
  it('teammate arranges another hand only with edit rights', async () => {
    const m = await mkUser('mia', [projectId]);
    const c = await mkCard();
    await ok('handQueue/addCards', { cardIds: [c], userId: m.id });
    expect(hand(m.id)).toEqual([c]);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const obs = await mkUser('obs');
    expect((await dispatch('handQueue/addCards', { cardIds: [c], userId: m.id }, obs.cookie)).statusCode).toBeGreaterThanOrEqual(403);
  });
  it('acting on another hand checks every task', async () => {
    const m = await mkUser('mia', [projectId]);
    const mem = await mkUser('max', [projectId]);
    const proj = await mkCard('p');
    // a deckless card created by the owner (admin); mem is not its creator and not an admin
    db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,status,visibility,is_doc,version,content_version,sort_index,created_at,last_updated_at) VALUES (?,?,NULL,?,'loose','not_started','default',0,0,1,0,0,0)")
      .run('loose1', 9999, mem.id);
    const own = await dispatch('handQueue/addCards', { cardIds: [proj, 'loose1'], userId: m.id }, mem.cookie);
    expect(own.statusCode).toBe(404); // m cannot see mem's deckless card
    // mixed list where target can see all but actor is not admin / creator of the deckless card
    db.prepare("UPDATE cards SET creator_id=? WHERE id='loose1'").run(m.id);
    const mixed = await dispatch('handQueue/addCards', { cardIds: [proj, 'loose1'], userId: m.id }, mem.cookie);
    expect(mixed.statusCode).toBe(404); // mem cannot even see it
    expect(hand(m.id)).toEqual([]);
    // admin may arrange it
    await ok('handQueue/addCards', { cardIds: [proj, 'loose1'], userId: m.id });
    expect(hand(m.id)).toEqual([proj, 'loose1']);
    // non-admin with rights on the project but a deckless card in the list: removal refused, nothing changed
    const rem = await dispatch('handQueue/removeCards', { cardIds: [proj, 'loose1'], userId: m.id }, mem.cookie);
    expect(rem.statusCode).toBe(403);
    expect(hand(m.id)).toEqual([proj, 'loose1']);
    const re = await dispatch('handQueue/reorder', { userId: m.id, cardIds: ['loose1', proj] }, mem.cookie);
    expect(re.statusCode).toBe(409); // loose1 is hidden from mem, so a list naming it is stale
    expect(hand(m.id)).toEqual([proj, 'loose1']);
    // missing card is 404
    expect((await dispatch('handQueue/removeCards', { cardIds: ['nope'], userId: m.id }, mem.cookie)).statusCode).toBe(404);
  });
  it('non-owner with rights can reorder and remove; observer and unseen target are refused', async () => {
    const m = await mkUser('mia', [projectId]);
    const mem = await mkUser('max', [projectId]);
    const [a, b] = [await mkCard('a'), await mkCard('b')];
    await ok('handQueue/addCards', { cardIds: [a, b], userId: m.id }, mem.cookie);
    await ok('handQueue/reorder', { userId: m.id, cardIds: [b, a] }, mem.cookie);
    expect(hand(m.id)).toEqual([b, a]);
    await ok('handQueue/removeCards', { cardIds: [b], userId: m.id }, mem.cookie);
    expect(hand(m.id)).toEqual([a]);
    // observer on the project: can see, cannot edit
    const o = await mkUser('olly', [projectId]);
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(o.id);
    for (const [name, payload] of [
      ['handQueue/addCards', { cardIds: [b], userId: m.id }],
      ['handQueue/removeCards', { cardIds: [a], userId: m.id }],
      ['handQueue/reorder', { userId: m.id, cardIds: [a] }],
    ] as const) {
      const r = await dispatch(name, payload, o.cookie);
      expect(r.statusCode, name).toBe(403);
      expect(r.json().error).toBe('forbidden');
    }
    expect(hand(m.id)).toEqual([a]);
    // target cannot see the card
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const out = await mkUser('zed');
    const r = await dispatch('handQueue/addCards', { cardIds: [b], userId: out.id });
    expect(r.statusCode).toBe(404);
    expect(hand(out.id)).toEqual([]);
  });
  it('reorder compares only the tasks the actor can see', async () => {
    const m = await mkUser('mia', [projectId]);
    const mem = await mkUser('max', [projectId]);
    const [x, y] = [await mkCard('x'), await mkCard('y')];
    db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,status,visibility,is_doc,version,content_version,sort_index,created_at,last_updated_at) VALUES ('hid',9998,NULL,?,'h','not_started','default',0,0,1,0,0,0)").run(m.id);
    db.prepare('INSERT INTO hand_cards (user_id, card_id, sort_index) VALUES (?,?,?),(?,?,?),(?,?,?)').run(m.id, 'hid', 1, m.id, x, 2, m.id, y, 3);
    await ok('handQueue/reorder', { userId: m.id, cardIds: [y, x] }, mem.cookie);
    expect(hand(m.id)).toEqual(['hid', y, x]);
    expect(idx(m.id)).toEqual([1, 2, 3]);
    for (const cardIds of [[y], [y, x, 'hid'], [x, x]]) {
      const r = await dispatch('handQueue/reorder', { userId: m.id, cardIds }, mem.cookie);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('stale_hand');
    }
    expect(hand(m.id)).toEqual(['hid', y, x]);
  });
  it('hand sync', async () => {
    const m = await mkUser('mia', [projectId]);
    const d = await mkDeck();
    await ok('decks/update', { id: d, handSyncEnabled: true });
    const first = await mkCard('manual');
    await ok('handQueue/addCards', { cardIds: [first], userId: m.id });
    const c = await mkIn(d);
    await ok('cards/update', { id: c, assigneeId: m.id });
    expect(hand(m.id)).toEqual([first, c]);
    expect((db.prepare('SELECT status s FROM cards WHERE id=?').get(c) as any).s).toBe('not_started');
    const r = await dispatch('handQueue/removeCards', { cardIds: [c], userId: m.id }, m.cookie);
    expect(r.statusCode).toBe(409);
    expect(r.json().error ?? r.json().code).toBe('hand_synced');
    // created with an owner
    const c2 = (await ok('cards/create', { content: 'x', deckId: d, assigneeId: m.id })).id;
    expect(hand(m.id)).toEqual([first, c, c2]);
    // unsynced removal of a manual card still works
    await ok('handQueue/removeCards', { cardIds: [first], userId: m.id }, m.cookie);
    // full hand: assignment still succeeds
    await ok('accounts/update', { settings: { maxHandSlots: 7 } });
    for (let i = 0; i < 5; i++) await ok('handQueue/addCards', { cardIds: [await mkCard(`f${i}`)], userId: m.id });
    expect(hand(m.id)).toHaveLength(7);
    const before = hand(m.id);
    const c3 = await mkIn(d);
    await ok('cards/update', { id: c3, assigneeId: m.id });
    expect(hand(m.id)).toEqual(before);
    expect((db.prepare('SELECT assignee_id a FROM cards WHERE id=?').get(c3) as any).a).toBe(m.id);
  });
  it('blocked stays', async () => {
    const c = await mkCard();
    await ok('cards/update', { id: c, status: 'started' });
    expect(hand(ownerId)).toEqual([c]);
    await ok('resolvables/create', { cardId: c, context: 'block', content: 'stuck' });
    expect(hand(ownerId)).toEqual([c]);
  });
  it('done pile', async () => {
    const c = await mkCard();
    await ok('cards/update', { id: c, status: 'started' });
    await ok('cards/update', { id: c, status: 'done' });
    expect(hand(ownerId)).toEqual([]);
    expect(db.prepare('SELECT * FROM done_pile WHERE user_id=? AND card_id=?').all(ownerId, c)).toHaveLength(1);
    expect((await snap(owner)).donePile).toHaveLength(1);
    await ok('cards/update', { id: c, status: 'not_started' });
    expect(db.prepare('SELECT * FROM done_pile WHERE card_id=?').all(c)).toHaveLength(0);
  });
  it('done pile via review close and old rows hidden', async () => {
    const c = await mkCard();
    await ok('cards/update', { id: c, status: 'started' });
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'review', content: 'r' });
    await ok('resolvables/close', { id: rid, markCardDone: true });
    expect(db.prepare('SELECT * FROM done_pile WHERE card_id=?').all(c)).toHaveLength(1);
    db.prepare('UPDATE done_pile SET done_at=? WHERE card_id=?').run(Date.now() - 15 * 86400000, c);
    expect((await snap(owner)).donePile).toEqual([]);
  });
  it('bookmarks private', async () => {
    const m = await mkUser('mia', [projectId]);
    const c = await mkCard();
    const hub = new LiveHub(db);
    const gotM: any[] = [], gotO: any[] = [];
    hub.add({ send: (s) => gotM.push(...JSON.parse(s).events), close() {} }, { id: m.id });
    hub.add({ send: (s) => gotO.push(...JSON.parse(s).events), close() {} }, { id: ownerId });
    const r = run(db, { id: ownerId } as any, 'bookmarks/addCards', { userId: ownerId, ids: [c] });
    hub.publish('1', r.events);
    expect(gotO.filter((e) => e.model === 'bookmark')).toHaveLength(1);
    expect(gotM.filter((e) => e.model === 'bookmark')).toHaveLength(0);
    expect((await snap(owner)).bookmarks).toHaveLength(1);
    expect((await snap(m.cookie)).bookmarks).toEqual([]);
    expect((await dispatch('bookmarks/addCards', { userId: ownerId, ids: [c] }, m.cookie)).statusCode).toBe(403);
    expect((await dispatch('bookmarks/removeCards', { userId: ownerId, ids: [c] }, m.cookie)).statusCode).toBe(403);
    const r2 = run(db, { id: ownerId } as any, 'bookmarks/removeCards', { userId: ownerId, ids: [c] });
    hub.publish('2', r2.events);
    expect(gotO.filter((e) => e.model === 'bookmark' && e.op === 'remove')).toHaveLength(1);
    expect(gotM.filter((e) => e.model === 'bookmark')).toHaveLength(0);
  });
  it('timezone', async () => {
    await ok('users/update', { id: ownerId, timezone: 'Europe/Rome' });
    expect((db.prepare('SELECT timezone t FROM users WHERE id=?').get(ownerId) as any).t).toBe('Europe/Rome');
    expect((await dispatch('users/update', { id: ownerId, timezone: 'Mars/Base' })).statusCode).toBe(400);
    const m = await mkUser('mia', [projectId]);
    expect((await dispatch('users/update', { id: ownerId, timezone: 'Europe/Rome' }, m.cookie)).statusCode).toBe(403);
  });
});

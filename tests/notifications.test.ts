import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { dispatch as run } from '../server/dispatch';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
const DAY3 = 259200000;
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

describe('view-gated commands', () => {
  it('an observer who is mentioned can markSeen', async () => {
    const obs = await mkUser('obi', [projectId]);
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(obs.id);
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: '@obi hi' });
    expect(note(obs.id, rid).unseen_entry_count).toBe(1);
    await ok('resolvables/markSeen', { resolvableId: rid }, obs.cookie);
    expect(note(obs.id, rid).unseen_entry_count).toBe(0);
  });
  it('without access, commands 404 and create no row', async () => {
    const lim = await mkProjectLimited();
    const out = await mkUser('zed');
    const c = (await ok('cards/create', { content: 'L', deckId: lim })).id;
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    for (const [n, p] of [['snooze', {}], ['markSeen', {}], ['setMuted', { isMuted: true }], ['setParticipation', { isParticipating: false }]] as const) {
      expect((await dispatch(`resolvables/${n}`, { resolvableId: rid, ...p }, out.cookie)).statusCode, n).toBe(404);
    }
    expect(note(out.id, rid)).toBeUndefined();
  });
  it('an opted-out author still moves their seen pointer', async () => {
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    await ok('resolvables/setParticipation', { resolvableId: rid, isParticipating: false });
    const { id: eid } = await ok('resolvables/comment', { resolvableId: rid, content: 'y' });
    expect(note(ownerId, rid)).toMatchObject({ is_participating: 0, latest_seen_entry_id: eid });
  });
});

describe('notification state', () => {
  it('creator row is muted, seen, with a 3-day reminder', async () => {
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'hi' });
    const n = note(ownerId, rid);
    const created = (db.prepare('SELECT created_at t FROM resolvables WHERE id=?').get(rid) as any).t;
    expect(n.is_muted).toBe(1);
    expect(n.unseen_entry_count).toBe(0);
    expect(n.remind_me_on).toBe(created + DAY3);
    const s = await snap(owner);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]).toMatchObject({ userId: ownerId, resolvableId: rid, isMuted: true, unseenEntryCount: 0 });
  });

  it('counts replies for others, markSeen clears', async () => {
    const bea = await mkUser('bea', [projectId]);
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'hi' });
    const { id: eid } = await ok('resolvables/comment', { resolvableId: rid, content: 'yo' }, bea.cookie);
    const a = note(ownerId, rid);
    expect(a.unseen_entry_count).toBe(1);
    expect(a.authors).toEqual([bea.id]);
    expect(a.latest_entry_id).toBe(eid);
    const b = note(bea.id, rid);
    expect(b.unseen_entry_count).toBe(0);
    expect(b.latest_seen_entry_id).toBe(eid);
    await ok('resolvables/markSeen', { resolvableId: rid });
    const a2 = note(ownerId, rid);
    expect(a2.unseen_entry_count).toBe(0);
    expect(a2.authors).toEqual([]);
    expect(a2.latest_seen_entry_id).toBe(eid);
  });

  it('a mention adds a participant; edits that add a mention too, without a bump', async () => {
    const bea = await mkUser('bea', [projectId]);
    const cy = await mkUser('cy', [projectId]);
    const c = await mkCard();
    const { id: rid, entryId } = await ok('resolvables/create', { cardId: c, context: 'comment', content: '@bea look' });
    const n = note(bea.id, rid);
    expect(n).toMatchObject({ is_participating: 1, unseen_entry_count: 1 });
    expect(note(cy.id, rid)).toBeUndefined();
    await ok('resolvables/editEntry', { entryId, content: '@bea look @cy too' });
    expect(note(cy.id, rid)).toMatchObject({ is_participating: 1, unseen_entry_count: 0 });
    expect(note(bea.id, rid).unseen_entry_count).toBe(1);
  });

  it('a mention needs project access', async () => {
    const lim = await mkProjectLimited();
    await mkUser('cy');
    const c = (await ok('cards/create', { content: 'L', deckId: lim })).id;
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: '@cy hi' });
    expect(db.prepare('SELECT COUNT(*) c FROM resolvable_notifications WHERE resolvable_id=?').get(rid)).toEqual({ c: 1 });
  });

  it('opting out keeps a user out of later entries', async () => {
    const bea = await mkUser('bea', [projectId]);
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: '@bea hi' });
    await ok('resolvables/setParticipation', { resolvableId: rid, isParticipating: false }, bea.cookie);
    expect(note(bea.id, rid).is_participating).toBe(0);
    await ok('resolvables/comment', { resolvableId: rid, content: 'again @bea' });
    expect(note(bea.id, rid).unseen_entry_count).toBe(1);
    await ok('resolvables/setMuted', { resolvableId: rid, isMuted: true }, bea.cookie);
    expect(note(bea.id, rid).is_muted).toBe(1);
  });

  it('snooze sets three days, null clears', async () => {
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    await ok('resolvables/snooze', { resolvableId: rid });
    expect(Math.abs(note(ownerId, rid).snooze_until - (Date.now() + DAY3))).toBeLessThan(1000);
    await ok('resolvables/snooze', { resolvableId: rid, until: null });
    expect(note(ownerId, rid).snooze_until).toBeNull();
  });

  it('is private and scoped', async () => {
    const bea = await mkUser('bea', [projectId]);
    const c = await mkCard();
    const hub = new LiveHub(db);
    const got: any[] = [];
    hub.add({ send: (s) => got.push(...JSON.parse(s).events), close() {} }, { id: bea.id });
    const me = { id: ownerId } as any;
    const r = run(db, me, 'resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    hub.publish('1', r.events);
    expect(got.filter((e) => e.model === 'resolvableNotification')).toHaveLength(0);
    expect(r.events.filter((e) => e.model === 'resolvableNotification').map((e: any) => e.row.userId).sort()).toEqual([ownerId]);
    const { id: rid } = r.payload as any;
    const r2 = run(db, me, 'resolvables/comment', { resolvableId: rid, content: 'hello' });
    hub.publish('2', r2.events);
    expect(got.filter((e) => e.model === 'resolvableNotification')).toEqual([]);
    // bea, once a participant, sees only her own row
    run(db, { id: bea.id } as any, 'resolvables/comment', { resolvableId: rid, content: 'hey' });
    const r3 = run(db, me, 'resolvables/comment', { resolvableId: rid, content: 'again' });
    hub.publish('3', r3.events);
    const mine = got.filter((e) => e.model === 'resolvableNotification');
    expect(mine).toHaveLength(1);
    expect(mine[0].row.userId).toBe(bea.id);
    // access loss: snapshot has no rows
    expect((await snap(bea.cookie)).notifications.length).toBeGreaterThan(0);
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(bea.id);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect((await snap(bea.cookie)).notifications).toEqual([]);
  });

  it('closed threads drop out of the snapshot but keep their rows', async () => {
    const c = await mkCard();
    const { id: rid } = await ok('resolvables/create', { cardId: c, context: 'comment', content: 'x' });
    await ok('resolvables/close', { id: rid });
    expect(note(ownerId, rid)).toBeTruthy();
    expect((await snap(owner)).notifications).toEqual([]);
  });
});

async function mkProjectLimited() {
  const p = (await ok('projects/create', { name: 'Lim' })).id as string;
  db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(p);
  return (await ok('decks/create', { title: 'LD', projectId: p })).id as string;
}

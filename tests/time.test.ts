import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { runJob, runTimerCap } from '../server/jobs';
import { LiveHub } from '../server/live';
import { parseDuration, formatDuration } from '../shared/duration';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;
let projectId: string;
let deckId: string;
let ownerId: string;
const me = () => ownerId;
const hub = { publish: () => {} };

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
const seg = (id: string) => db.prepare('SELECT * FROM time_segments WHERE id=?').get(id) as any;
const enable = (mode: string | null = 'strict') => {
  const s = (db.prepare('SELECT settings_json s FROM account').get() as any).s;
  db.prepare('UPDATE account SET settings_json=?').run(JSON.stringify({ ...JSON.parse(s), timeTrackingMode: mode }));
};
const H = 3600e3;

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users').get() as { id: string }).id;
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('parseDuration', () => {
  it('parses the accepted forms', () => {
    expect(parseDuration('120')).toBe(7_200_000);
    expect(parseDuration('3:20')).toBe(12_000_000);
    expect(parseDuration('2.5h')).toBe(9_000_000);
    expect(parseDuration('45m')).toBe(2_700_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('1:75')).toBeNull();
    for (const bad of ['-1', '1.5', '3:75', '1h75m', '99999999', '1h-5m']) expect(parseDuration(bad), bad).toBeNull();
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('0:00')).toBe(0);
  });
  it('formats h:mm', () => {
    expect(formatDuration(12_000_000)).toBe('3:20');
    expect(formatDuration(60_000)).toBe('0:01');
  });
});

describe('time tracking', () => {
  it('start sets owner and status', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    expect(seg(id).duration_ms).toBeNull();
    expect(card(c).status).toBe('started');
    expect(card(c).assignee_id).toBe(me());
    expect(db.prepare('SELECT 1 FROM hand_cards WHERE card_id=?').get(c)).toBeTruthy();
  });
  it('keeps an existing owner', async () => {
    enable();
    const u = await mkUser('bob', [projectId]);
    const c = await mkCard(deckId, { assigneeId: u.id });
    await ok('timeTracking/start', { userId: me(), cardId: c });
    expect(card(c).assignee_id).toBe(u.id);
  });
  it('one timer at a time', async () => {
    enable();
    const a = await mkCard(); const b = await mkCard();
    const s1 = (await ok('timeTracking/start', { userId: me(), cardId: a })).id;
    const s2 = (await ok('timeTracking/start', { userId: me(), cardId: b })).id;
    expect(seg(s1).duration_ms).not.toBeNull();
    expect(seg(s2).duration_ms).toBeNull();
  });
  it('stop keeps the task started', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(Date.now() - 5000, id);
    await ok('timeTracking/stop', { id });
    expect(seg(id).duration_ms).toBeGreaterThanOrEqual(5000);
    expect(card(c).status).toBe('started');
  });
  it('stop is own-only and not for finished segments', async () => {
    enable();
    const c = await mkCard();
    const u = await mkUser('bob', [projectId]);
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    await fail('timeTracking/stop', { id }, 403, 'forbidden', u.cookie);
    await ok('timeTracking/stop', { id });
    await fail('timeTracking/stop', { id }, 409);
  });
  it('start needs userId = actor, a hero gives 409, a done task gives 409', async () => {
    enable();
    const u = await mkUser('bob', [projectId]);
    const c = await mkCard();
    await fail('timeTracking/start', { userId: u.id, cardId: c }, 403, 'forbidden');
    const kid = await mkCard(deckId, { parentCardId: c });
    await fail('timeTracking/start', { userId: me(), cardId: c }, 409);
    await ok('cards/update', { id: kid, status: 'done' });
    await fail('timeTracking/start', { userId: me(), cardId: kid }, 409);
  });
  it('feature off gives 409', async () => {
    const c = await mkCard();
    await fail('timeTracking/start', { userId: me(), cardId: c }, 409, 'feature_disabled');
    await fail('timeTracking/create', { startedAt: Date.now() - H, durationInMs: H, cardId: c, userId: me() }, 409, 'feature_disabled');
  });
  it('create validates duration and user', async () => {
    enable();
    const c = await mkCard();
    const u = await mkUser('bob', [projectId]);
    const base = { startedAt: Date.now() - 3 * H, cardId: c };
    const { id } = await ok('timeTracking/create', { ...base, durationInMs: H, userId: me() });
    expect(seg(id).duration_ms).toBe(H);
    await fail('timeTracking/create', { ...base, durationInMs: 0, userId: me() }, 400);
    await fail('timeTracking/create', { ...base, durationInMs: 24 * H + 1, userId: me() }, 400);
    await fail('timeTracking/create', { ...base, durationInMs: H, userId: me() }, 403, 'forbidden', u.cookie);
    const other = (await ok('timeTracking/create', { ...base, durationInMs: H, userId: u.id })).id;
    expect(seg(other).user_id).toBe(u.id);
    // card status untouched; history records a time row
    expect(card(c).status).toBe('not_started');
    const kinds = (db.prepare('SELECT changes_json j FROM card_history WHERE card_id=?').all(c) as any[]).flatMap((r) => JSON.parse(r.j).map((x: any) => x.kind));
    expect(kinds).toContain('time');
  });
  it('delete: own segment or project.manage', async () => {
    enable();
    const c = await mkCard();
    const u = await mkUser('bob', [projectId]);
    const v = await mkUser('cy', [projectId]);
    const mine2 = (await ok('timeTracking/create', { startedAt: Date.now() - 2 * H, durationInMs: H, cardId: c, userId: u.id })).id;
    await fail('timeTracking/delete', { id: mine2 }, 403, 'forbidden', v.cookie);
    await ok('timeTracking/delete', { id: mine2 }, u.cookie);
    expect(seg(mine2)).toBeUndefined();
  });
  it('snapshot carries recent and running segments of visible tasks only', async () => {
    enable();
    const c = await mkCard();
    db.prepare("UPDATE projects SET visibility='limited'").run();
    const u = await mkUser('bob');
    const old = newId();
    db.prepare('INSERT INTO time_segments (id,card_id,user_id,started_at,duration_ms,created_at) VALUES (?,?,?,?,?,?)').run(old, c, u.id, Date.now() - 40 * 24 * H, H, 0);
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    const s = await snap(owner);
    const ids = s.timeSegments.map((x: any) => x.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain(old);
    expect(s.timeSegments.find((x: any) => x.id === id).durationInMs).toBeNull();
    expect((await snap(u.cookie)).timeSegments).toEqual([]);
  });
  it('8h cap stops long timers at started_at + 8h', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    const now = Date.now();
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(now - 9 * H, id);
    runJob(db, hub, (ctx) => runTimerCap(ctx, now));
    expect(seg(id).duration_ms).toBe(8 * H);
  });
  it('8h cap leaves younger timers and emits upserts', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    const now = Date.now();
    const events: any[] = [];
    runJob(db, { publish: (_a, e) => events.push(...e) }, (ctx) => runTimerCap(ctx, now));
    expect(seg(id).duration_ms).toBeNull();
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(now - 9 * H, id);
    runJob(db, { publish: (_a, e) => events.push(...e) }, (ctx) => runTimerCap(ctx, now));
    expect(events.some((e) => e.model === 'timeSegment' && e.op === 'upsert' && e.row.id === id)).toBe(true);
  });
  it('stop clamps a stale timer to 8h', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(Date.now() - 9 * H, id);
    await ok('timeTracking/stop', { id });
    expect(seg(id).duration_ms).toBe(8 * H);
  });
  it('cap boundary: exactly 8h is stopped, stopped segments untouched', async () => {
    enable();
    const c = await mkCard();
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    const done = (await ok('timeTracking/create', { startedAt: 1000, durationInMs: H, cardId: c, userId: me() })).id;
    const now = Date.now();
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(now - 8 * H + 1, id);
    runJob(db, hub, (ctx) => runTimerCap(ctx, now));
    expect(seg(id).duration_ms).toBeNull();
    db.prepare('UPDATE time_segments SET started_at=? WHERE id=?').run(now - 8 * H, id);
    runJob(db, hub, (ctx) => runTimerCap(ctx, now));
    expect(seg(id).duration_ms).toBe(8 * H);
    expect(seg(done).duration_ms).toBe(H);
    expect(seg(done).started_at).toBe(1000);
  });
  it('delete needs the feature on and task access, even for own segments', async () => {
    enable();
    db.prepare("UPDATE projects SET visibility='limited'").run();
    const c = await mkCard();
    const u = await mkUser('bob', [projectId]);
    const mine = (await ok('timeTracking/create', { startedAt: Date.now() - 2 * H, durationInMs: H, cardId: c, userId: u.id })).id;
    const before = db.prepare('SELECT COUNT(*) n FROM card_history WHERE card_id=?').get(c) as any;
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(u.id);
    await fail('timeTracking/delete', { id: mine }, 403, 'forbidden', u.cookie);
    expect(seg(mine)).toBeDefined();
    expect((db.prepare('SELECT COUNT(*) n FROM card_history WHERE card_id=?').get(c) as any).n).toBe(before.n);
    db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(projectId, u.id);
    enable(null);
    await fail('timeTracking/delete', { id: mine }, 409, 'feature_disabled', u.cookie);
    enable();
    await ok('cards/update', { id: c, visibility: 'deleted' });
    await fail('timeTracking/delete', { id: mine }, 404, 'not_found', u.cookie);
    expect(seg(mine)).toBeDefined();
  });
  it('a failed start leaves the previous timer running; a running timer on a done task does not shortcut', async () => {
    enable();
    const a = await mkCard(); const b = await mkCard();
    const s1 = (await ok('timeTracking/start', { userId: me(), cardId: a })).id;
    await ok('cards/update', { id: b, status: 'done' });
    await fail('timeTracking/start', { userId: me(), cardId: b }, 409);
    expect(seg(s1).duration_ms).toBeNull();
    await ok('cards/update', { id: a, status: 'done' });
    expect(seg(s1).duration_ms).not.toBeNull(); // finishing the card stops its timer
    await fail('timeTracking/start', { userId: me(), cardId: a }, 409);
  });
  it('db allows one running timer per user', async () => {
    enable();
    const a = await mkCard();
    await ok('timeTracking/start', { userId: me(), cardId: a });
    expect(() => db.prepare('INSERT INTO time_segments (id,card_id,user_id,started_at,duration_ms,created_at) VALUES (?,?,?,?,NULL,0)').run(newId(), a, me(), 1)).toThrow();
  });
  it('live: outsiders get no timeSegment events', async () => {
    enable();
    db.prepare("UPDATE projects SET visibility='limited'").run();
    const c = await mkCard();
    const out = await mkUser('out');
    const { id } = await ok('timeTracking/start', { userId: me(), cardId: c });
    const row = { id, cardId: c, userId: me() };
    const hub2 = new LiveHub(db);
    const got: Record<string, any[]> = { owner: [], out: [] };
    hub2.add({ send: (d) => got.owner.push(JSON.parse(d)), close() {} }, { id: me() });
    hub2.add({ send: (d) => got.out.push(JSON.parse(d)), close() {} }, { id: out.id });
    hub2.publish('a', [{ model: 'timeSegment', op: 'upsert', row }]);
    hub2.publish('b', [{ model: 'timeSegment', op: 'remove', row }]);
    expect(got.owner.length).toBe(2);
    expect(got.out).toEqual([]);
  });
});

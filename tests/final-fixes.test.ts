import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { runJob, runAutoArchive } from '../server/jobs';
import { LiveHub } from '../server/live';
import { parseDuration, formatDuration } from '../shared/duration';
import { myTodayTotal, endsInFuture } from '../web/src/timeTracking';
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


const addRunning = (cardId: string, startedAt = Date.now() - 600_000) => {
  const id = newId();
  db.prepare('INSERT INTO time_segments (id, card_id, user_id, started_at, duration_ms, created_at) VALUES (?,?,?,?,NULL,?)').run(id, cardId, ownerId, startedAt, startedAt);
  return id;
};
const hand = (uid: string) => (db.prepare('SELECT card_id c FROM hand_cards WHERE user_id=? ORDER BY sort_index').all(uid) as any[]).map((r) => r.c as string);

describe('final review fixes', () => {
  it('1: deleted tasks in a Hand do not break reorder or count toward hand_full', async () => {
    await ok('accounts/update', { settings: { maxHandSlots: 7 } });
    const [a, b, c] = [await mkCard(), await mkCard(), await mkCard()];
    await ok('handQueue/addCards', { cardIds: [a, b, c], userId: ownerId });
    await ok('cards/update', { id: b, visibility: 'deleted' });
    await ok('handQueue/reorder', { userId: ownerId, cardIds: [c, a] });
    expect(hand(ownerId).filter((x) => x !== b)).toEqual([c, a]);
    // 2 live + 1 deleted in Hand; 5 more live fill 7 live, the 8th is refused
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await mkCard());
    await ok('handQueue/addCards', { cardIds: more, userId: ownerId });
    await fail('handQueue/addCards', { cardIds: [await mkCard()], userId: ownerId }, 409, 'hand_full');
  });

  it('3: done / archive / delete / auto-archive stop the task timers', async () => {
    enable();
    const mk = async () => { const id = await mkCard(); await ok('cards/update', { id, status: 'started' }); return id; };
    const [d, ar, de, j] = [await mk(), await mk(), await mk(), await mk()];
    const sd = addRunning(d);
    await ok('cards/update', { id: d, status: 'done' });
    expect(seg(sd).duration_ms).toBeGreaterThan(590_000);
    const sa = addRunning(ar, Date.now() - 20 * H);
    await ok('cards/update', { id: ar, visibility: 'archived' });
    expect(seg(sa).duration_ms).toBe(8 * H);
    const sx = addRunning(de);
    await ok('cards/update', { id: de, visibility: 'deleted' });
    expect(seg(sx).duration_ms).toBeGreaterThan(590_000);
    await ok('cards/update', { id: j, status: 'done' });
    await ok('accounts/update', { settings: { autoArchiveHours: 1 } });
    const sj = addRunning(j);
    db.prepare('UPDATE cards SET done_at=? WHERE id=?').run(Date.now() - 3 * H, j);
    runJob(db, hub, (ctx) => runAutoArchive(ctx, Date.now()));
    expect(card(j).visibility).toBe('archived');
    expect(seg(sj).duration_ms).not.toBeNull();
  });

  it('4: GET /api/tasks/:id/time gives all-time total and newest 200 segments', async () => {
    enable();
    const c = await mkCard();
    const ins = db.prepare('INSERT INTO time_segments (id, card_id, user_id, started_at, duration_ms, created_at) VALUES (?,?,?,?,?,0)');
    for (let i = 0; i < 205; i++) ins.run(newId(), c, ownerId, 1000 + i, 1000);
    const run = addRunning(c, Date.now() - 60_000);
    const r = await app.inject({ method: 'GET', url: `/api/cards/${c}/time`, headers: hdr(owner) });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.segments.length).toBe(200);
    expect(j.segments[0].id).toBe(run);
    expect(j.totalMs).toBeGreaterThanOrEqual(205_000 + 59_000);
    expect(j.totalMs).toBeLessThan(205_000 + 70_000);
    expect((await app.inject({ method: 'GET', url: '/api/cards/nope/time', headers: hdr(owner) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/cards/${c}/time`, headers: { host: HOST } })).statusCode).toBe(401);
  });

  it('6: starting a task with a full Hand still starts it but does not add it', async () => {
    await ok('accounts/update', { settings: { maxHandSlots: 7 } });
    const filler = [];
    for (let i = 0; i < 7; i++) filler.push(await mkCard());
    await ok('handQueue/addCards', { cardIds: filler, userId: ownerId });
    const [b, c] = [await mkCard(), await mkCard()];
    await ok('cards/update', { id: b, status: 'started' });
    expect(card(b).status).toBe('started');
    expect(hand(ownerId)).toEqual(filler);
    await ok('cards/create', { content: 'q', deckId, putInQueue: true });
    expect(hand(ownerId)).toEqual(filler);
    enable();
    await ok('timeTracking/start', { userId: ownerId, cardId: c });
    expect(card(c).status).toBe('started');
    expect(hand(ownerId)).toEqual(filler);
  });

  it('7: removing a project deletes milestones and run configs left with no projects', async () => {
    await ok('accounts/update', { settings: { milestonesEnabled: true, sprintsEnabled: true } });
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    const mBody = { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false };
    const only = (await ok('milestones/create', { ...mBody, projectIds: [projectId] })).id;
    const both = (await ok('milestones/create', { ...mBody, projectIds: [projectId, p2] })).id;
    const glob = (await ok('milestones/create', { ...mBody, isGlobal: true, projectIds: [] })).id;
    const cfg = { name: 'RT', runLabelTemplate: 'S %RUN_NR%', color: 'green', upcomingSprints: 2, sprintDurationWeeks: 2, sprintStartDate: '2026-11-14', moveOnFinish: [], isGlobal: false, endHour: 24, endHourTimezone: 'Europe/Rome' };
    const cOnly = (await ok('sprints/createConfig', { ...cfg, projectIds: [projectId] })).id;
    const cBoth = (await ok('sprints/createConfig', { ...cfg, projectIds: [projectId, p2] })).id;
    await ok('projects/delete', { id: projectId });
    const has = (t: string, id: string) => !!db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(id);
    expect(has('milestones', only)).toBe(false);
    expect(has('milestones', both)).toBe(true);
    expect(has('milestones', glob)).toBe(true);
    expect(has('sprint_configs', cOnly)).toBe(false);
    expect(has('sprint_configs', cBoth)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM sprints WHERE config_id=?').get(cOnly)).toEqual({ n: 0 });
  });

  it('5: deleting a list refreshes run progress', async () => {
    await ok('accounts/update', { settings: { sprintsEnabled: true } });
    const cfg = { name: 'RT', runLabelTemplate: 'S %RUN_NR%', color: 'green', upcomingSprints: 2, sprintDurationWeeks: 2, sprintStartDate: '2026-11-14', moveOnFinish: [], isGlobal: false, endHour: 24, endHourTimezone: 'Europe/Rome', projectIds: [projectId] };
    await ok('sprints/createConfig', cfg);
    const sp = (db.prepare('SELECT id FROM sprints ORDER BY run_nr').get() as any).id;
    const c = await mkCard();
    await ok('cards/update', { id: c, sprintId: sp });
    const total = () => (db.prepare('SELECT total_count t FROM sprint_progress WHERE sprint_id=? ORDER BY day DESC LIMIT 1').get(sp) as any)?.t;
    expect(total()).toBe(1);
    await ok('decks/delete', { id: deckId });
    expect(total()).toBe(0);
  });

  it('10: Add Time rejects an entry ending in the future', async () => {
    enable();
    const c = await mkCard();
    await fail('timeTracking/create', { startedAt: Date.now() + 3600e3, durationInMs: 600_000, cardId: c, userId: ownerId }, 400);
    await fail('timeTracking/create', { startedAt: Date.now() - 600_000, durationInMs: 3600e3, cardId: c, userId: ownerId }, 400);
    await ok('timeTracking/create', { startedAt: Date.now() - 3600e3, durationInMs: 3600e3, cardId: c, userId: ownerId });
  });

  it('11: users/update canonicalises timezone aliases', async () => {
    await ok('users/update', { id: ownerId, timezone: 'Asia/Calcutta' });
    const tz = (db.prepare('SELECT timezone t FROM users WHERE id=?').get(ownerId) as any).t;
    expect(tz).toBe(new Intl.DateTimeFormat(undefined, { timeZone: 'Asia/Calcutta' }).resolvedOptions().timeZone);
    await fail('users/update', { id: ownerId, timezone: 'Not/AZone' }, 400);
  });

  it('8: migration 015 adds the indexes', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((r) => r.name);
    expect(names).toContain('cards_status_done_at');
    expect(names).toContain('resolvable_entries_resolvable');
    expect(names).toContain('time_segments_one_running');
  });

  it('10: today total clips segments to the local day', () => {
    const now = new Date(2026, 10, 14, 1, 0, 0).getTime(); // 01:00 local
    const mid = new Date(2026, 10, 14, 0, 0, 0).getTime();
    const seg = (id: string, startedAt: number, durationInMs: number | null) => [id, { id, userId: 'u', cardId: 'c', startedAt, durationInMs }] as const;
    const st: any = { me: { id: 'u' }, timeSegments: new Map([
      seg('a', mid - 30 * 60_000, 60 * 60_000), // 23:30 -> 00:30: only 30 min today
      seg('b', mid - 3600e3, null),             // running since 23:00: 1 h today
      seg('c', mid - 5 * 3600e3, 3600e3),       // yesterday only
    ]) };
    expect(myTodayTotal(st, now)).toBe(30 * 60_000 + 3600e3);
    expect(endsInFuture(now - 10 * 60_000, 10 * 60_000, now)).toBe(false);
    expect(endsInFuture(now, 3600e3, now)).toBe(true);
  });
});

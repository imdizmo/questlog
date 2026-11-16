import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { runJob, runDailyProgress } from '../server/jobs';
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
const today = () => (globalThis as any).Temporal.Now.plainDateISO().toString() as string;
const mk = async (extra: object = {}) =>
  ok('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId], ...extra });
const progress = (m: string, p = projectId) =>
  db.prepare('SELECT * FROM milestone_progress WHERE milestone_id=? AND project_id=? AND day=?').get(m, p, today()) as any;
const limitProject = (id: string) => db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(id);

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

describe('milestones', () => {
  it('create shares one sequence', async () => {
    const a = await mk(), b = await mk({ name: 'N' });
    expect([a.accountSeq, b.accountSeq]).toEqual([11, 12]);
  });

  it('update replaces the whole record; a missing field is 400', async () => {
    const { id } = await mk();
    await ok('milestones/update', { id, name: 'X', date: '2026-12-01', startDate: '2026-11-20', color: 'blue', isGlobal: false, projectIds: [projectId] });
    expect(db.prepare('SELECT name, date, color FROM milestones WHERE id=?').get(id)).toMatchObject({ name: 'X', date: '2026-12-01', color: 'blue' });
    await fail('milestones/update', { id, name: 'X', date: null, color: 'blue', isGlobal: false, projectIds: [projectId] }, 400);
    await fail('milestones/update', { id, name: 'X', date: '2026-12-01', startDate: '2026-12-05', color: 'blue', isGlobal: false, projectIds: [projectId] }, 400);
    await fail('milestones/update', { id, name: 'X', date: null, startDate: null, color: 'nope', isGlobal: false, projectIds: [projectId] }, 400);
  });

  it('feature off gives 409', async () => {
    await ok('accounts/update', { settings: { milestonesEnabled: false } });
    await fail('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] }, 409);
  });

  it('permissions: project milestones need manage, global needs admin', async () => {
    const u = await mkUser('u', [projectId]);
    await fail('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] }, 403, undefined, u.cookie);
    await fail('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: true, projectIds: [] }, 403, undefined, u.cookie);
    await fail('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [] }, 400);
  });

  it('scope: hidden from outsiders; tasks of other projects are refused', async () => {
    const q = (await ok('projects/create', { name: 'Q' })).id as string;
    const qDeck = (await ok('decks/create', { title: 'QD', projectId: q })).id as string;
    limitProject(q);
    const { id } = await mk({ projectIds: [q] });
    const out = await mkUser('out', [projectId]);
    expect((await snap(out.cookie)).milestones.map((m: any) => m.id)).not.toContain(id);
    expect((await snap(owner)).milestones.map((m: any) => m.id)).toContain(id);
    const pm = (await mk()).id as string;
    const c = await mkCard(qDeck);
    await fail('cards/update', { id: c, milestoneId: pm }, 400, 'milestone_project');
    const global = (await mk({ isGlobal: true, projectIds: [] })).id as string;
    await ok('cards/update', { id: c, milestoneId: global });
    expect(card(c).milestone_id).toBe(global);
    expect((await snap(out.cookie)).milestones.map((m: any) => m.id)).toContain(global);
  });

  it('zones: task in zone, cleared on milestone change, nulled on delete', async () => {
    const m1 = (await mk()).id as string, m2 = (await mk()).id as string;
    const z = (await ok('milestoneZones/create', { milestoneId: m1, name: 'Z' })).id as string;
    const z2 = (await ok('milestoneZones/create', { milestoneId: m2, name: 'Z2' })).id as string;
    const c = await mkCard();
    await fail('cards/update', { id: c, milestoneId: m1, milestoneZoneId: z2 }, 400);
    await ok('cards/update', { id: c, milestoneId: m1, milestoneZoneId: z });
    expect(card(c)).toMatchObject({ milestone_id: m1, milestone_zone_id: z });
    await ok('milestoneZones/update', { id: z, name: 'Z!' });
    await ok('cards/update', { id: c, milestoneId: m2 });
    expect(card(c)).toMatchObject({ milestone_id: m2, milestone_zone_id: null });
    await ok('cards/update', { id: c, milestoneId: m1, milestoneZoneId: z });
    await ok('milestoneZones/delete', { id: z });
    expect(card(c).milestone_zone_id).toBeNull();
    expect(card(c).milestone_id).toBe(m1);
  });

  it('auto milestone assigns new tasks and tasks moved in', async () => {
    const m = (await mk()).id as string;
    await ok('decks/update', { id: deckId, autoMilestoneId: m });
    const c = await mkCard();
    expect(card(c).milestone_id).toBe(m);
    const other = (await ok('decks/create', { title: 'O', projectId })).id as string;
    const c2 = await mkCard(other);
    expect(card(c2).milestone_id).toBeNull();
    await ok('cards/update', { id: c2, deckId });
    expect(card(c2).milestone_id).toBe(m);
    const q = (await ok('projects/create', { name: 'Q' })).id as string;
    const qd = (await ok('decks/create', { title: 'QD', projectId: q })).id as string;
    await fail('decks/update', { id: qd, autoMilestoneId: m }, 400, 'milestone_project');
  });

  it('progress counts tasks per project and follows status, effort and removal', async () => {
    const { id } = await mk();
    const a = await mkCard(deckId, { effort: 3 }), b = await mkCard(deckId, { effort: 2 });
    await ok('cards/update', { id: a, milestoneId: id });
    await ok('cards/update', { id: b, milestoneId: id });
    expect(progress(id)).toMatchObject({ total_count: 2, done_count: 0, total_effort: 5, done_effort: 0 });
    await ok('cards/update', { id: a, status: 'done' });
    expect(progress(id)).toMatchObject({ total_count: 2, done_count: 1, total_effort: 5, done_effort: 3 });
    await ok('cards/update', { id: b, effort: 4 });
    expect(progress(id)).toMatchObject({ total_effort: 7 });
    await ok('cards/update', { id: b, milestoneId: null });
    expect(progress(id)).toMatchObject({ total_count: 1, done_count: 1 });
    await ok('cards/update', { id: a, visibility: 'deleted' });
    expect(progress(id)).toMatchObject({ total_count: 0, done_count: 0 });
  });

  it('progress rows are per project: an outsider only gets visible projects', async () => {
    const q = (await ok('projects/create', { name: 'Q' })).id as string;
    const qDeck = (await ok('decks/create', { title: 'QD', projectId: q })).id as string;
    limitProject(q);
    const { id } = await mk({ isGlobal: true, projectIds: [] });
    await ok('cards/update', { id: await mkCard(), milestoneId: id });
    await ok('cards/update', { id: await mkCard(qDeck), milestoneId: id });
    const out = await mkUser('out', [projectId]);
    const rows = (await snap(out.cookie)).milestoneProgress;
    expect(rows.map((r: any) => r.projectId)).toEqual([projectId]);
    expect((await snap(owner)).milestoneProgress.map((r: any) => r.projectId).sort()).toEqual([projectId, q].sort());
  });

  it('daily job writes a row for open milestones', async () => {
    const { id } = await mk();
    await ok('cards/update', { id: await mkCard(), milestoneId: id });
    db.prepare('DELETE FROM milestone_progress').run();
    runJob(db, new LiveHub(db), (ctx) => runDailyProgress(ctx));
    expect(progress(id)).toMatchObject({ total_count: 1 });
    // a milestone that ended long ago is not refreshed
    const old = (await mk({ date: '2020-01-01' })).id as string;
    db.prepare("UPDATE cards SET milestone_id=? WHERE id=?").run(old, await mkCard());
    runJob(db, new LiveHub(db), (ctx) => runDailyProgress(ctx));
    expect(progress(old)).toBeUndefined();
  });

  it('delete nulls the tasks milestone', async () => {
    const { id } = await mk();
    const c = await mkCard();
    await ok('cards/update', { id: c, milestoneId: id });
    await ok('milestones/delete', { id });
    expect(card(c).milestone_id).toBeNull();
  });

  it('daily job: 201 empty open milestones do not starve one with tasks', async () => {
    const ins = db.prepare("INSERT INTO milestones (id, account_seq, name, color, is_global, created_at) VALUES (?,?,?,?,1,0)");
    db.exec('BEGIN');
    for (let i = 0; i < 201; i++) ins.run(`empty${i}`, 100 + i, 'E', 'green');
    db.exec('COMMIT');
    const { id } = await mk();
    await ok('cards/update', { id: await mkCard(), milestoneId: id });
    db.prepare('DELETE FROM milestone_progress').run();
    runJob(db, new LiveHub(db), (ctx) => runDailyProgress(ctx));
    expect(progress(id)).toMatchObject({ total_count: 1 });
  });

  it('a zone without a milestone is invalid_zone; a zone-only change is a milestoneZone history kind', async () => {
    const m = (await mk()).id as string;
    const z = (await ok('milestoneZones/create', { milestoneId: m, name: 'Z' })).id as string;
    const c = await mkCard();
    await fail('cards/update', { id: c, milestoneId: null, milestoneZoneId: z }, 400, 'invalid_zone');
    await ok('cards/update', { id: c, milestoneId: m });
    await ok('cards/update', { id: c, milestoneZoneId: z });
    const h = db.prepare('SELECT changes_json j FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(c) as any;
    expect(JSON.parse(h.j)).toEqual([{ kind: 'milestoneZone', from: null, to: z }]);
  });

  it('feature off blocks changes but still allows clearing', async () => {
    const m = (await mk()).id as string;
    const z = (await ok('milestoneZones/create', { milestoneId: m, name: 'Z' })).id as string;
    const c = await mkCard();
    await ok('cards/update', { id: c, milestoneId: m });
    await ok('decks/update', { id: deckId, autoMilestoneId: m });
    await ok('accounts/update', { settings: { milestonesEnabled: false } });
    await fail('milestones/update', { id: m, name: 'X', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] }, 409, 'feature_disabled');
    await fail('milestones/setPinned', { id: m, isPinned: true }, 409, 'feature_disabled');
    await fail('milestoneZones/update', { id: z, name: 'Y' }, 409, 'feature_disabled');
    await fail('cards/update', { id: c, milestoneZoneId: z }, 409, 'feature_disabled');
    await fail('decks/update', { id: deckId, autoMilestoneId: m }, 409, 'feature_disabled');
    await ok('cards/update', { id: c, milestoneId: null });
    await ok('decks/update', { id: deckId, autoMilestoneId: null });
  });

  it('bulk milestone changes send no per-task events and recount once per command', async () => {
    const m = (await mk()).id as string;
    const z = (await ok('milestoneZones/create', { milestoneId: m, name: 'Z' })).id as string;
    for (let i = 0; i < 5; i++) await ok('cards/update', { id: await mkCard(), milestoneId: m, milestoneZoneId: z });
    const user = { id: (db.prepare('SELECT id FROM users').get() as any).id } as any;
    const events = (name: string, payload: unknown) => run(db, user, name, payload).events;
    expect(events('milestoneZones/delete', { id: z }).filter((e) => e.model === 'card')).toHaveLength(0);
    expect(events('milestones/delete', { id: m }).filter((e) => e.model === 'card')).toHaveLength(0);
    // recount once: a bulk status change over 3 cards emits one progress event
    const m2 = (await mk()).id as string;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const c = await mkCard(); await ok('cards/update', { id: c, milestoneId: m2 }); ids.push(c); }
    const ev = events('cards/bulkUpdate', { ids, status: 'done' });
    expect(ev.filter((e) => e.model === 'milestoneProgress')).toHaveLength(1);
  });
});

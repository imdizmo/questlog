import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { runJob, runRollover, startScheduler } from '../server/jobs';
import { runEndsAt, runLabel, runWindow } from '../shared/schedule';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;
let projectId: string;
let deckId: string;
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
const cfgBody = (extra: object = {}) => ({
  name: 'RT', runLabelTemplate: 'Sprint %RUN_NR%', color: 'green', upcomingSprints: 2, sprintDurationWeeks: 2, sprintStartDate: '2026-11-14',
  moveOnFinish: [], projectIds: [projectId], isGlobal: false, endHour: 24, endHourTimezone: 'Europe/Rome', ...extra,
});
const ago = (n: number) => (globalThis as any).Temporal.Now.plainDateISO().subtract({ days: n }).toString() as string;
const mk = (extra: object = {}) => ok('sprints/createConfig', cfgBody(extra));
const sprintsOf = (cfg: string) => db.prepare('SELECT * FROM sprints WHERE config_id=? ORDER BY run_nr').all(cfg) as any[];
const tick = (now: number) => runJob(db, hub, (ctx) => runRollover(ctx, now));

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  db.prepare("UPDATE account SET settings_json = json_set(settings_json, '$.sprintsEnabled', json('true'))").run(); // new workspaces start with sprints off
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('schedule helpers', () => {
  it('labels and windows', () => {
    expect(runLabel('Sprint %RUN_NR%', 3)).toBe('Sprint 3');
    expect(runWindow('2026-11-14', 1, 2)).toEqual({ startDay: '2026-11-14', endDay: '2026-11-27' });
    expect(runWindow('2026-11-14', 2, 2)).toEqual({ startDay: '2026-11-28', endDay: '2026-12-11' });
  });
  it('run end instant', () => {
    expect(runEndsAt('2026-11-27', 24, 'Europe/Rome')).toBe(Date.UTC(2026, 10, 27, 23, 0));
    expect(runEndsAt('2027-03-27', 24, 'Europe/Rome')).toBe(Date.UTC(2027, 2, 27, 23, 0));
    expect(runEndsAt('2027-03-28', 24, 'Europe/Rome')).toBe(Date.UTC(2027, 2, 28, 22, 0));
    expect(runEndsAt('2026-11-27', 17, 'Europe/Rome')).toBe(Date.UTC(2026, 10, 27, 16, 0));
  });
});

describe('createConfig', () => {
  it('generates the upcoming runs with plan_seq numbers', async () => {
    await ok('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] });
    const seqAfterMilestone = (db.prepare('SELECT plan_seq s FROM account').get() as any).s;
    const res = await mk();
    expect(res.sprints.map((s: any) => s.accountSeq)).toEqual([seqAfterMilestone + 1, seqAfterMilestone + 2]);
    const rows = sprintsOf(res.id);
    expect(rows.map((r) => [r.label, r.start_day, r.end_day, r.run_nr])).toEqual([
      ['Sprint 1', '2026-11-14', '2026-11-27', 1], ['Sprint 2', '2026-11-28', '2026-12-11', 2]]);
    expect(rows[0].ends_at).toBe(Date.UTC(2026, 10, 27, 23, 0));
  });
  it('validates', async () => {
    await fail('sprints/createConfig', cfgBody({ runLabelTemplate: 'Sprint' }), 400);
    for (const w of [0, 9, 11, 13]) await fail('sprints/createConfig', cfgBody({ sprintDurationWeeks: w }), 400);
    for (const u of [0, 7, 9, 11, 16]) await fail('sprints/createConfig', cfgBody({ upcomingSprints: u }), 400);
    await fail('sprints/createConfig', cfgBody({ name: 'A1' }), 400);
    await fail('sprints/createConfig', cfgBody({ sprintStartDate: ago(400) }), 400);
    const r = await dispatch('sprints/createConfig', cfgBody({ runLabelTemplate: 'Sprint' }));
    expect(JSON.stringify(r.json())).toContain('Add at least one variable');
    await fail('sprints/createConfig', cfgBody({ name: 'ABCDEF' }), 400);
    await fail('sprints/createConfig', cfgBody({ endHourTimezone: 'Nope/Zone' }), 400);
    await fail('sprints/createConfig', cfgBody({ projectIds: [] }), 400, 'project_required');
  });
  it('accepts the wider sets and dedupes moveOnFinish', async () => {
    for (const w of [10, 12]) await mk({ sprintDurationWeeks: w, upcomingSprints: 1 });
    for (const u of [8, 15]) await mk({ upcomingSprints: u });
    const c = await mk({ moveOnFinish: ['blocked', 'blocked'] });
    expect(JSON.parse((db.prepare('SELECT move_on_finish_json j FROM sprint_configs WHERE id=?').get(c.id) as any).j)).toEqual(['blocked']);
  });
  it('feature off gives 409, but clearing a task sprint is still allowed', async () => {
    const cfg = await mk();
    const c = await mkCard();
    await ok('cards/update', { id: c, sprintId: cfg.sprints[0].id });
    const s = (db.prepare('SELECT settings_json s FROM account').get() as any).s;
    db.prepare('UPDATE account SET settings_json=?').run(JSON.stringify({ ...JSON.parse(s), sprintsEnabled: false }));
    await fail('sprints/createConfig', cfgBody(), 409, 'feature_disabled');
    await fail('cards/update', { id: c, sprintId: cfg.sprints[1].id }, 409, 'feature_disabled');
    await ok('cards/update', { id: c, sprintId: null });
    expect(card(c).sprint_id).toBeNull();
  });
  it('needs manage rights', async () => {
    const m = await mkUser('Mem', [projectId]);
    await fail('sprints/createConfig', cfgBody(), 403, undefined, m.cookie);
    await fail('sprints/createConfig', cfgBody({ isGlobal: true, projectIds: [] }), 403, undefined, m.cookie);
    await mk({ isGlobal: true, projectIds: [] });
  });
});

describe('tasks and sprints', () => {
  it('assigns within scope, rejects other projects, records history and progress', async () => {
    const cfg = await mk();
    const sid = cfg.sprints[0].id;
    const c = await mkCard();
    await ok('cards/update', { id: c, sprintId: sid });
    expect(card(c).sprint_id).toBe(sid);
    const p = db.prepare('SELECT * FROM sprint_progress WHERE sprint_id=? AND project_id=?').get(sid, projectId) as any;
    expect(p.total_count).toBe(1);
    const h = db.prepare('SELECT changes_json j FROM card_history WHERE card_id=? ORDER BY version DESC').all(c) as any[];
    expect(JSON.parse(h[0].j)).toContainEqual({ kind: 'sprint', from: null, to: sid });
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    const c2 = await mkCard(d2);
    await fail('cards/update', { id: c2, sprintId: sid }, 400, 'sprint_project');
    await fail('cards/update', { id: c, sprintId: 'nope' }, 404);
  });
  it('a list move to an uncovered project clears the sprint quietly', async () => {
    const cfg = await mk();
    const c = await mkCard();
    await ok('cards/update', { id: c, sprintId: cfg.sprints[0].id });
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    await ok('cards/update', { id: c, deckId: d2 });
    expect(card(c).sprint_id).toBeNull();
  });
  it('snapshot scopes configs, runs and progress to what the viewer can see', async () => {
    const cfg = await mk({ moveOnFinish: ['blocked', 'undone'] });
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(p2);
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    const other = await mk({ name: 'OTH', projectIds: [p2] });
    const c2 = await mkCard(d2);
    await ok('cards/update', { id: c2, sprintId: other.sprints[0].id });
    const u = await mkUser('Vis', [projectId]);
    const s = await snap(u.cookie);
    expect(s.sprintConfigs.map((c: any) => c.id)).toEqual([cfg.id]);
    expect(s.sprintConfigs[0].moveOnFinish).toEqual(['blocked', 'undone']);
    expect(s.sprints.map((x: any) => x.id).sort()).toEqual(cfg.sprints.map((x: any) => x.id).sort());
    expect(s.sprintProgress.every((p: any) => p.projectId === projectId)).toBe(true);
    const o = await snap(owner);
    expect(o.sprintConfigs).toHaveLength(2);
    expect(o.sprintProgress.some((p: any) => p.projectId === p2)).toBe(true);
  });
});

describe('updateConfig and archiveConfig', () => {
  it('re-times unstarted runs and leaves started ones alone', async () => {
    const past = await mk({ sprintStartDate: ago(60) });
    const before = sprintsOf(past.id);
    await ok('sprints/updateConfig', { id: past.id, ...cfgBody({ sprintStartDate: ago(60), runLabelTemplate: 'X %RUN_NR%', sprintDurationWeeks: 1 }) });
    expect(sprintsOf(past.id).map((r) => [r.label, r.start_day, r.end_day])).toEqual(before.map((r) => [r.label, r.start_day, r.end_day]));
    const fut = await mk({ sprintStartDate: '2999-01-01' });
    await ok('sprints/updateConfig', { id: fut.id, ...cfgBody({ sprintStartDate: '2999-02-01', runLabelTemplate: 'X %RUN_NR%', sprintDurationWeeks: 1 }) });
    expect(sprintsOf(fut.id).map((r) => [r.label, r.start_day, r.end_day])).toEqual([
      ['X 1', '2999-02-01', '2999-02-07'], ['X 2', '2999-02-08', '2999-02-14']]);
  });
  it('scope shrink drops tasks of uncovered projects from the runs', async () => {
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    const cfg = await mk({ projectIds: [projectId, p2] });
    const a = await mkCard(); const b = await mkCard(d2);
    for (const c of [a, b]) await ok('cards/update', { id: c, sprintId: cfg.sprints[0].id });
    await ok('sprints/updateConfig', { id: cfg.id, ...cfgBody({ projectIds: [projectId] }) });
    expect(card(a).sprint_id).toBe(cfg.sprints[0].id);
    expect(card(b).sprint_id).toBeNull();
    const row = db.prepare('SELECT total_count t FROM sprint_progress WHERE sprint_id=? AND project_id=?').get(cfg.sprints[0].id, p2) as any;
    expect(row.t).toBe(0);
  });
  it('archived configs get no new runs', async () => {
    const cfg = await mk();
    await ok('sprints/archiveConfig', { id: cfg.id });
    const first = sprintsOf(cfg.id)[0];
    tick(first.ends_at);
    expect(sprintsOf(cfg.id)).toHaveLength(2);
    expect(sprintsOf(cfg.id)[0].is_finished).toBe(1);
  });
});

describe('rollover', () => {
  it('rollover once: finishes run 1 once, adds run 3 once, keeps 2 upcoming', async () => {
    const cfg = await mk();
    const r1 = sprintsOf(cfg.id)[0];
    tick(r1.ends_at - 1);
    expect(sprintsOf(cfg.id).map((r) => r.is_finished)).toEqual([0, 0]);
    tick(r1.ends_at);
    tick(r1.ends_at);
    const rows = sprintsOf(cfg.id);
    expect(rows.map((r) => [r.run_nr, r.is_finished])).toEqual([[1, 1], [2, 0], [3, 0]]);
    expect(rows[2].label).toBe('Sprint 3');
    expect(rows[2].start_day).toBe('2026-12-12');
  });
  it('carry over: blocked moves, in review and done stay', async () => {
    const cfg = await mk({ moveOnFinish: ['blocked'] });
    const [r1, r2] = sprintsOf(cfg.id);
    const blocked = await mkCard(); const review = await mkCard(); const done = await mkCard(); const plain = await mkCard();
    for (const c of [blocked, review, done, plain]) await ok('cards/update', { id: c, sprintId: r1.id });
    await ok('resolvables/create', { cardId: blocked, context: 'block', content: 'b' });
    await ok('resolvables/create', { cardId: review, context: 'review', content: 'r' });
    await ok('cards/update', { id: done, status: 'done' });
    tick(r1.ends_at);
    expect(card(blocked).sprint_id).toBe(r2.id);
    expect(card(review).sprint_id).toBe(r1.id);
    expect(card(done).sprint_id).toBe(r1.id);
    expect(card(plain).sprint_id).toBe(r1.id);
    const h = db.prepare('SELECT changes_json j, changer_id c FROM card_history WHERE card_id=? ORDER BY version DESC').get(blocked) as any;
    expect(JSON.parse(h.j)).toContainEqual({ kind: 'sprint', from: r1.id, to: r2.id, by: 'system' });
    expect(h.c).toBe('system');
    const prog = db.prepare('SELECT total_count t FROM sprint_progress WHERE sprint_id=? AND project_id=? ORDER BY day DESC').get(r2.id, projectId) as any;
    expect(prog.t).toBe(1);
  });
  it('review and undone filters', async () => {
    const cfg = await mk({ moveOnFinish: ['review', 'undone'] });
    const [r1, r2] = sprintsOf(cfg.id);
    const blocked = await mkCard(); const review = await mkCard(); const plain = await mkCard();
    for (const c of [blocked, review, plain]) await ok('cards/update', { id: c, sprintId: r1.id });
    await ok('resolvables/create', { cardId: blocked, context: 'block', content: 'b' });
    await ok('resolvables/create', { cardId: review, context: 'review', content: 'r' });
    tick(r1.ends_at);
    expect(card(review).sprint_id).toBe(r2.id);
    expect(card(plain).sprint_id).toBe(r2.id);
    expect(card(blocked).sprint_id).toBe(r1.id);
  });
  it('missed rollovers finish runs in order and keep 2 upcoming', async () => {
    const cfg = await mk();
    const r1 = sprintsOf(cfg.id)[0];
    const now = r1.ends_at + 35 * 86400e3;
    tick(now); tick(now);
    const rows = sprintsOf(cfg.id);
    expect(rows.slice(0, 2).map((r) => r.is_finished)).toEqual([1, 1]);
    expect(rows.filter((r) => !r.is_finished).length).toBe(2);
    expect(rows.map((r) => r.run_nr)).toEqual([...rows.keys()].map((i) => i + 1));
  });
  it('moves at most 500 tasks per tick and keeps the run unfinished until done', async () => {
    const cfg = await mk({ moveOnFinish: ['undone'] });
    const [r1, r2] = sprintsOf(cfg.id);
    const first = await mkCard();
    const cols = Object.keys(card(first)).filter((k) => k !== 'id' && k !== 'seq');
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<509)
      INSERT INTO cards (id, seq, ${cols.join(',')}) SELECT 'bulk' || i, 10000 + i, ${cols.map((c) => 'c.' + c).join(',')} FROM n, cards c WHERE c.id=?`).run(first);
    db.prepare('UPDATE cards SET sprint_id=? WHERE deck_id=?').run(r1.id, deckId);
    const total = (db.prepare('SELECT COUNT(*) n FROM cards WHERE sprint_id=?').get(r1.id) as any).n;
    expect(total).toBe(510);
    tick(r1.ends_at);
    expect((db.prepare('SELECT COUNT(*) n FROM cards WHERE sprint_id=?').get(r2.id) as any).n).toBe(500);
    expect(sprintsOf(cfg.id)[0].is_finished).toBe(0);
    tick(r1.ends_at);
    expect((db.prepare('SELECT COUNT(*) n FROM cards WHERE sprint_id=?').get(r2.id) as any).n).toBe(510);
    expect(sprintsOf(cfg.id)[0].is_finished).toBe(1);
  });
  it('the scheduler runs the rollover', async () => {
    const cfg = await mk();
    const r1 = sprintsOf(cfg.id)[0];
    const stop = startScheduler(db, hub, { intervalMs: 5, now: () => r1.ends_at });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(sprintsOf(cfg.id)[0].is_finished).toBe(1);
  });
});

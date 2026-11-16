import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { runJob, runRollover } from '../server/jobs';
import { LiveHub } from '../server/live';
import { dispatch as run } from '../server/dispatch';
import { userRow } from '../server/commands/rows';
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
const mkUser = async (name: string, access: string[] = [], role = 'member') => {
  const id = newId();
  const email = `${name}@x.io`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, ?)").run(id, role);
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

const sprintRows = (c: string) => db.prepare('SELECT * FROM sprints WHERE config_id=? ORDER BY run_nr').all(c) as any[];
/** Runs a command as the owner directly, to see the events it emits. */
const events = (name: string, payload: unknown) => run(db, userRow(db, (db.prepare("SELECT id FROM users WHERE email='o@x.io'").get() as any).id) as any, name, payload).events;
const liveRoute = (model: string, row: object) => (new LiveHub(db) as any).route({ model, op: 'upsert', row });

describe('list default view', () => {
  it('lists/update stores preferredOrder canonicalised and emits the list', async () => {
    const evs = events('decks/update', {
      id: deckId,
      preferredOrder: { prop: 'priority', isReversed: true, mode: 'tableView', secondary: [{ prop: 'priority', isReversed: false }, { prop: 'effort', isReversed: false }, { prop: 'manual', isReversed: false }] },
    });
    const stored = { prop: 'priority', isReversed: true, mode: 'tableView', secondary: [{ prop: 'effort', isReversed: false }] };
    expect(JSON.parse((db.prepare('SELECT preferred_order FROM decks WHERE id=?').get(deckId) as any).preferred_order)).toEqual(stored);
    const ev = evs.find((e) => e.model === 'deck') as any;
    expect(ev.row.preferredOrder).toEqual(stored);
    expect((await snap(owner)).decks.find((d: any) => d.id === deckId).preferredOrder).toEqual(stored);
    await ok('decks/update', { id: deckId, preferredOrder: null });
    expect((await snap(owner)).decks.find((d: any) => d.id === deckId).preferredOrder).toBeNull();
  });
  it('rejects malformed views', async () => {
    const v = { prop: 'priority', isReversed: false, mode: 'miniCard', secondary: null };
    await fail('decks/update', { id: deckId, preferredOrder: { ...v, prop: 'nope' } }, 400);
    await fail('decks/update', { id: deckId, preferredOrder: { ...v, mode: 'grid' } }, 400);
    const six = ['effort', 'status', 'sprint', 'milestone', 'tags', 'assignee'].map((prop) => ({ prop, isReversed: false }));
    await fail('decks/update', { id: deckId, preferredOrder: { ...v, secondary: six } }, 400);
  });
  it('an observer cannot save a list default view (403)', async () => {
    const ob = await mkUser('obs', [projectId], 'observer');
    await fail('decks/update', { id: deckId, preferredOrder: { prop: 'effort', isReversed: false, mode: 'miniCard', secondary: null } }, 403, undefined, ob.cookie);
  });
});

describe('saved searches', () => {
  const tokens = [{ category: 'status', value: 'started', isNegated: false }, { category: 'priority', value: 'a', isNegated: true, op: 'eq' }];
  it('search/save returns an id; the snapshot of another user has no savedSearches from me; live routes the row only to me', async () => {
    const { id } = await ok('search/save', { tokens, forceOr: true });
    expect(typeof id).toBe('string');
    const mine = (await snap(owner)).savedSearches;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id, tokens, forceOr: true });
    const other = await mkUser('bob', [projectId]);
    expect((await snap(other.cookie)).savedSearches).toEqual([]);
    const ev = events('search/save', { tokens: [], forceOr: false }).find((e) => e.model === 'savedSearch') as any;
    expect(ev.op).toBe('upsert');
    expect(liveRoute('savedSearch', ev.row)).toEqual({ to: 'user', userId: ev.row.userId });
    expect(ev.row.userId).toBe((mine[0]).userId);
  });
  it('rejects bad tokens', async () => {
    const t = { category: 'status', value: 'x', isNegated: false };
    await fail('search/save', { tokens: Array(21).fill(t), forceOr: false }, 400);
    await fail('search/save', { tokens: [{ ...t, value: 'x'.repeat(201) }], forceOr: false }, 400);
    await fail('search/save', { tokens: [{ ...t, category: 'c'.repeat(41) }], forceOr: false }, 400);
    // strict shapes: unknown category, value outside the category's set, op on a category that does not compare
    await fail('search/save', { tokens: [{ category: 'bogus', value: null, isNegated: false }], forceOr: false }, 400, 'invalid_payload');
    await fail('search/save', { tokens: [{ category: 'due', value: 'tomorrow', isNegated: false }], forceOr: false }, 400, 'invalid_payload');
    await fail('search/save', { tokens: [{ category: 'deck', value: null, isNegated: false }], forceOr: false }, 400, 'invalid_payload');
    await fail('search/save', { tokens: [{ category: 'owner', value: null, isNegated: false, op: 'gte' }], forceOr: false }, 400, 'invalid_payload');
    expect((await snap(owner)).savedSearches).toEqual([]);
    // effort accepts any finite non-negative number, not just small decimals
    for (const value of ['0.125', '10000', '1e-7', null]) {
      await ok('search/save', { tokens: [{ category: 'effort', value, isNegated: false, op: 'gte' }], forceOr: false });
    }
    for (const value of ['-1', 'abc', '', 'Infinity', '1'.repeat(21)]) {
      await fail('search/save', { tokens: [{ category: 'effort', value, isNegated: false }], forceOr: false }, 400, 'invalid_payload');
    }
  });
  it("search/delete of someone else's search → 404; the owner deletes and the event carries routing keys", async () => {
    const { id } = await ok('search/save', { tokens, forceOr: false });
    const bob = await mkUser('bob', [projectId]);
    await fail('search/delete', { id }, 404, 'not_found', bob.cookie);
    expect(db.prepare('SELECT COUNT(*) n FROM saved_searches').get()).toEqual({ n: 1 });
    const ev = events('search/delete', { id }).find((e) => e.model === 'savedSearch') as any;
    expect(ev).toMatchObject({ op: 'remove', row: { id } });
    expect(liveRoute('savedSearch', ev.row)).toEqual({ to: 'user', userId: ev.row.userId });
  });
  it('51st saved search → 409 limit_reached', async () => {
    for (let i = 0; i < 50; i++) await ok('search/save', { tokens: [], forceOr: false });
    await fail('search/save', { tokens: [], forceOr: false }, 409, 'limit_reached');
    const bob = await mkUser('bob', [projectId]);
    await ok('search/save', { tokens: [], forceOr: false }, bob.cookie);
  });
});

describe('run carry-over fields', () => {
  it('rollover increments carryCount and sets sprintJoinedAt', async () => {
    const cfg = await ok('sprints/createConfig', cfgBody({ moveOnFinish: ['undone'] }));
    const [r1, r2] = sprintRows(cfg.id);
    const a = await mkCard(); const b = await mkCard(); const done = await mkCard();
    for (const c of [a, b, done]) await ok('cards/update', { id: c, sprintId: r1.id });
    await ok('cards/update', { id: done, status: 'done' });
    expect(card(a).carry_count).toBe(0);
    expect(card(a).sprint_joined_at).not.toBeNull();
    const at = r1.ends_at + 5;
    tick(at);
    for (const c of [a, b]) expect(card(c)).toMatchObject({ sprint_id: r2.id, carry_count: 1, sprint_joined_at: at });
    expect(card(done)).toMatchObject({ sprint_id: r1.id, carry_count: 0 });
    const snapCard = (await snap(owner)).cards.find((c: any) => c.id === a);
    expect(snapCard).toMatchObject({ carryCount: 1, sprintJoinedAt: at });
    tick(r2.ends_at + 5);
    expect(card(a).carry_count).toBe(2);
  });
  it('manual sprint change resets carryCount', async () => {
    const cfg = await mk();
    const [r1, r2] = sprintRows(cfg.id);
    const c = await mkCard();
    await ok('cards/update', { id: c, sprintId: r1.id });
    db.prepare('UPDATE cards SET carry_count=3 WHERE id=?').run(c);
    const before = Date.now();
    await ok('cards/update', { id: c, sprintId: r2.id });
    expect(card(c).carry_count).toBe(0);
    expect(card(c).sprint_joined_at).toBeGreaterThanOrEqual(before);
    db.prepare('UPDATE cards SET carry_count=2 WHERE id=?').run(c);
    await ok('cards/update', { id: c, sprintId: null });
    expect(card(c)).toMatchObject({ carry_count: 0, sprint_joined_at: null });
  });
  it('bulk sprint set resets carryCount like update; clearing zeroes both', async () => {
    const cfg = await mk();
    const [r1] = sprintRows(cfg.id);
    const a = await mkCard(); const b = await mkCard();
    for (const c of [a, b]) { await ok('cards/update', { id: c, sprintId: r1.id }); db.prepare('UPDATE cards SET carry_count=4, sprint_joined_at=1 WHERE id=?').run(c); }
    await ok('cards/bulkUpdate', { ids: [a, b], sprintId: null });
    for (const c of [a, b]) expect(card(c)).toMatchObject({ sprint_id: null, carry_count: 0, sprint_joined_at: null });
    const before = Date.now();
    await ok('cards/bulkUpdate', { ids: [a, b], sprintId: r1.id });
    for (const c of [a, b]) { expect(card(c).carry_count).toBe(0); expect(card(c).sprint_joined_at).toBeGreaterThanOrEqual(before); }
  });
  it('updateConfig dropping a project resets carry fields on the tasks it removes from runs', async () => {
    const p2 = (await ok('projects/create', { name: 'P2' })).id;
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    const cfg = await mk({ projectIds: [projectId, p2] });
    const [r1] = sprintRows(cfg.id);
    const keep = await mkCard(); const drop = await mkCard(d2);
    for (const c of [keep, drop]) { await ok('cards/update', { id: c, sprintId: r1.id }); db.prepare('UPDATE cards SET carry_count=2 WHERE id=?').run(c); }
    await ok('sprints/updateConfig', { id: cfg.id, ...cfgBody({ projectIds: [projectId] }) });
    expect(card(drop)).toMatchObject({ sprint_id: null, carry_count: 0, sprint_joined_at: null });
    expect(card(keep)).toMatchObject({ sprint_id: r1.id, carry_count: 2 });
  });
});

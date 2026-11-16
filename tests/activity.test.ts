import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { filterOf, filtersOf, mergeProperties, sentence, type ActivityItem, type ActivityLookup } from '../shared/activity';
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
const feed = async (qs: string, cookie = owner) => app.inject({ method: 'GET', url: `/api/activity?${qs}`, headers: hdr(cookie) });
const feedOk = async (qs: string, cookie = owner) => {
  const r = await feed(qs, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: ActivityItem[]; next: string | null };
};
const mkCard = async (title = 'C') => (await ok('cards/create', { content: title, deckId })).id as string;

const lookup: ActivityLookup = {
  card: (id) => (id === 'c1' ? 'Fix door' : null),
  user: (id) => (id === 'u2' ? 'Mia' : 'Someone'),
  deck: () => 'Backlog',
  project: () => 'Game',
  milestone: () => 'a milestone',
  milestoneZone: () => 'a zone',
  sprint: () => 'a run',
  priorityLabel: (p) => ({ a: 'High', b: 'Medium', c: 'Low' } as Record<string, string>)[p],
};
const item = (over: Partial<ActivityItem>): ActivityItem =>
  ({ id: 'x', at: 1000, actorId: 'u1', cardId: 'c1', deckId: 'd', kind: 'history', ...over });

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  db.prepare("UPDATE account SET settings_json = json_set(settings_json, '$.sprintsEnabled', json('true'))").run(); // new workspaces start with sprints off
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('shared/activity', () => {
  it('maps kinds to filters', () => {
    expect(filterOf('created')).toBe('newCards');
    expect(filterOf('blocked')).toBe('workflow');
    expect(filterOf('commentOpened')).toBe('conversations');
    expect(filterOf('file')).toBe('attachments');
    expect(filterOf('title')).toBe('content');
    expect(filterOf('priority')).toBe('properties');
    expect(filtersOf({ kind: 'status', to: 'done' })).toEqual(['workflow', 'done']);
    expect(filtersOf({ kind: 'status', to: 'started' })).toEqual(['workflow']);
  });
  it('sentences', () => {
    expect(sentence(item({ changes: [{ kind: 'priority', to: 'a' }, { kind: 'effort', to: 5 }] }), lookup)).toBe('Priority set to High and Effort set to 5');
    expect(sentence(item({ changes: [{ kind: 'owner', to: 'u2' }] }), lookup)).toBe('Fix door assigned to Mia');
    expect(sentence(item({ changes: [{ kind: 'tags', from: ['x'], to: ['x', 'bug', 'backend'] }] }), lookup)).toBe('Fix door added #bug #backend');
    expect(sentence(item({ changes: [{ kind: 'dueDate', to: '2026-11-20' }] }), lookup)).toBe('Fix door set Due Date to Friday 20 Nov');
    expect(sentence(item({ changes: [{ kind: 'created' }] }), lookup)).toBe('Fix door was created');
    expect(sentence(item({ kind: 'entry', quote: 'hello' }), lookup)).toBe('Fix door wrote hello');
    expect(sentence(item({ kind: 'deckCreated', cardId: null, deckId: 'd', projectId: 'p' }), lookup)).toBe('Created Backlog in Game');
  });
  it('merges only adjacent property items of one task and actor within 5 minutes', () => {
    const a = item({ id: 'a', at: 100_000, changes: [{ kind: 'effort', to: 5 }] });
    const b = item({ id: 'b', at: 40_000, changes: [{ kind: 'priority', to: 'a' }] });
    const far = item({ id: 'c', at: 40_000 - 6 * 60_000, changes: [{ kind: 'priority', to: 'b' }] });
    const content = item({ id: 'd', at: 1, changes: [{ kind: 'content' }] });
    const out = mergeProperties([a, b, far, content]);
    expect(out.map((i) => i.id)).toEqual(['a', 'c', 'd']);
    expect(out[0].changes!.map((c) => c.kind)).toEqual(['priority', 'effort']);
  });
});

describe('GET /api/activity', () => {
  it('merges a priority and an effort edit into one sentence', async () => {
    const c = await mkCard('Door');
    await ok('cards/update', { id: c, priority: 'a' });
    await ok('cards/update', { id: c, effort: 5 });
    const { items } = await feedOk(`deckId=${deckId}&filters=properties`);
    expect(items).toHaveLength(1);
    const labels = { a: 'High', b: 'Medium', c: 'Low' } as Record<string, string>;
    expect(sentence(items[0], { ...lookup, card: () => 'Door', priorityLabel: (p) => labels[p] })).toBe('Priority set to High and Effort set to 5');
  });
  it('filters=done returns only status-to-done items', async () => {
    const c = await mkCard();
    await ok('cards/update', { id: c, status: 'started' });
    await ok('cards/update', { id: c, status: 'done' });
    const { items } = await feedOk(`deckId=${deckId}&filters=done`);
    expect(items).toHaveLength(1);
    expect(items[0].changes).toEqual([{ kind: 'status', from: 'started', to: 'done' }]);
  });
  it('pages 50 + 50 + 20 with a stable cursor, even with identical timestamps', async () => {
    const c = await mkCard();
    const ins = db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json, deck_id, project_id) VALUES (?,?,?,?,?,?,?)');
    const who = (db.prepare('SELECT id FROM users').get() as any).id;
    for (let i = 0; i < 120; i++) ins.run(c, 100 + i, who, 5_000_000 + Math.floor(i / 10), JSON.stringify([{ kind: 'content' }]), deckId, projectId);
    const seen: string[] = [];
    let next: string | null = null;
    const sizes: number[] = [];
    do {
      const p: { items: ActivityItem[]; next: string | null } = await feedOk(`deckId=${deckId}&filters=content${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      sizes.push(p.items.length);
      seen.push(...p.items.map((i) => i.id));
      next = p.next;
    } while (next);
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
  });
  it('caps the page at 50 whatever limit is asked', async () => {
    const c = await mkCard();
    const ins = db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json, deck_id, project_id) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 60; i++) ins.run(c, 100 + i, 'u', 9_000_000 + i, JSON.stringify([{ kind: 'content' }]), deckId, projectId);
    expect((await feedOk(`deckId=${deckId}&limit=500&filters=content`)).items).toHaveLength(50);
  });
  it('404s without access and omits deleted tasks', async () => {
    const id = newId();
    db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, 'v@x.io', 'V', hashPassword('pw'));
    db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, 'observer');
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'v@x.io', password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } });
    expect((await feed(`deckId=${deckId}`, cookieOf(login))).statusCode).toBe(404);
    expect((await feed(`projectId=${projectId}`, cookieOf(login))).statusCode).toBe(404);
    expect((await feed('')).statusCode).toBe(400);
    const c = await mkCard('Gone');
    const keep = await mkCard('Keep');
    await ok('cards/update', { id: c, visibility: 'deleted' });
    const { items } = await feedOk(`deckId=${deckId}`);
    expect(items.some((i) => i.cardId === c)).toBe(false);
    expect(items.some((i) => i.cardId === keep)).toBe(true);
  });
  it('ends with the list creation, and includes comment entries', async () => {
    const c = await mkCard('Door');
    await ok('resolvables/create', { cardId: c, context: 'comment', content: 'looks **good**' });
    const { items, next } = await feedOk(`deckId=${deckId}`);
    expect(next).toBeNull();
    const last = items[items.length - 1];
    expect(last.kind).toBe('deckCreated');
    expect(last.projectId).toBe(projectId);
    expect(sentence(last, { ...lookup, deck: () => 'D', project: () => 'P' })).toBe('Created D in P');
    expect(items.find((i) => i.kind === 'entry')?.quote).toBe('looks **good**');
    expect((await feedOk(`projectId=${projectId}&filters=conversations`)).items.every((i) => i.kind === 'entry' || i.changes!.every((ch) => ch.kind.startsWith('comment')))).toBe(true);
  });
  it('stamps history with the new list on a move', async () => {
    const d2 = (await ok('decks/create', { title: 'D2', projectId })).id;
    const c = await mkCard();
    await ok('cards/update', { id: c, deckId: d2 });
    const rows = db.prepare('SELECT deck_id, project_id, changes_json j FROM card_history WHERE card_id=? ORDER BY version').all(c) as any[];
    expect(rows.map((r) => r.deck_id)).toEqual([deckId, d2]);
    expect(rows[1].project_id).toBe(projectId);
  });
  it('hides a moved task from the old project, and its old list, once it sits in a project the viewer cannot see', async () => {
    const hidden = (await ok('projects/create', { name: 'Hidden' })).id;
    const hiddenDeck = (await ok('decks/create', { title: 'H', projectId: hidden })).id;
    const c = await mkCard('Secret');
    const id = newId();
    db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, 'w@x.io', 'W', hashPassword('pw'));
    db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, 'observer');
    db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(projectId, id);
    const viewer = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'w@x.io', password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
    expect((await feedOk(`deckId=${deckId}`, viewer)).items.some((i) => i.cardId === c)).toBe(true);
    await ok('cards/update', { id: c, deckId: hiddenDeck });
    for (const qs of [`deckId=${deckId}`, `projectId=${projectId}`]) {
      expect((await feedOk(qs, viewer)).items.some((i) => i.cardId === c)).toBe(false);
    }
    expect((await feed(`deckId=${hiddenDeck}`, viewer)).statusCode).toBe(404);
  });
  it('keeps old-list rows for a move within one project', async () => {
    const d2 = (await ok('decks/create', { title: 'D2', projectId })).id;
    const c = await mkCard();
    await ok('cards/update', { id: c, deckId: d2 });
    expect((await feedOk(`deckId=${deckId}`)).items.some((i) => i.cardId === c)).toBe(true);
  });
  it('fills a page from a sparse filter that crosses the 200-row chunk boundary', async () => {
    const c = await mkCard();
    const ins = db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json, deck_id, project_id) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 450; i++) ins.run(c, 100 + i, 'u', 7_000_000 + i, JSON.stringify([i % 150 === 0 ? { kind: 'file', to: `f${i}` } : { kind: 'content' }]), deckId, projectId);
    const r = await feedOk(`deckId=${deckId}&filters=attachments`);
    expect(r.items).toHaveLength(3);
    expect(r.next).toBeNull();
  });
  it('excludes entries on a deleted task', async () => {
    const c = await mkCard('Door');
    await ok('resolvables/create', { cardId: c, context: 'comment', content: 'secret words' });
    await ok('cards/update', { id: c, visibility: 'deleted' });
    expect((await feedOk(`deckId=${deckId}`)).items.some((i) => i.kind === 'entry')).toBe(false);
  });
  it('caps rows scanned per request: a sparse filter returns a partial page with a cursor that keeps paging', async () => {
    const c = await mkCard();
    const ins = db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json, deck_id, project_id) VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 2300; i++) ins.run(c, 100 + i, 'u', 7_000_000 + i, JSON.stringify([i === 0 ? { kind: 'file', to: 'old.png' } : { kind: 'content' }]), deckId, projectId);
    const first = await feedOk(`deckId=${deckId}&filters=attachments`);
    expect(first.items).toHaveLength(0);
    expect(first.next).not.toBeNull();
    let next = first.next; let found: ActivityItem[] = []; let pages = 1;
    while (next && pages++ < 10) {
      const p = await feedOk(`deckId=${deckId}&filters=attachments&before=${encodeURIComponent(next)}`);
      found = found.concat(p.items); next = p.next;
    }
    expect(found).toHaveLength(1);
    expect(next).toBeNull();
  });
});

describe('milestone and run feeds', () => {
  const mkMs = (extra: object = {}) =>
    ok('milestones/create', { name: 'Beta', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId], ...extra });
  const mkUser = async (name: string, access: string[] = []) => {
    const id = newId();
    db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, `${name}@x.io`, name, hashPassword('pw'));
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
    for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${name}@x.io`, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } });
    return { id, cookie: cookieOf(res) };
  };

  it('milestone feed: assigning a task and changing its priority gives both items', async () => {
    const m = await mkMs();
    const c = await mkCard('Door');
    await ok('cards/update', { id: c, milestoneId: m.id });
    await ok('cards/update', { id: c, priority: 'a' });
    const { items } = await feedOk(`milestoneId=${m.id}`);
    const kinds = items.flatMap((i) => (i.changes ?? []).map((x) => x.kind));
    expect(kinds).toContain('milestone');
    expect(kinds).toContain('priority');
    const names = { ...lookup, card: () => 'Door', milestone: (id: string) => (id === m.id ? 'Beta' : 'a milestone') };
    expect(items.map((i) => sentence(i, names)).join('|')).toContain('Door added to Beta');
  });

  it('milestone feed scope: a Limited project task in a global milestone is absent for an outsider', async () => {
    const m = await mkMs({ isGlobal: true, projectIds: [] });
    const secret = (await ok('projects/create', { name: 'Secret' })).id as string;
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(secret);
    const sDeck = (await ok('decks/create', { title: 'S', projectId: secret })).id as string;
    const hidden = (await ok('cards/create', { content: 'Hidden', deckId: sDeck })).id as string;
    const shown = await mkCard('Shown');
    await ok('cards/update', { id: hidden, milestoneId: m.id });
    await ok('cards/update', { id: shown, milestoneId: m.id });
    await ok('resolvables/create', { cardId: hidden, context: 'comment', content: 'classified' });
    const outsider = await mkUser('out', [projectId]);
    const mine = await feedOk(`milestoneId=${m.id}`, outsider.cookie);
    expect(mine.items.some((i) => i.cardId === hidden)).toBe(false);
    expect(mine.items.some((i) => i.cardId === shown)).toBe(true);
    expect((await feedOk(`milestoneId=${m.id}`)).items.some((i) => i.cardId === hidden)).toBe(true);
  });

  it('a milestone the viewer cannot see is 404; both scopes at once is 400', async () => {
    const secret = (await ok('projects/create', { name: 'Secret' })).id as string;
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(secret);
    const m = await mkMs({ projectIds: [secret] });
    const outsider = await mkUser('out2', [projectId]);
    expect((await feed(`milestoneId=${m.id}`, outsider.cookie)).statusCode).toBe(404);
    expect((await feed(`milestoneId=${m.id}&deckId=${deckId}`)).statusCode).toBe(400);
  });

  it('stamps milestone_id on the history row', async () => {
    const m = await mkMs();
    const c = await mkCard('Door');
    await ok('cards/update', { id: c, milestoneId: m.id });
    const row = db.prepare('SELECT milestone_id m FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(c) as { m: string };
    expect(row.m).toBe(m.id);
  });

  it('run feed: history and threads of tasks in the run', async () => {
    await ok('sprints/createConfig', { name: 'RT', runLabelTemplate: 'Sprint %RUN_NR%', color: 'green', upcomingSprints: 1, sprintDurationWeeks: 2, sprintStartDate: '2026-11-14',
      moveOnFinish: [], projectIds: [projectId], isGlobal: false, endHour: 24, endHourTimezone: 'Europe/Rome' });
    const run = db.prepare('SELECT id FROM sprints ORDER BY run_nr LIMIT 1').get() as { id: string };
    const c = await mkCard('Door');
    await ok('cards/update', { id: c, sprintId: run.id });
    await ok('resolvables/create', { cardId: c, context: 'comment', content: 'hello run' });
    const { items } = await feedOk(`sprintId=${run.id}`);
    expect(items.some((i) => i.changes?.some((x) => x.kind === 'sprint'))).toBe(true);
    expect(items.some((i) => i.kind === 'entry')).toBe(true);
    const other = await mkCard('Other');
    await ok('cards/update', { id: other, priority: 'a' });
    expect((await feedOk(`sprintId=${run.id}`)).items.some((i) => i.cardId === other)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { connect, type AddressInfo } from 'node:net';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { HACKNPLAN_BASE } from '../server/importers/hacknplan';
import { ALLOWED_HOSTS } from '../server/integrations/http';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/trello-board.json', import.meta.url), 'utf8'));
let db: Db;
let app: FastifyInstance;
let owner: string;
let projectId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const json = { host: HOST, 'content-type': 'application/json' };
const post = (url: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { ...json, cookie } });
const ok = async (url: string, payload: unknown, cookie = owner) => {
  const r = await post(url, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const mkUser = async (role: string, name: string, email: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: json });
  return { id, cookie: cookieOf(r) };
};
const decksOf = (pid: string) => db.prepare('SELECT * FROM decks WHERE project_id=? ORDER BY sort_index').all(pid) as any[];
const cardsOf = (pid: string) => db.prepare('SELECT c.* FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? ORDER BY c.seq').all(pid) as any[];
const tagsOf = (pid: string) => (JSON.parse((db.prepare('SELECT tags_json t FROM projects WHERE id=?').get(pid) as any).t) as { name: string }[]).map((t) => t.name);
const byTitle = (pid: string, t: string) => cardsOf(pid).find((c) => c.content.startsWith(`# ${t}`));

/** The local HacknPlan mock (set in beforeAll below): buildApp's test-only outbound seam points api.hacknplan.com at it. */
let hacknplanMock = '';
const outbound = () => ({ mocks: hacknplanMock ? { 'api.hacknplan.com': hacknplanMock } : {} });

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], outbound: outbound() });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  owner = cookieOf(r);
  projectId = (await ok('/dispatch/projects/create', { name: 'Imports' })).id;
  await ok('/dispatch/accounts/update', { settings: { dueDateEnabled: true } });
});
afterEach(async () => {
  await app.close();
});

describe('Trello import', () => {
  it('trello fixture → decks per open list, cards, tags, checklist markdown, owner matched by name', async () => {
    const bo = await mkUser('member', 'Bo Painter', 'bo@x.io');
    const r = await ok('/dispatch/imports/trello', { projectId, board: FIXTURE });
    expect(r).toMatchObject({ decks: 2, cards: 3 });
    expect(decksOf(projectId).map((d) => d.title)).toEqual(['Backlog', 'Doing']);
    const cards = cardsOf(projectId);
    expect(cards).toHaveLength(3);
    // Cards follow the list order and their position inside it; archived cards and cards of archived lists are skipped.
    const [backlog, doing] = decksOf(projectId);
    expect(cards.filter((c) => c.deck_id === backlog.id).sort((a, b) => a.sort_index - b.sort_index).map((c) => c.content.split('\n')[0]))
      .toEqual(['# Title screen', '# Lantern sprite']);
    expect(cards.some((c) => c.content.includes('Archived card') || c.content.includes('archived list'))).toBe(false);
    // Labels become project tags (an unnamed label uses its colour).
    expect(tagsOf(projectId)).toEqual(expect.arrayContaining(['art', 'bug', 'blue']));
    const lantern = byTitle(projectId, 'Lantern sprite');
    expect(JSON.parse(lantern.master_tags_json).sort()).toEqual(['art', 'blue']);
    expect(lantern.content).toContain('Glow pass on the lantern.');
    // Checklist items in their position order, as Markdown checkboxes.
    expect(lantern.content).toContain('**Steps**\n- [x] Sketch\n- [ ] Paint glow');
    expect(JSON.parse(lantern.checkbox_stats_json)).toEqual({ checked: 1, total: 2 });
    // Attachments are links only.
    expect(lantern.content).toContain('[glow-ref.png](https://trello.com/1/cards/');
    expect(lantern.assignee_id).toBe(bo.id);
    expect(lantern.due_date).toBe('2030-03-04');
    // No member with that name or email: no owner.
    const door = byTitle(projectId, 'Door does not open');
    expect(door.assignee_id).toBeNull();
    expect(JSON.parse(door.master_tags_json)).toEqual(['bug']);
    // Comments are not imported.
    expect((db.prepare('SELECT COUNT(*) n FROM resolvables').get() as any).n).toBe(0);
    // History as for any created card.
    expect((db.prepare("SELECT COUNT(*) n FROM card_history WHERE changes_json LIKE '%created%'").get() as any).n).toBe(3);
  });

  it('skips due dates when the feature is off', async () => {
    await ok('/dispatch/accounts/update', { settings: { dueDateEnabled: false } });
    await ok('/dispatch/imports/trello', { projectId, board: FIXTURE });
    expect(byTitle(projectId, 'Lantern sprite').due_date).toBeNull();
  });

  it('trello 21 MB → 400', async () => {
    const big = { ...FIXTURE, desc: 'x'.repeat(21 * 1024 * 1024) };
    const r = await post('/dispatch/imports/trello', { projectId, board: big });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('file_too_large');
    expect(cardsOf(projectId)).toHaveLength(0);
    // Broken JSON is refused as such.
    const broken = await post('/dispatch/imports/trello', '{"projectId":');
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toBe('invalid_json');
  });

  it('a streamed body without a length is counted as it arrives', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const body = Readable.from((function* () { yield Buffer.from('{"projectId":"x","board":'); for (let i = 0; i < 21; i++) yield chunk; })());
    const r = await app.inject({ method: 'POST', url: '/dispatch/imports/trello', payload: body as any, headers: { ...json, cookie: owner } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('file_too_large');
  });

  it('an archived project is refused', async () => {
    await ok('/dispatch/projects/update', { id: projectId, isArchived: true });
    const r = await post('/dispatch/imports/trello', { projectId, board: FIXTURE });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('project_archived');
    expect(decksOf(projectId)).toHaveLength(0);
  });

  it('signed out → 401 before the body is read', async () => {
    const r = await app.inject({ method: 'POST', url: '/dispatch/imports/trello', payload: JSON.stringify({ projectId, board: FIXTURE }), headers: json });
    expect(r.statusCode).toBe(401);
  });

  it('the import slot is taken only by people who may import, checked before the body is read', async () => {
    const m = await mkUser('member', 'Mem', 'm@x.io', [projectId]);
    const viewer = await mkUser('observer', 'Obs', 'obs@x.io', [projectId]);
    // A broken body: had it been read, the answer would be invalid_json.
    for (const who of [m.cookie, viewer.cookie]) {
      for (const url of [`/dispatch/imports/trello?projectId=${projectId}`, '/dispatch/imports/trello']) {
        const r = await app.inject({ method: 'POST', url, payload: '{', headers: { ...json, cookie: who } });
        expect([r.statusCode, r.json().error]).toEqual([403, 'forbidden']);
      }
    }
    // The target in the query must be the one in the body.
    const other = (await ok('/dispatch/projects/create', { name: 'Other' })).id;
    const mismatch = await post(`/dispatch/imports/trello?projectId=${other}`, { projectId, board: FIXTURE });
    expect([mismatch.statusCode, mismatch.json().error]).toEqual([400, 'invalid_payload']);
    expect(decksOf(projectId)).toHaveLength(0);
    expect((await post(`/dispatch/imports/trello?projectId=${projectId}`, { projectId, board: FIXTURE })).statusCode).toBe(200);
  });

  it('a body that does not arrive in time drops the connection and frees the import slot', async () => {
    await app.close();
    app = buildApp({ db, hosts: [HOST], importBodyMs: 300, outbound: outbound() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const sock = connect(port, '127.0.0.1');
    sock.on('error', () => {});
    const closed = new Promise<void>((r) => sock.on('close', () => r()));
    sock.write(`POST /dispatch/imports/trello?projectId=${projectId} HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${owner}\r\n`
      + 'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"projectId":');
    await new Promise((r) => setTimeout(r, 100));
    // Still trickling: the slot is held.
    const busy = await post(`/dispatch/imports/trello?projectId=${projectId}`, { projectId, board: FIXTURE });
    expect([busy.statusCode, busy.json().error]).toEqual([409, 'import_running']);
    await closed;
    const r = await post(`/dispatch/imports/trello?projectId=${projectId}`, { projectId, board: FIXTURE });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('member without project management → 403, nothing imported', async () => {
    const m = await mkUser('member', 'Mem', 'm@x.io');
    const r = await post('/dispatch/imports/trello', { projectId, board: FIXTURE }, m.cookie);
    expect(r.statusCode).toBe(403);
    expect(decksOf(projectId)).toHaveLength(0);
  });

  it('too many cards → 400', async () => {
    const list = FIXTURE.lists[0].id;
    const cards = Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, desc: '', closed: false, idList: list, pos: i, idLabels: [], idMembers: [], idChecklists: [], due: null }));
    const r = await post('/dispatch/imports/trello', { projectId, board: { ...FIXTURE, cards } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('too_many_cards');
    expect(cardsOf(projectId)).toHaveLength(0);
  });
});

// ---- HacknPlan: a local mock of the REST API v0 (never the real host) ----
type Hit = { path: string; auth: string | undefined };
let mock: Server;
let hits: Hit[] = [];
const KEY = 'test-key-123';
const HP = {
  project: { id: 42, name: 'Hollow Bell' },
  categories: [{ categoryId: 1, name: 'Programming' }, { categoryId: 2, name: 'Art' }],
  boards: [{ boardId: 10, name: 'Sprint 1', milestoneId: 7 }, { boardId: 11, name: 'Sprint 2', milestoneId: null }],
  milestones: [{ milestoneId: 7, name: 'Alpha', dueDate: '2030-05-01T00:00:00Z' }],
  tags: [{ tagId: 3, name: 'Gameplay' }],
  users: [{ user: { id: 900, username: 'bo', name: 'Bo Painter', email: 'bo@x.io' } }],
  workitems: [
    { workItemId: 100, title: 'Combat', description: 'The fighting loop', isStory: true, category: { categoryId: 1, name: 'Programming' }, board: { boardId: 10, name: 'Sprint 1' },
      importanceLevel: { importanceLevelId: 1, name: 'Urgent' }, estimatedCost: 0, tags: [{ tagId: 3, name: 'Gameplay' }], assignedUsers: [], subTasks: [] },
    { workItemId: 101, title: 'Sword swing', description: '', isStory: false, parentStoryId: 100, category: { categoryId: 1, name: 'Programming' }, board: { boardId: 10, name: 'Sprint 1' },
      importanceLevel: { importanceLevelId: 2, name: 'High' }, estimatedCost: 3, dueDate: '2030-04-02T00:00:00Z',
      tags: [], assignedUsers: [{ user: { id: 900, username: 'bo', name: 'Bo Painter', email: 'bo@x.io' } }],
      subTasks: [{ id: 1, title: 'Animation hook', isCompleted: true }, { id: 2, title: 'Hit box', isCompleted: false }],
      attachments: [{ name: 'swing.gif', url: 'https://files.example.test/swing.gif' }] },
    { workItemId: 102, title: 'Shield art', description: 'Wood and iron', isStory: false, parentStoryId: 100, category: { categoryId: 2, name: 'Art' }, board: { boardId: 11, name: 'Sprint 2' },
      importanceLevel: { importanceLevelId: 4, name: 'Low' }, estimatedCost: 5, tags: [], assignedUsers: [], subTasks: [] },
  ],
};
const PAGE = 2;

/** Keys the mock accepts: plain, one that answers with ~8 MB lists, one that answers slowly, one with a broken page. */
const BIG_KEY = 'big-key', SLOW_KEY = 'slow-key', BAD_KEY = 'bad-page-key';

function route(u: URL, res: ServerResponse) {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = u.pathname.match(/^\/v0\/projects\/(\d+)(?:\/(\w+))?$/);
  if (!m || m[1] !== '42') return send(404, { message: 'not found' });
  const what = m[2];
  if (!what) return send(200, HP.project);
  if (what === 'workitems') {
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(PAGE, Number(u.searchParams.get('limit') ?? PAGE));
    return send(200, { totalCount: HP.workitems.length, offset, limit, items: HP.workitems.slice(offset, offset + limit) });
  }
  if (what in HP) return send(200, (HP as any)[what]);
  send(404, { message: 'not found' });
}

beforeAll(async () => {
  mock = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? '/', 'http://mock');
    hits.push({ path: u.pathname + u.search, auth: req.headers.authorization });
    const key = (req.headers.authorization ?? '').replace(/^ApiKey /, '');
    if (![KEY, BIG_KEY, SLOW_KEY, BAD_KEY].includes(key)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"message":"unauthorized"}');
    }
    // About 8 MB per list response, streamed without a length: three of them pass the 20 MB budget of one import.
    if (key === BIG_KEY && /\/(categories|boards|milestones)$/.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const item = JSON.stringify({ categoryId: 1, boardId: 1, milestoneId: 1, name: 'n'.repeat(100_000) });
      res.write('[');
      for (let i = 0; i < 80; i++) res.write((i ? ',' : '') + item);
      return res.end(']');
    }
    if (key === BAD_KEY && u.pathname.endsWith('/workitems')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('"not a page"');
    }
    if (key === SLOW_KEY) { setTimeout(() => route(u, res), 150); return; }
    route(u, res);
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  hacknplanMock = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hacknplanMock = '';
  await new Promise((r) => mock.close(r));
});

describe('HacknPlan import', () => {
  beforeEach(() => { hits = []; });

  it('talks to api.hacknplan.com by default, a host on the outbound allow-list', () => {
    expect(HACKNPLAN_BASE).toBe('https://api.hacknplan.com/v0');
    expect(ALLOWED_HOSTS).toContain('api.hacknplan.com');
  });

  it('requests go through the outbound client: an unreachable api.hacknplan.com is reported, nothing imported', async () => {
    await app.close();
    hits = [];
    // Point the allowed host at a closed loopback port (offline stand-in for an unreachable HacknPlan).
    app = buildApp({ db, hosts: [HOST], outbound: { mocks: { 'api.hacknplan.com': 'http://127.0.0.1:9' } } });
    const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: 42, groupBy: 'category' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('hacknplan_unavailable');
    expect(hits).toHaveLength(0);
    expect(decksOf(projectId)).toHaveLength(0);
  });

  it('hacknplan against a mock server maps user stories to heroes and subtasks to checklists', async () => {
    const bo = await mkUser('member', 'Bo Painter', 'bo@x.io');
    const r = await ok('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: 42, groupBy: 'category' });
    expect(r).toMatchObject({ decks: 2, cards: 3 });
    expect(hits.every((h) => h.auth === `ApiKey ${KEY}`)).toBe(true);
    expect(hits.filter((h) => h.path.startsWith('/v0/projects/42/workitems'))).toHaveLength(2); // paged
    expect(decksOf(projectId).map((d) => d.title)).toEqual(['Programming', 'Art']);
    const combat = byTitle(projectId, 'Combat');
    const swing = byTitle(projectId, 'Sword swing');
    const shield = byTitle(projectId, 'Shield art');
    // User stories become hero cards, their tasks sub cards.
    expect(swing.parent_card_id).toBe(combat.id);
    expect(shield.parent_card_id).toBe(combat.id);
    // Subtasks become a checklist; attachments are links.
    expect(swing.content).toContain('- [x] Animation hook\n- [ ] Hit box');
    expect(swing.content).toContain('[swing.gif](https://files.example.test/swing.gif)');
    // Importance → priority, estimated cost → effort, due date, assignee who is a member, tags.
    expect([combat.priority, swing.priority, shield.priority]).toEqual(['a', 'a', 'c']);
    expect([swing.effort, shield.effort]).toEqual([3, 5]);
    expect(swing.due_date).toBe('2030-04-02');
    expect(swing.assignee_id).toBe(bo.id);
    expect(JSON.parse(combat.master_tags_json)).toEqual(['gameplay']);
    // Milestones (through the board) become milestones of the project.
    const ms = db.prepare('SELECT * FROM milestones').all() as any[];
    expect(ms.map((m) => [m.name, m.date])).toEqual([['Alpha', '2030-05-01']]);
    expect(swing.milestone_id).toBe(ms[0].id);
    expect(shield.milestone_id).toBeNull();
  });

  it('groups by board', async () => {
    await ok('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: 42, groupBy: 'board' });
    expect(decksOf(projectId).map((d) => d.title)).toEqual(['Sprint 1', 'Sprint 2']);
  });

  it('a wrong key is reported and nothing is imported', async () => {
    const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: 'nope', hpProjectId: 42, groupBy: 'category' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('hacknplan_auth');
    expect(decksOf(projectId)).toHaveLength(0);
  });

  it('checks permission before any request leaves the server', async () => {
    const m = await mkUser('member', 'Mem', 'm@x.io');
    const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: 42, groupBy: 'category' }, m.cookie);
    expect(r.statusCode).toBe(403);
    expect(hits).toHaveLength(0);
  });

  it('one import reads at most 20 MB from HacknPlan in all', async () => {
    const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: BIG_KEY, hpProjectId: 42, groupBy: 'category' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('hacknplan_too_large');
    // Each response alone fits; the third one breaks the shared budget, and no work items are asked for.
    expect(hits.some((h) => h.path.endsWith('/milestones'))).toBe(true);
    expect(hits.some((h) => h.path.includes('/workitems'))).toBe(false);
    expect(decksOf(projectId)).toHaveLength(0);
  });

  it('a page HacknPlan sends in another shape is reported, not a crash', async () => {
    const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: BAD_KEY, hpProjectId: 42, groupBy: 'category' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('hacknplan_unavailable');
  });

  it('one import (or clone) at a time in the workspace → 409 import_running', async () => {
    const slow = post('/dispatch/imports/hacknplan', { projectId, apiKey: SLOW_KEY, hpProjectId: 42, groupBy: 'category' });
    while (!hits.length) await new Promise((r) => setTimeout(r, 5));
    const trello = await post('/dispatch/imports/trello', { projectId, board: FIXTURE });
    expect([trello.statusCode, trello.json().error]).toEqual([409, 'import_running']);
    const second = await post('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: 42, groupBy: 'board' });
    expect([second.statusCode, second.json().error]).toEqual([409, 'import_running']);
    const clone = await post('/dispatch/clone/projects', { projectIds: [projectId], visibility: 'full' });
    expect([clone.statusCode, clone.json().error]).toEqual([409, 'import_running']);
    const first = await slow;
    expect(first.statusCode, first.body).toBe(200);
    expect(decksOf(projectId).map((d) => d.title)).toEqual(['Programming', 'Art']);
    // The slot is free again, also after a failed import.
    expect((await post('/dispatch/imports/hacknplan', { projectId, apiKey: 'nope', hpProjectId: 42, groupBy: 'category' })).statusCode).toBe(400);
    expect((await post('/dispatch/imports/trello', { projectId, board: FIXTURE })).statusCode).toBe(200);
  });

  it('refuses anything but a numeric project id (no paths or hosts from the request)', async () => {
    for (const hp of ['42/../../x', 'http://evil.test/', -1]) {
      const r = await post('/dispatch/imports/hacknplan', { projectId, apiKey: KEY, hpProjectId: hp, groupBy: 'category' });
      expect(r.statusCode).toBe(400);
    }
    expect(hits).toHaveLength(0);
  });
});

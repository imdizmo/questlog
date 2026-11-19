/**
 * "May delete" on the regular command API (/dispatch): a personal token without it can't run a deleting command
 * (Command.deletes, server/dispatch.ts assertTokenMayDelete). Sessions and org tokens are not affected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { callDeletes, registry } from '../server/dispatch';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;
let ownerId: string;
let projectId: string;
let deckId: string;

type Auth = { cookie?: string; bearer?: string };
const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const send = (a: Auth, name: string, payload: unknown) => app.inject({
  method: 'POST', url: `/dispatch/${name}`, payload: payload as any,
  headers: { host: HOST, 'content-type': 'application/json', ...(a.cookie ? { cookie: a.cookie } : {}), ...(a.bearer ? { authorization: `Bearer ${a.bearer}` } : {}) },
});
const ok = async (name: string, payload: unknown, a: Auth = { cookie: owner }) => {
  const r = await send(a, name, payload);
  expect(r.statusCode, `${name} ${r.body}`).toBe(200);
  return r.json().payload;
};
const mkToken = async (input: Record<string, unknown>): Promise<string> =>
  (await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], ...input })).token;
const mkCard = async (content = 'C', d = deckId): Promise<string> => (await ok('cards/create', { content, deckId: d })).id;
const count = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const cardVis = (id: string) => (db.prepare('SELECT visibility v FROM cards WHERE id=?').get(id) as { v: string }).v;
const setting = (s: Record<string, unknown>) => ok('accounts/update', { settings: s });

/** One deleting command: `setup` makes something to delete (as the owner's session), `gone` tells whether it went. */
interface Case { name: string; setup(): Promise<{ payload: unknown; gone(): boolean }> }
const typeCount = (id: string) => () => count('SELECT COUNT(*) n FROM entry_types WHERE id=?', id) === 0;

const CASES: Case[] = [
  { name: 'cards/update', async setup() {
    const id = await mkCard();
    return { payload: { id, visibility: 'deleted' }, gone: () => cardVis(id) === 'deleted' };
  } },
  { name: 'cards/bulkUpdate', async setup() {
    const ids = [await mkCard('A'), await mkCard('B')];
    return { payload: { ids, visibility: 'deleted' }, gone: () => ids.every((i) => cardVis(i) === 'deleted') };
  } },
  { name: 'cards/removeFile', async setup() {
    const cardId = await mkCard();
    const id = newId();
    db.prepare("INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,'a.txt','text/plain',1,0)").run(id, cardId, ownerId);
    return { payload: { fileId: id }, gone: () => count('SELECT COUNT(*) n FROM files WHERE id=?', id) === 0 };
  } },
  { name: 'decks/delete', async setup() {
    const id = (await ok('decks/create', { title: 'Gone', projectId })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM decks WHERE id=?', id) === 0 };
  } },
  { name: 'milestones/delete', async setup() {
    const id = (await ok('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM milestones WHERE id=?', id) === 0 };
  } },
  { name: 'milestoneZones/delete', async setup() {
    const m = (await ok('milestones/create', { name: 'M', date: null, startDate: null, color: 'green', isGlobal: false, projectIds: [projectId] })).id;
    const id = (await ok('milestoneZones/create', { milestoneId: m, name: 'Z' })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM milestone_zones WHERE id=?', id) === 0 };
  } },
  { name: 'projects/delete', async setup() {
    const id = (await ok('projects/create', { name: 'Doomed' })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM projects WHERE id=?', id) === 0 };
  } },
  { name: 'presets/delete', async setup() {
    const id = (await ok('presets/create', { name: 'Bug', data: { content: 'x' } })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM card_presets WHERE id=?', id) === 0 };
  } },
  { name: 'visionBoard/deleteBoard', async setup() {
    const id = (await ok('visionBoard/createBoard', { cardId: await mkCard() })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM vision_boards WHERE id=?', id) === 0 };
  } },
  { name: 'timeTracking/delete', async setup() {
    await setting({ timeTrackingMode: 'manual' });
    const id = newId();
    db.prepare('INSERT INTO time_segments (id,card_id,user_id,started_at,duration_ms,created_at) VALUES (?,?,?,0,60000,0)').run(id, await mkCard(), ownerId);
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM time_segments WHERE id=?', id) === 0 };
  } },
  { name: 'assets/delete', async setup() {
    const id = newId();
    db.prepare("INSERT INTO assets (id,project_id,title,kind,source,created_at,updated_at) VALUES (?,?,'A','picture','uploaded',0,0)").run(id, projectId);
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM assets WHERE id=?', id) === 0 };
  } },
  { name: 'wiki/deleteType', async setup() {
    const id = (await ok('wiki/createType', { projectId, name: `T${newId().slice(-6)}` })).id;
    return { payload: { id }, gone: typeCount(id) };
  } },
  { name: 'wiki/deleteFamily', async setup() {
    const id = (await ok('wiki/createFamily', { projectId, name: `F${newId().slice(-6)}`, color: '#b8862f' })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM entry_families WHERE id=?', id) === 0 };
  } },
  { name: 'wiki/deleteLinkKind', async setup() {
    const id = (await ok('wiki/createLinkKind', { projectId, label: `rel${newId().slice(-6)}`, reverseLabel: 'back', fromTypes: [], toTypes: [] })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM link_kinds WHERE id=?', id) === 0 };
  } },
  { name: 'wiki/removeLink', async setup() {
    const key = `k${newId().slice(-6).toLowerCase()}`;
    await ok('wiki/createLinkKind', { projectId, key, label: key, reverseLabel: 'back', fromTypes: [], toTypes: [] });
    const a = (await ok('wiki/createEntry', { projectId, typeId: null, name: `Wolf ${key}` })).id;
    const b = (await ok('wiki/createEntry', { projectId, typeId: null, name: `Fang ${key}` })).id;
    const id = (await ok('wiki/addLink', { kindKey: key, fromCardId: a, toCardId: b })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM entry_links WHERE id=?', id) === 0 };
  } },
  { name: 'wiki/pruneValues', async setup() {
    const typeId = (await ok('wiki/createType', { projectId, name: `P${newId().slice(-6)}` })).id;
    const cardId = (await ok('wiki/createEntry', { projectId, typeId, name: `Thing ${newId().slice(-6)}` })).id;
    // A stored value of a field the type does not have: prune drops it.
    db.prepare(`UPDATE cards SET fields_json='{"old":1}' WHERE id=?`).run(cardId);
    return { payload: { typeId }, gone: () => (db.prepare('SELECT fields_json f FROM cards WHERE id=?').get(cardId) as { f: string }).f === '{}' };
  } },
  { name: 'sprints/archiveConfig', async setup() {
    await setting({ sprintsEnabled: true });
    const id = (await ok('sprints/createConfig', { name: 'RT', runLabelTemplate: 'S %RUN_NR%', color: 'green', upcomingSprints: 1, sprintDurationWeeks: 2,
      sprintStartDate: '2026-11-14', moveOnFinish: [], projectIds: [projectId], isGlobal: false, endHour: 24, endHourTimezone: 'Europe/Rome' })).id;
    return { payload: { id }, gone: () => count('SELECT COUNT(*) n FROM sprint_configs WHERE id=? AND is_archived=1', id) === 1 };
  } },
  { name: 'journeys/set', async setup() {
    await setting({ workflowMode: 'journeys' });
    const d = (await ok('decks/create', { title: 'J', projectId })).id;
    await ok('journeys/set', { deckId: d, steps: [{ title: 'Concept', assigneeId: null, priority: null, effort: null }] });
    return { payload: { deckId: d, steps: [] }, gone: () => count('SELECT COUNT(*) n FROM journeys WHERE deck_id=?', d) === 0 };
  } },
];

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users').get() as { id: string }).id;
  db.prepare('UPDATE account SET user_api_tokens_enabled=1').run();
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); });

describe('"May delete" on the command API', () => {
  it('every gated command has a case here', () => {
    const gated = Object.entries(registry).filter(([, c]) => c.deletes).map(([n]) => n).sort();
    expect(CASES.map((c) => c.name).sort()).toEqual(gated);
  });

  it('commands that remove something are either gated or reviewed as allowed (must not fail open)', () => {
    // Reviewed, not gated: a person's own rows (saved search, reaction, watch, bookmark, Hand, link ignore), and
    // a project's archive (projects/update, reversible). A new command named like a removal must be flagged `deletes` or added here.
    const allowed = new Set(['search/delete', 'resolvables/removeReaction', 'watchings/removeCard', 'watchings/removeDeck',
      'bookmarks/removeCards', 'handQueue/removeCards', 'cards/removeLinkIgnore',
      // Never reachable by a token at all (TOKEN_DENIED_NAMESPACES).
      'integrations/deleteGitHook', 'guests/remove']);
    const removals = Object.keys(registry).filter((n) => /delete|remove|prune|archive/i.test(n));
    expect(removals.filter((n) => !registry[n].deletes && !allowed.has(n))).toEqual([]);
  });

  it('cards/update and cards/bulkUpdate delete only with visibility "deleted"; journeys/set only with no steps', () => {
    expect(callDeletes(registry['cards/update'], { id: 'x', visibility: 'archived' })).toBe(false);
    expect(callDeletes(registry['cards/update'], { id: 'x', content: '' })).toBe(false);
    expect(callDeletes(registry['cards/bulkUpdate'], { ids: ['x'], status: 'done' })).toBe(false);
    expect(callDeletes(registry['journeys/set'], { deckId: 'd', steps: [{}] })).toBe(false);
  });

  for (const c of CASES) {
    it(`${c.name}: refused for a personal token without "May delete"; allowed with it, for sessions and org tokens`, async () => {
      const plain = await mkToken({ label: 'Plain' });
      const deleter = await mkToken({ label: 'Deleter', mayDelete: true });
      const org = await mkToken({ kind: 'org', label: 'Integration' });

      const t1 = await c.setup();
      const r = await send({ bearer: plain }, c.name, t1.payload);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toEqual({ error: 'token_cannot_delete', data: { command: c.name, message: 'This token can\'t delete. Create a token with "May delete" ticked.' } });
      expect(t1.gone()).toBe(false);
      // The refused token can still do the same thing without deleting.
      await ok(c.name === 'journeys/set' ? 'decks/create' : 'cards/create', c.name === 'journeys/set' ? { title: 'x', projectId } : { content: 'x', deckId }, { bearer: plain });

      await ok(c.name, t1.payload, { bearer: deleter });
      expect(t1.gone()).toBe(true);

      const t2 = await c.setup();
      await ok(c.name, t2.payload, { cookie: owner });
      expect(t2.gone()).toBe(true);

      const t3 = await c.setup();
      await ok(c.name, t3.payload, { bearer: org });
      expect(t3.gone()).toBe(true);
    });
  }

  it('archiving and other edits stay open to a token without "May delete"', async () => {
    const plain = await mkToken({ label: 'Plain' });
    const a = await mkCard('A');
    const b = await mkCard('B');
    await ok('cards/update', { id: a, visibility: 'archived' }, { bearer: plain });
    await ok('cards/bulkUpdate', { ids: [b], status: 'done' }, { bearer: plain });
    await ok('cards/update', { id: b, priority: 'a' }, { bearer: plain });
    expect([cardVis(a), cardVis(b)]).toEqual(['archived', 'default']);
    // A project's archive can be undone, so it is not a delete.
    const p = (await ok('projects/create', { name: 'Shelved' })).id;
    await ok('projects/update', { id: p, isArchived: true }, { bearer: plain });
    await ok('projects/update', { id: p, isArchived: false }, { bearer: plain });
    expect(count('SELECT COUNT(*) n FROM projects WHERE id=? AND is_archived=0', p)).toBe(1);
  });

  it('a project whose cover url fails is removed again for a token without "May delete" too', async () => {
    const plain = await mkToken({ label: 'Plain' });
    const r = await send({ bearer: plain }, 'projects/create', { name: 'Z', coverUrl: 'http://127.0.0.1:9/x.png' });
    expect(r.json().error).toBe('bad_cover_url');
    expect(count("SELECT COUNT(*) n FROM projects WHERE name='Z'")).toBe(0);
  });

  it('a whole batch is refused when one call deletes (MCP batches go through the same check)', async () => {
    const { dispatchAll } = await import('../server/dispatch');
    const { tokenActor } = await import('../server/tokens');
    const plain = await mkToken({ label: 'Plain' });
    const a = await mkCard('A');
    const b = await mkCard('B');
    const actor = tokenActor(db, plain);
    expect(() => dispatchAll(db, actor, [
      { name: 'cards/update', payload: { id: a, content: 'changed' } },
      { name: 'cards/update', payload: { id: b, visibility: 'deleted' } },
    ])).toThrow('token_cannot_delete');
    expect((db.prepare('SELECT content c FROM cards WHERE id=?').get(a) as { c: string }).c).toBe('A');
    expect(cardVis(b)).toBe('default');
  });
});

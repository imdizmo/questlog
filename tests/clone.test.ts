import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const json = { host: HOST, 'content-type': 'application/json' };
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let ownerId: string;
let pid: string;
let deckId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const post = (url: string, payload: unknown, cookie = owner) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { ...json, cookie } });
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await post(`/dispatch/${name}`, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const mkUser = async (role: string, email: string) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: json });
  return { id, cookie: cookieOf(r) };
};
const cardsOf = (projectId: string) => all('SELECT c.* FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? ORDER BY c.seq', projectId);

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `clone-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 1 });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  owner = cookieOf(r);
  ownerId = r.json().user.id;
  pid = (await ok('projects/create', { name: 'Keep' })).id;
  deckId = (await ok('decks/create', { title: 'Levels', projectId: pid })).id;
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  await ok('projects/update', { id: pid, tags: [{ name: 'art', emoji: null }] });
  const ms = (await ok('milestones/create', { name: 'Beta', date: '2030-01-01', startDate: null, color: 'blue', isGlobal: false, projectIds: [pid] })).id as string;
  const hero = (await ok('cards/create', { content: '# Hero', deckId, masterTags: ['art'] })).id as string;
  const sub = (await ok('cards/create', { content: '# Sub', deckId, parentCardId: hero })).id as string;
  await ok('cards/update', { id: hero, milestoneId: ms });
  const up = await app.inject({ method: 'POST', url: `/api/cards/${hero}/files?name=pic.png`, payload: PNG, headers: { host: HOST, cookie: owner, 'content-type': 'image/png' } });
  expect(up.statusCode, up.body).toBe(200);
  const fileId = up.json().id as string;
  const v = one('SELECT content_version v FROM cards WHERE id=?', hero).v;
  await ok('cards/update', { id: hero, content: `# Hero\n\n![pic](/api/files/${fileId})`, contentVersion: v });
  const res = (await ok('resolvables/create', { cardId: hero, context: 'comment', content: 'First!' })).id as string;
  const entry = one('SELECT id FROM resolvable_entries WHERE resolvable_id=?', res).id as string;
  await ok('resolvables/addReaction', { entryId: entry, value: { type: 'emoji', value: '👍' } });
  await ok('watchings/addCard', { cardId: hero });
  await ok('watchings/addDeck', { deckId, userId: ownerId });
  db.prepare('INSERT INTO journeys (id, deck_id, steps, updated_at) VALUES (?,?,?,?)').run(newId(), deckId, JSON.stringify([{ title: 'Step', assigneeId: null, priority: null, effort: null }]), 1);
  db.prepare('INSERT INTO time_segments (id, card_id, user_id, started_at, duration_ms, created_at) VALUES (?,?,?,?,?,?)').run(newId(), hero, ownerId, 1000, 60_000, 1000);
  await ok('handQueue/addCards', { cardIds: [hero], userId: ownerId });
  await ok('bookmarks/addCards', { userId: ownerId, ids: [hero] });
  return { ms, hero, sub, fileId };
}

describe('clone/projects', () => {
  it('clone copies tasks with comments and files, merges an identical milestone, skips hands', async () => {
    const { ms, hero, fileId } = await seed();
    const out = await ok('clone/projects', { projectIds: [pid], visibility: 'limited' });
    expect(out.projects).toHaveLength(1);
    const cid = out.projects[0].id as string;
    const p = one('SELECT * FROM projects WHERE id=?', cid);
    expect(p).toMatchObject({ name: 'Keep (copy)', visibility: 'limited' });
    expect(JSON.parse(p.tags_json).map((t: any) => t.name)).toContain('art');
    // Decks with journeys and subscribers.
    const decks = all('SELECT * FROM decks WHERE project_id=?', cid);
    expect(decks.map((d) => d.title)).toEqual(['Levels']);
    expect(decks[0].id).not.toBe(deckId);
    expect(one('SELECT COUNT(*) n FROM journeys WHERE deck_id=?', decks[0].id).n).toBe(1);
    expect(one('SELECT COUNT(*) n FROM deck_subscriptions WHERE deck_id=?', decks[0].id).n).toBe(1);
    // Cards, hierarchy, tags.
    const cards = cardsOf(cid);
    expect(cards).toHaveLength(2);
    const [h, s] = cards;
    expect(h.id).not.toBe(hero);
    expect(s.parent_card_id).toBe(h.id);
    expect(JSON.parse(h.master_tags_json)).toEqual(['art']);
    // Comments with entries and reactions.
    const rs = all('SELECT * FROM resolvables WHERE card_id=?', h.id);
    expect(rs).toHaveLength(1);
    const es = all('SELECT * FROM resolvable_entries WHERE resolvable_id=?', rs[0].id);
    expect(es.map((e) => e.content)).toEqual(['First!']);
    expect(one('SELECT COUNT(*) n FROM resolvable_reactions WHERE entry_id=?', es[0].id).n).toBe(1);
    // Files: a new row and a copied blob; the content points at the copy.
    const files = all('SELECT * FROM files WHERE card_id=?', h.id);
    expect(files).toHaveLength(1);
    expect(files[0].id).not.toBe(fileId);
    expect(files[0]).toMatchObject({ name: 'pic.png', mime: 'image/png', size: PNG.length });
    expect(Buffer.compare(readFileSync(join(dir, files[0].id)), PNG)).toBe(0);
    expect(existsSync(join(dir, fileId))).toBe(true);
    expect(h.content).toContain(`/api/files/${files[0].id}`);
    expect(h.cover_file_id).toBe(files[0].id);
    // The milestone is the same (identical name, date, colour): merged, now covering the copy too.
    expect(one('SELECT COUNT(*) n FROM milestones').n).toBe(1);
    expect(h.milestone_id).toBe(ms);
    expect(all('SELECT project_id p FROM milestone_projects WHERE milestone_id=?', ms).map((r) => r.p).sort()).toEqual([pid, cid].sort());
    // Subscribers, time entries and history come along.
    expect(one('SELECT COUNT(*) n FROM card_subscriptions WHERE card_id=?', h.id).n).toBe(1);
    expect(one('SELECT COALESCE(SUM(duration_ms),0) t FROM time_segments WHERE card_id=?', h.id).t).toBe(60_000);
    expect(one('SELECT COUNT(*) n FROM card_history WHERE card_id=?', h.id).n).toBe(one('SELECT COUNT(*) n FROM card_history WHERE card_id=?', hero).n);
    expect(one('SELECT project_id p FROM card_history WHERE card_id=? LIMIT 1', h.id).p).toBe(cid);
    // Not copied: hands and bookmarks.
    expect(one('SELECT COUNT(*) n FROM hand_cards WHERE card_id IN (?,?)', h.id, s.id).n).toBe(0);
    expect(one('SELECT COUNT(*) n FROM bookmarks WHERE card_id IN (?,?)', h.id, s.id).n).toBe(0);
    // The source is untouched.
    expect(cardsOf(pid)).toHaveLength(2);
    expect(one('SELECT COUNT(*) n FROM hand_cards WHERE card_id=?', hero).n).toBe(1);
  });

  it('a cloned wiki entry is plain Lore: no type or wiki parent from the source project', async () => {
    const { hero } = await seed();
    const t = (await ok('wiki/createType', { projectId: pid, name: 'Item' })).id as string;
    db.prepare("UPDATE cards SET entry_type_id=?, entry_key='hero', fields_json='{\"a\":1}' WHERE id=?").run(t, hero);
    const cid = (await ok('clone/projects', { projectIds: [pid], visibility: 'limited' })).projects[0].id as string;
    const h = cardsOf(cid).find((c) => c.content.includes('Hero'))!;
    expect(h).toMatchObject({ entry_type_id: null, wiki_parent_id: null, entry_key: 'hero', fields_json: '{"a":1}' });
  });

  it('a milestone with another colour is not merged in', async () => {
    await seed();
    // Same name and date but another colour: not identical, so the copy keeps the blue one.
    await ok('milestones/create', { name: 'Beta', date: '2030-01-01', startDate: null, color: 'red', isGlobal: false, projectIds: [pid] });
    const out = await ok('clone/projects', { projectIds: [pid], visibility: 'full' });
    expect(one('SELECT COUNT(*) n FROM milestones').n).toBe(2);
    const h = cardsOf(out.projects[0].id)[0];
    expect(one('SELECT color FROM milestones WHERE id=?', h.milestone_id).color).toBe('blue');
  });

  it('a lost blob is skipped, other files are still copied', async () => {
    const { fileId } = await seed();
    unlinkSync(join(dir, fileId));
    const out = await ok('clone/projects', { projectIds: [pid], visibility: 'full' });
    expect(all('SELECT f.id FROM files f JOIN cards c ON c.id=f.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id=?', out.projects[0].id)).toHaveLength(0);
    // No stray copies left on disk.
    expect(readdirSync(dir).filter((n) => !n.startsWith('.'))).toEqual([]);
  });

  it('a Limited project keeps its audience, and everyone is told to reload', async () => {
    await ok('projects/update', { id: pid, visibility: 'limited' });
    const m = await mkUser('member', 'acc@x.io');
    await ok('projects/setAccess', { projectId: pid, userId: m.id, access: 'producer' });
    const publish = vi.spyOn(app.hub, 'publish');
    const out = await ok('clone/projects', { projectIds: [pid], visibility: 'limited' });
    const cid = out.projects[0].id as string;
    expect(all('SELECT user_id u, project_role r FROM project_access WHERE project_id=?', cid)).toEqual([{ u: m.id, r: 'producer' }]);
    const events = publish.mock.calls.flatMap((c) => c[1]);
    expect(events).toContainEqual({ model: 'project', op: 'access', row: { id: cid } });
    expect(events.some((e) => e.model === 'card')).toBe(false);
  });

  it('history of a task in a project run does not follow the copy into that run', async () => {
    const { hero } = await seed();
    const sprint = newId();
    db.prepare('UPDATE card_history SET sprint_id=? WHERE card_id=?').run(sprint, hero);
    const out = await ok('clone/projects', { projectIds: [pid], visibility: 'full' });
    const h = cardsOf(out.projects[0].id)[0];
    expect(all('SELECT DISTINCT sprint_id s FROM card_history WHERE card_id=?', h.id)).toEqual([{ s: null }]);
  });

  it('member (non-admin) clone → 403', async () => {
    await seed();
    const m = await mkUser('member', 'm@x.io');
    const r = await post('/dispatch/clone/projects', { projectIds: [pid], visibility: 'full' }, m.cookie);
    expect(r.statusCode).toBe(403);
    expect(one('SELECT COUNT(*) n FROM projects').n).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

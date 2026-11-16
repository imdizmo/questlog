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
const limitProject = (id: string) => db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(id);
const on = () => ok('accounts/update', { settings: { workflowMode: 'journeys' } });
const steps = [
  { title: 'Concept', assigneeId: null as string | null, priority: 'a', effort: 3 },
  { title: 'Build', assigneeId: null as string | null, priority: null, effort: null },
];

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

describe('journeys', () => {
  it('set then apply creates N subtasks with step properties', async () => {
    await on();
    const me = (await snap(owner)).me.id as string;
    await ok('journeys/set', { deckId, steps: [{ ...steps[0], assigneeId: me }, steps[1]] });
    const parent = await mkCard();
    const { cardIds } = await ok('journeys/apply', { cardId: parent });
    expect(cardIds).toHaveLength(2);
    expect(card(cardIds[0])).toMatchObject({ content: '# Concept', parent_card_id: parent, deck_id: deckId, assignee_id: me, priority: 'a', effort: 3 });
    expect(card(cardIds[1])).toMatchObject({ content: '# Build', parent_card_id: parent, priority: null, effort: null });
    const s = await snap(owner);
    expect(s.journeys).toHaveLength(1);
    expect(s.journeys[0]).toMatchObject({ deckId, steps: [expect.objectContaining({ title: 'Concept' }), expect.objectContaining({ title: 'Build' })] });
    // applying again adds the steps again
    const again = await ok('journeys/apply', { cardId: parent });
    expect(again.cardIds).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) n FROM cards WHERE parent_card_id=?').get(parent)).toMatchObject({ n: 4 });
  });

  it('a step owner who lost project access gets an unowned subtask instead of failing the apply', async () => {
    await on();
    limitProject(projectId);
    const u = await mkUser('u', [projectId]);
    await ok('journeys/set', { deckId, steps: [{ ...steps[0], assigneeId: u.id }, steps[1]] });
    db.prepare('DELETE FROM project_access WHERE user_id=?').run(u.id);
    const parent = await mkCard();
    const { cardIds } = await ok('journeys/apply', { cardId: parent });
    expect(cardIds).toHaveLength(2);
    expect(card(cardIds[0])).toMatchObject({ content: '# Concept', assignee_id: null, priority: 'a', effort: 3 });
  });

  it('empty steps delete the journey', async () => {
    await on();
    await ok('journeys/set', { deckId, steps });
    await ok('journeys/set', { deckId, steps: [] });
    expect(db.prepare('SELECT COUNT(*) n FROM journeys').get()).toMatchObject({ n: 0 });
  });

  it('apply in a list without journey is 404; a subtask is refused with 409', async () => {
    await on();
    const c = await mkCard();
    await fail('journeys/apply', { cardId: c }, 404);
    await ok('journeys/set', { deckId, steps });
    const sub = await mkCard(deckId, { parentCardId: c });
    await fail('journeys/apply', { cardId: sub }, 409, 'invalid_hierarchy');
  });

  it('journeys off gives 409', async () => {
    await fail('journeys/set', { deckId, steps }, 409, 'feature_disabled');
    await on();
    await ok('journeys/set', { deckId, steps });
    const c = await mkCard();
    await ok('accounts/update', { settings: { workflowMode: null } });
    await fail('journeys/apply', { cardId: c }, 409, 'feature_disabled');
  });

  it('a member without manage cannot set (403) but can apply', async () => {
    await on();
    const u = await mkUser('u', [projectId]);
    await fail('journeys/set', { deckId, steps }, 403, undefined, u.cookie);
    await ok('journeys/set', { deckId, steps });
    const c = await mkCard();
    const r = await ok('journeys/apply', { cardId: c }, u.cookie);
    expect(r.cardIds).toHaveLength(2);
  });

  it('31 steps or a bad step is 400', async () => {
    await on();
    const many = Array.from({ length: 31 }, (_, i) => ({ title: `S${i}`, assigneeId: null, priority: null, effort: null }));
    await fail('journeys/set', { deckId, steps: many }, 400);
    await fail('journeys/set', { deckId, steps: [{ ...steps[0], title: '' }] }, 400);
    await ok('journeys/set', { deckId, steps: many.slice(0, 30) });
  });

  it('visible only to people who see the list project', async () => {
    await on();
    limitProject(projectId);
    await ok('journeys/set', { deckId, steps });
    const out = await mkUser('out');
    expect((await snap(out.cookie)).journeys).toEqual([]);
    expect((await snap(owner)).journeys).toHaveLength(1);
  });
});

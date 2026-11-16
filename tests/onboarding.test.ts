import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { TOKEN_DENIED_NAMESPACES } from '../server/tokens';
import { QUESTS, QUEST_STEP_KEYS, currentChapter, toRoman, unavailableSteps } from '../shared/quests';
import { TEMPLATES, TEMPLATE_IDS } from '../shared/templates';
import { parseContent } from '../shared/content';
import { prioritySchema, effortSchema } from '../server/commands/cards';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
let owner: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const send = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { host: HOST, cookie, 'content-type': 'application/json' } });
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await send(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
async function mkMember(name: string) {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, `${name}@x.io`, name, hashPassword('pw'));
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'member')").run(id);
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${name}@x.io`, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } });
  return { id, cookie: cookieOf(r) };
}
const snap = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie } })).json();
const count = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { n: number }).n;

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
});
afterEach(async () => { await app.close(); });

describe('onboarding tasks', () => {
  it('registers the observed step keys and numbers sprints', () => {
    for (const k of ['useSorting', 'addSubCard', 'applySCMIntegration']) expect(QUEST_STEP_KEYS.has(k)).toBe(true);
    expect(QUESTS.reduce((n, c) => n + c.steps.length, 0)).toBe(QUEST_STEP_KEYS.size); // no duplicate keys
    expect(toRoman(8)).toBe('VIII');
    expect(toRoman(4)).toBe('IV');
    expect(currentChapter(new Set())).toBe(1);
    expect(currentChapter(new Set(QUESTS[0].steps.map((s) => s.key)))).toBe(2);
    expect(currentChapter(QUEST_STEP_KEYS)).toBe(QUESTS.length);
  });

  it('a step the plan does not allow (time tracking on Free) never holds the sprint back', () => {
    const skip = unavailableSteps((f) => f !== 'timeTracking');
    expect([...skip]).toEqual(['trackTime']);
    expect([...unavailableSteps(() => true)]).toEqual([]);
    const ch3 = QUESTS[2].steps.map((s) => s.key).filter((k) => k !== 'trackTime');
    const done = new Set([...QUESTS[0].steps, ...QUESTS[1].steps, ...ch3.map((key) => ({ key }))].map((s) => s.key));
    expect(currentChapter(done)).toBe(3); // blocked on Pro-only time tracking
    expect(currentChapter(done, skip)).toBe(4); // the marker moves on
    expect(currentChapter(QUEST_STEP_KEYS, skip)).toBe(QUESTS.length);
  });

  it('progress is idempotent and per user', async () => {
    const bob = await mkMember('bob');
    const first = await ok('onboarding/progress', { step: 'createCard', stepInfo: { via: 'test' } });
    expect(first).toMatchObject({ step: 'createCard', isNew: true });
    const again = await ok('onboarding/progress', { step: 'createCard' });
    expect(again).toMatchObject({ step: 'createCard', isNew: false });
    expect(count('SELECT COUNT(*) n FROM user_onboarding')).toBe(1);
    const at = (db.prepare('SELECT completed_at a FROM user_onboarding').get() as { a: number }).a;
    await ok('onboarding/progress', { step: 'createCard' });
    expect((db.prepare('SELECT completed_at a FROM user_onboarding').get() as { a: number }).a).toBe(at);

    expect((await snap(owner)).onboarding.map((r: any) => r.step)).toEqual(['createCard']);
    expect((await snap(bob.cookie)).onboarding).toEqual([]);
    await ok('onboarding/progress', { step: 'addComment' }, bob.cookie);
    expect((await snap(bob.cookie)).onboarding.map((r: any) => r.step)).toEqual(['addComment']);
    expect((await snap(owner)).onboarding.map((r: any) => r.step)).toEqual(['createCard']);
  });

  it('unknown step → 400', async () => {
    for (const body of [{ step: 'nope' }, { step: '' }, {}, { step: 'createCard', stepInfo: 'x' }, { step: 'createCard', stepInfo: { a: { b: 1 } } }]) {
      const r = await send('onboarding/progress', body);
      expect(r.statusCode).toBe(400);
    }
    expect(count('SELECT COUNT(*) n FROM user_onboarding')).toBe(0);
  });

  it('a new completion goes live to that user only; API tokens are denied', async () => {
    const bob = await mkMember('bob');
    const hub = new LiveHub(db);
    const got = new Map<string, any[]>([[bob.id, []]]);
    const ownerId = (db.prepare('SELECT id FROM users WHERE email=?').get('o@x.io') as any).id;
    got.set(ownerId, []);
    for (const id of [bob.id, ownerId]) hub.add({ send: (d) => got.get(id)!.push(JSON.parse(d)), close: () => {} }, { id });
    hub.publish('a', [{ model: 'onboardingStep', op: 'upsert', row: { userId: bob.id, step: 'createCard', completedAt: 1 } }]);
    expect(got.get(bob.id)!.length).toBe(1);
    expect(got.get(ownerId)!.length).toBe(0);
    expect(TOKEN_DENIED_NAMESPACES.has('onboarding')).toBe(true);
  });
});

describe('project templates', () => {
  it('has the ten genres', () => {
    expect(TEMPLATE_IDS).toEqual(['action', 'adventure', 'platformer', 'puzzle', 'roguelike', 'rpg', 'simulation', 'sports', 'strategy', 'survival']);
  });

  it('template content passes the task content validator', () => {
    for (const t of TEMPLATES) {
      const tagNames = new Set(t.tags.map((x) => x.name));
      expect(tagNames.size, t.id).toBe(t.tags.length);
      for (const tag of t.tags) expect(tag.name, t.id).toMatch(/^[\p{L}\p{N}_-]{1,32}$/u);
      const spaceIds = new Set(t.spaces.map((s) => s.id));
      expect(spaceIds.size, t.id).toBe(t.spaces.length);
      expect(t.decks.length, t.id).toBeGreaterThanOrEqual(3);
      const cards = t.decks.flatMap((d) => d.cards.map((c) => ({ d, c })));
      expect(cards.length, t.id).toBeGreaterThanOrEqual(5);
      expect(cards.length, t.id).toBeLessThanOrEqual(12);
      for (const d of t.decks) {
        expect(spaceIds.has(d.space), `${t.id}/${d.title}`).toBe(true);
        expect(d.title.trim()).not.toBe('');
      }
      for (const { c } of cards) {
        expect(c.content.trim(), t.id).not.toBe('');
        expect(c.content.length, t.id).toBeLessThan(4000);
        if (c.priority) expect(prioritySchema.safeParse(c.priority).success).toBe(true);
        if (c.effort !== undefined) expect(effortSchema.safeParse(c.effort).success).toBe(true);
        for (const x of c.tags ?? []) expect(tagNames.has(x), `${t.id}: tag ${x}`).toBe(true);
        for (const x of parseContent(c.content).tags) expect(tagNames.has(x), `${t.id}: #${x}`).toBe(true);
      }
    }
  });

  it.each(TEMPLATE_IDS)('%s creates its spaces, lists and tasks in one transaction', async (id) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const before = { c: count('SELECT COUNT(*) n FROM cards'), d: count('SELECT COUNT(*) n FROM decks') };
    const { id: pid } = await ok('projects/create', { name: `My ${id}`, template: id });
    const project = (await snap(owner)).projects.find((p: any) => p.id === pid);
    expect(project.spaces).toEqual(t.spaces);
    expect(project.tags).toEqual(t.tags);
    const decks = db.prepare('SELECT * FROM decks WHERE project_id=? ORDER BY sort_index, seq').all(pid) as any[];
    expect(decks.length).toBe(t.decks.length);
    expect(decks.map((d) => d.title).sort()).toEqual(t.decks.map((d) => d.title).sort());
    for (const d of decks) {
      const td = t.decks.find((x) => x.title === d.title)!;
      expect(d.deck_type).toBe(td.deckType);
      expect(d.space_id).toBe(td.space);
      const cards = db.prepare("SELECT * FROM cards WHERE deck_id=? ORDER BY sort_index").all(d.id) as any[];
      expect(cards.map((c) => c.content)).toEqual(td.cards.map((c) => c.content));
      for (const [i, c] of cards.entries()) {
        expect(c.is_doc === 1).toBe(td.deckType === 'doc');
        expect(JSON.parse(c.master_tags_json).sort()).toEqual([...(td.cards[i].tags ?? []), ...parseContent(td.cards[i].content).tags].filter((x, j, a) => a.indexOf(x) === j).sort());
      }
    }
    expect(count('SELECT COUNT(*) n FROM cards') - before.c).toBe(t.decks.reduce((n, d) => n + d.cards.length, 0));
    expect(count('SELECT COUNT(*) n FROM decks') - before.d).toBe(t.decks.length);
  });

  it('without a template the project starts with one area and no lists', async () => {
    const { id } = await ok('projects/create', { name: 'Plain' });
    expect(count('SELECT COUNT(*) n FROM decks WHERE project_id=?', id)).toBe(0);
    expect((await ok('projects/create', { name: 'Plain 2', template: undefined })).id).toBeTruthy();
  });

  it('an unknown template → 400 and nothing is created', async () => {
    const r = await send('projects/create', { name: 'X', template: 'moba' });
    expect(r.statusCode).toBe(400);
    expect(count('SELECT COUNT(*) n FROM projects')).toBe(0);
  });

  it('a failure part-way rolls the whole template back', async () => {
    // The 1000-seq trigger makes the second created card fail.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON cards WHEN (SELECT COUNT(*) FROM cards) >= 2 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const r = await send('projects/create', { name: 'Boom', template: 'rpg' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(count('SELECT COUNT(*) n FROM projects')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM decks')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM cards')).toBe(0);
  });

  it('respects the plan project limit', async () => {
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    for (const n of [1, 2, 3]) await ok('projects/create', { name: `P${n}`, template: 'puzzle' });
    const r = await send('projects/create', { name: 'P4', template: 'puzzle' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'projects' } });
    expect(count('SELECT COUNT(*) n FROM projects')).toBe(3);
  });
});

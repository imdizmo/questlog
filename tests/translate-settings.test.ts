import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { TranslateEngine } from '../server/translate/engine';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
const PACK = join(__dirname, 'fixtures', 'translate-pack');
let db: Db;
let app: FastifyInstance;
let ada: string, bob: string, adminCookie: string;
let projectId: string, deckId: string;
const hdr = (cookie?: string) => ({ host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
const cookieOf = (res: any) => {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session');
  return c ? `jt_session=${c.value}` : '';
};
const post = (name: string, payload: unknown, cookie: string) => app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie) });
const run = async (name: string, payload: unknown, cookie: string) => {
  const r = await post(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const enabled = () => (JSON.parse((db.prepare('SELECT settings_json s FROM account').get() as { s: string }).s) as { translationEnabled?: boolean }).translationEnabled === true;
const person = async (email: string, role: string) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, email, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: hdr() }));
};

async function boot(packDir: string) {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], translate: { engine: new TranslateEngine({ packDir }), queue: { debounceMs: 5, backfillGapMs: 0 } } });
  await app.ready();
  ada = cookieOf(await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ada', email: 'a@x.io', password: 'pw-owner' }, headers: hdr() }));
  bob = await person('b@x.io', 'member');
  adminCookie = await person('adm@x.io', 'admin');
  projectId = (await run('projects/create', { name: 'P' }, ada)).id;
  deckId = (await run('decks/create', { title: 'L', projectId, spaceId: 1 }, ada)).id;
}
afterEach(async () => { await app.close(); db.close(); });

describe('translation setting and API', () => {
  describe('with a language pack', () => {
    beforeEach(() => boot(PACK));

    it('lets owner and admin switch it on, not a member', async () => {
      expect((await post('accounts/update', { settings: { translationEnabled: true } }, bob)).statusCode).toBe(403);
      expect(enabled()).toBe(false);
      expect((await post('accounts/update', { settings: { translationEnabled: true } }, adminCookie)).statusCode).toBe(200);
      expect(enabled()).toBe(true);
      await run('accounts/update', { settings: { translationEnabled: false } }, ada);
      expect(enabled()).toBe(false);
    });

    it('rejects a non-boolean value', async () => {
      expect((await post('accounts/update', { settings: { translationEnabled: 'yes' } }, ada)).statusCode).toBe(400);
    });

    it('starts the queue right away when switched on', async () => {
      const start = vi.spyOn(app.translate, 'start');
      await run('accounts/update', { settings: { translationEnabled: true } }, ada);
      expect(start).toHaveBeenCalledTimes(1);
      await run('accounts/update', { settings: { translationEnabled: false } }, ada);
      expect(start).toHaveBeenCalledTimes(1);
      await run('accounts/update', { name: 'W2' }, ada);
      expect(start).toHaveBeenCalledTimes(1);
    });

    it('reports the pack, its version and the setting at /translate/status', async () => {
      const get = async (c: string) => (await app.inject({ method: 'GET', url: '/translate/status', headers: hdr(c) }));
      expect((await get(bob)).json()).toEqual({ pack: true, version: 'fixture-1', enabled: false, queued: 0 });
      await run('accounts/update', { settings: { translationEnabled: true } }, ada);
      expect((await get(bob)).json()).toMatchObject({ pack: true, enabled: true });
      expect((await get('')).statusCode).toBe(401);
    });

    it('translate/open: 404 for a card the caller cannot see, nothing queued when off, queued when on', async () => {
      const hiddenProject = (await run('projects/create', { name: 'Secret' }, ada)).id;
      db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(hiddenProject);
      const hiddenDeck = (await run('decks/create', { title: 'H', projectId: hiddenProject, spaceId: 1 }, ada)).id;
      const mine = (await run('cards/create', { deckId: hiddenDeck, content: 'Titolo\nIl cavaliere va al castello con la spada.' }, ada)).id;
      const shared = (await run('cards/create', { deckId, content: 'Titolo\nIl cavaliere va al castello con la spada.' }, ada)).id;
      const open = (c: string, kind: string, id: string) => post('translate/open', { kind, id }, c);
      expect((await open(bob, 'card', mine)).statusCode).toBe(404);
      expect((await open(ada, 'card', 'nope')).statusCode).toBe(404);
      expect((await open(ada, 'entry', 'nope')).statusCode).toBe(404);
      const open1 = vi.spyOn(app.translate, 'open');
      expect((await open(ada, 'card', shared)).statusCode).toBe(200);
      expect(app.translate.queued()).toBe(0); // off: nothing is queued
      await run('accounts/update', { settings: { translationEnabled: true } }, ada);
      expect((await open(bob, 'card', shared)).statusCode).toBe(200);
      expect(open1).toHaveBeenCalledWith('card', shared);
      expect((await post('translate/open', { kind: 'x', id: shared }, ada)).statusCode).toBe(400);
    });

    it('translate/open on a comment follows its card', async () => {
      const hiddenProject = (await run('projects/create', { name: 'Secret' }, ada)).id;
      db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(hiddenProject);
      const hiddenDeck = (await run('decks/create', { title: 'H', projectId: hiddenProject, spaceId: 1 }, ada)).id;
      const mine = (await run('cards/create', { deckId: hiddenDeck, content: 'Solo io' }, ada)).id;
      const { entryId } = await run('resolvables/create', { cardId: mine, context: 'comment', content: 'Ciao a tutti' }, ada);
      await run('accounts/update', { settings: { translationEnabled: true } }, ada);
      expect((await post('translate/open', { kind: 'entry', id: entryId }, bob)).statusCode).toBe(404);
      expect((await post('translate/open', { kind: 'entry', id: entryId }, ada)).statusCode).toBe(200);
    });
  });

  describe('without a language pack', () => {
    beforeEach(() => boot(join(__dirname, 'fixtures', 'no-such-pack')));

    it('refuses to switch it on with 409 translation_pack_missing, switching off still works', async () => {
      const r = await post('accounts/update', { settings: { translationEnabled: true } }, ada);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('translation_pack_missing');
      expect(enabled()).toBe(false);
      expect((await post('accounts/update', { settings: { translationEnabled: false } }, ada)).statusCode).toBe(200);
    });

    it('reports pack:false at /translate/status', async () => {
      const r = await app.inject({ method: 'GET', url: '/translate/status', headers: hdr(ada) });
      expect(r.json()).toEqual({ pack: false, version: null, enabled: false, queued: 0 });
    });
  });

  describe('project glossary', () => {
    beforeEach(() => boot(PACK));
    const set = (glossary: unknown, c = ada) => post('projects/update', { id: projectId, glossary }, c);
    const stored = () => JSON.parse((db.prepare('SELECT keep_names_json k FROM projects WHERE id=?').get(projectId) as { k: string }).k);

    it('stores a trimmed glossary and sends it as glossary on the project row and snapshot', async () => {
      expect((await set([{ term: ' Aldric ', it: 'Aldrico' }, { term: 'Fogbound', en: 'Fog-Bound' }])).statusCode).toBe(200);
      expect(stored()).toEqual([{ term: 'Aldric', it: 'Aldrico' }, { term: 'Fogbound', en: 'Fog-Bound' }]);
      const snap = (await app.inject({ method: 'GET', url: '/api/snapshot', headers: hdr(ada) })).json();
      const p = snap.projects.find((x: any) => x.id === projectId);
      expect(p.glossary).toEqual(stored());
      expect(p.keepNames).toBeUndefined();
    });

    it('rejects more than 200 entries, long or empty terms, long targets and duplicate terms', async () => {
      const many = Array.from({ length: 201 }, (_, i) => ({ term: `n${i}` }));
      expect((await set(many)).statusCode).toBe(400);
      expect((await set(many.slice(0, 200))).statusCode).toBe(200);
      expect((await set([{ term: 'x'.repeat(81) }])).statusCode).toBe(400);
      expect((await set([{ term: '   ' }])).statusCode).toBe(400);
      expect((await set([{ term: 'a', en: 'y'.repeat(81) }])).statusCode).toBe(400);
      expect((await set([{ term: 'a', it: 'y'.repeat(81) }])).statusCode).toBe(400);
      expect((await set([{ term: 'Aldric' }, { term: ' aldric ' }])).statusCode).toBe(400);
      expect((await set('Aldric')).statusCode).toBe(400);
    });

    it('follows who may edit the project: a member may, an observer may not', async () => {
      expect((await set([{ term: 'A' }], bob)).statusCode).toBe(200);
      const obs = await person('o@x.io', 'observer');
      expect((await set([{ term: 'B' }], obs)).statusCode).toBe(403);
      expect(stored()).toEqual([{ term: 'A' }]);
    });
  });
});

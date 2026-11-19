import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// The server side of the workspace menu: the description and picture settings, and the Archive section's deleted list.
const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;

const hdr = (cookie?: string) => ({ host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
const cookieOf = (res: any) => {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session');
  return c ? `jt_session=${c.value}` : '';
};
const post = (url: string, payload: unknown, cookie?: string) => app.inject({ method: 'POST', url, payload: payload as any, headers: hdr(cookie) });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: hdr(cookie) });
const ok = async (name: string, payload: unknown, cookie: string) => {
  const r = await post(`/dispatch/${name}`, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
function mkUser(role: string, email: string) {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const loginAs = async (email: string) => cookieOf(await post('/api/login', { email, password: 'pw' }));

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('workspace description and picture', () => {
  it('saves and checks them', async () => {
    const owner = cookieOf(await post('/api/setup', { workspaceName: 'W', name: 'Own', email: 'o@x.io', password: 'pw-owner' }));
    await ok('accounts/update', { settings: { description: 'Our game studio.', coverArt: 3 } }, owner);
    const snap = (await get('/api/snapshot', owner)).json();
    expect(snap.account.settings.description).toBe('Our game studio.');
    expect(snap.account.settings.coverArt).toBe(3);
    // A partial update leaves the rest alone.
    await ok('accounts/update', { settings: { staleHours: 50 } }, owner);
    expect((await get('/api/snapshot', owner)).json().account.settings.description).toBe('Our game studio.');
    expect((await post('/dispatch/accounts/update', { settings: { coverArt: 999 } }, owner)).statusCode).toBe(400);
    expect((await post('/dispatch/accounts/update', { settings: { description: 'x'.repeat(1001) } }, owner)).statusCode).toBe(400);
    await ok('accounts/update', { settings: { coverArt: null } }, owner);
    mkUser('member', 'm@x.io');
    const member = await loginAs('m@x.io');
    expect((await post('/dispatch/accounts/update', { settings: { description: 'mine now' } }, member)).statusCode).toBe(403);
  });
});

describe('GET /api/cards-deleted', () => {
  it('lists deleted cards the person could open, newest first, and they can be restored', async () => {
    const owner = cookieOf(await post('/api/setup', { workspaceName: 'W', name: 'Own', email: 'o@x.io', password: 'pw-owner' }));
    mkUser('member', 'm@x.io');
    const member = await loginAs('m@x.io');
    const open = (await ok('projects/create', { name: 'Open' }, owner)).id;
    const secret = (await ok('projects/create', { name: 'Secret', visibility: 'limited' }, owner)).id;
    const openDeck = (await ok('decks/create', { title: 'OD', projectId: open }, owner)).id;
    const secretDeck = (await ok('decks/create', { title: 'SD', projectId: secret }, owner)).id;
    const a = await ok('cards/create', { content: '# Gone task\nbody', deckId: openDeck }, owner);
    const b = await ok('cards/create', { content: 'Secret gone', deckId: secretDeck }, owner);
    const live = await ok('cards/create', { content: 'Still here', deckId: openDeck }, owner);
    await ok('cards/update', { id: a.id, visibility: 'deleted' }, owner);
    await ok('cards/update', { id: b.id, visibility: 'deleted' }, owner);

    const mine = (await get('/api/cards-deleted', owner)).json().cards;
    expect(mine.map((c: any) => c.title).sort()).toEqual(['Gone task', 'Secret gone']);
    expect(mine.find((c: any) => c.id === live.id)).toBeUndefined();
    expect(mine[0]).toMatchObject({ deckId: expect.any(String), creatorId: expect.any(String), isDoc: false });

    // The member does not see the limited project, so not its trash either.
    const theirs = (await get('/api/cards-deleted', member)).json().cards;
    expect(theirs.map((c: any) => c.title)).toEqual(['Gone task']);

    await ok('cards/update', { id: a.id, visibility: 'default' }, member);
    expect((await get('/api/cards-deleted', member)).json().cards).toEqual([]);
    expect((await get('/api/cards-deleted')).statusCode).toBe(401);
  });
});

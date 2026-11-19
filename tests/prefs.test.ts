import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { MAX_PREF_BYTES, MAX_PREF_KEYS } from '../shared/prefs';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// Per-person preferences (server/prefs.ts): the sidebar, its folds and the tabs follow the person across devices.
const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;

const hdr = (cookie?: string, extra: Record<string, string> = {}) => ({ host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra });
const cookieOf = (res: any) => {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session');
  return c ? `jt_session=${c.value}` : '';
};
const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/prefs', headers: hdr(cookie) });
const put = (key: string, value: unknown, cookie?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'PUT', url: `/api/prefs/${key}`, payload: { value } as any, headers: hdr(cookie, extra) });

let ada: string;
let bob: string;

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ada', email: 'a@x.io', password: 'pw-owner' }, headers: hdr() });
  ada = cookieOf(setup);
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, 'b@x.io', 'Bob', hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, 'member');
  bob = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'b@x.io', password: 'pw' }, headers: hdr() }));
});
afterEach(async () => { await app.close(); db.close(); });

describe('per-person preferences', () => {
  it('starts empty, keeps what is put, and null forgets it', async () => {
    expect((await get(ada)).json().prefs).toEqual({});
    expect((await put('sidebar', { folded: true, pages: 'icons' }, ada)).statusCode).toBe(200);
    const got = (await get(ada)).json();
    expect(got.prefs).toEqual({ sidebar: { folded: true, pages: 'icons' } });
    expect(got.updatedAt.sidebar).toBeGreaterThan(0); // the page compares values it kept offline with this
    await put('sidebar', null, ada);
    expect((await get(ada)).json().prefs).toEqual({});
  });

  it('is per person', async () => {
    await put('tabs', { v: 1 }, ada);
    expect((await get(bob)).json().prefs).toEqual({});
    await put('tabs', { v: 2 }, bob);
    expect((await get(ada)).json().prefs.tabs).toEqual({ v: 1 });
  });

  it('needs a session', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await put('tabs', 1)).statusCode).toBe(401);
  });

  it('refuses a bad key', async () => {
    for (const k of ['Tabs', '1x', 'a'.repeat(41), 'a-b']) expect((await put(k, 1, ada)).statusCode, k).toBe(400);
  });

  it('refuses a value over the cap and keeps the old one', async () => {
    await put('tabs', 'small', ada);
    const r = await put('tabs', 'x'.repeat(MAX_PREF_BYTES + 1), ada);
    expect(r.statusCode).toBe(413);
    expect((await get(ada)).json().prefs.tabs).toBe('small');
  });

  it('keeps at most MAX_PREF_KEYS keys, but an existing key can still change', async () => {
    for (let i = 0; i < MAX_PREF_KEYS; i++) expect((await put(`k${i}`, i, ada)).statusCode).toBe(200);
    expect((await put('one.more', 1, ada)).statusCode).toBe(409);
    expect((await put('k0', 'changed', ada)).statusCode).toBe(200);
    expect(Object.keys((await get(ada)).json().prefs)).toHaveLength(MAX_PREF_KEYS);
  });

  it('refuses a write from another site', async () => {
    expect((await put('tabs', 1, ada, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await get(ada)).json().prefs).toEqual({});
  });

  it('goes with the person', async () => {
    await put('tabs', 1, bob);
    db.prepare("DELETE FROM users WHERE email='b@x.io'").run();
    expect((db.prepare('SELECT COUNT(*) c FROM user_prefs').get() as { c: number }).c).toBe(0);
  });
});

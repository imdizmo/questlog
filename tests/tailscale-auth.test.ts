import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, setClock, _resetLimiter } from '../server/auth';
import type { TailscalePerson } from '../server/tailscale';

const HOST = 'localhost:8780';
const ORIGIN = 'http://localhost:8780';
const TS_IP = '100.101.1.2';
const ADA: TailscalePerson = { login: 'ada@example.com', displayName: 'Ada' };
const json = { host: HOST, 'content-type': 'application/json' };
const page = { host: HOST, accept: 'text/html,application/xhtml+xml' };

let db: Db;
let app: ReturnType<typeof buildApp>;
let webRoot = '';
let calls: { ip: string; port: number }[] = [];
let answer: TailscalePerson | null = ADA;
let t = 1_000_000;

const sessionCookie = (res: any) => res.cookies.find((c: any) => c.name === 'jt_session');
const cookieOf = (res: any) => `jt_session=${sessionCookie(res).value}`;

function start(enabled = true) {
  app = buildApp({
    db, hosts: [HOST], webRoot,
    tailscale: { enabled, socketPath: 'unused' },
    tailscaleWhois: async (ip, port) => { calls.push({ ip, port }); return answer; },
  });
}
function mkUser(email: string, password = 'pw-user', role = 'member', extra: { tailscale?: string; disabled?: boolean } = {}): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,tailscale_login,disabled) VALUES (?,?,?,?,0,?,?)')
    .run(id, email, email.split('@')[0], hashPassword(password), extra.tailscale ?? null, extra.disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const load = (url = '/', ip = TS_IP, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...page, ...headers }, remoteAddress: ip });
const login = (email: string, password: string, ip = '127.0.0.1') =>
  app.inject({ method: 'POST', url: '/api/login', payload: { email, password }, headers: { ...json, origin: ORIGIN }, remoteAddress: ip });
const sessionRows = () => db.prepare('SELECT user_id, via FROM sessions').all() as { user_id: string; via: string | null }[];
const requests = () => db.prepare('SELECT * FROM access_requests').all() as { login: string; display_name: string; first_seen: number; last_seen: number }[];

beforeEach(async () => {
  _resetLimiter();
  t = 1_000_000;
  setClock(() => t);
  calls = [];
  answer = ADA;
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  webRoot = mkdtempSync(join(base, 'tailscale-auth-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Questlog</title>');
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'assets', 'x.js'), 'console.log(1)');
  start();
  await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Owner', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  db.prepare('DELETE FROM sessions').run();
  calls = [];
});
afterEach(async () => {
  await app.close();
  setClock(() => Date.now());
  rmSync(webRoot, { recursive: true, force: true });
});

describe('sign-in by Tailscale', () => {
  it('known login gets a session', async () => {
    const id = mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const r = await load('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>Questlog</title>');
    expect(calls).toEqual([{ ip: TS_IP, port: expect.any(Number) }]);
    const c = sessionCookie(r);
    expect(c).toBeTruthy();
    expect(c.httpOnly).toBe(true);
    expect(r.cookies.find((x: any) => x.name === 'jt_device')).toBeUndefined();
    expect(sessionRows()).toEqual([{ user_id: id, via: 'tailscale' }]);
    const snap = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie: cookieOf(r) } });
    expect(snap.statusCode).toBe(200);
    const me = snap.json().users.find((u: any) => u.id === id);
    expect(me.tailscaleLogin).toBe('ada@example.com');
    expect(snap.json().users.find((u: any) => u.id !== id).tailscaleLogin).toBeNull();
  });

  it('matches the login without regard to case, and reads an IPv4-mapped peer', async () => {
    const id = mkUser('ada@x.io', 'pw', 'member', { tailscale: 'Ada@Example.com' });
    const r = await load('/', `::ffff:${TS_IP}`);
    expect(calls[0].ip).toBe(TS_IP);
    expect(sessionCookie(r)).toBeTruthy();
    expect(sessionRows()).toEqual([{ user_id: id, via: 'tailscale' }]);
  });

  it('unknown login gets the ask page and one request row', async () => {
    const r1 = await load('/');
    expect(r1.statusCode).toBe(403);
    expect(r1.headers['content-type']).toMatch(/^text\/html/);
    expect(r1.headers['content-security-policy']).toBeTruthy();
    expect(r1.body).toContain('not on this team yet');
    expect(r1.body).toContain('ada@example.com');
    expect(r1.body).toContain('href="/login"');
    expect(r1.body).toContain('Questlog');
    expect(r1.body).not.toMatch(/<script/i);
    expect(sessionCookie(r1)).toBeUndefined();
    expect(requests()).toEqual([{ login: 'ada@example.com', display_name: 'Ada', first_seen: 1_000_000, last_seen: 1_000_000 }]);
    t += 5_000;
    const r2 = await load('/cards/12');
    expect(r2.statusCode).toBe(403);
    expect(requests()).toEqual([{ login: 'ada@example.com', display_name: 'Ada', first_seen: 1_000_000, last_seen: 1_005_000 }]);
    expect(sessionRows()).toEqual([]);
  });

  it('escapes the login and display name on the ask page', async () => {
    answer = { login: '<b>x</b>@example.com', displayName: '"><img src=x onerror=alert(1)>' };
    const r = await load('/');
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('<b>x</b>');
    expect(r.body).not.toContain('<img');
    expect(r.body).toContain('&lt;b&gt;x&lt;/b&gt;@example.com');
  });

  it('disabled user refused', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com', disabled: true });
    const r = await load('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>Questlog</title>');
    expect(r.body).not.toContain('not on this team yet');
    expect(sessionCookie(r)).toBeUndefined();
    expect(sessionRows()).toEqual([]);
    expect(requests()).toEqual([]);
  });

  it('a disabled workspace gives a Tailscale session to its owner only', async () => {
    db.prepare('UPDATE account SET is_disabled=1').run();
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const r = await load('/');
    expect(r.statusCode).toBe(200);
    expect(sessionCookie(r)).toBeUndefined();
    expect(sessionRows()).toEqual([]);
    db.prepare("UPDATE users SET tailscale_login=NULL WHERE email='ada@x.io'").run();
    db.prepare("UPDATE users SET tailscale_login='ada@example.com' WHERE email='o@x.io'").run();
    const o = await load('/');
    expect(sessionCookie(o)).toBeTruthy();
  });

  it('non-tailscale peer is untouched', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    for (const ip of ['127.0.0.1', '10.0.0.5', '::1', '100.63.255.255', '100.128.0.1']) {
      const r = await load('/', ip);
      expect(r.statusCode).toBe(200);
      expect(sessionCookie(r)).toBeUndefined();
    }
    expect(calls).toEqual([]);
    expect(sessionRows()).toEqual([]);
  });

  it('headers never identify', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const r = await load('/', '127.0.0.1', {
      'x-forwarded-for': TS_IP, 'x-real-ip': TS_IP, forwarded: `for=${TS_IP}`,
      'tailscale-user-login': 'ada@example.com', 'tailscale-user-name': 'Ada',
    });
    expect(r.statusCode).toBe(200);
    expect(sessionCookie(r)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(sessionRows()).toEqual([]);
  });

  it('a proxied request is never looked up', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const proxied: Record<string, string>[] = [{ 'x-forwarded-for': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'x-forwarded-host': 'questlog.example' },
      { 'x-real-ip': '1.2.3.4' }, { via: '1.1 proxy' }];
    for (const h of proxied) {
      const r = await load('/', TS_IP, h);
      expect(r.statusCode).toBe(200);
      expect(sessionCookie(r)).toBeUndefined();
    }
    answer = { login: 'zed@example.com', displayName: 'Zed' };
    const r = await load('/', TS_IP, { 'x-forwarded-for': '1.2.3.4' });
    expect(r.statusCode).toBe(200);
    expect(calls).toEqual([]);
    expect(sessionRows()).toEqual([]);
    expect(requests()).toEqual([]);
  });

  it('a lookup or a request write that fails falls back to the normal page', async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      await app.close();
      app = buildApp({ db, hosts: [HOST], webRoot, tailscale: { enabled: true, socketPath: 'unused' }, tailscaleWhois: async () => { throw new Error('boom'); } });
      const r = await load('/');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<title>Questlog</title>');
      expect(sessionCookie(r)).toBeUndefined();
      await app.close();
      start();
      db.exec('DROP TABLE access_requests');
      const w = await load('/');
      expect(w.statusCode).toBe(200);
      expect(w.body).toContain('<title>Questlog</title>');
      expect(errors.length).toBe(2);
    } finally {
      console.error = orig;
    }
  });

  it('switch off makes no call', async () => {
    await app.close();
    start(false);
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const r = await load('/');
    expect(r.statusCode).toBe(200);
    expect(sessionCookie(r)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('daemon down falls back to login', async () => {
    answer = null;
    const r = await load('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>Questlog</title>');
    expect(sessionCookie(r)).toBeUndefined();
    expect(requests()).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it('only page loads look up', async () => {
    mkUser('ada@x.io', 'pw', 'member', { tailscale: 'ada@example.com' });
    const urls = ['/assets/x.js', '/api/status', '/healthz', '/login', '/login?next=%2F', '/setup', '/join/abc',
      '/team/other', '/fonts/a.woff2', '/open/hollow-keep', '/email/unsubscribe', '/integrations/x', '/mcp', '/dispatch/x/y',
      '/%61pi/status', '/%74eam/other'];
    for (const url of urls) await load(url);
    await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'x', password: 'y' }, headers: { ...json, accept: 'text/html', origin: ORIGIN }, remoteAddress: TS_IP });
    await app.inject({ method: 'POST', url: '/', headers: { ...page, origin: ORIGIN }, remoteAddress: TS_IP });
    await load('/', TS_IP, { authorization: 'Bearer x' });
    await app.inject({ method: 'GET', url: '/', headers: { host: HOST, accept: 'application/json' }, remoteAddress: TS_IP });
    await app.inject({ method: 'GET', url: '/', headers: { host: HOST }, remoteAddress: TS_IP });
    expect(calls).toEqual([]);
    expect(sessionRows()).toEqual([]);
  });

  it('existing session skips lookup', async () => {
    mkUser('bob@x.io', 'pw-bob');
    const l = await login('bob@x.io', 'pw-bob');
    calls = [];
    const r = await load('/', TS_IP, { cookie: cookieOf(l) });
    expect(r.statusCode).toBe(200);
    expect(calls).toEqual([]);
    // An unknown or expired cookie is no session: the lookup runs.
    await load('/', TS_IP, { cookie: 'jt_session=nope' });
    expect(calls.length).toBe(1);
  });
});

describe('/api/tailscale and linking', () => {
  const info = (cookie: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/tailscale', headers: { host: HOST, cookie, ...headers }, remoteAddress: TS_IP });
  const link = (cookie: string, password: string | undefined, ip = TS_IP, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/tailscale/link', payload: password === undefined ? {} : { password },
      headers: { ...json, origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers }, remoteAddress: ip });
  const linkOf = (id: string) => (db.prepare('SELECT tailscale_login l FROM users WHERE id=?').get(id) as { l: string | null }).l;

  it('link', async () => {
    const bob = mkUser('bob@x.io', 'pw-bob');
    const carl = mkUser('carl@x.io', 'pw-carl');
    const bc = cookieOf(await login('bob@x.io', 'pw-bob', TS_IP));
    const cc = cookieOf(await login('carl@x.io', 'pw-carl', TS_IP));

    expect((await info(bc)).json()).toEqual({ enabled: true, login: 'ada@example.com', displayName: 'Ada', linkedUserId: null, sessionVia: null });
    const l = await link(bc, 'pw-bob');
    expect(l.statusCode).toBe(200);
    expect((await info(bc)).json()).toMatchObject({ login: 'ada@example.com', linkedUserId: bob });
    expect(linkOf(bob)).toBe('ada@example.com');

    const again = await link(cc, 'pw-carl');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_linked');
    expect(linkOf(carl)).toBeNull();

    // A Tailscale session says so.
    const page1 = await load('/');
    const tc = cookieOf(page1);
    expect((await info(tc)).json()).toMatchObject({ linkedUserId: bob, sessionVia: 'tailscale' });
  });

  it('link asks for the password, limited as a login', async () => {
    const bob = mkUser('bob@x.io', 'pw-bob');
    const bc = cookieOf(await login('bob@x.io', 'pw-bob', TS_IP));
    for (const pw of ['wrong', '', undefined]) {
      const r = await link(bc, pw);
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe('bad_credentials');
    }
    expect(linkOf(bob)).toBeNull();
    // Wrong passwords count against the login limits: after ten failures even the right one is refused for a while.
    for (let i = 0; i < 7; i++) await link(bc, 'wrong');
    const locked = await link(bc, 'pw-bob');
    expect(locked.statusCode).toBe(429);
    expect(linkOf(bob)).toBeNull();
    const pwLogin = await login('bob@x.io', 'pw-bob', TS_IP);
    expect(pwLogin.statusCode).toBe(429);
    t += 5 * 60 * 1000;
    expect((await link(bc, 'pw-bob')).statusCode).toBe(200);
    expect(linkOf(bob)).toBe('ada@example.com');
  });

  it('a known-device cookie does not skip the limits of the link password', async () => {
    const bob = mkUser('bob@x.io', 'pw-bob');
    const res = await login('bob@x.io', 'pw-bob', TS_IP);
    const device = res.cookies.find((c: any) => c.name === 'jt_device');
    expect(device).toBeTruthy();
    const cookie = `${cookieOf(res)}; jt_device=${device!.value}`;
    for (let i = 0; i < 10; i++) expect((await link(cookie, 'wrong')).statusCode).toBe(401);
    const locked = await link(cookie, 'pw-bob');
    expect(locked.statusCode).toBe(429);
    expect(linkOf(bob)).toBeNull();
  });

  it('linking removes your own join request', async () => {
    mkUser('bob@x.io', 'pw-bob');
    await load('/');
    expect(requests().map((r) => r.login)).toEqual(['ada@example.com']);
    db.prepare("INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES ('other@example.com','O',1,1)").run();
    const bc = cookieOf(await login('bob@x.io', 'pw-bob', TS_IP));
    expect((await link(bc, 'pw-bob')).statusCode).toBe(200);
    expect(requests().map((r) => r.login)).toEqual(['other@example.com']);
  });

  it('link refuses a peer Tailscale does not recognise, and a cross-site post', async () => {
    mkUser('bob@x.io', 'pw-bob');
    const bc = cookieOf(await login('bob@x.io', 'pw-bob'));
    const fromLocal = await link(bc, 'pw-bob', '127.0.0.1');
    expect(fromLocal.statusCode).toBe(400);
    expect(fromLocal.json().error).toBe('not_tailscale');
    answer = null;
    expect((await link(bc, 'pw-bob')).statusCode).toBe(400);
    answer = ADA;
    expect((await link(bc, 'pw-bob', TS_IP, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await link('', 'pw-bob')).statusCode).toBe(401);
    expect(db.prepare('SELECT 1 FROM users WHERE tailscale_login IS NOT NULL').get()).toBeUndefined();
  });

  it('a proxied request is not Tailscale to /api/tailscale and link', async () => {
    mkUser('bob@x.io', 'pw-bob');
    const bc = cookieOf(await login('bob@x.io', 'pw-bob', TS_IP));
    const r = await info(bc, { 'x-forwarded-for': '1.2.3.4' });
    expect(r.json()).toMatchObject({ enabled: true, login: null, linkedUserId: null });
    const l = await link(bc, 'pw-bob', TS_IP, { via: '1.1 proxy' });
    expect(l.statusCode).toBe(400);
    expect(l.json().error).toBe('not_tailscale');
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT 1 FROM users WHERE tailscale_login IS NOT NULL').get()).toBeUndefined();
  });

  it('with the switch off, /api/tailscale reports it and looks nothing up', async () => {
    await app.close();
    start(false);
    mkUser('bob@x.io', 'pw-bob');
    const bc = cookieOf(await login('bob@x.io', 'pw-bob', TS_IP));
    const r = await info(bc);
    expect(r.json()).toEqual({ enabled: false, login: null, displayName: null, linkedUserId: null, sessionVia: null });
    expect((await link(bc, 'pw-bob')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

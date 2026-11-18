import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, _resetLimiter } from '../server/auth';
import type { TailscalePerson } from '../server/tailscale';

// POST /api/setup with JATIFY_ADMIN_TOKEN (any peer), the owner's Tailscale link at setup, and /team/whoami teamServer.

const HOST = 'localhost:8780';
const TS_IP = '100.101.1.2';
const TOKEN = 'setup-secret-token';
const ADA: TailscalePerson = { login: 'ada@example.com', displayName: 'Ada' };
const SETUP = { workspaceName: 'W', name: 'Owner', email: 'o@x.io', password: 'pw-owner' };

let db: Db;
let app: ReturnType<typeof buildApp>;
let teamDir = '';
let peer: TailscalePerson | null = ADA;

function start(enabled = true) {
  app = buildApp({ db, hosts: [HOST], tailscale: { enabled, socketPath: 'unused' }, tailscaleWhois: async () => peer });
}
const setup = (o: { ip?: string; token?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'POST', url: '/api/setup', remoteAddress: o.ip ?? '127.0.0.1',
    headers: { host: HOST, 'content-type': 'application/json', ...(o.token === undefined ? {} : { 'x-jatify-token': o.token }), ...o.headers },
    payload: { ...SETUP, ...o.body },
  });
const users = () => db.prepare('SELECT email, tailscale_login FROM users').all() as { email: string; tailscale_login: string | null }[];
const teamPath = () => join(teamDir, 'team.json');
const teamFile = () => JSON.parse(readFileSync(teamPath(), 'utf8')) as { members: { login: string; role: string }[] };

beforeEach(() => {
  _resetLimiter();
  setClock(() => Date.UTC(2026, 10, 18));
  peer = ADA;
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  teamDir = mkdtempSync(join(base, 'setup-token-'));
  vi.stubEnv('JT_TEAM_FILE', teamPath());
  vi.stubEnv('JATIFY_ADMIN_TOKEN', '');
  vi.stubEnv('JATIFY_TEAM_SERVER', '');
  vi.stubEnv('JT_LOOPBACK_TRUST', '');
  start();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
  setClock(() => Date.now());
  rmSync(teamDir, { recursive: true, force: true });
});

describe('setup token (JATIFY_ADMIN_TOKEN)', () => {
  it('without the env, setup is unchanged: no token needed from loopback or the tailnet', async () => {
    expect((await setup()).statusCode).toBe(200);
    db = openDb(':memory:'); await app.close(); start();
    expect((await setup({ ip: TS_IP })).statusCode).toBe(200);
  });
  it('with the env, setup without the token is refused from loopback and over the tailnet', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    for (const ip of ['127.0.0.1', '::1', TS_IP, '198.51.100.5']) {
      const r = await setup({ ip });
      expect(r.statusCode, ip).toBe(403);
      expect(r.json()).toEqual({ error: 'setup_token', message: expect.any(String) });
    }
    for (const token of ['', `${TOKEN}x`, TOKEN.slice(0, -1)]) expect((await setup({ token })).json().error, token).toBe('setup_token');
    expect(users()).toEqual([]);
  });
  it('the token is accepted for setup from any peer: over the tailnet', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    const r = await setup({ ip: TS_IP, token: TOKEN });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe('o@x.io');
  });
  it('the token is accepted for setup from a non-tailnet peer and through a proxy too', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    expect((await setup({ ip: '198.51.100.5', token: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).statusCode).toBe(200);
  });
  it('over the tailnet the token is for setup only: /team/members writes stay loopback-only', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    peer = null;
    expect((await setup({ ip: TS_IP, token: TOKEN })).statusCode).toBe(200);
    const write = (ip: string) => app.inject({
      method: 'POST', url: '/team/members', remoteAddress: ip,
      headers: { host: HOST, 'content-type': 'application/json', 'x-jatify': '1', 'x-jatify-token': TOKEN },
      payload: JSON.stringify({ login: 'new@example.com', role: 'member' }),
    });
    const r = await write(TS_IP);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('not_member');
    expect((await write('127.0.0.1')).statusCode).toBe(201);
  });
});

describe('already set up', () => {
  it('a second setup is 409 already_setup before any token check, with a valid, a wrong or no token', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    expect((await setup({ token: TOKEN })).statusCode).toBe(200);
    for (const token of [TOKEN, 'wrong', undefined]) {
      const r = await setup({ token, ip: TS_IP, body: { email: 'b@x.io' } });
      expect(r.statusCode, String(token)).toBe(409);
      expect(r.json().error).toBe('already_setup');
    }
  });
});

describe('JT_LOOPBACK_TRUST=0 (the Docker image)', () => {
  beforeEach(() => { vi.stubEnv('JT_LOOPBACK_TRUST', '0'); vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN); });
  it('the token is still required for setup from any peer, loopback included', async () => {
    for (const ip of ['127.0.0.1', TS_IP]) expect((await setup({ ip })).json().error, ip).toBe('setup_token');
    expect((await setup({ token: TOKEN })).statusCode).toBe(200);
  });
  it('the body tailscaleLogin is ignored even from loopback with the token', async () => {
    await setup({ token: TOKEN, body: { tailscaleLogin: 'ada@example.com' } });
    expect(users()[0].tailscale_login).toBeNull();
    expect(existsSync(teamPath())).toBe(false);
  });
  it('whois linking still works', async () => {
    await setup({ ip: TS_IP, token: TOKEN });
    expect(users()[0].tailscale_login).toBe(ADA.login);
    expect(teamFile().members.map((m) => m.login)).toEqual([ADA.login]);
  });
  it('the token never grants owner access on /team/*, from loopback either', async () => {
    peer = null;
    await setup({ token: TOKEN });
    const asToken = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({
      method, url, remoteAddress: '127.0.0.1',
      headers: { host: HOST, 'x-jatify-token': TOKEN, ...(payload ? { 'content-type': 'application/json', 'x-jatify': '1' } : {}) },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });
    expect((await asToken('GET', '/team/members')).json().error).toBe('not_member');
    expect((await asToken('POST', '/team/members', { login: 'n@example.com', role: 'member' })).statusCode).toBe(403);
    vi.stubEnv('JT_LOOPBACK_TRUST', '1');
    expect((await asToken('GET', '/team/members')).statusCode).toBe(200);
  });
});

describe('owner link at setup', () => {
  it('a Tailscale peer (switch on, whois answers) becomes the linked owner and team.json is written', async () => {
    const r = await setup({ ip: TS_IP });
    expect(r.statusCode).toBe(200);
    expect(users()).toEqual([{ email: 'o@x.io', tailscale_login: ADA.login }]);
    expect(teamFile().members).toEqual([{ login: ADA.login, name: 'Owner', role: 'owner' }]);
  });
  it('a join request the owner left before setup goes', async () => {
    db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,0,0)').run(ADA.login, 'Ada');
    await setup({ ip: TS_IP });
    expect(db.prepare('SELECT COUNT(*) c FROM access_requests').get()).toEqual({ c: 0 });
  });
  it('the whois login wins over a body tailscaleLogin', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    await setup({ ip: TS_IP, token: TOKEN, body: { tailscaleLogin: 'other@example.com' } });
    expect(users()[0].tailscale_login).toBe(ADA.login);
  });
  it('no link with the switch off, through a proxy, or when whois has no person', async () => {
    await app.close(); start(false);
    await setup({ ip: TS_IP });
    expect(users()[0].tailscale_login).toBeNull();

    db = openDb(':memory:'); await app.close(); start();
    await setup({ ip: TS_IP, headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(users()[0].tailscale_login).toBeNull();

    db = openDb(':memory:'); await app.close(); start();
    peer = null;
    await setup({ ip: TS_IP });
    expect(users()[0].tailscale_login).toBeNull();
    expect(existsSync(teamPath())).toBe(false);
  });
  it('from loopback with a valid token, the body tailscaleLogin is linked', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    const r = await setup({ token: TOKEN, body: { tailscaleLogin: '  ada@example.com ' } });
    expect(r.statusCode).toBe(200);
    expect(users()[0].tailscale_login).toBe('ada@example.com');
    expect(teamFile().members.map((m) => m.login)).toEqual(['ada@example.com']);
  });
  it('a bad body tailscaleLogin with a valid token is 400 and sets nothing up', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    for (const tailscaleLogin of [42, '   ', 'x'.repeat(321)]) {
      expect((await setup({ token: TOKEN, body: { tailscaleLogin } })).statusCode).toBe(400);
    }
    expect(users()).toEqual([]);
  });
  it('the body tailscaleLogin is ignored without the token', async () => {
    await setup({ body: { tailscaleLogin: 'mallory@example.com' } });
    expect(users()[0].tailscale_login).toBeNull();
    expect(existsSync(teamPath())).toBe(false);
  });
  it('the body tailscaleLogin is ignored with the token from a non-loopback peer or through a proxy', async () => {
    vi.stubEnv('JATIFY_ADMIN_TOKEN', TOKEN);
    peer = null;
    await setup({ ip: TS_IP, token: TOKEN, body: { tailscaleLogin: 'mallory@example.com' } });
    expect(users()[0].tailscale_login).toBeNull();

    db = openDb(':memory:'); await app.close(); start();
    await setup({ token: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' }, body: { tailscaleLogin: 'mallory@example.com' } });
    expect(users()[0].tailscale_login).toBeNull();
  });
});

describe('/team/whoami teamServer', () => {
  const whoami = () => app.inject({ method: 'GET', url: '/team/whoami', headers: { host: HOST }, remoteAddress: TS_IP });
  it('absent without JATIFY_TEAM_SERVER, the env value when set', async () => {
    await setup({ ip: TS_IP });
    expect((await whoami()).json()).not.toHaveProperty('teamServer');
    vi.stubEnv('JATIFY_TEAM_SERVER', 'http://team.example:8780');
    expect((await whoami()).json()).toMatchObject({ login: ADA.login, role: 'owner', teamServer: 'http://team.example:8780' });
  });
});

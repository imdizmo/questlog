import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../server/db';
import { buildApp, cspFor, CSP } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { privateOrTailnet } from '../server/suggestions';
import { crc32 } from '../shared/zip';
import { pictureRefusal, SUGGESTION_LIMITS, suggestionsVia, suggestionZip } from '../shared/suggestions';
import { checkSuggestions, sendSuggestion, suggestionTarget, targetOf } from '../web/src/suggestions';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// The Suggestion button: the zip the page builds, where it sends (GET /api/status), the show rule, and the desktop
// server's forward to the team's library service (server/suggestions.ts), against a stub library service.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

describe('the suggestion zip', () => {
  it('has the CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('passes unzip -t and holds exactly the words and the pictures', () => {
    if (!existsSync('/usr/bin/unzip')) return; // unzip absent: the CRC check above still ran
    const base = join(process.env.HOME ?? '.', '.cache/gametracker/scratch');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'zip-'));
    try {
      const words = 'Make the board bigger. Größer! ✨';
      const p = join(dir, 's.zip');
      writeFileSync(p, suggestionZip(words, [PNG, JPG]));
      expect(execFileSync('unzip', ['-t', p]).toString()).toContain('No errors detected');
      expect(execFileSync('unzip', ['-Z1', p]).toString().trim().split('\n')).toEqual(['suggestion.txt', 'screenshot-1.png', 'screenshot-2.jpg']);
      expect(execFileSync('unzip', ['-p', p, 'suggestion.txt']).toString('utf8')).toBe(words);
      expect(new Uint8Array(execFileSync('unzip', ['-p', p, 'screenshot-2.jpg']))).toEqual(JPG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the pictures inside the limits', () => {
    const L = SUGGESTION_LIMITS;
    expect(pictureRefusal([], PNG)).toBeNull();
    expect(pictureRefusal(Array(L.pictures).fill(PNG), PNG)).toMatch(/^At most 10 pictures, 10 MB each and 19 MB together/);
    expect(pictureRefusal([], new Uint8Array(L.pictureBytes + 1))).not.toBeNull();
    const nine = new Uint8Array(9 * 1024 * 1024);
    expect(pictureRefusal([nine, nine], new Uint8Array(1024 * 1024))).toBeNull(); // 19 MB together: just fits
    expect(pictureRefusal([nine, nine], new Uint8Array(1024 * 1024 + 1))).not.toBeNull();
  });
});

describe('where the page sends', () => {
  it('local only from the desktop app with a team, direct from a team server, else nowhere', () => {
    expect(suggestionsVia({ JT_WORKSPACE_LABEL: 'This computer', JATIFY_TEAM: 'nas' }, '1.0')).toEqual({ via: 'local' });
    expect(suggestionsVia({ JT_WORKSPACE_LABEL: 'This computer', JATIFY_TEAM_SERVER: 'nas' }, '1.0')).toBeNull();
    expect(suggestionsVia({ JATIFY_TEAM_SERVER: 'http://nas.example:8780/' }, '1.0')).toEqual({ via: 'direct', host: 'nas.example', version: '1.0' });
    expect(suggestionsVia({ JATIFY_TEAM_SERVER: '[fd7a:115c:a1e0::5]:8780' }, '1.0')).toMatchObject({ host: '[fd7a:115c:a1e0::5]' });
    expect(suggestionsVia({ JATIFY_TEAM: 'nas' }, '1.0')).toBeNull();
    expect(suggestionsVia({}, '1.0')).toBeNull();
  });

  it('the page builds its addresses from it', () => {
    expect(targetOf({ via: 'local' })).toEqual({ whoami: '/api/suggestions/whoami', send: '/api/suggestions', credentials: 'same-origin' });
    expect(targetOf({ via: 'direct', host: 'nas', version: '0.3.0' })).toEqual({
      whoami: 'http://nas:8781/team/whoami', send: 'http://nas:8781/team/suggestions?tool=questlog&version=0.3.0&os=web', credentials: 'omit',
    });
    expect(targetOf(null)).toBeNull();
    expect(targetOf({ via: 'direct' })).toBeNull();
  });

  it('the CSP lets the page reach the library service only when it sends there directly', () => {
    expect(cspFor({})).toBe(CSP);
    expect(cspFor({ JT_WORKSPACE_LABEL: 'This computer', JATIFY_TEAM: 'nas' })).toBe(CSP);
    expect(cspFor({ JATIFY_TEAM_SERVER: 'nas:8780' })).toContain("connect-src 'self' blob: http://nas:8781;");
    // blob: for the 3D viewer's embedded model pictures (three.js reads them with fetch on its own blob: URLs).
    expect(CSP).toContain("connect-src 'self' blob:;");
  });
});

describe('the show rule', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('needs a role from whoami', async () => {
    const f = answer(200, { login: 'me@x', role: 'observer' });
    await checkSuggestions({ via: 'local' }, f);
    expect(f).toHaveBeenCalledWith('/api/suggestions/whoami', expect.objectContaining({ credentials: 'same-origin' }));
    expect(suggestionTarget()?.send).toBe('/api/suggestions');
    await checkSuggestions({ via: 'local' }, answer(200, { login: 'me@x', role: null }));
    expect(suggestionTarget()).toBeNull();
    await checkSuggestions({ via: 'direct', host: 'nas', version: '1' }, answer(200, { role: 'member' }));
    expect(suggestionTarget()?.credentials).toBe('omit');
    await checkSuggestions({ via: 'local' }, answer(404, { error: 'not_found' }));
    expect(suggestionTarget()).toBeNull();
    await checkSuggestions({ via: 'local' }, answer(200, { role: 'owner' }));
    await checkSuggestions({ via: 'local' }, vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
    expect(suggestionTarget()).toBeNull();
    const none = vi.fn() as unknown as typeof fetch;
    await checkSuggestions(null, none);
    expect(none).not.toHaveBeenCalled();
    expect(suggestionTarget()).toBeNull();
  });

  it('says why a send failed, keeping the words', async () => {
    const t = targetOf({ via: 'local' })!;
    expect(await sendSuggestion(t, new Uint8Array([1]), answer(201, { id: 'questlog/x.zip' }))).toBeNull();
    expect(await sendSuggestion(t, new Uint8Array([1]), answer(400, { error: 'The text is empty.' })))
      .toBe('Not sent: The text is empty. Your words are kept: try again, or copy them somewhere.');
    expect(await sendSuggestion(t, new Uint8Array([1]), answer(404, { error: 'not found' }))).toMatch(/too old for suggestions/);
    expect(await sendSuggestion(t, new Uint8Array([1]), vi.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch))
      .toMatch(/can't reach your team's server/);
  });
});

describe('the desktop server\'s forward', () => {
  const HOST = 'localhost:8790';
  let db: Db;
  let app: FastifyInstance;
  let stub: Server;
  let got: { method: string; url: string; type: string; body: Buffer }[];
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    _resetLimiter();
    got = [];
    reply = { status: 201, body: { id: 'questlog/20261118-120000-abcdef12.zip' } };
    stub = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        got.push({ method: req.method!, url: req.url!, type: String(req.headers['content-type'] ?? ''), body: Buffer.concat(parts) });
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    vi.stubEnv('JT_WORKSPACE_LABEL', 'This computer');
    vi.stubEnv('JATIFY_TEAM', '127.0.0.1');
    db = openDb(':memory:');
    app = buildApp({ db, hosts: [HOST], library: { port: (stub.address() as AddressInfo).port } });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await new Promise((r) => stub.close(r));
    vi.unstubAllEnvs();
  });

  const signIn = async () => {
    const r = await app.inject({ method: 'POST', url: '/api/setup', headers: { host: HOST, 'content-type': 'application/json' },
      payload: { workspaceName: 'W', name: 'Me', email: 'me@x.io', password: 'pw-owner' } });
    const c = (r.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session')!;
    return `jt_session=${c.value}`;
  };
  const send = (cookie: string, body: Buffer, extra: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: '/api/suggestions', remoteAddress, payload: body,
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/zip', cookie, ...extra } });

  it('says local in /api/status and forwards the zip unchanged, with the answer as it is', async () => {
    const status = (await app.inject({ method: 'GET', url: '/api/status', headers: { host: HOST } })).json();
    expect(status.suggestions).toEqual({ via: 'local' });
    const cookie = await signIn();
    const zip = Buffer.from(suggestionZip('More colours, please.', [PNG]));
    const r = await send(cookie, zip);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: 'questlog/20261118-120000-abcdef12.zip' });
    expect(got).toHaveLength(1);
    expect(got[0].method).toBe('POST');
    expect(got[0].url).toMatch(/^\/team\/suggestions\?tool=questlog&version=[0-9A-Za-z.+-]+&os=(linux|windows|macos)$/);
    expect(got[0].type).toBe('application/zip');
    expect(got[0].body.equals(zip)).toBe(true);

    reply = { status: 403, body: { error: 'You are not on this team.' } };
    const no = await send(cookie, zip);
    expect(no.statusCode).toBe(403);
    expect(no.json()).toEqual({ error: 'You are not on this team.' });

    reply = { status: 200, body: { login: 'me@x', name: 'Me', role: 'member' } };
    const who = await app.inject({ method: 'GET', url: '/api/suggestions/whoami', headers: { host: HOST, cookie } });
    expect(who.json()).toEqual({ login: 'me@x', name: 'Me', role: 'member' });
    expect(got.at(-1)!.url).toBe('/team/whoami');
  });

  it('answers only a signed-in person on loopback, a zip, at most 20 MB', async () => {
    const cookie = await signIn();
    const zip = Buffer.from(suggestionZip('x', []));
    expect((await send('', zip)).statusCode).toBe(401);
    expect((await send(cookie, zip, {}, '100.64.0.7')).statusCode).toBe(403);
    expect((await send(cookie, zip, { 'x-forwarded-for': '100.64.0.7' })).statusCode).toBe(403);
    expect((await send(cookie, zip, { 'content-type': 'text/plain' })).statusCode).toBe(415);
    const big = await send(cookie, Buffer.alloc(SUGGESTION_LIMITS.zipBytes + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatch(/over 20 MB/);
    expect(got).toHaveLength(0); // nothing reached the library service
  });

  it('forwards a zip near the limit (well past the server-wide body limit)', async () => {
    const cookie = await signIn();
    const zip = Buffer.alloc(SUGGESTION_LIMITS.zipBytes - 1024, 7);
    const r = await send(cookie, zip);
    expect(r.statusCode).toBe(201);
    expect(got).toHaveLength(1);
    expect(got[0].body.equals(zip)).toBe(true);
  });

  it('counts the body as it arrives when no length is given', async () => {
    const cookie = await signIn();
    const { Readable } = await import('node:stream');
    const chunk = Buffer.alloc(1024 * 1024);
    const body = Readable.from((function* () { for (let i = 0; i < 21; i++) yield chunk; })());
    const r = await app.inject({ method: 'POST', url: '/api/suggestions', payload: body,
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/zip', cookie } });
    expect(r.statusCode).toBe(413);
    expect(got).toHaveLength(0);
  });

  it('is not there on a team server', async () => {
    vi.stubEnv('JT_WORKSPACE_LABEL', '');
    const cookie = await signIn();
    expect((await send(cookie, Buffer.from(suggestionZip('x', [])))).statusCode).toBe(404);
  });

  it('says so when the library service is down', async () => {
    const cookie = await signIn();
    await new Promise((r) => stub.close(r));
    stub = createServer();
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as AddressInfo).port;
    await new Promise((r) => stub.close(r));
    await app.close();
    app = buildApp({ db, hosts: [HOST], library: { port } });
    await app.ready();
    stub = createServer(); // closed in afterEach
    const r = await send(cookie, Buffer.from(suggestionZip('x', [])));
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/can't reach your team's server/);
  });

  it('looks the team host up once and connects to the address it checked', async () => {
    const cookie = await signIn();
    const port = (stub.address() as AddressInfo).port;
    const zip = Buffer.from(suggestionZip('x', []));
    const rebuild = async (lookup: (h: string) => Promise<string[]>) => {
      await app.close();
      app = buildApp({ db, hosts: [HOST], library: { port, lookup } });
      await app.ready();
    };
    vi.stubEnv('JATIFY_TEAM', 'team.example');
    // A name with any public address is refused before anything connects.
    for (const answer of [['8.8.8.8'], ['127.0.0.1', '8.8.8.8']]) {
      await rebuild(async () => answer);
      const r = await send(cookie, zip);
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatch(/not on a private network or Tailscale/);
    }
    expect(got).toHaveLength(0);
    // A private answer: asked once, the connection goes to that address, Host keeps the team's name.
    const asked: string[] = [];
    await rebuild(async (h) => { asked.push(h); return ['127.0.0.1']; });
    let host = '';
    stub.removeAllListeners('request');
    stub.on('request', (req, res) => { host = String(req.headers.host); got.push({ method: req.method!, url: req.url!, type: '', body: Buffer.alloc(0) }); req.resume(); res.writeHead(201).end('{"id":"q/x.zip"}'); });
    expect((await send(cookie, zip)).statusCode).toBe(201);
    expect(asked).toEqual(['team.example']);
    expect(host).toBe(`team.example:${port}`);
  });

  it('only sends to private or Tailscale addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '100.100.1.1', '::1', 'fd7a:115c:a1e0::5', '::ffff:10.0.0.2']) {
      expect(privateOrTailnet(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:db8::1']) expect(privateOrTailnet(ip), ip).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { LIBRARY_CAPS, libraryPath, shelfKind } from '../shared/library';
import { checkLibrary, libraryTargetOf, packIndex, libJson, libPicture, _clearIndexCache } from '../web/src/library';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// Reading the team's library for the Assets page (contract: ShelfServer 0.7.0, LIBRARY-READ). Which paths may be read,
// the desktop server's read-only forward, and the page's client (show rule, index cache).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('which library paths may be read', () => {
  it('allows only the contract\'s read routes', () => {
    expect(libraryPath('team/whoami')).toBe('/team/whoami');
    expect(libraryPath('library')).toBe('/library');
    expect(libraryPath('library/Undead Pack/index/pack.json')).toBe('/library/Undead%20Pack/index/pack.json');
    expect(libraryPath('library/P1/index/thumbs/ab12.png')).toBe('/library/P1/index/thumbs/ab12.png');
    expect(libraryPath('maps')).toBe('/maps');
    expect(libraryPath('props')).toBe('/props');
    expect(libraryPath('maps/zone0/picture')).toBe('/maps/zone0/picture');
    expect(libraryPath('props/crate/picture?version=3')).toBe('/props/crate/picture?version=3');
  });

  it('refuses everything else', () => {
    for (const p of ['library/P1/files/x', 'library/P1/files', 'library/P1/index/../../x', 'library/P1/index/./x', 'library/../maps',
      'library/P1/index/%2e%2e/x', 'library/P1/index/', 'library/P1/index', 'team/suggestions', 'team/projects', 'maps/zone0/pack',
      'maps/zone0/picture?version=x', 'maps/zone0/picture?other=1', 'maps/zone0', '/library', 'library/P1/index/a\\b', '']) {
      expect(libraryPath(p), p).toBeNull();
    }
  });

  it('knows a model by its class', () => {
    expect(shelfKind('StaticMesh')).toBe('model');
    expect(shelfKind('SkeletalMesh')).toBe('model');
    expect(shelfKind('Texture2D')).toBe('picture');
    expect(shelfKind(undefined)).toBe('picture');
  });
});

describe('the desktop server\'s library forward', () => {
  const HOST = 'localhost:8790';
  let db: Db;
  let app: FastifyInstance;
  let stub: Server;
  let got: string[];
  let handle: (req: IncomingMessage, res: ServerResponse) => void;
  let cookie: string;

  beforeEach(async () => {
    _resetLimiter();
    got = [];
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    stub = createServer((req, res) => { got.push(req.url!); handle(req, res); });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    vi.stubEnv('JT_WORKSPACE_LABEL', 'This computer');
    vi.stubEnv('JATIFY_TEAM', '127.0.0.1');
    db = openDb(':memory:');
    app = buildApp({ db, hosts: [HOST], library: { port: (stub.address() as AddressInfo).port } });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/setup', headers: { host: HOST, 'content-type': 'application/json' },
      payload: { workspaceName: 'W', name: 'Me', email: 'me@x.io', password: 'pw-owner' } });
    cookie = `jt_session=${(r.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session')!.value}`;
  });
  afterEach(async () => {
    await app.close();
    stub.closeAllConnections();
    await new Promise((r) => stub.close(r));
    vi.unstubAllEnvs();
  });
  const get = (path: string, extra: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'GET', url: `/api/library/${path}`, remoteAddress, headers: { host: HOST, cookie, ...extra } });

  it('passes a picture through unchanged', async () => {
    const r = await get('library/Undead%20Pack/index/thumbs/a.png');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.equals(PNG)).toBe(true);
    expect(got).toEqual(['/library/Undead%20Pack/index/thumbs/a.png']);
  });

  it('passes JSON through, and the library service\'s status', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"login":"me@x","role":"member","version":"0.7.0"}');
    const r = await get('team/whoami');
    expect(r.json()).toEqual({ login: 'me@x', role: 'member', version: '0.7.0' });
    handle = (_q, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"none"}');
    expect((await get('maps/zone0/picture')).statusCode).toBe(404);
  });

  it('never asks for anything outside the read routes', async () => {
    for (const p of ['library/P1/files/x', 'library/P1/index/..%2F..%2Fx', 'library/P1/index/%2e%2e/x', 'team/suggestions', 'library/P1/index/%zz']) {
      expect([400, 404], p).toContain((await get(p)).statusCode); // a malformed escape is 400 before routing
    }
    expect(got).toEqual([]);
  });

  it('refuses answers that are not JSON or a picture, or too long', async () => {
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<script>x</script>');
    expect((await get('library')).statusCode).toBe(502);
    handle = (_q, res) => res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(LIBRARY_CAPS.picture + 1) }).end();
    expect((await get('maps/a/picture')).statusCode).toBe(502);
  });

  it('answers only a signed-in person on loopback, on This computer', async () => {
    expect((await get('library', { cookie: '' })).statusCode).toBe(401);
    expect((await get('library', {}, '100.64.0.7')).statusCode).toBe(403);
    expect((await get('library', { 'x-forwarded-for': '100.64.0.7' })).statusCode).toBe(403);
    vi.stubEnv('JT_WORKSPACE_LABEL', '');
    expect((await get('library')).statusCode).toBe(404);
    expect(got).toEqual([]);
  });

  const rebuild = async (timeouts: { firstMs?: number; idleMs?: number }) => {
    await app.close();
    app = buildApp({ db, hosts: [HOST], library: { port: (stub.address() as AddressInfo).port }, libraryTimeouts: timeouts });
    await app.ready();
  };

  it('gives up when the first answer is slow, but not on a long answer that keeps coming', async () => {
    await rebuild({ firstMs: 150, idleMs: 150 });
    handle = (_q, res) => { setTimeout(() => { if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end('[]'); }, 400); };
    expect((await get('library')).statusCode).toBe(502);
    // Twelve pieces 60 ms apart: longer than both limits together, never idle for one.
    handle = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      let i = 0;
      const t = setInterval(() => { if (++i < 12) res.write(i === 1 ? '[0' : `,${i}`); else { clearInterval(t); res.end(']'); } }, 60);
    };
    const r = await get('library');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(11);
  });

  it('cuts an answer that stops coming', async () => {
    await rebuild({ firstMs: 1000, idleMs: 150 });
    let upstreamClosed = false;
    handle = (_q, res) => { res.on('close', () => { upstreamClosed = true; }); res.writeHead(200, { 'content-type': 'application/json' }); res.write('[1'); };
    const r = await get('library').catch((e) => e);
    expect(r instanceof Error || r.body !== '[1]').toBe(true);
    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 2000 });
  });

  it('closes the library service\'s answer when the page goes away', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    let upstreamClosed = false;
    handle = (_q, res) => { res.on('close', () => { upstreamClosed = true; }); res.writeHead(200, { 'content-type': 'application/json' }); res.write('[1'); };
    const { request } = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, path: '/api/library/library', headers: { host: HOST, cookie } }, (res) => {
        res.once('data', () => { q.destroy(); resolve(); });
      });
      q.on('error', () => {});
      q.end();
      setTimeout(() => reject(new Error('no answer')), 3000);
    });
    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 2000 });
  });

  it('says so when the library service is down', async () => {
    stub.closeAllConnections();
    await new Promise((r) => stub.close(r));
    stub = createServer();
    const r = await get('library');
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/can't reach your team's server/);
  });
});

describe('the page\'s library client', () => {
  const answer = (routes: Record<string, () => Response>) => vi.fn(async (url: string) => {
    const hit = Object.keys(routes).find((k) => url.endsWith(k));
    if (!hit) throw new TypeError('offline');
    return routes[hit]();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads through this server on This computer, straight from a team server', () => {
    expect(libraryTargetOf({ via: 'local' })).toEqual({ base: '/api/library', credentials: 'same-origin' });
    expect(libraryTargetOf({ via: 'direct', host: 'nas', version: '0.3.0' })).toEqual({ base: 'http://nas:8781', credentials: 'omit' });
    expect(libraryTargetOf(null)).toBeNull();
  });

  it('opens the browsers only for a member on 0.7.0 or later', async () => {
    expect((await checkLibrary(null, answer({}))).state).toBe('none');
    expect((await checkLibrary({ via: 'local' }, answer({ '/team/whoami': json({ role: 'member', version: '0.7.0' }) }))).state).toBe('ok');
    expect((await checkLibrary({ via: 'local' }, answer({ '/team/whoami': json({ role: 'member', version: '0.6.3' }) }))).state).toBe('old');
    expect((await checkLibrary({ via: 'local' }, answer({ '/team/whoami': json({ role: null, version: '0.7.0' }) }))).state).toBe('old');
    expect((await checkLibrary({ via: 'local' }, answer({ '/team/whoami': json({ error: 'x' }, 403) }))).state).toBe('old');
    expect((await checkLibrary({ via: 'direct', host: 'nas', version: '1' }, answer({}))).state).toBe('old'); // blocked by the browser
  });

  it('reads JSON and pictures, refusing other answers', async () => {
    const t = libraryTargetOf({ via: 'local' })!;
    const f = answer({ '/maps': json([{ id: 'zone0' }]), '/maps/zone0/picture': () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      '/maps/x/picture': () => new Response('<p>', { headers: { 'content-type': 'text/html' } }) });
    expect(await libJson(t, 'maps', f)).toEqual([{ id: 'zone0' }]);
    expect((await libPicture(t, 'maps/zone0/picture', f)).type).toBe('image/png');
    await expect(libPicture(t, 'maps/x/picture', f)).rejects.toThrow();
    await expect(libJson(t, 'library/P/files/x', f)).rejects.toThrow();
  });

  it('fetches a pack\'s index once per size and mtime, keeping at most four', async () => {
    _clearIndexCache();
    const t = libraryTargetOf({ via: 'local' })!;
    const f = vi.fn(async () => new Response(JSON.stringify({ engine: 'unreal', assets: [] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    await packIndex(t, 'P1', { size: 10, mtime: 1 }, f);
    await packIndex(t, 'P1', { size: 10, mtime: 1 }, f);
    expect(f.mock.calls).toHaveLength(1);
    expect(String(f.mock.calls[0][0])).toBe('/api/library/library/P1/index/index.json');
    await packIndex(t, 'P1', { size: 10, mtime: 2 }, f); // changed: read again
    expect(f.mock.calls).toHaveLength(2);
    for (const p of ['P2', 'P3', 'P4', 'P5']) await packIndex(t, p, { size: 1, mtime: 1 }, f);
    await packIndex(t, 'P1', { size: 10, mtime: 2 }, f); // pushed out by four newer
    expect(f.mock.calls).toHaveLength(7);
  });
});

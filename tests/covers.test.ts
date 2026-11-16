import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { fetchCoverUrl, isBlockedAddress } from '../server/covers';
import { COVER_ARTWORKS } from '../shared/covers';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let ownerId: string;
let projectId: string;
let deckId: string;
const stubs: Server[] = [];

const coversDir = () => join(dir, 'covers');
const coverFiles = () => (existsSync(coversDir()) ? readdirSync(coversDir()) : []);
const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const hdr = (cookie: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie, ...extra });
const dispatch = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie, { 'content-type': 'application/json' }) });
const dispatchOk = async (name: string, payload: unknown, cookie = owner) => {
  const r = await dispatch(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const upload = (pid: string, body: Buffer, type = 'image/png', cookie = owner) =>
  app.inject({ method: 'POST', url: `/api/covers?projectId=${pid}`, payload: body as any, headers: hdr(cookie, { 'content-type': type }) });
const getCover = (id: string, cookie = owner, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/api/covers/${id}`, headers: hdr(cookie, extra) });
const snap = async () => (await app.inject({ method: 'GET', url: '/api/snapshot', headers: hdr(owner) })).json();
const mkUser = async (role: string, email: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
};
const stub = async (handler: Parameters<typeof createServer>[1]) => {
  const s = createServer(handler);
  stubs.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const ctx = () => ({ db, actor: { id: ownerId } as any, events: [], emit: () => {}, afterCommit: () => {} });
const open = { allowAddress: () => true };

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `covers-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users').get() as any).id;
  projectId = (await dispatchOk('projects/create', { name: 'P' })).id;
  deckId = (await dispatchOk('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => {
  for (const s of stubs.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cover art', () => {
  it('has 13 named artworks', () => {
    expect(COVER_ARTWORKS.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(COVER_ARTWORKS.every((a) => a.name.length > 0)).toBe(true);
  });
  it('round-trips through the snapshot and rejects bad ids', async () => {
    await dispatchOk('decks/update', { id: deckId, cover: { kind: 'art', id: 7 } });
    await dispatchOk('projects/update', { id: projectId, cover: { kind: 'art', id: 3 } });
    let s = await snap();
    expect(s.decks[0].cover).toEqual({ kind: 'art', id: 7 });
    expect(s.projects[0].cover).toEqual({ kind: 'art', id: 3 });
    expect((await dispatch('decks/update', { id: deckId, cover: { kind: 'art', id: 14 } })).statusCode).toBe(400);
    expect((await dispatch('decks/update', { id: deckId, cover: { kind: 'art', id: 0 } })).statusCode).toBe(400);
    await dispatchOk('decks/update', { id: deckId, cover: null });
    s = await snap();
    expect(s.decks[0].cover).toBeNull();
  });
  it('lists/create takes a cover and records the creator', async () => {
    const { id } = await dispatchOk('decks/create', { title: 'E', projectId, cover: { kind: 'art', id: 2 } });
    const d = (await snap()).decks.find((x: any) => x.id === id);
    expect(d.cover).toEqual({ kind: 'art', id: 2 });
    expect(d.creatorId).toBe(ownerId);
  });
});

describe('cover upload', () => {
  it('stores, serves with private no-cache and an ETag', async () => {
    const up = await upload(projectId, PNG);
    expect(up.statusCode, up.body).toBe(200);
    const id = up.json().id;
    const g = await getCover(id);
    expect(g.statusCode).toBe(200);
    expect(Buffer.compare(g.rawPayload, PNG)).toBe(0);
    expect(g.headers['cache-control']).toBe('private, no-cache');
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect(g.headers.etag).toBe(`"${id}"`);
    await dispatchOk('decks/update', { id: deckId, cover: { kind: 'file', fileId: id } });
    expect((await snap()).decks[0].cover).toEqual({ kind: 'file', fileId: id });
  });
  it('rejects 11 MB with 413 and leaves no file', async () => {
    const r = await upload(projectId, Buffer.alloc(11 * 1024 * 1024, 1));
    expect(r.statusCode).toBe(413);
    expect(coverFiles()).toEqual([]);
  });
  it('rejects non-image types with 415', async () => {
    const r = await upload(projectId, Buffer.from('<script>1</script>'), 'text/html');
    expect(r.statusCode).toBe(415);
    expect(coverFiles()).toEqual([]);
  });
  it('needs content.edit to upload', async () => {
    const obs = await mkUser('observer', 'ob@x.io', [projectId]);
    expect((await upload(projectId, PNG, 'image/png', obs)).statusCode).toBe(404);
  });
  it('404s a user without project access; 304 only with a valid session', async () => {
    const id = (await upload(projectId, PNG)).json().id;
    const other = await mkUser('observer', 'o2@x.io', []);
    expect((await getCover(id, other)).statusCode).toBe(404);
    expect((await getCover(id, other, { 'if-none-match': `"${id}"` })).statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: `/api/covers/${id}`, headers: { host: HOST, 'if-none-match': `"${id}"` } });
    expect(anon.statusCode).not.toBe(304);
    expect(anon.statusCode).not.toBe(200);
    const ok = await getCover(id, owner, { 'if-none-match': `"${id}"` });
    expect(ok.statusCode).toBe(304);
    expect(ok.headers['cache-control']).toBe('private, no-cache');
  });
  it('deleting the project removes its cover files', async () => {
    await upload(projectId, PNG);
    expect(coverFiles().length).toBe(1);
    await dispatchOk('projects/delete', { id: projectId });
    await vi.waitFor(() => expect(coverFiles()).toEqual([]));
  });
});

describe('cross-project cover', () => {
  it('rejects a file cover of another project with bad_cover', async () => {
    const q = (await dispatchOk('projects/create', { name: 'Q' })).id;
    const qDeck = (await dispatchOk('decks/create', { title: 'QD', projectId: q })).id;
    const id = (await upload(projectId, PNG)).json().id;
    const r = await dispatch('decks/update', { id: qDeck, cover: { kind: 'file', fileId: id } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('bad_cover');
    const r2 = await dispatch('projects/update', { id: q, cover: { kind: 'file', fileId: id } });
    expect(r2.json().error).toBe('bad_cover');
    const r3 = await dispatch('decks/update', { id: qDeck, cover: { kind: 'file', fileId: 'nope' } });
    expect(r3.json().error).toBe('bad_cover');
  });
});

describe('cover url guard', () => {
  it('isBlockedAddress', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', 'fd00::1', 'fe80::1', '0.0.0.0', '::',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101',
      '198.18.0.1', '198.19.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.5', '100.64.0.1',
      'fec0::1', 'ff02::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '1::1', '::2',
      '::ffff:0:7f00:1', '::ffff:0:c0a8:101', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::c0a8:101', '64:ff9b:1:7f::0:0',
      '2002:7f00:1::1', '2002:0a00:1::', '2002:c0a8:101::1', 'fc00::1', 'fe80::1%eth0']) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '198.17.0.1', '198.20.0.1', '2606:4700::1111', '2a00:1450::1', '::ffff:8.8.8.8', '::ffff:0:808:808', '64:ff9b::808:808', '2002:808:808::1', '2001:4860::8888']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('refuses loopback, localhost and non-http schemes', async () => {
    const base = await stub((_q, s) => { s.writeHead(200, { 'content-type': 'image/png' }); s.end(PNG); });
    for (const u of [`${base}/x.png`, base.replace('127.0.0.1', 'localhost') + '/x.png', 'ftp://example.com/x.png', 'file:///etc/passwd', 'not a url', 'http://[::1]:1/x', 'http://user:pw@203.0.113.5/x']) {
      await expect(fetchCoverUrl(ctx(), projectId, u), u).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
    }
    expect(coverFiles()).toEqual([]);
  });
  it('fetches an image when the address is admitted (test option)', async () => {
    const base = await stub((_q, s) => { s.writeHead(200, { 'content-type': 'image/png; charset=x' }); s.end(PNG); });
    const id = await fetchCoverUrl(ctx(), projectId, `${base}/x.png`, open);
    expect(coverFiles()).toEqual([id]);
    expect((await getCover(id)).statusCode).toBe(200);
  });
  it('a workspace at its plan storage limit cannot set a cover from a URL: 413 plan_limit, nothing stored', async () => {
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    db.prepare("INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,?,'image/png',?,0)").run(newId(), projectId, ownerId, 1024 ** 3 - 10);
    const base = await stub((_q, s) => { s.writeHead(200, { 'content-type': 'image/png' }); s.end(PNG); });
    await expect(fetchCoverUrl(ctx(), projectId, `${base}/x.png`, open)).rejects.toMatchObject({ status: 413, code: 'plan_limit', data: { limit: 'storage' } });
    expect(coverFiles()).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) n FROM covers').get() as { n: number }).n).toBe(1);
  });
  it('rejects non-image content types', async () => {
    const base = await stub((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<b>x</b>'); });
    await expect(fetchCoverUrl(ctx(), projectId, `${base}/x`, open)).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
    expect(coverFiles()).toEqual([]);
  });
  it('rejects a body past 10 MB and leaves no file', async () => {
    const base = await stub((_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let n = 0;
      const pump = () => { while (n < 30) { n++; if (!s.write(chunk)) return void s.once('drain', pump); } s.end(); };
      pump();
    });
    await expect(fetchCoverUrl(ctx(), projectId, `${base}/big`, open)).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
    expect(coverFiles()).toEqual([]);
  });
  it('follows at most 3 redirects', async () => {
    const mk = (hops: number) => stub((q, s) => {
      const n = Number(q.url!.slice(1) || 0);
      if (n < hops) { s.writeHead(302, { location: `/${n + 1}` }); return void s.end(); }
      s.writeHead(200, { 'content-type': 'image/png' }); s.end(PNG);
    });
    const ok = await mk(3);
    await expect(fetchCoverUrl(ctx(), projectId, ok + '/0', open)).resolves.toBeTruthy();
    const bad = await mk(4);
    await expect(fetchCoverUrl(ctx(), projectId, bad + '/0', open)).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
  });
  it('destroys the connection of a redirect with an endless body', async () => {
    let closed!: () => void;
    const gone = new Promise<void>((r) => { closed = r; });
    const base = await stub((q, s) => {
      s.writeHead(302, { location: '/next' });
      const t = setInterval(() => s.write('x'.repeat(1024)), 5);
      q.socket.once('close', () => { clearInterval(t); closed(); });
    });
    await expect(fetchCoverUrl(ctx(), projectId, base + '/a', { allowAddress: (() => { let n = 0; return () => n++ < 1; })() })).rejects.toMatchObject({ code: 'bad_cover_url' });
    await Promise.race([gone, new Promise((_r, rej) => setTimeout(() => rej(new Error('socket still open')), 2000))]);
  });
  it('destroys the connection when the body passes the cap', async () => {
    let closed!: () => void;
    const gone = new Promise<void>((r) => { closed = r; });
    const base = await stub((q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      const t = setInterval(() => s.write(Buffer.alloc(1024 * 1024, 1)), 1);
      q.socket.once('close', () => { clearInterval(t); closed(); });
    });
    await expect(fetchCoverUrl(ctx(), projectId, base + '/big', open)).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
    await Promise.race([gone, new Promise((_r, rej) => setTimeout(() => rej(new Error('socket still open')), 2000))]);
    expect(coverFiles()).toEqual([]);
  });
  it('re-validates every redirect hop', async () => {
    const base = await stub((_q, s) => { s.writeHead(302, { location: 'http://192.168.1.1/x.png' }); s.end(); });
    let seen = 0;
    const allowFirstOnly = (ip: string) => { seen++; return ip === '127.0.0.1' && seen === 1; };
    await expect(fetchCoverUrl(ctx(), projectId, base + '/a', { allowAddress: allowFirstOnly })).rejects.toMatchObject({ status: 400, code: 'bad_cover_url' });
    expect(seen).toBe(2);
  });
  it('commands fetch coverUrl before storing; a blocked url is 400 bad_cover_url', async () => {
    const r = await dispatch('decks/update', { id: deckId, coverUrl: 'http://127.0.0.1:9/x.png' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('bad_cover_url');
    const p = await dispatch('projects/create', { name: 'Z', coverUrl: 'http://127.0.0.1:9/x.png' });
    expect(p.json().error).toBe('bad_cover_url');
    expect((await snap()).projects.map((x: any) => x.name)).toEqual(['P']);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { cleanName, contentDisposition } from '../server/file-routes';
import { sweepFilesDir } from '../server/files';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let deckId: string;
let projectId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const hdr = (cookie: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie, ...extra });
const dispatchOk = async (name: string, payload: unknown, cookie = owner) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie, { 'content-type': 'application/json' }) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const upload = (cardId: string, name: string, body: Buffer | Readable, type = 'application/octet-stream', cookie = owner) =>
  app.inject({ method: 'POST', url: `/api/cards/${cardId}/files?name=${encodeURIComponent(name)}`, payload: body as any, headers: hdr(cookie, { 'content-type': type }) });
const getFile = (id: string, cookie = owner) => app.inject({ method: 'GET', url: `/api/files/${id}`, headers: hdr(cookie) });
const mkCard = async (d = deckId) => (await dispatchOk('cards/create', { content: 'C', deckId: d })).id as string;
const cover = (id: string) => (db.prepare('SELECT cover_file_id c FROM cards WHERE id=?').get(id) as any).c as string | null;
const setCover = (v: string) => dispatchOk('accounts/update', { settings: { coverFromAttachments: v } });
const mkUser = async (role: string, email: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
};
const png = (cardId: string, name = 'a.png') => upload(cardId, name, PNG, 'image/png').then((r) => r.json().id as string);

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `files-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 1 });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await dispatchOk('projects/create', { name: 'P' })).id;
  deckId = (await dispatchOk('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attachments', () => {
  it('upload and download', async () => {
    const c = await mkCard();
    const up = await upload(c, 'pic.png', PNG, 'image/png');
    expect(up.statusCode, up.body).toBe(200);
    const id = up.json().id;
    const dl = await getFile(id);
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^inline/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toBe('private, no-cache');
    expect(dl.headers.etag).toBe(`"${id}"`);
    const html = await upload(c, 'evil ü.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    const h = await getFile(html.json().id);
    expect(h.headers['content-disposition']).toMatch(/^attachment; filename="evil _\.html"; filename\*=UTF-8''evil%20%C3%BC\.html$/);
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    // svg is never inline
    const svg = await upload(c, 'x.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    expect((await getFile(svg.json().id)).headers['content-disposition']).toMatch(/^attachment/);
  });

  it('sanitizes names and ignores them as paths', async () => {
    const c = await mkCard();
    const r = await upload(c, '../../etc/pa\u0001ss' + 'x'.repeat(300), Buffer.from('a'));
    expect(r.statusCode).toBe(200);
    const row = db.prepare('SELECT name FROM files WHERE id=?').get(r.json().id) as any;
    expect(row.name).not.toMatch(/[\/\\\u0001]/);
    expect(row.name.length).toBeLessThanOrEqual(200);
    expect(readdirSync(dir)).toEqual([r.json().id]);
  });

  it('file access', async () => {
    const q = (await dispatchOk('projects/create', { name: 'Q', visibility: 'limited' })).id;
    const qd = (await dispatchOk('decks/create', { title: 'Q', projectId: q })).id;
    const c = await mkCard(qd);
    const id = (await upload(c, 'a.txt', Buffer.from('hi'))).json().id;
    const m = await mkUser('member', 'm@x.io');
    expect((await getFile(id, m)).statusCode).toBe(404);
    expect((await upload(c, 'b.txt', Buffer.from('hi'), 'text/plain', m)).statusCode).toBe(404);
    expect((await getFile(newId())).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { host: HOST } })).statusCode).toBe(401);
  });

  it('observer cannot upload; CSRF applies', async () => {
    const c = await mkCard();
    const o = await mkUser('observer', 'ob@x.io', [projectId]);
    expect((await upload(c, 'a.txt', Buffer.from('hi'), 'text/plain', o)).statusCode).toBe(403);
    const x = await app.inject({ method: 'POST', url: `/api/cards/${c}/files?name=a`, payload: Buffer.from('x') as any,
      headers: hdr(owner, { 'content-type': 'text/plain', origin: 'http://evil.example' }) });
    expect(x.statusCode).toBe(403);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('upload cap', async () => {
    const c = await mkCard();
    const chunk = Buffer.alloc(256 * 1024, 1);
    const stream = Readable.from((function* () { for (let i = 0; i < 8; i++) yield chunk; })());
    const r = await upload(c, 'big.bin', stream);
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('file_too_large');
    expect(readdirSync(dir)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) n FROM files').get() as any).n).toBe(0);
    // declared length too
    const big = await upload(c, 'big2.bin', Buffer.alloc(2 * 1024 * 1024));
    expect(big.statusCode).toBe(413);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('streams over a real socket', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const c = await mkCard();
    const send = (total: number) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/cards/${c}/files?name=r.bin`,
        headers: { host: HOST, cookie: owner, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let sent = 0; sent < total; sent += chunk.length) req.write(chunk);
      req.end();
    });
    const ok = await send(900 * 1024);
    expect(ok.status, ok.body).toBe(200);
    const id = JSON.parse(ok.body).id;
    expect((db.prepare('SELECT size s FROM files WHERE id=?').get(id) as any).s).toBe(Math.ceil((900 * 1024) / 65536) * 65536);
    const big = await send(3 * 1024 * 1024).catch(() => ({ status: 413, body: '' }));
    expect(big.status).toBe(413);
    expect(readdirSync(dir)).toEqual([id]);
  });

  it('cover rules', async () => {
    const c = await mkCard();
    expect(cover(c)).toBeNull();
    const txt = (await upload(c, 'n.txt', Buffer.from('x'), 'text/plain')).json().id;
    expect(cover(c)).toBeNull();
    const a = await png(c, 'a.png');
    await new Promise((r) => setTimeout(r, 5));
    const b = await png(c, 'b.png');
    expect(txt).toBeTruthy();
    expect(cover(c)).toBe(a);
    await setCover('latest');
    expect(cover(c)).toBe(b);
    await setCover('none');
    expect(cover(c)).toBeNull();
    await setCover('first');
    expect(cover(c)).toBe(a);
  });

  it('hero takes its subtask cover', async () => {
    const hero = await mkCard();
    const sub = await mkCard();
    await dispatchOk('cards/update', { id: hero, childCards: [sub] });
    const f = await png(sub);
    expect(cover(sub)).toBe(f);
    expect(cover(hero)).toBe(f);
    const own = await png(hero, 'own.png');
    expect(cover(hero)).toBe(own);
    await dispatchOk('cards/removeFile', { fileId: own });
    expect(cover(hero)).toBe(f);
    await dispatchOk('accounts/update', { settings: { heroCoverFromSubs: false } });
    expect(cover(hero)).toBeNull();
    await dispatchOk('accounts/update', { settings: { heroCoverFromSubs: true } });
    expect(cover(hero)).toBe(f);
    await dispatchOk('cards/update', { id: hero, childCards: [] });
    expect(cover(hero)).toBeNull();
  });

  it('remove file', async () => {
    const c = await mkCard();
    const a = await png(c, 'a.png');
    const b = await png(c, 'b.png');
    expect(cover(c)).toBe(a);
    await dispatchOk('cards/removeFile', { fileId: a });
    expect(db.prepare('SELECT 1 FROM files WHERE id=?').get(a)).toBeUndefined();
    await vi.waitFor(() => expect(existsSync(join(dir, a))).toBe(false));
    expect(existsSync(join(dir, b))).toBe(true);
    expect(cover(c)).toBe(b);
    const o = await mkUser('observer', 'ob@x.io', [projectId]);
    const r = await app.inject({ method: 'POST', url: '/dispatch/cards/removeFile', payload: { fileId: b }, headers: hdr(o, { 'content-type': 'application/json' }) });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/dispatch/cards/removeFile', payload: { fileId: newId() }, headers: hdr(owner, { 'content-type': 'application/json' }) })).statusCode).toBe(404);
  });

  it('events: upload and remove publish file + task', async () => {
    const seen: any[] = [];
    const spy = vi.spyOn(app.hub, 'publish').mockImplementation((_a, ev) => { seen.push(...ev); });
    const c = await mkCard();
    seen.length = 0;
    const f = await png(c);
    expect(seen.map((e) => `${e.model}:${e.op}`).sort()).toEqual(['card:upsert', 'file:upsert']);
    expect(seen.find((e) => e.model === 'file').row).toMatchObject({ id: f, cardId: c, name: 'a.png', mime: 'image/png', size: PNG.length });
    seen.length = 0;
    await dispatchOk('cards/removeFile', { fileId: f });
    expect(seen.find((e) => e.model === 'file')).toMatchObject({ op: 'remove', row: { id: f, cardId: c } });
    spy.mockRestore();
  });

  it('project delete removes disk files', async () => {
    const c = await mkCard();
    const f = await png(c);
    expect(existsSync(join(dir, f))).toBe(true);
    await dispatchOk('projects/delete', { id: projectId });
    await vi.waitFor(() => expect(existsSync(join(dir, f))).toBe(false));
  });
});

describe('file history', () => {
  const kinds = (cardId: string) => (db.prepare('SELECT changes_json j FROM card_history WHERE card_id=? ORDER BY version').all(cardId) as { j: string }[])
    .flatMap((r) => JSON.parse(r.j)).filter((c: any) => c.kind === 'file');
  it('records an upload and a removal on the task, bumping its version', async () => {
    const id = await mkCard();
    const v0 = (db.prepare('SELECT version v FROM cards WHERE id=?').get(id) as any).v;
    const fid = await png(id, 'flag.png');
    expect(kinds(id)).toEqual([{ kind: 'file', from: null, to: 'flag.png' }]);
    expect((db.prepare('SELECT version v FROM cards WHERE id=?').get(id) as any).v).toBe(v0 + 1);
    await dispatchOk('cards/removeFile', { fileId: fid });
    expect(kinds(id)).toEqual([{ kind: 'file', from: null, to: 'flag.png' }, { kind: 'file', from: 'flag.png', to: null }]);
  });
});

describe('final review fixes', () => {
  it('download revalidates by id ETag, and only after the access check', async () => {
    const c = await mkCard();
    const f = await png(c);
    const first = await getFile(f);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.headers.etag).toBe(`"${f}"`);
    const again = await app.inject({ method: 'GET', url: `/api/files/${f}`, headers: hdr(owner, { 'if-none-match': `"${f}"` }) });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    const other = await app.inject({ method: 'GET', url: `/api/files/${f}`, headers: hdr(owner, { 'if-none-match': '"nope"' }) });
    expect(other.statusCode).toBe(200);
    // A user who cannot see the card gets 404 even with a matching ETag.
    const q = (await dispatchOk('projects/create', { name: 'Q', visibility: 'limited' })).id;
    const qd = (await dispatchOk('decks/create', { title: 'Q', projectId: q })).id;
    const hidden = await png(await mkCard(qd));
    const m = await mkUser('member', 'm2@x.io');
    const r = await app.inject({ method: 'GET', url: `/api/files/${hidden}`, headers: hdr(m, { 'if-none-match': `"${hidden}"` }) });
    expect(r.statusCode).toBe(404);
  });

  it('upload refuses a task deleted while the bytes were streaming', async () => {
    const c = await mkCard();
    const chunk = Buffer.alloc(16 * 1024, 3);
    const stream = Readable.from((function* () {
      yield chunk;
      // Another request deletes the card before the upload finishes.
      db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(c);
      yield chunk;
    })());
    const r = await upload(c, 'late.bin', stream);
    expect(r.statusCode, r.body).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) n FROM files').get() as any).n).toBe(0);
  });

  it('upload refuses a task hard-deleted while the bytes were streaming', async () => {
    const c = await mkCard();
    const chunk = Buffer.alloc(16 * 1024, 3);
    const stream = Readable.from((function* () {
      yield chunk;
      db.prepare('DELETE FROM card_history WHERE card_id=?').run(c);
      db.prepare('DELETE FROM cards WHERE id=?').run(c);
      yield chunk;
    })());
    const r = await upload(c, 'late.bin', stream);
    expect(r.statusCode, r.body).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('long emoji names are cut on code points and still download', async () => {
    const name = 'a' + '😀'.repeat(150);
    const clean = cleanName(name);
    expect([...clean].length).toBeLessThanOrEqual(200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clean)).toBe(false);
    expect(() => contentDisposition('attachment', clean)).not.toThrow();
    // Even a stored name with a lone surrogate never breaks the header.
    expect(() => contentDisposition('attachment', 'x\uD83D')).not.toThrow();
    const c = await mkCard();
    const up = await upload(c, name, Buffer.from('hi'));
    expect(up.statusCode, up.body).toBe(200);
    const dl = await getFile(up.json().id);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''a%F0%9F%98%80");
  });

  it('startup sweep removes temp files and files without a row', async () => {
    const c = await mkCard();
    const keep = await png(c);
    writeFileSync(join(dir, '.tmp-' + newId()), 'partial');
    const orphan = newId();
    writeFileSync(join(dir, orphan), 'lost');
    mkdirSync(join(dir, 'subdir'));
    expect(sweepFilesDir(db, dir)).toEqual({ tmp: 1, orphans: 1 });
    expect(readdirSync(dir).sort()).toEqual([keep, 'subdir'].sort());
    expect(sweepFilesDir(db, join(dir, 'missing'))).toEqual({ tmp: 0, orphans: 0 });
  });
});

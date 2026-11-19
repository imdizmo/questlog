import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { sweepFilesDir } from '../server/files';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// The Assets library's server side (server/assets.ts): the table, the stored copies, the routes and commands, and the
// paths that already look after files (startup sweep, project removal, storage used).
const HOST = 'localhost:8790';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let projectId: string;

const assetsDir = () => join(dir, 'assets');
const blobs = () => (existsSync(assetsDir()) ? readdirSync(assetsDir()).sort() : []);
const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const hdr = (cookie: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie, ...extra });
const dispatch = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie, { 'content-type': 'application/json' }) });
const dispatchOk = async (name: string, payload: unknown, cookie = owner) => {
  const r = await dispatch(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const upload = (q: Record<string, string>, body: Buffer, type = 'image/png', cookie = owner) =>
  app.inject({ method: 'POST', url: `/api/assets?${new URLSearchParams({ projectId, ...q })}`, payload: body as any, headers: hdr(cookie, { 'content-type': type }) });
const list = async (cookie = owner, pid = projectId) => app.inject({ method: 'GET', url: `/api/assets?projectId=${pid}`, headers: hdr(cookie) });
const mkUser = async (role: string, email: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
};

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `assets-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 1 });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await dispatchOk('projects/create', { name: 'P' })).id;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('adding from the computer', () => {
  it('keeps a picture and lists it', async () => {
    const r = await upload({ title: 'Beach', kind: 'concept', for: 'Key art' }, PNG);
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a).toMatchObject({ title: 'Beach', kind: 'concept', for: 'Key art', source: 'uploaded', link: null, hasPicture: true, pictureMime: 'image/png', hasModel: false, size: PNG.length, usedIn: [] });
    expect(blobs()).toHaveLength(1);
    const l = await list();
    expect(l.json().items.map((x: any) => x.id)).toEqual([a.id]);
    const pic = await app.inject({ method: 'GET', url: `/api/assets/${a.id}/picture`, headers: hdr(owner) });
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    expect(pic.headers['x-content-type-options']).toBe('nosniff');
    expect(pic.rawPayload.equals(PNG)).toBe(true);
  });

  it('goes by the bytes, not the declared type', async () => {
    const html = await upload({ title: 'x' }, Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/png');
    expect(html.statusCode).toBe(415);
    const gif = await upload({ title: 'x' }, Buffer.from('GIF89a\x01\x00\x01\x00'), 'image/gif');
    expect(gif.statusCode).toBe(415);
    expect(blobs()).toEqual([]);
    // A JPEG sent as PNG is kept as what it is.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    expect((await upload({ title: 'j' }, jpg, 'image/png')).json().pictureMime).toBe('image/jpeg');
  });

  it('refuses more than the file size cap and an empty body', async () => {
    const big = await upload({ title: 'big' }, Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
    expect(big.statusCode).toBe(413);
    expect((await upload({ title: 'e' }, Buffer.alloc(0))).statusCode).toBe(400);
    expect(blobs()).toEqual([]);
  });

  it('keeps a .glb as a 3D model, with a picture added later', async () => {
    const r = await upload({ title: 'Deer', kind: 'picture' }, GLB, 'application/octet-stream');
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json();
    expect(a).toMatchObject({ kind: 'model', hasModel: true, hasPicture: false });
    const m = await app.inject({ method: 'GET', url: `/api/assets/${a.id}/model`, headers: hdr(owner) });
    expect(m.headers['content-type']).toBe('model/gltf-binary');
    expect(m.rawPayload.equals(GLB)).toBe(true);
    const p = await app.inject({ method: 'PUT', url: `/api/assets/${a.id}/picture`, payload: PNG as any, headers: hdr(owner, { 'content-type': 'image/png' }) });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ hasPicture: true, hasModel: true, size: PNG.length + GLB.length });
    expect(blobs()).toHaveLength(2);
    // A model's picture is replaced, the old one removed; a plain picture's is not replaceable.
    await app.inject({ method: 'PUT', url: `/api/assets/${a.id}/picture`, payload: PNG as any, headers: hdr(owner, { 'content-type': 'image/png' }) });
    await vi.waitFor(() => expect(blobs()).toHaveLength(2));
    const pic = (await upload({ title: 'p' }, PNG)).json();
    expect((await app.inject({ method: 'PUT', url: `/api/assets/${pic.id}/picture`, payload: PNG as any, headers: hdr(owner, { 'content-type': 'image/png' }) })).statusCode).toBe(409);
    // A .glb is never a picture.
    expect((await app.inject({ method: 'PUT', url: `/api/assets/${a.id}/picture`, payload: GLB as any, headers: hdr(owner, { 'content-type': 'image/png' }) })).statusCode).toBe(415);
  });

  it('checks the words it is given', async () => {
    expect((await upload({ title: 'x', kind: 'sound' }, PNG)).statusCode).toBe(400);
    expect((await upload({ title: 'x', for: 'Weapons' }, PNG)).statusCode).toBe(400);
    expect((await upload({ title: 'x', source: 'url' }, PNG)).statusCode).toBe(400);
    expect((await upload({ title: 'x', source: 'asset-shelf' }, PNG)).statusCode).toBe(400); // no link
    expect((await upload({ title: '' }, PNG)).json().title).toBe('Untitled');
    expect(blobs()).toHaveLength(1);
  });
});

describe('who may see and change', () => {
  it('needs the project: view to list and fetch, edit to add', async () => {
    const a = (await upload({ title: 'Beach' }, PNG)).json();
    const stranger = await mkUser('observer', 's@x.io'); // no access row: does not see the project
    expect((await list(stranger)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/assets/${a.id}/picture`, headers: hdr(stranger) })).statusCode).toBe(404);
    expect((await upload({ title: 'x' }, PNG, 'image/png', stranger)).statusCode).toBe(404);
    expect((await dispatch('assets/update', { id: a.id, title: 'x' }, stranger)).statusCode).toBe(404);
    const observer = await mkUser('observer', 'v@x.io', [projectId]);
    expect((await list(observer)).statusCode).toBe(200);
    expect((await upload({ title: 'x' }, PNG, 'image/png', observer)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/assets?projectId=nope`, headers: hdr(owner) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/assets/${a.id}/picture`, headers: { host: HOST } })).statusCode).toBe(401);
  });
});

describe('rename, retag, delete', () => {
  it('changes the words and removes the copy', async () => {
    const a = (await upload({ title: 'Beach' }, PNG)).json();
    await dispatchOk('assets/update', { id: a.id, title: 'The beach', kind: 'concept', for: 'Places' });
    expect((await list()).json().items[0]).toMatchObject({ title: 'The beach', kind: 'concept', for: 'Places' });
    await dispatchOk('assets/update', { id: a.id, for: null });
    expect((await list()).json().items[0].for).toBeNull();
    expect((await dispatch('assets/update', { id: a.id, for: 'Weapons' })).statusCode).toBe(400);
    expect((await dispatch('assets/update', { id: a.id, kind: 'model' })).statusCode).toBe(400); // a model needs its .glb
    await dispatchOk('assets/delete', { id: a.id });
    expect((await list()).json().items).toEqual([]);
    await vi.waitFor(() => expect(blobs()).toEqual([]));
    expect((await dispatch('assets/delete', { id: a.id })).statusCode).toBe(404);
  });
});

describe('the paths that already look after files', () => {
  it('the startup sweep keeps asset copies and removes strays', async () => {
    await upload({ title: 'Beach' }, PNG);
    writeFileSync(join(assetsDir(), 'stray'), 'x');
    writeFileSync(join(assetsDir(), '.tmp-x'), 'x');
    expect(sweepFilesDir(db, dir)).toEqual({ tmp: 1, orphans: 1 });
    expect(blobs()).toHaveLength(1);
  });

  it('removing a project removes its copies', async () => {
    await upload({ title: 'Beach' }, PNG);
    await upload({ title: 'Deer' }, GLB);
    expect(blobs()).toHaveLength(2);
    await dispatchOk('projects/delete', { id: projectId });
    await vi.waitFor(() => expect(blobs()).toEqual([]));
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get()).toEqual({ n: 0 });
  });

  it('counts toward storage used', async () => {
    const { uploadRoom } = await import('../server/billing');
    const before = uploadRoom(db);
    await upload({ title: 'Beach' }, PNG);
    expect(before).toBeDefined();
    const used = db.prepare('SELECT (SELECT COALESCE(SUM(size),0) FROM files)+(SELECT COALESCE(SUM(size),0) FROM covers)+(SELECT COALESCE(SUM(picture_size+model_size),0) FROM assets) n').get() as { n: number };
    expect(used.n).toBe(PNG.length);
  });
});

describe('links back to the team library', () => {
  it('needs a well-formed link and takes the team address from the server', async () => {
    vi.stubEnv('JATIFY_TEAM_SERVER', 'nas.example:8780');
    const link = JSON.stringify({ kind: 'asset', pack: 'P1', path: 'Game/Ghoul', server: 'evil.example', packTitle: 'Undead pack' });
    const r = await upload({ title: 'Ghoul', kind: 'model', source: 'asset-shelf', link }, PNG);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'model', hasModel: false, hasPicture: true, link: { server: 'nas.example', kind: 'asset', pack: 'P1', path: 'Game/Ghoul', packTitle: 'Undead pack' } });
    const map = await upload({ title: 'Zone 0', kind: 'map', source: 'groundwork', link: JSON.stringify({ kind: 'map', id: 'zone0', version: 3 }) }, PNG);
    expect(map.json().link).toEqual({ server: 'nas.example', kind: 'map', id: 'zone0', version: 3 });
    expect((await upload({ title: 'x', source: 'groundwork', link: JSON.stringify({ kind: 'map', id: 'z' }) }, PNG)).statusCode).toBe(400);
    expect((await upload({ title: 'x', source: 'groundwork', link: '{nope' }, PNG)).statusCode).toBe(400);
  });

  it('is refused without a team', async () => {
    const link = JSON.stringify({ kind: 'map', id: 'zone0', version: 1 });
    expect((await upload({ title: 'x', kind: 'map', source: 'groundwork', link }, PNG)).statusCode).toBe(400);
  });
});

describe('use as a picture of an entry', () => {
  it('attaches a copy to the entry and lists where it is used', async () => {
    const a = (await upload({ title: 'Ghoul' }, PNG)).json();
    const cardId = (await dispatchOk('wiki/createEntry', { projectId, typeId: null, name: 'Drowned Man' })).id;
    const r = await app.inject({ method: 'POST', url: `/api/assets/${a.id}/use`, payload: { cardId }, headers: hdr(owner, { 'content-type': 'application/json' }) });
    expect(r.statusCode, r.body).toBe(200);
    const file = db.prepare('SELECT * FROM files WHERE id=?').get(r.json().fileId) as any;
    expect(file).toMatchObject({ card_id: cardId, asset_id: a.id, mime: 'image/png', name: 'Ghoul.png', size: PNG.length });
    expect((await list()).json().items[0].usedIn).toEqual([{ cardId, title: 'Drowned Man' }]);
    // The entry's own copy stays when the asset goes.
    await dispatchOk('assets/delete', { id: a.id });
    await vi.waitFor(() => expect(blobs()).toEqual([]));
    expect(existsSync(join(dir, file.id))).toBe(true);
  });

  it('only on an entry of the same project that the person may edit', async () => {
    const a = (await upload({ title: 'Ghoul' }, PNG)).json();
    const other = (await dispatchOk('projects/create', { name: 'Q' })).id;
    const elsewhere = (await dispatchOk('wiki/createEntry', { projectId: other, typeId: null, name: 'Elsewhere' })).id;
    const use = (cardId: string, cookie = owner) => app.inject({ method: 'POST', url: `/api/assets/${a.id}/use`, payload: { cardId }, headers: hdr(cookie, { 'content-type': 'application/json' }) });
    expect((await use(elsewhere)).statusCode).toBe(404);
    expect((await use('nope')).statusCode).toBe(404);
    const here = (await dispatchOk('wiki/createEntry', { projectId, typeId: null, name: 'Here' })).id;
    const observer = await mkUser('observer', 'v@x.io', [projectId]);
    expect((await use(here, observer)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) n FROM files').get()).toEqual({ n: 0 });
  });
});

describe('from a URL', () => {
  it('needs edit rights and refuses private addresses through the route', async () => {
    const send = (payload: object, cookie = owner) => app.inject({ method: 'POST', url: '/api/assets/from-url', payload, headers: hdr(cookie, { 'content-type': 'application/json' }) });
    const observer = await mkUser('observer', 'v@x.io', [projectId]);
    expect((await send({ projectId, url: 'https://example.com/a.png' }, observer)).statusCode).toBe(404);
    expect((await send({ projectId, url: 'http://127.0.0.1:9/a.png' })).statusCode).toBe(400);
    expect((await send({ projectId })).statusCode).toBe(400);
    expect(blobs()).toEqual([]);
  });
});

describe('security review fixes', () => {
  it('re-checks the plan\'s storage inside the action, and leaves no copy behind', async () => {
    const { runAction } = await import('../server/dispatch');
    const { insertAsset, storeAssetBlob } = await import('../server/assets');
    const { Readable } = await import('node:stream');
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    const ownerId = (db.prepare('SELECT id FROM users').get() as { id: string }).id;
    // Stored while there was room; then another upload takes the room before this one is recorded.
    const blob = await storeAssetBlob(db, Readable.from([PNG]), 1024, () => new Error('cap') as any);
    db.prepare("INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,?,'image/png',?,0)").run(newId(), projectId, ownerId, 1024 ** 3 - 10);
    expect(() => runAction(db, { id: ownerId } as any, (ctx) => insertAsset(ctx, { projectId, title: 'x', for: null, source: 'uploaded', link: null }, blob)))
      .toThrow(expect.objectContaining({ status: 413, code: 'plan_limit', data: { limit: 'storage' } }));
    expect(db.prepare('SELECT COUNT(*) n FROM assets').get()).toEqual({ n: 0 });
    // Through the routes: refused, nothing kept (new picture and a model's picture).
    const up = await upload({ title: 'x' }, PNG);
    expect(up.statusCode).toBe(413);
    expect(up.json()).toEqual({ error: 'plan_limit', data: { limit: 'storage' } });
    expect(blobs()).toEqual([blob.id]); // only the one stored by hand above
  });

  it('a model\'s new picture is refused past the storage left', async () => {
    const a = (await upload({ title: 'Deer' }, GLB)).json();
    const ownerId = (db.prepare('SELECT id FROM users').get() as { id: string }).id;
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    db.prepare("INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,?,'image/png',?,0)").run(newId(), projectId, ownerId, 1024 ** 3 - GLB.length - 10);
    const r = await app.inject({ method: 'PUT', url: `/api/assets/${a.id}/picture`, payload: PNG as any, headers: hdr(owner, { 'content-type': 'image/png' }) });
    expect(r.statusCode).toBe(413);
    expect(blobs()).toHaveLength(1);
    expect((await list()).json().items[0].hasPicture).toBe(false);
  });

  it('"Used in" names only entries of the asset\'s own project', async () => {
    const a = (await upload({ title: 'Ghoul' }, PNG)).json();
    const here = (await dispatchOk('wiki/createEntry', { projectId, typeId: null, name: 'Here' })).id;
    await app.inject({ method: 'POST', url: `/api/assets/${a.id}/use`, payload: { cardId: here }, headers: hdr(owner, { 'content-type': 'application/json' }) });
    // A copy on another project's card (as a cloned project's attachments are): never named here.
    const other = (await dispatchOk('projects/create', { name: 'Secret' })).id;
    const there = (await dispatchOk('wiki/createEntry', { projectId: other, typeId: null, name: 'Secret entry' })).id;
    db.prepare("INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at,asset_id) VALUES (?,?,?,'g.png','image/png',1,0,?)").run(newId(), there, (db.prepare('SELECT id FROM users').get() as { id: string }).id, a.id);
    expect((await list()).json().items[0].usedIn).toEqual([{ cardId: here, title: 'Here' }]);
    const { assetRow } = await import('../server/assets');
    expect(assetRow(db, a.id)!.usedIn.map((u) => u.title)).toEqual(['Here']); // what a live event carries
  });
});

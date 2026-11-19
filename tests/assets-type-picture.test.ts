import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// A wiki type's uploaded picture: from the computer (POST /api/wiki/types/:id/picture) or an asset's picture
// (POST /api/assets/:id/use-for-type), each copied into the project's covers and set on the type in one go.
const HOST = 'localhost:8790';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let projectId: string;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const hdr = (cookie: string, extra: Record<string, string> = {}) => ({ host: HOST, cookie, ...extra });
const dispatchOk = async (name: string, payload: unknown, cookie = owner) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie, { 'content-type': 'application/json' }) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const upload = async (body: Buffer, type = 'image/png', pid = projectId) => {
  const r = await app.inject({ method: 'POST', url: `/api/assets?${new URLSearchParams({ projectId: pid, title: 'Wreck' })}`, payload: body as any, headers: hdr(owner, { 'content-type': type }) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
};
const use = (assetId: string, typeId: string, cookie = owner) =>
  app.inject({ method: 'POST', url: `/api/assets/${assetId}/use-for-type`, payload: { typeId }, headers: hdr(cookie, { 'content-type': 'application/json' }) });
const picture = (typeId: string) => JSON.parse((db.prepare('SELECT picture_json p FROM entry_types WHERE id=?').get(typeId) as { p: string | null }).p ?? 'null');
const covers = () => (db.prepare('SELECT id FROM covers WHERE project_id=?').all(projectId) as { id: string }[]).map((r) => r.id);
const mkMember = async (email: string) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, 'M', hashPassword('pw'));
  db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?,'member')").run(id);
  db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(projectId, id);
  return cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } }));
};

beforeEach(async () => {
  _resetLimiter();
  dir = join(homedir(), '.cache/gametracker/scratch', `assets-type-picture-${process.pid}`);
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
  rmSync(dir, { recursive: true, force: true });
});

describe('an asset as a type picture', () => {
  it('copies the picture into a cover of the project and sets it on the type; a second one releases the first', async () => {
    const typeId = (await dispatchOk('wiki/createType', { projectId, name: 'Ship' })).id;
    const asset = await upload(PNG);
    const r = await use(asset, typeId);
    expect(r.statusCode, r.body).toBe(200);
    const { fileId } = r.json();
    expect(picture(typeId)).toEqual({ kind: 'file', fileId });
    expect(covers()).toEqual([fileId]);
    expect(readFileSync(join(dir, 'covers', fileId))).toEqual(PNG);
    // The cover serves like any type picture.
    const got = await app.inject({ method: 'GET', url: `/api/covers/${fileId}`, headers: hdr(owner) });
    expect(got.statusCode).toBe(200);
    // Another asset replaces it; the first copy goes, the asset itself stays.
    const second = (await use(await upload(PNG), typeId)).json().fileId;
    expect(picture(typeId)).toEqual({ kind: 'file', fileId: second });
    expect(covers()).toEqual([second]);
    expect(db.prepare('SELECT 1 FROM assets WHERE id=?').get(asset)).toBeTruthy();
    // Deleting the asset leaves the type's own copy.
    await dispatchOk('assets/delete', { id: asset });
    expect(existsSync(join(dir, 'covers', second))).toBe(true);
  });

  it('refuses a type of another project, a missing type and people who do not manage the project', async () => {
    const other = (await dispatchOk('projects/create', { name: 'Q' })).id;
    const foreign = (await dispatchOk('wiki/createType', { projectId: other, name: 'Ship' })).id;
    const asset = await upload(PNG);
    expect((await use(asset, foreign)).statusCode).toBe(404);
    expect((await use(asset, newId())).statusCode).toBe(404);
    const typeId = (await dispatchOk('wiki/createType', { projectId, name: 'Ship' })).id;
    const member = await mkMember('m@x.io');
    expect((await use(asset, typeId, member)).statusCode).toBe(404);
    expect(picture(typeId)).toBeNull();
    expect(covers()).toEqual([]);
  });

  it('a model without a picture yet says no_picture and stores nothing', async () => {
    const typeId = (await dispatchOk('wiki/createType', { projectId, name: 'Ship' })).id;
    const model = await upload(GLB, 'model/gltf-binary');
    const r = await use(model, typeId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe('no_picture');
    expect(covers()).toEqual([]);
  });
});

describe('uploading a type picture', () => {
  const put = (typeId: string, body: Buffer, type = 'image/png', cookie = owner) =>
    app.inject({ method: 'POST', url: `/api/wiki/types/${typeId}/picture`, payload: body as any, headers: hdr(cookie, { 'content-type': type }) });
  it('stores the picture as a cover and sets it on the type; a second one releases the first', async () => {
    const typeId = (await dispatchOk('wiki/createType', { projectId, name: 'Ship' })).id;
    const r = await put(typeId, PNG);
    expect(r.statusCode, r.body).toBe(200);
    const { fileId } = r.json();
    expect(picture(typeId)).toEqual({ kind: 'file', fileId });
    expect(readFileSync(join(dir, 'covers', fileId))).toEqual(PNG);
    const second = (await put(typeId, PNG)).json().fileId;
    expect(covers()).toEqual([second]);
    // The released copy's bytes go after the commit, asynchronously.
    await vi.waitFor(() => expect(existsSync(join(dir, 'covers', fileId))).toBe(false));
  });
  it('refuses before storing anything: not a manager, a missing type, a type of a project out of reach, a wrong type of file', async () => {
    const typeId = (await dispatchOk('wiki/createType', { projectId, name: 'Ship' })).id;
    const member = await mkMember('m2@x.io');
    expect((await put(typeId, PNG, 'image/png', member)).statusCode).toBe(404);
    expect((await put(newId(), PNG)).statusCode).toBe(404);
    expect((await put(typeId, Buffer.from('<svg/>'), 'image/svg+xml')).statusCode).toBe(415);
    expect(picture(typeId)).toBeNull();
    expect(covers()).toEqual([]);
    expect(existsSync(join(dir, 'covers')) ? readdirSync(join(dir, 'covers')).filter((f) => !f.startsWith('.')) : []).toEqual([]);
  });
});

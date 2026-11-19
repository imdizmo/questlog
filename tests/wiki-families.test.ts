// Wiki families (redesign phase 3): the families table, its commands, starter families and type pictures.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';

const HOST = 'localhost:8780';
let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerCookie: string;
let projectId: string;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function mkUser(role: string, access: { projectId: string; projectRole?: string | null }[] = []): string {
  const id = newId();
  db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,'x',0)").run(id, `${id}@x.io`, role);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,?)').run(a.projectId, id, a.projectRole ?? null);
  return id;
}
function cookieFor(userId: string): string {
  const t = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(t), userId, Date.now() + 3600e3);
  return `jt_session=${t}`;
}
function mkProject(seq: number): string {
  const id = newId();
  db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,'P','limited',0,'[]',0)").run(id, seq);
  return id;
}
/** A session cookie, or `Bearer <token>` for an API token. */
const send = (auth: string, cmd: string, payload: unknown) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any,
  headers: { host: HOST, 'content-type': 'application/json', ...(auth.startsWith('Bearer ') ? { authorization: auth } : { cookie: auth }) },
});
const ok = async (cmd: string, payload: unknown, cookie = ownerCookie) => {
  const r = await send(cookie, cmd, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const fail = async (cmd: string, payload: unknown, status: number, code?: string, cookie = ownerCookie) => {
  const r = await send(cookie, cmd, payload);
  expect(r.statusCode, r.body).toBe(status);
  if (code) expect(r.json().error).toBe(code);
};
const snap = async (cookie = ownerCookie) => {
  const r = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const typeRow = (key: string) => db.prepare('SELECT * FROM entry_types WHERE project_id=? AND key=?').get(projectId, key) as any;
const families = () => db.prepare('SELECT * FROM entry_families WHERE project_id=? ORDER BY sort_index').all(projectId) as any[];
const famName = (key: string) => (db.prepare('SELECT f.name n FROM entry_types t LEFT JOIN entry_families f ON f.id=t.family_id WHERE t.project_id=? AND t.key=?')
  .get(projectId, key) as { n: string | null } | undefined)?.n ?? null;

beforeEach(async () => {
  db = openDb(':memory:');
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  ownerCookie = cookieFor(mkUser('owner'));
  projectId = mkProject(1);
});
afterEach(async () => { await app.close(); });

describe('the families migration', () => {
  it('adds the families table and the type columns; the snapshot carries families', async () => {
    const cols = (db.prepare('PRAGMA table_info(entry_types)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('family_id');
    expect(cols).toContain('picture_json');
    const s = await snap();
    expect(s.entryFamilies).toEqual([]);
    const { id } = await ok('wiki/createType', { projectId, name: 'Item' });
    const t = (await snap()).entryTypes.find((x: any) => x.id === id);
    expect(t.familyId).toBeNull();
    expect(t.picture).toBeNull();
  });
});

describe('family commands', () => {
  it('creates, renames, recolours and reorders families', async () => {
    const a = (await ok('wiki/createFamily', { projectId, name: 'Characters', color: '#c9733a' })).id;
    const b = (await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' })).id;
    expect(families().map((f) => f.name)).toEqual(['Characters', 'Items']);
    await ok('wiki/updateFamily', { id: a, name: 'People', color: '#112233' });
    expect(families()[0]).toMatchObject({ name: 'People', color: '#112233' });
    await ok('wiki/moveFamily', { id: b, before: a });
    expect(families().map((f) => f.name)).toEqual(['Items', 'People']);
    await ok('wiki/moveFamily', { id: b, before: null });
    expect(families().map((f) => f.name)).toEqual(['People', 'Items']);
    expect((await snap()).entryFamilies.map((f: any) => f.name)).toEqual(['People', 'Items']);
  });

  it('refuses a duplicate name (any case), a bad colour, and non-managers', async () => {
    await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' });
    await fail('wiki/createFamily', { projectId, name: 'items', color: '#b8862f' }, 409, 'duplicate_name');
    await fail('wiki/createFamily', { projectId, name: 'Story', color: 'red' }, 400);
    const member = cookieFor(mkUser('member', [{ projectId }]));
    await fail('wiki/createFamily', { projectId, name: 'Story', color: '#8a4fb0' }, 403, undefined, member);
  });

  it('deleting a family moves its types to No family and deletes no type', async () => {
    const fam = (await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' })).id;
    const item = (await ok('wiki/createType', { projectId, name: 'Item', familyId: fam })).id;
    await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item });
    expect(famName('item')).toBe('Items');
    expect(await ok('wiki/deleteFamily', { id: fam })).toEqual({ typesMoved: 1 });
    expect(families()).toEqual([]);
    expect(typeRow('item').family_id).toBeNull();
    expect(typeRow('weapon')).toBeTruthy();
  });

  it('only root types hold a family; becoming a kind clears it', async () => {
    const fam = (await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' })).id;
    const item = (await ok('wiki/createType', { projectId, name: 'Item', familyId: fam })).id;
    const w = (await ok('wiki/createType', { projectId, name: 'Weapon', familyId: fam })).id;
    await fail('wiki/createType', { projectId, name: 'Armor', parentTypeId: item, familyId: fam }, 400, 'not_root');
    await ok('wiki/updateType', { id: w, parentTypeId: item });
    expect(typeRow('weapon').family_id).toBeNull();
    await fail('wiki/updateType', { id: w, familyId: fam }, 400, 'not_root');
    await ok('wiki/updateType', { id: w, parentTypeId: null, familyId: fam });
    expect(famName('weapon')).toBe('Items');
  });

  it('a personal token deletes a family only when created with "May delete"', async () => {
    const fam = (await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' })).id;
    const mk = async (mayDelete: boolean) => `Bearer ${(await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], mayDelete })).token}`;
    await fail('wiki/deleteFamily', { id: fam }, 403, 'token_cannot_delete', await mk(false));
    expect(families()).toHaveLength(1);
    await ok('wiki/deleteFamily', { id: fam }, await mk(true));
    expect(families()).toEqual([]);
  });

  it('refuses a family of another project', async () => {
    const other = mkProject(2);
    const fam = (await ok('wiki/createFamily', { projectId: other, name: 'Items', color: '#b8862f' })).id;
    await fail('wiki/createType', { projectId, name: 'Item', familyId: fam }, 400, 'unknown_family');
  });
});

describe('type pictures', () => {
  const mkCover = (p: string) => {
    const id = newId();
    db.prepare("INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,NULL,'image/png',1,0)").run(id, p);
    return id;
  };
  it('stores a painted style or a cover of the project, and releases a replaced cover', async () => {
    const t = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    await ok('wiki/updateType', { id: t, picture: { kind: 'painted', style: 'night' } });
    expect(JSON.parse(typeRow('item').picture_json)).toEqual({ kind: 'painted', style: 'night' });
    const c1 = mkCover(projectId);
    await ok('wiki/updateType', { id: t, picture: { kind: 'file', fileId: c1 } });
    expect((await snap()).entryTypes[0].picture).toEqual({ kind: 'file', fileId: c1 });
    await ok('wiki/updateType', { id: t, picture: null });
    expect(db.prepare('SELECT 1 FROM covers WHERE id=?').get(c1)).toBeUndefined();
  });
  it('refuses a cover of another project, a missing one and an unknown style', async () => {
    const t = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    await fail('wiki/updateType', { id: t, picture: { kind: 'file', fileId: mkCover(mkProject(2)) } }, 400, 'bad_picture');
    await fail('wiki/updateType', { id: t, picture: { kind: 'file', fileId: newId() } }, 400, 'bad_picture');
    await fail('wiki/updateType', { id: t, picture: { kind: 'painted', style: 'neon' } }, 400);
  });
});

describe('starter families', () => {
  it('the core pack files its root types into the preview families', async () => {
    await ok('wiki/addStarterPack', { projectId, core: true });
    expect(families().map((f) => f.name)).toEqual(['Characters', 'Creatures', 'Items', 'Places', 'Story']);
    expect(famName('npc')).toBe('Characters');
    expect(famName('faction')).toBe('Characters');
    expect(famName('creature')).toBe('Creatures');
    expect(famName('item')).toBe('Items');
    expect(famName('location')).toBe('Places');
    expect(famName('mission')).toBe('Story');
    expect(famName('storyline')).toBe('Story');
    expect(famName('history')).toBe('Story');
  });
  it('the full pack adds Systems and Production; kinds stay without a family', async () => {
    await ok('wiki/addStarterPack', { projectId });
    expect(families().map((f) => f.name)).toEqual(['Characters', 'Creatures', 'Items', 'Places', 'Story', 'Systems', 'Production']);
    expect(famName('recipe')).toBe('Systems');
    expect(famName('asset')).toBe('Production');
    expect(typeRow('weapon').family_id).toBeNull();
  });
  it('leaves types the project already had alone, and offers families separately', async () => {
    await ok('wiki/createType', { projectId, key: 'item', name: 'My item' });
    await ok('wiki/addStarterPack', { projectId, core: true });
    expect(typeRow('item').family_id).toBeNull();
    expect(typeRow('item').name).toBe('My item');
    expect(await ok('wiki/addStarterFamilies', { projectId })).toEqual({ familiesAdded: 1, typesFiled: 1 });
    expect(famName('item')).toBe('Items');
    expect(await ok('wiki/addStarterFamilies', { projectId })).toEqual({ familiesAdded: 0, typesFiled: 0 });
  });
  it('the offer files only unfiled pack roots of an older project and keeps a person\'s choice', async () => {
    // As an older project: the pack added before families existed.
    await ok('wiki/addStarterPack', { projectId, core: true });
    db.prepare('UPDATE entry_types SET family_id=NULL').run();
    db.prepare('DELETE FROM entry_families').run();
    const mine = (await ok('wiki/createFamily', { projectId, name: 'Folk', color: '#123456' })).id;
    await ok('wiki/updateType', { id: typeRow('npc').id, familyId: mine });
    const own = (await ok('wiki/createType', { projectId, name: 'Spell' })).id;
    const r = await ok('wiki/addStarterFamilies', { projectId });
    expect(r.familiesAdded).toBe(5);
    expect(famName('npc')).toBe('Folk');
    expect(famName('faction')).toBe('Characters');
    expect(typeRow('spell').family_id).toBeNull();
    expect(db.prepare('SELECT family_id f FROM entry_types WHERE id=?').get(own)).toEqual({ f: null });
  });
});

describe('the family cap', () => {
  it('a project at the cap still gets the starter pack; its types stay in No family', async () => {
    for (let i = 0; i < 50; i++) await ok('wiki/createFamily', { projectId, name: `F${i}`, color: '#123456' });
    await fail('wiki/createFamily', { projectId, name: 'One more', color: '#123456' }, 409, 'limit');
    const r = await ok('wiki/addStarterPack', { projectId, core: true });
    expect(r.typesAdded).toBe(8);
    expect(families()).toHaveLength(50);
    expect(typeRow('item').family_id).toBeNull();
    expect(await ok('wiki/addStarterFamilies', { projectId })).toEqual({ familiesAdded: 0, typesFiled: 0 });
  });
  it('at the cap, a pack family that already exists (by name) still gets its types', async () => {
    await ok('wiki/createFamily', { projectId, name: 'items', color: '#b8862f' });
    for (let i = 0; i < 49; i++) await ok('wiki/createFamily', { projectId, name: `F${i}`, color: '#123456' });
    await ok('wiki/addStarterPack', { projectId, core: true });
    expect(famName('item')).toBe('items');
    expect(typeRow('npc').family_id).toBeNull();
  });
});

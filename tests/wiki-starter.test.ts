import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { STARTER_KINDS, STARTER_TYPES } from '../shared/templates/gameStarterPack';

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
const send = (cookie: string, cmd: string, payload: unknown) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: { host: HOST, 'content-type': 'application/json', cookie },
});
const ok = async (cmd: string, payload: unknown, cookie = ownerCookie) => {
  const r = await send(cookie, cmd, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const types = () => (db.prepare('SELECT * FROM entry_types WHERE project_id=?').all(projectId) as any[])
  .map((t) => ({ ...t, fields: JSON.parse(t.fields_json) }));
const kinds = () => (db.prepare('SELECT * FROM link_kinds WHERE project_id=?').all(projectId) as any[])
  .map((k) => ({ ...k, props: JSON.parse(k.props_json), sumRule: k.sum_rule_json && JSON.parse(k.sum_rule_json) }));

beforeEach(async () => {
  db = openDb(':memory:');
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  ownerCookie = cookieFor(mkUser('owner'));
  projectId = newId();
  db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,1,'P','limited',0,'[]',0)").run(projectId);
});
afterEach(async () => { await app.close(); });

describe('wiki/addStarterPack', () => {
  it('creates every spec type and link kind', async () => {
    const r = await ok('wiki/addStarterPack', { projectId });
    expect(r).toEqual({ typesAdded: 39, kindsAdded: 21 });
    expect(STARTER_TYPES).toHaveLength(39);
    expect(STARTER_KINDS).toHaveLength(21);
    const t = types();
    expect(t).toHaveLength(39);
    const byKey = new Map(t.map((x) => [x.key, x]));
    for (const k of ['item', 'weapon', 'creature', 'recipe', 'mission', 'status_effect', 'level_curve', 'asset', 'point_of_interest', 'quest_item']) expect(byKey.has(k), k).toBe(true);
    expect(byKey.get('weapon').parent_type_id).toBe(byKey.get('item').id);
    for (const c of ['armor', 'consumable', 'material', 'quest_item']) expect(byKey.get(c).parent_type_id).toBe(byKey.get('item').id);
    for (const c of ['region', 'zone', 'point_of_interest']) expect(byKey.get(c).parent_type_id).toBe(byKey.get('location').id);
    // Root types carry description (long text, not in the infobox) and icon; children inherit them.
    for (const x of t.filter((y) => !y.parent_type_id)) {
      expect(x.fields.find((f: any) => f.key === 'description'), x.key).toMatchObject({ kind: 'longtext', inInfobox: false });
      expect(x.fields.find((f: any) => f.key === 'icon'), x.key).toMatchObject({ kind: 'image' });
    }
    expect(byKey.get('item').fields.find((f: any) => f.key === 'rarity')).toMatchObject({ kind: 'enum', options: ['common', 'uncommon', 'rare', 'epic', 'legendary'] });
    expect(byKey.get('weapon').fields.find((f: any) => f.key === 'damage')).toMatchObject({ kind: 'range' });

    const k = new Map(kinds().map((x) => [x.key, x]));
    expect(k.size).toBe(21);
    expect(k.get('drops')).toMatchObject({ label: 'drops', reverse_label: 'dropped by', sumRule: null });
    const sells = k.get('sells');
    expect(sells.reverse_label).toBe('sold by');
    expect(sells.props.find((p: any) => p.key === 'price')).toMatchObject({ kind: 'number' });
    expect(sells.props.find((p: any) => p.key === 'currency')).toMatchObject({ kind: 'entry', target: 'currency' });
    expect(k.get('art_for')).toMatchObject({ reverse_label: 'art', from_types_json: '["asset"]', to_types_json: '[]' });
  });

  it('adds nothing the second time', async () => {
    await ok('wiki/addStarterPack', { projectId });
    expect(await ok('wiki/addStarterPack', { projectId })).toEqual({ typesAdded: 0, kindsAdded: 0 });
    expect(types()).toHaveLength(39);
    expect(kinds()).toHaveLength(21);
  });

  it('starts a page with its entity type headings and keeps templates on the type', async () => {
    const base = (await ok('wiki/createType', { projectId, name: 'Place', sections: ['Look and feel', 'History'] })).id;
    const town = (await ok('wiki/createType', { projectId, name: 'Town', parentTypeId: base, sections: ['Trade', 'History'], fields: [{ key: 'size', label: 'Size', kind: 'integer' }] })).id;
    db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,sort_index,created_at) VALUES (?,1,?,1,'Lore','doc',1,0)").run(newId(), projectId);
    const { id } = await ok('wiki/createEntry', { projectId, typeId: town, name: 'Oldtown' });
    expect((db.prepare('SELECT content FROM cards WHERE id=?').get(id) as any).content).toBe('# Oldtown\n\n## Look and feel\n\n## History\n\n## Trade');
    const templates = [{ name: 'Village', fields: { size: 40 }, links: [] }];
    await ok('wiki/updateType', { id: town, templates });
    await ok('wiki/updateType', { id: town, name: 'Settlement' });
    const row = db.prepare('SELECT * FROM entry_types WHERE id=?').get(town) as any;
    expect(JSON.parse(row.templates_json)).toEqual(templates);
    expect(JSON.parse(row.sections_json)).toEqual(['Trade', 'History']);
    expect((await send(ownerCookie, 'wiki/updateType', { id: town, templates: [{ name: 'x', fields: {}, links: [], extra: 1 }] })).statusCode).toBe(400);
  });

  it('adds the small set first and the rest later', async () => {
    expect(await ok('wiki/addStarterPack', { projectId, core: true })).toEqual({ typesAdded: 8, kindsAdded: 6 });
    expect(types().map((x) => x.key).sort()).toEqual(['creature', 'faction', 'history', 'item', 'location', 'mission', 'npc', 'storyline']);
    const drops = kinds().find((k) => k.key === 'drops');
    expect(JSON.parse(drops.from_types_json)).toEqual(['creature', 'npc']);
    expect(JSON.parse(drops.to_types_json)).toEqual(['item']);
    expect(await ok('wiki/addStarterPack', { projectId })).toEqual({ typesAdded: 31, kindsAdded: 15 });
  });

  it('keeps a pre-existing item type unchanged and files the pack children under it', async () => {
    const fields = [{ key: 'damage', label: 'Hit', kind: 'number' }];
    const item = (await ok('wiki/createType', { projectId, name: 'Thing', key: 'item', icon: 'x', fields })).id;
    const before = db.prepare('SELECT * FROM entry_types WHERE id=?').get(item);
    expect(await ok('wiki/addStarterPack', { projectId })).toEqual({ typesAdded: 38, kindsAdded: 21 });
    expect(db.prepare('SELECT * FROM entry_types WHERE id=?').get(item)).toEqual(before);
    const weapon = types().find((t) => t.key === 'weapon');
    expect(weapon.parent_type_id).toBe(item);
    // Weapon's own damage would repeat the inherited key, so it is left out.
    expect(weapon.fields.some((f: any) => f.key === 'damage')).toBe(false);
  });

  it('needs project.manage', async () => {
    const member = cookieFor(mkUser('member', [{ projectId }]));
    const r = await send(member, 'wiki/addStarterPack', { projectId });
    expect(r.statusCode).toBe(403);
    expect(types()).toHaveLength(0);
  });

  it('adds all or nothing: over the type cap it adds no type and no kind', async () => {
    const now = Date.now();
    const ins = db.prepare("INSERT INTO entry_types (id,project_id,key,name,fields_json,sort_index,created_at,updated_at) VALUES (?,?,?,?,'[]',0,?,?)");
    for (let i = 0; i < 180; i++) ins.run(newId(), projectId, `t${i}`, `T${i}`, now, now);
    const r = await send(ownerCookie, 'wiki/addStarterPack', { projectId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('limit');
    expect(types()).toHaveLength(180);
    expect(kinds()).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { cardRow } from '../server/commands/rows';

const HOST = 'localhost:8780';
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
let owner: string;
let ownerCookie: string;
let projectId: string;
let deckId: string;
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
function mkProject(name = 'P'): string {
  const id = newId();
  db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,'limited',0,'[]',0)").run(id, ++seq, name);
  return id;
}
function mkDeck(p: string): string {
  const id = newId();
  db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES (?,?,?,1,'D','doc',0)").run(id, ++seq, p);
  return id;
}
function mkCard(d: string | null, content = 'Task'): string {
  const id = newId();
  db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at,is_doc) VALUES (?,?,?,?,?,'default','[]',0,0,1)")
    .run(id, ++seq, d, owner, content);
  return id;
}
function mkLink(kindKey: string, from: string, to: string, p = projectId): string {
  const id = newId();
  db.prepare('INSERT INTO entry_links (id,project_id,kind_key,from_card_id,to_card_id,created_at) VALUES (?,?,?,?,?,0)').run(id, p, kindKey, from, to);
  return id;
}

type Auth = { cookie?: string; bearer?: string };
const send = (a: Auth | string, cmd: string, payload: unknown) => {
  const auth = typeof a === 'string' ? { cookie: a } : a;
  return app.inject({
    method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any,
    headers: { host: HOST, 'content-type': 'application/json', ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) },
  });
};
const ok = async (cmd: string, payload: unknown, a: Auth | string = ownerCookie) => {
  const r = await send(a, cmd, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const fail = async (cmd: string, payload: unknown, status: number, code?: string, a: Auth | string = ownerCookie) => {
  const r = await send(a, cmd, payload);
  expect(r.statusCode, r.body).toBe(status);
  if (code) expect(r.json().error).toBe(code);
  return r.json();
};
const snap = async (a: Auth | string) => {
  const auth = typeof a === 'string' ? { cookie: a } : a;
  const r = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const mkToken = async (input: Record<string, unknown>): Promise<string> =>
  (await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], ...input })).token;
const price = { key: 'price', label: 'Price', kind: 'number', min: 0 };

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  owner = mkUser('owner');
  ownerCookie = cookieFor(owner);
  projectId = mkProject();
  deckId = mkDeck(projectId);
});
afterEach(async () => { await app.close(); });

describe('migration 030', () => {
  it('adds the task columns and the three tables', () => {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('cards')).toEqual(expect.arrayContaining(['entry_type_id', 'entry_key', 'fields_json', 'wiki_parent_id']));
    for (const t of ['entry_types', 'link_kinds', 'entry_links']) expect(cols(t).length).toBeGreaterThan(0);
  });

  it('task rows carry entryTypeId, entryKey, fields (parsed) and wikiParentId', async () => {
    const c = mkCard(deckId, 'Fire Sword');
    const t = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    db.prepare("UPDATE cards SET entry_type_id=?, entry_key='fire_sword', fields_json='{\"price\":3}' WHERE id=?").run(t, c);
    expect(cardRow(db, c)).toMatchObject({ entryTypeId: t, entryKey: 'fire_sword', fields: { price: 3 }, wikiParentId: null });
    const s = await snap(ownerCookie);
    expect(s.cards.find((x: any) => x.id === c)).toMatchObject({ entryTypeId: t, entryKey: 'fire_sword', fields: { price: 3 }, wikiParentId: null });
  });
});

describe('wiki types', () => {
  it('creates Item and Weapon; members with access see both, others neither', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item', fields: [price] })).id;
    const weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item, icon: 'sword', color: '#ff0000' })).id;
    const member = mkUser('member', [{ projectId }]);
    const outsider = mkUser('member');
    const s = await snap(cookieFor(member));
    expect(s.entryTypes).toHaveLength(2);
    expect(s.entryTypes.find((t: any) => t.id === item)).toMatchObject({ key: 'item', name: 'Item', projectId, parentTypeId: null, fields: [price] });
    expect(s.entryTypes.find((t: any) => t.id === weapon)).toMatchObject({ key: 'weapon', parentTypeId: item, icon: 'sword', color: '#ff0000', fields: [] });
    const o = await snap(cookieFor(outsider));
    expect(o.entryTypes).toEqual([]);
    expect(o.linkKinds).toEqual([]);
    expect(o.entryLinks).toEqual([]);
  });

  it('default keys avoid taken ones; an explicit taken key is 409 duplicate_key', async () => {
    await ok('wiki/createType', { projectId, name: 'Item' });
    const second = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    expect((db.prepare('SELECT key FROM entry_types WHERE id=?').get(second) as any).key).toBe('item_2');
    await fail('wiki/createType', { projectId, name: 'X', key: 'item' }, 409, 'duplicate_key');
    await fail('wiki/createType', { projectId, name: 'X', key: 'Bad Key' }, 400, 'invalid_payload');
    // Another project may reuse the key.
    const other = mkProject('Q');
    await ok('wiki/createType', { projectId: other, name: 'Item', key: 'item' });
  });

  it('a parent change that makes a cycle is 409 cycle', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item })).id;
    await fail('wiki/updateType', { id: weapon, parentTypeId: weapon }, 409, 'cycle');
    await fail('wiki/updateType', { id: item, parentTypeId: weapon }, 409, 'cycle');
    // A parent from another project is unknown.
    const foreign = (await ok('wiki/createType', { projectId: mkProject('Q'), name: 'Thing' })).id;
    await fail('wiki/updateType', { id: weapon, parentTypeId: foreign }, 400, 'unknown_type');
    await ok('wiki/updateType', { id: weapon, parentTypeId: null });
  });

  it('fields are hidden, never removed; new keys are checked', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item', fields: [price] })).id;
    const r = await fail('wiki/updateType', { id: item, fields: [] }, 409, 'field_removed');
    expect(r.data).toEqual({ field: 'price' });
    await ok('wiki/updateType', { id: item, fields: [{ ...price, label: 'Cost', hidden: true }] });
    expect((await snap(ownerCookie)).entryTypes[0].fields).toEqual([{ ...price, label: 'Cost', hidden: true }]);
    // New keys: KEY_RE, unique in the type and in the inherited list, targets must exist.
    await fail('wiki/updateType', { id: item, fields: [price, { key: '1bad', label: 'B', kind: 'text' }] }, 400, 'invalid_payload');
    await fail('wiki/updateType', { id: item, fields: [price, { ...price, label: 'Again' }] }, 409, 'duplicate_key');
    const weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item })).id;
    await fail('wiki/updateType', { id: weapon, fields: [{ key: 'price', label: 'P', kind: 'number' }] }, 409, 'duplicate_key');
    await fail('wiki/updateType', { id: weapon, fields: [{ key: 'ammo', label: 'Ammo', kind: 'entry', target: 'nope' }] }, 400, 'unknown_type');
    await ok('wiki/updateType', { id: weapon, fields: [{ key: 'ammo', label: 'Ammo', kind: 'entry', target: 'item' }] });
    // A field the parent adds later can't clash with a child's own field either.
    await fail('wiki/updateType', { id: item, fields: [price, { key: 'ammo', label: 'A', kind: 'text' }] }, 409, 'duplicate_key');
  });

  it('deleteType: 409 type_in_use with counts while children or entries use it', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item })).id;
    const r = await fail('wiki/deleteType', { id: item }, 409, 'type_in_use');
    expect(r.data).toEqual({ childTypes: 1, entries: 0, fieldTargets: 0, linkKinds: 0 });
    const c = mkCard(deckId);
    db.prepare('UPDATE cards SET entry_type_id=? WHERE id=?').run(weapon, c);
    expect((await fail('wiki/deleteType', { id: weapon }, 409, 'type_in_use')).data).toEqual({ childTypes: 0, entries: 1, fieldTargets: 0, linkKinds: 0 });
    db.prepare('UPDATE cards SET entry_type_id=NULL WHERE id=?').run(c);
    await ok('wiki/deleteType', { id: weapon });
    await ok('wiki/deleteType', { id: item });
    expect(db.prepare('SELECT COUNT(*) n FROM entry_types').get()).toEqual({ n: 0 });
    await fail('wiki/deleteType', { id: item }, 404, 'not_found');
  });

  it('deleteType: only live entries block; trashed ones become untyped lore and keep their values', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const live = mkCard(deckId);
    const trashed = mkCard(deckId);
    db.prepare("UPDATE cards SET entry_type_id=?, fields_json='{\"price\":3}' WHERE id IN (?,?)").run(item, live, trashed);
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(trashed);
    expect((await fail('wiki/deleteType', { id: item }, 409, 'type_in_use')).data).toMatchObject({ entries: 1 });
    expect((db.prepare('SELECT entry_type_id t FROM cards WHERE id=?').get(trashed) as any).t).toBe(item); // a refused delete changes nothing
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(live);
    await ok('wiki/deleteType', { id: item });
    for (const id of [live, trashed]) {
      expect(db.prepare('SELECT entry_type_id, fields_json FROM cards WHERE id=?').get(id)).toEqual({ entry_type_id: null, fields_json: '{"price":3}' });
    }
  });

  it('deleteType: refused while a field target or a link kind names the type', async () => {
    const potion = (await ok('wiki/createType', { projectId, name: 'Potion', fields: [{ key: 'base', label: 'Base', kind: 'entry', target: 'potion' }] })).id;
    const recipe = (await ok('wiki/createType', { projectId, name: 'Recipe', fields: [{ key: 'result', label: 'Result', kind: 'entry', target: 'potion' }, { key: 'extra', label: 'Extra', kind: 'entries', target: 'potion' }] })).id;
    const kind = (await ok('wiki/createLinkKind', { projectId, label: 'brews', reverseLabel: 'brewed by', fromTypes: ['potion'], toTypes: ['potion'] })).id;
    // Its own self-reference doesn't count; Recipe's two fields and the kind do.
    expect((await fail('wiki/deleteType', { id: potion }, 409, 'type_in_use')).data).toEqual({ entries: 0, childTypes: 0, fieldTargets: 2, linkKinds: 1 });
    await ok('wiki/deleteLinkKind', { id: kind });
    await ok('wiki/updateType', { id: recipe, fields: [{ key: 'result', label: 'Result', kind: 'text' }, { key: 'extra', label: 'Extra', kind: 'text' }] });
    await ok('wiki/deleteType', { id: potion });
  });

  it('unchanged dangling type keys never block a save; new or changed ones do', async () => {
    const recipe = (await ok('wiki/createType', { projectId, name: 'Recipe', fields: [{ key: 'result', label: 'Result', kind: 'entry', target: 'recipe' }] })).id;
    const kind = (await ok('wiki/createLinkKind', { projectId, label: 'brews', reverseLabel: 'brewed by', fromTypes: ['recipe'], toTypes: [], props: [{ key: 'with', label: 'With', kind: 'entry', target: 'recipe' }] })).id;
    // A database that already holds dangling keys (from before the delete check).
    db.prepare(`UPDATE entry_types SET fields_json='[{"key":"result","label":"Result","kind":"entry","target":"ghost"}]' WHERE id=?`).run(recipe);
    db.prepare(`UPDATE link_kinds SET from_types_json='["ghost"]', props_json='[{"key":"with","label":"With","kind":"entry","target":"ghost"}]' WHERE id=?`).run(kind);
    await ok('wiki/updateType', { id: recipe, fields: [{ key: 'result', label: 'Renamed', kind: 'entry', target: 'ghost' }, { key: 'note', label: 'Note', kind: 'text' }] });
    await fail('wiki/updateType', { id: recipe, fields: [{ key: 'result', label: 'R', kind: 'entry', target: 'ghost2' }, { key: 'note', label: 'Note', kind: 'text' }] }, 400, 'unknown_type');
    await fail('wiki/updateType', { id: recipe, fields: [{ key: 'result', label: 'R', kind: 'entry', target: 'ghost' }, { key: 'note', label: 'Note', kind: 'text' }, { key: 'more', label: 'M', kind: 'entry', target: 'ghost' }] }, 400, 'unknown_type');
    await ok('wiki/updateLinkKind', { id: kind, label: 'brews!', fromTypes: ['ghost', 'recipe'], props: [{ key: 'with', label: 'W', kind: 'entry', target: 'ghost' }] });
    await fail('wiki/updateLinkKind', { id: kind, toTypes: ['ghost'] }, 400, 'unknown_type');
  });

  it('a type fields list or a kind props list above 64 KB is 413 too_large', async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, kind: 'enum', options: Array.from({ length: 10 }, (_, j) => `${'x'.repeat(190)}${j}`) }));
    await fail('wiki/createType', { projectId, name: 'Big', fields: big }, 413, 'too_large');
    await fail('wiki/createLinkKind', { projectId, label: 'l', reverseLabel: 'r', fromTypes: [], toTypes: [], props: big.slice(0, 20).map((f) => ({ ...f, help: 'h'.repeat(2000), options: [...f.options, ...f.options] })) }, 413, 'too_large');
    const id = (await ok('wiki/createType', { projectId, name: 'Small', fields: big.slice(0, 20) })).id;
    await fail('wiki/updateType', { id, fields: big }, 413, 'too_large');
  });

  it('keys can\'t be changed: sending one on update is 400', async () => {
    const id = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    await fail('wiki/updateType', { id, key: 'other' }, 400, 'invalid_payload');
    const kind = (await ok('wiki/createLinkKind', { projectId, label: 'drops', reverseLabel: 'dropped by', fromTypes: [], toTypes: [] })).id;
    await fail('wiki/updateLinkKind', { id: kind, key: 'other' }, 400, 'invalid_payload');
  });

  it('caps: 200 types per project, 100 fields per type → 409 limit', async () => {
    for (let i = 0; i < 200; i++) {
      db.prepare('INSERT INTO entry_types (id,project_id,key,name,created_at,updated_at) VALUES (?,?,?,?,0,0)').run(newId(), projectId, `t${i}`, `T${i}`);
    }
    await fail('wiki/createType', { projectId, name: 'One more' }, 409, 'limit');
    const other = mkProject('Q');
    const fields = Array.from({ length: 101 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, kind: 'text' }));
    await fail('wiki/createType', { projectId: other, name: 'Big', fields }, 409, 'limit');
    await ok('wiki/createType', { projectId: other, name: 'Big', fields: fields.slice(0, 100) });
  });

  it('a member without project.manage gets 403; a producer may manage', async () => {
    const member = mkUser('member', [{ projectId }]);
    await fail('wiki/createType', { projectId, name: 'Item' }, 403, 'forbidden', cookieFor(member));
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    await fail('wiki/updateType', { id: item, name: 'X' }, 403, 'forbidden', cookieFor(member));
    await fail('wiki/deleteType', { id: item }, 403, 'forbidden', cookieFor(member));
    await fail('wiki/createLinkKind', { projectId, label: 'drops', reverseLabel: 'dropped by', fromTypes: [], toTypes: [] }, 403, 'forbidden', cookieFor(member));
    const producer = mkUser('member', [{ projectId, projectRole: 'producer' }]);
    await ok('wiki/updateType', { id: item, name: 'Thing' }, cookieFor(producer));
  });

  it('tokens: read → 403 missing_scope; confined to another project → 403 on every command', async () => {
    const read = await mkToken({ access: 'read' });
    const r = await fail('wiki/createType', { projectId, name: 'Item' }, 403, 'missing_scope', { bearer: read });
    expect(r.data).toEqual({ requiredScope: 'wiki:write' });
    const other = mkProject('Q');
    const confined = await mkToken({ role: 'producer', projectIds: [other], mayDelete: true });
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const kind = (await ok('wiki/createLinkKind', { projectId, label: 'drops', reverseLabel: 'dropped by', fromTypes: [], toTypes: [] })).id;
    const b = { bearer: confined };
    await fail('wiki/createType', { projectId, name: 'X' }, 403, 'forbidden', b);
    await fail('wiki/updateType', { id: item, name: 'Hacked' }, 403, 'forbidden', b);
    await fail('wiki/deleteType', { id: item }, 403, 'forbidden', b);
    await fail('wiki/createLinkKind', { projectId, label: 'x', reverseLabel: 'y', fromTypes: [], toTypes: [] }, 403, 'forbidden', b);
    await fail('wiki/updateLinkKind', { id: kind, label: 'Hacked' }, 403, 'forbidden', b);
    await fail('wiki/deleteLinkKind', { id: kind }, 403, 'forbidden', b);
    expect((db.prepare('SELECT name FROM entry_types WHERE id=?').get(item) as any).name).toBe('Item');
    expect((db.prepare('SELECT label FROM link_kinds WHERE id=?').get(kind) as any).label).toBe('drops');
    const s = await snap(b);
    expect(s.entryTypes).toEqual([]);
    expect(s.linkKinds).toEqual([]);
    // In its own project the write token works.
    await ok('wiki/createType', { projectId: other, name: 'Item' }, b);
  });
});

describe('wiki link kinds', () => {
  const drops = { label: 'drops', reverseLabel: 'dropped by', fromTypes: [] as string[], toTypes: [] as string[] };

  it('works_on is reserved', async () => {
    await fail('wiki/createLinkKind', { projectId, ...drops, key: 'works_on' }, 409, 'reserved_key');
  });

  it('creates with a default key, checks types, props and the sum rule', async () => {
    await ok('wiki/createType', { projectId, name: 'Monster' });
    await ok('wiki/createType', { projectId, name: 'Item' });
    await fail('wiki/createLinkKind', { projectId, ...drops, fromTypes: ['monster'], toTypes: ['nope'] }, 400, 'unknown_type');
    await fail('wiki/createLinkKind', { projectId, ...drops, props: [{ key: 'cur', label: 'C', kind: 'entry', target: 'nope' }] }, 400, 'unknown_type');
    await fail('wiki/createLinkKind', { projectId, ...drops, props: [{ key: 'chance', label: 'C', kind: 'number' }], sumRule: { prop: 'other', max: 100 } }, 400, 'invalid_payload');
    const props = [{ key: 'chance', label: 'Chance', kind: 'number', unit: '%' }, { key: 'qty', label: 'Qty', kind: 'range' }];
    const id = (await ok('wiki/createLinkKind', { projectId, ...drops, fromTypes: ['monster'], toTypes: ['item'], props, sumRule: { prop: 'chance', max: 100 } })).id;
    const k = (await snap(ownerCookie)).linkKinds.find((x: any) => x.id === id);
    expect(k).toMatchObject({ key: 'drops', label: 'drops', reverseLabel: 'dropped by', fromTypes: ['monster'], toTypes: ['item'], props, sumRule: { prop: 'chance', max: 100 } });
    expect((await ok('wiki/createLinkKind', { projectId, ...drops }))).toHaveProperty('id');
    expect((db.prepare("SELECT key FROM link_kinds WHERE key LIKE 'drops%' ORDER BY key").all() as any[]).map((r) => r.key)).toEqual(['drops', 'drops_2']);
    await fail('wiki/createLinkKind', { projectId, ...drops, key: 'drops' }, 409, 'duplicate_key');
    // Props: hide, don't remove; cap 20.
    await fail('wiki/updateLinkKind', { id, props: [props[0]], sumRule: { prop: 'chance', max: 100 } }, 409, 'field_removed');
    // The sum rule can't use a hidden prop.
    await fail('wiki/updateLinkKind', { id, props: [{ ...props[0], hidden: true }, props[1]] }, 400, 'invalid_payload');
    await ok('wiki/updateLinkKind', { id, props: [props[0], { ...props[1], hidden: true }], label: 'loot', sumRule: null });
    expect((await snap(ownerCookie)).linkKinds.find((x: any) => x.id === id)).toMatchObject({ key: 'drops', label: 'loot', sumRule: null });
    const many = Array.from({ length: 19 }, (_, i) => ({ key: `p${i}`, label: `P${i}`, kind: 'text' }));
    await fail('wiki/updateLinkKind', { id, props: [...props, ...many] }, 409, 'limit');
  });

  it('caps link kinds at 200 per project', async () => {
    for (let i = 0; i < 200; i++) {
      db.prepare("INSERT INTO link_kinds (id,project_id,key,label,reverse_label,created_at,updated_at) VALUES (?,?,?,'l','r',0,0)").run(newId(), projectId, `k${i}`);
    }
    await fail('wiki/createLinkKind', { projectId, ...drops }, 409, 'limit');
  });

  it('updateLinkKind refuses unknown type keys', async () => {
    const id = (await ok('wiki/createLinkKind', { projectId, ...drops })).id;
    await fail('wiki/updateLinkKind', { id, fromTypes: ['ghost'] }, 400, 'unknown_type');
  });

  it('deleting a kind deletes its links and reports the count', async () => {
    const id = (await ok('wiki/createLinkKind', { projectId, ...drops })).id;
    const other = (await ok('wiki/createLinkKind', { projectId, ...drops, key: 'crafts' })).id;
    const a = mkCard(deckId, 'A'); const b = mkCard(deckId, 'B'); const c = mkCard(deckId, 'C');
    mkLink('drops', a, b); mkLink('drops', a, c);
    const kept = mkLink('crafts', b, c);
    expect((await snap(ownerCookie)).entryLinks).toHaveLength(3);
    expect(await ok('wiki/deleteLinkKind', { id })).toEqual({ linksDeleted: 2 });
    expect((db.prepare('SELECT id FROM entry_links').all() as any[]).map((r) => r.id)).toEqual([kept]);
    expect(db.prepare('SELECT 1 FROM link_kinds WHERE id=?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM link_kinds WHERE id=?').get(other)).toBeDefined();
  });

  it('the snapshot leaves out links to deleted tasks and links of other projects', async () => {
    const a = mkCard(deckId, 'A'); const b = mkCard(deckId, 'B');
    const live = mkLink('drops', a, b);
    const gone = mkCard(deckId, 'Gone');
    mkLink('drops', a, gone);
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(gone);
    const q = mkProject('Q');
    const qa = mkCard(mkDeck(q), 'QA');
    mkLink('drops', qa, qa, q);
    const member = mkUser('member', [{ projectId }]);
    expect((await snap(cookieFor(member))).entryLinks.map((l: any) => l.id)).toEqual([live]);
  });
});

describe('wiki live and cleanup', () => {
  it('routes entryType, linkKind and entryLink events to the project viewers only', async () => {
    const hub = new LiveHub(db);
    const member = mkUser('member', [{ projectId }]);
    const outsider = mkUser('member');
    const got: Record<string, any[]> = { member: [], outsider: [] };
    hub.add({ send: (d) => got.member.push(JSON.parse(d)), close() {} }, { id: member });
    hub.add({ send: (d) => got.outsider.push(JSON.parse(d)), close() {} }, { id: outsider });
    hub.publish('a1', [
      { model: 'entryType', op: 'upsert', row: { id: 't', projectId } },
      { model: 'linkKind', op: 'remove', row: { id: 'k', projectId } },
      { model: 'entryLink', op: 'remove', row: { id: 'l', projectId } },
    ]);
    expect(got.member[0].events.map((e: any) => e.model)).toEqual(['entryType', 'linkKind', 'entryLink']);
    expect(got.outsider).toEqual([]);
  });

  it('commands emit one event per changed row', async () => {
    const { dispatch } = await import('../server/dispatch');
    const me = { id: owner, email: '', name: 'o', timezone: null, disabled: false, createdAt: 0 };
    const t = dispatch(db, me, 'wiki/createType', { projectId, name: 'Item' });
    expect(t.events).toEqual([{ model: 'entryType', op: 'upsert', row: expect.objectContaining({ id: (t.payload as any).id, projectId, key: 'item', fields: [] }) }]);
    const k = dispatch(db, me, 'wiki/createLinkKind', { projectId, label: 'drops', reverseLabel: 'dropped by', fromTypes: [], toTypes: [] });
    const a = mkCard(deckId); const b = mkCard(deckId);
    const l1 = mkLink('drops', a, b);
    const del = dispatch(db, me, 'wiki/deleteLinkKind', { id: (k.payload as any).id });
    expect(del.events).toEqual([
      { model: 'entryLink', op: 'remove', row: { id: l1, projectId } },
      { model: 'linkKind', op: 'remove', row: expect.objectContaining({ id: (k.payload as any).id, projectId }) },
    ]);
    expect(dispatch(db, me, 'wiki/deleteType', { id: (t.payload as any).id }).events)
      .toEqual([{ model: 'entryType', op: 'remove', row: expect.objectContaining({ id: (t.payload as any).id, projectId }) }]);
  });

  it('deleting a project removes its types even when a trashed, deckless entry still uses one', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: item })).id;
    await ok('wiki/createType', { projectId, name: 'Sword', parentTypeId: weapon });
    await ok('wiki/createLinkKind', { projectId, label: 'drops', reverseLabel: 'dropped by', fromTypes: ['item'], toTypes: [] });
    mkLink('drops', mkCard(deckId), mkCard(deckId));
    const c = mkCard(deckId);
    db.prepare('UPDATE cards SET entry_type_id=? WHERE id=?').run(item, c);
    await ok('decks/delete', { id: deckId });
    expect((db.prepare('SELECT deck_id, entry_type_id FROM cards WHERE id=?').get(c) as any)).toEqual({ deck_id: null, entry_type_id: item });
    await ok('projects/delete', { id: projectId });
    for (const t of ['entry_types', 'link_kinds', 'entry_links']) expect(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT entry_type_id FROM cards WHERE id=?').get(c) as any).entry_type_id).toBeNull();
  });
});

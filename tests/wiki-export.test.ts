import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { EXPORT_LIMITS, writeWikiExport } from '../server/wikiExport';
import { campaignChecks } from '../web/src/wiki';

const HOST = 'localhost:8780';
const SPACES = JSON.stringify([{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]);
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
let owner: string;
let ownerCookie: string;
let projectId: string;
let types: Record<string, string>;
const dir = join(homedir(), '.cache/gametracker/scratch', `wiki-export-test-${process.pid}`);
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
  db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,'limited',0,?,0)").run(id, ++seq, name, SPACES);
  return id;
}
function mkDeck(p: string, type = 'doc', sortIndex = 1): string {
  const id = newId();
  db.prepare('INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,sort_index,created_at) VALUES (?,?,?,1,?,?,?,0)').run(id, ++seq, p, `D${seq}`, type, sortIndex);
  return id;
}

type Auth = { cookie?: string; bearer?: string };
const headers = (a: Auth) => ({ host: HOST, ...(a.cookie ? { cookie: a.cookie } : {}), ...(a.bearer ? { authorization: `Bearer ${a.bearer}` } : {}) });
const ok = async (cmd: string, payload: unknown, a: Auth = { cookie: ownerCookie }) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: { ...headers(a), 'content-type': 'application/json' } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const get = (query = '', a: Auth = { cookie: ownerCookie }, p = projectId) =>
  app.inject({ method: 'GET', url: `/api/wiki/${p}/export${query}`, headers: headers(a) });
const exported = async (query = '', a: Auth = { cookie: ownerCookie }) => {
  const r = await get(query, a);
  expect(r.statusCode, r.body).toBe(200);
  return JSON.parse(r.body);
};
const entry = async (name: string, type: string | null): Promise<string> =>
  (await ok('wiki/createEntry', { projectId, typeId: type && types[type], name })).id;
const setFields = (cardId: string, fields: Record<string, unknown>) => ok('wiki/setEntry', { cardId, fields });
const mkToken = async (input: Record<string, unknown>): Promise<string> =>
  (await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'read', projectIds: [], ...input })).token;

let sword: string;
let wolf: string;

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  app = buildApp({ db, hosts: [HOST], filesDir: dir });
  await app.ready();
  owner = mkUser('owner');
  ownerCookie = cookieFor(owner);
  projectId = mkProject('Ashen Isles');
  mkDeck(projectId);
  types = {};
  types.item = (await ok('wiki/createType', { projectId, name: 'Item', fields: [
    { key: 'value', label: 'Value', kind: 'integer', required: true, min: 0 },
    { key: 'icon', label: 'Icon', kind: 'image' },
    { key: 'old', label: 'Old', kind: 'text', hidden: true },
  ] })).id;
  types.weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: types.item, fields: [
    { key: 'damage', label: 'Damage', kind: 'number' },
    { key: 'hits', label: 'Hits', kind: 'range' },
    { key: 'element', label: 'Element', kind: 'enum', options: ['fire', 'ice'] },
  ] })).id;
  types.creature = (await ok('wiki/createType', { projectId, name: 'Creature', fields: [{ key: 'loot', label: 'Loot', kind: 'entries', target: 'item' }] })).id;
  await ok('wiki/createLinkKind', {
    projectId, key: 'drops', label: 'drops', reverseLabel: 'dropped by', fromTypes: ['creature'], toTypes: ['item'],
    props: [{ key: 'chance', label: 'Chance', kind: 'number', min: 0, max: 100 }], sumRule: { prop: 'chance', max: 100 },
  });
  sword = await entry('Fire Sword', 'weapon');
  await setFields(sword, { value: 30, damage: 12, hits: { min: 1, max: 3 }, element: 'fire', old: 'legacy', stray: 'x' });
  wolf = await entry('Wolf', 'creature');
  await setFields(wolf, { loot: ['fire_sword'] });
  await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: sword, props: { chance: 40 } });
});
afterEach(async () => {
  await app.close();
  // The scratch file of each export is unlinked as soon as it is opened.
  expect(readdirSync(dir)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/wiki/:projectId/export', () => {
  it('a fixture project: format, types with own fields and parent, entries with all values, links by keys, checks', async () => {
    const r = await get();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="ashen_isles-gamedata.json"');
    const d = JSON.parse(r.body);
    expect(Object.keys(d)).toEqual(['format', 'version', 'campaign', 'exportedAt', 'types', 'families', 'linkKinds', 'entries', 'links', 'random', 'tables', 'rules', 'scenarios', 'checks']);
    expect(d.format).toBe('questlog-gamedata');
    expect(d.version).toBe(1);
    expect(d.campaign).toEqual({ id: projectId, name: 'Ashen Isles' });
    expect(new Date(d.exportedAt).toISOString()).toBe(d.exportedAt);

    const weapon = d.types.find((t: any) => t.key === 'weapon');
    expect(weapon).toEqual({
      key: 'weapon', name: 'Weapon', parent: 'item', family: null, picture: 'dusk',
      fields: [
        { key: 'damage', kind: 'number', required: false, min: null, max: null, options: null, target: null },
        { key: 'hits', kind: 'range', required: false, min: null, max: null, options: null, target: null },
        { key: 'element', kind: 'enum', required: false, min: null, max: null, options: ['fire', 'ice'], target: null },
      ],
    });
    // Hidden fields are not part of the type.
    expect(d.types.find((t: any) => t.key === 'item').fields.map((f: any) => f.key)).toEqual(['value', 'icon']);
    expect(d.linkKinds).toEqual([{
      key: 'drops', label: 'drops', reverseLabel: 'dropped by', from: ['creature'], to: ['item'],
      props: [{ key: 'chance', kind: 'number', required: false, min: 0, max: 100, options: null, target: null }],
    }]);

    const fire = d.entries.find((e: any) => e.key === 'fire_sword');
    expect(Object.keys(fire)).toEqual(['id', 'key', 'type', 'name', 'aliases', 'parent', 'tags', 'fields', 'text', 'blocks']);
    expect(fire).toMatchObject({ id: sword, type: 'weapon', name: 'Fire Sword', parent: null, tags: [], text: '' });
    // Inherited values first (value), then own; hidden (old) and unknown (stray) values are left out.
    expect(fire.fields).toEqual({ value: 30, damage: 12, hits: { min: 1, max: 3 }, element: 'fire' });
    expect(d.entries.find((e: any) => e.key === 'wolf').fields).toEqual({ loot: ['fire_sword'] });
    expect(d.links).toEqual([{ kind: 'drops', from: 'wolf', to: 'fire_sword', props: { chance: 40 }, order: 0 }]);
    // Wolf has no value: Creature has no required field; only checks of real problems are listed.
    expect(d.checks).toEqual([]);
  });

  it('families: listed in order with their root types; each type names its family (a kind its root\'s) and picture', async () => {
    const fam = (await ok('wiki/createFamily', { projectId, name: 'Items', color: '#b8862f' })).id;
    await ok('wiki/createFamily', { projectId, name: 'Empty', color: '#123456' });
    await ok('wiki/updateType', { id: types.item, familyId: fam });
    await ok('wiki/updateType', { id: types.weapon, picture: { kind: 'painted', style: 'night' } });
    const d = await exported();
    expect(d.families).toEqual([{ name: 'Items', color: '#b8862f', types: ['item'] }, { name: 'Empty', color: '#123456', types: [] }]);
    expect(d.types.find((t: any) => t.key === 'item')).toMatchObject({ family: 'Items', picture: 'dusk' });
    expect(d.types.find((t: any) => t.key === 'weapon')).toMatchObject({ family: 'Items', picture: 'night', parent: 'item' });
  });

  it('typed blocks: each entry lists the ones that hold data, links by exported key and assets by id and title', async () => {
    const shield = (db.prepare("INSERT INTO assets (id,project_id,title,kind,source,created_at,updated_at) VALUES ('as1',?,'Wolf model','model','uploaded',0,0) RETURNING id").get(projectId) as { id: string }).id;
    await ok('wiki/setPage', { typeId: types.creature, page: { guided: false, blocks: [
      { id: 'f', kind: 'facts', title: 'Facts', width: 'half' }, { id: 'm', kind: 'model', title: 'Model', width: 'half' },
      { id: 'a', kind: 'table', title: 'Attacks', width: 'full', cols: ['Attack', 'Damage'] }, { id: 'b', kind: 'lines', title: 'Barks', width: 'full' },
      { id: 'k', kind: 'links', title: 'Hunts with', width: 'full', to: '' }, { id: 'e', kind: 'steps', title: 'Empty', width: 'full' }] } });
    await ok('wiki/setBlock', { cardId: wolf, blockId: 'm', data: { assetId: shield } });
    await ok('wiki/setBlock', { cardId: wolf, blockId: 'a', data: { rows: [['Bite', '8']] } });
    await ok('wiki/setBlock', { cardId: wolf, blockId: 'b', data: { items: ['Grr'] } });
    await ok('wiki/setBlock', { cardId: wolf, blockId: 'k', data: { cardIds: [sword] } });
    await ok('wiki/setBlock', { cardId: wolf, blockId: 'e', data: { items: [] } });
    const d = await exported();
    expect(d.entries.find((e: any) => e.key === 'wolf').blocks).toEqual([
      { title: 'Model', kind: 'model', asset: { id: shield, title: 'Wolf model' } },
      { title: 'Attacks', kind: 'table', columns: ['Attack', 'Damage'], rows: [['Bite', '8']] },
      { title: 'Barks', kind: 'lines', items: ['Grr'] },
      { title: 'Hunts with', kind: 'links', entries: ['fire_sword'] },
    ]);
    expect(d.entries.find((e: any) => e.key === 'fire_sword').blocks).toEqual([]);
  });
  it('a value made invalid by a kind change is absent from fields and listed in checks', async () => {
    const t = (await ok('wiki/createType', { projectId, name: 'Spell', fields: [{ key: 'power', label: 'Power', kind: 'text' }] })).id;
    const fireball = (await ok('wiki/createEntry', { projectId, typeId: t, name: 'Fireball' })).id;
    await setFields(fireball, { power: 'high' });
    await ok('wiki/updateType', { id: t, fields: [{ key: 'power', label: 'Power', kind: 'number' }] });
    const d = await exported();
    expect(d.entries.find((e: any) => e.key === 'fireball').fields).toEqual({});
    expect(d.checks).toEqual([{ entry: 'fireball', problem: 'invalid_value', detail: 'power: wrong_kind' }]);
    // The stored value is kept, not rewritten: changing the kind back brings it back.
    expect(JSON.parse((db.prepare('SELECT fields_json f FROM cards WHERE id=?').get(fireball) as { f: string }).f)).toEqual({ power: 'high' });
    await ok('wiki/updateType', { id: t, fields: [{ key: 'power', label: 'Power', kind: 'text' }] });
    expect((await exported()).entries.find((e: any) => e.key === 'fireball').fields).toEqual({ power: 'high' });
  });

  it('a link to a deleted entry, and references to it, are left out', async () => {
    const fang = await entry('Fang', 'item');
    await setFields(fang, { value: 1 });
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 10 } });
    await setFields(wolf, { loot: ['fire_sword', 'fang'] });
    expect((await exported()).links.map((l: any) => l.to)).toEqual(['fire_sword', 'fang']);
    const v = (db.prepare('SELECT version FROM cards WHERE id=?').get(fang) as { version: number }).version;
    await ok('cards/update', { id: fang, visibility: 'deleted', version: v });
    const d = await exported();
    expect(d.entries.map((e: any) => e.key)).not.toContain('fang');
    expect(d.links).toEqual([{ kind: 'drops', from: 'wolf', to: 'fire_sword', props: { chance: 40 }, order: 0 }]);
    expect(d.entries.find((e: any) => e.key === 'wolf').fields).toEqual({});
    // The link to the trashed entry is left out silently (spec); the field reference to its key is listed.
    expect(d.checks).toEqual([{ entry: 'wolf', problem: 'broken_ref', detail: 'loot: broken_ref' }]);
    // Restored: the entry, the link and the reference are back in the next export.
    await ok('cards/update', { id: fang, visibility: 'default' });
    const back = await exported();
    expect(back.links.map((l: any) => l.to)).toEqual(['fire_sword', 'fang']);
    expect(back.entries.find((e: any) => e.key === 'wolf').fields).toEqual({ loot: ['fire_sword', 'fang'] });
    expect(back.checks).toEqual([]);
  });

  it('a link to a trashed entry does not block a strict export (the badge cannot show or remove it)', async () => {
    const fang = await entry('Fang', 'item');
    await setFields(fang, { value: 1 });
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 10 } });
    const v = (db.prepare('SELECT version FROM cards WHERE id=?').get(fang) as { version: number }).version;
    await ok('cards/update', { id: fang, visibility: 'deleted', version: v });
    const r = await get('?strict=1');
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).checks).toEqual([]);
    // A trashed source too.
    const v2 = (db.prepare('SELECT version FROM cards WHERE id=?').get(wolf) as { version: number }).version;
    await ok('cards/update', { id: wolf, visibility: 'deleted', version: v2 });
    expect((await get('?strict=1')).statusCode).toBe(200);
  });

  it('more than 1,000 checks: the first 1,000 are listed, with checksTotal and checksTruncated (file and 422 body)', async () => {
    await setFields(sword, { value: null });
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at,is_doc,entry_type_id,entry_key,fields_json) VALUES (?,?,?,?,?,'default','[]',0,0,1,?,?,'{}')");
    const deck = (db.prepare('SELECT deck_id d FROM cards WHERE id=?').get(sword) as { d: string }).d;
    for (let i = 0; i < 1004; i++) ins.run(newId(), ++seq, deck, owner, `# E${i}`, types.item, `e${i}`);
    const d = await exported();
    expect(Object.keys(d).slice(-3)).toEqual(['checks', 'checksTotal', 'checksTruncated']);
    expect(d.checks).toHaveLength(1000);
    expect(d.checksTotal).toBe(1005);
    expect(d.checksTruncated).toBe(true);
    const r = await get('?strict=1');
    expect(r.statusCode).toBe(422);
    const body = r.json();
    expect(body.checks).toHaveLength(1000);
    expect(body).toMatchObject({ error: 'checks_failed', checksTotal: 1005, checksTruncated: true });
  });

  it('untyped lore is absent unless includePages=1; parents point at exported keys', async () => {
    const page = await entry('Lore of the Isles', null);
    await ok('wiki/setParent', { cardId: sword, parentId: page });
    let d = await exported();
    expect(d.entries.map((e: any) => e.name)).not.toContain('Lore of the Isles');
    expect(d.entries.find((e: any) => e.key === 'fire_sword').parent).toBeNull();
    d = await exported('?includePages=1');
    const lore = d.entries.find((e: any) => e.name === 'Lore of the Isles');
    expect(lore).toMatchObject({ id: page, type: null, fields: {} });
    expect(d.entries.find((e: any) => e.key === 'fire_sword').parent).toBe(lore.key);
  });

  it('text is the entry content after its title line; image fields export the file name and download path', async () => {
    const v = (db.prepare('SELECT content_version FROM cards WHERE id=?').get(sword) as { content_version: number }).content_version;
    await ok('cards/update', { id: sword, content: '# Fire Sword\nBurns *bright*.', contentVersion: v });
    const fileId = newId();
    db.prepare("INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,'sword.png','image/png',3,0)").run(fileId, sword, owner);
    await setFields(sword, { icon: fileId });
    const fire = (await exported()).entries.find((e: any) => e.key === 'fire_sword');
    expect(fire.text).toBe('Burns *bright*.');
    expect(fire.fields.icon).toEqual({ file: 'sword.png', url: `/api/files/${fileId}` });
    // An id that is not (or no longer) an attachment of this entry is left out and listed; strict refuses.
    db.prepare('DELETE FROM files WHERE id=?').run(fileId);
    const d = await exported();
    expect(d.entries.find((e: any) => e.key === 'fire_sword').fields.icon).toBeUndefined();
    expect(d.checks).toEqual([{ entry: 'fire_sword', problem: 'invalid_value', detail: 'icon: image not attached' }]);
    expect((await get('?strict=1')).statusCode).toBe(422);
  });

  it('without includePages, links and references to plain pages are broken_ref (left out, listed, strict fails)', async () => {
    await ok('wiki/createLinkKind', { projectId, key: 'about', label: 'about', reverseLabel: 'told in', fromTypes: [], toTypes: [] });
    const page = await entry('Lore of the Isles', null);
    const pageKey = (db.prepare('SELECT entry_key k FROM cards WHERE id=?').get(page) as { k: string | null }).k
      ?? (db.prepare("UPDATE cards SET entry_key='lore_of_the_isles' WHERE id=?").run(page), 'lore_of_the_isles');
    await ok('wiki/updateType', { id: types.creature, fields: [
      { key: 'loot', label: 'Loot', kind: 'entries', target: 'item' }, { key: 'origin', label: 'Origin', kind: 'entry' },
    ] });
    await setFields(wolf, { origin: pageKey });
    await ok('wiki/addLink', { kindKey: 'about', fromCardId: wolf, toCardId: page });
    let d = await exported();
    expect(d.entries.find((e: any) => e.key === 'wolf').fields).toEqual({ loot: ['fire_sword'] });
    expect(d.links.map((l: any) => l.kind)).toEqual(['drops']);
    expect(d.checks.map((c: any) => [c.entry, c.problem])).toEqual([['wolf', 'broken_ref'], ['wolf', 'broken_ref']]);
    expect((await get('?strict=1')).statusCode).toBe(422);
    // With includePages the page is in the file: the reference and the link are kept, nothing is listed.
    d = await exported('?includePages=1');
    expect(d.entries.find((e: any) => e.key === 'wolf').fields).toEqual({ loot: ['fire_sword'], origin: pageKey });
    expect(d.links.map((l: any) => [l.kind, l.to])).toEqual([['about', pageKey], ['drops', 'fire_sword']]);
    expect(d.checks).toEqual([]);
    expect((await get('?strict=1&includePages=1')).statusCode).toBe(200);
  });

  it('strict=1 with one failing check → 422 checks_failed, no file', async () => {
    expect((await get('?strict=1')).statusCode).toBe(200);
    await setFields(sword, { value: null });
    const r = await get('?strict=1');
    expect(r.statusCode).toBe(422);
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(r.json()).toEqual({ error: 'checks_failed', checks: [{ entry: 'fire_sword', problem: 'missing_required', detail: 'value' }] });
    // Non-strict still exports, without the missing value.
    expect((await exported()).entries.find((e: any) => e.key === 'fire_sword').fields.value).toBeUndefined();
  });

  it('a sum rule over its max is listed; works_on quest links are not game data', async () => {
    const pelt = await entry('Pelt', 'item');
    await setFields(pelt, { value: 2 });
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: pelt, props: { chance: 70 } });
    const questDeck = mkDeck(projectId, 'task', 2);
    const q = (await ok('cards/create', { deckId: questDeck, content: '# Forge it' })).id;
    await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: sword });
    const d = await exported();
    expect(d.links.map((l: any) => [l.kind, l.to, l.order])).toEqual([['drops', 'fire_sword', 0], ['drops', 'pelt', 1]]);
    expect(d.checks).toEqual([{ entry: 'wolf', problem: 'sum_exceeded', detail: 'drops.chance adds up to 110, max 100' }]);
  });

  it('a read token can export; a token confined to another project and a user without access get 404', async () => {
    const read = await mkToken({ access: 'read' });
    expect((await exported('', { bearer: read })).entries.length).toBe(2);
    const other = mkProject('Other');
    const confined = await mkToken({ role: 'producer', projectIds: [other] });
    expect((await get('', { bearer: confined })).statusCode).toBe(404);
    const confinedHere = await mkToken({ role: 'producer', projectIds: [projectId] });
    expect((await get('', { bearer: confinedHere })).statusCode).toBe(200);
    const stranger = cookieFor(mkUser('member'));
    expect((await get('', { cookie: stranger })).statusCode).toBe(404);
    expect((await get('', { cookie: ownerCookie }, 'nope')).statusCode).toBe(404);
    expect((await get('', {})).statusCode).toBe(401);
    // An observer with access may export.
    const observer = cookieFor(mkUser('observer', [{ projectId }]));
    expect((await get('', { cookie: observer })).statusCode).toBe(200);
  });

  it('renaming an entry keeps its key and id in the next export', async () => {
    const before = (await exported()).entries.find((e: any) => e.id === sword);
    const v = (db.prepare('SELECT content_version FROM cards WHERE id=?').get(sword) as { content_version: number }).content_version;
    await ok('cards/update', { id: sword, content: '# Blazing Blade', contentVersion: v });
    const after = (await exported()).entries.find((e: any) => e.id === sword);
    expect(after).toMatchObject({ id: before.id, key: 'fire_sword', name: 'Blazing Blade' });
  });

  it('over the caps → 413 too_large', async () => {
    const saved = { ...EXPORT_LIMITS };
    try {
      EXPORT_LIMITS.maxEntries = 1;
      let r = await get();
      expect(r.statusCode).toBe(413);
      expect(r.json().error).toBe('too_large');
      EXPORT_LIMITS.maxEntries = saved.maxEntries;
      EXPORT_LIMITS.maxLinks = 0;
      r = await get();
      expect(r.statusCode).toBe(413);
      EXPORT_LIMITS.maxLinks = saved.maxLinks;
      // Bytes: field values + link props + exported text. The fixture is a few hundred bytes.
      EXPORT_LIMITS.maxBytes = 100;
      r = await get();
      expect(r.statusCode).toBe(413);
      expect(r.json()).toMatchObject({ error: 'too_large', data: { maxBytes: 100 } });
      EXPORT_LIMITS.maxBytes = 10_000;
      expect((await get()).statusCode).toBe(200);
    } finally { Object.assign(EXPORT_LIMITS, saved); }
  });

  it('a disabled workspace answers 423', async () => {
    db.prepare('UPDATE account SET is_disabled=1').run();
    expect((await get()).statusCode).toBe(423);
  });
});

describe('writeWikiExport', () => {
  it('writes chunks that join to the same document, and strict writes nothing when checks fail', () => {
    const chunks: string[] = [];
    const { checks, total } = writeWikiExport(db, projectId, { strict: false, includePages: false }, (c) => chunks.push(c));
    expect([checks, total]).toEqual([[], 0]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.join('')).entries).toHaveLength(2);
    db.prepare("UPDATE cards SET fields_json='{}' WHERE id=?").run(sword);
    const none: string[] = [];
    const r = writeWikiExport(db, projectId, { strict: true, includePages: false }, (c) => none.push(c));
    expect(r.checks.map((c) => c.problem)).toEqual(['missing_required']);
    expect(none).toEqual([]);
  });
});

describe('the Wiki badge and the export', () => {
  /** The store as the client builds it from the snapshot (the collections campaignChecks reads). */
  const clientState = async () => {
    const r = await app.inject({ method: 'GET', url: '/api/snapshot', headers: headers({ cookie: ownerCookie }) });
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    const byId = (rows: any[]) => new Map(rows.map((x) => [x.id, x]));
    return { cards: byId(s.cards), decks: byId(s.decks), entryTypes: byId(s.entryTypes), linkKinds: byId(s.linkKinds), entryLinks: byId(s.entryLinks), files: byId(s.files) } as any;
  };

  it('list the same checks for the same project', async () => {
    // A trashed link target, an image no longer attached, a link and a reference to a plain page, a missing value, a quest link.
    const fang = await entry('Fang', 'item');
    await setFields(fang, { value: 1 });
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 10 } });
    const v = (db.prepare('SELECT version FROM cards WHERE id=?').get(fang) as { version: number }).version;
    await ok('cards/update', { id: fang, visibility: 'deleted', version: v });
    const fileId = newId();
    db.prepare("INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,'sword.png','image/png',3,0)").run(fileId, sword, owner);
    await setFields(sword, { icon: fileId, value: null });
    db.prepare('DELETE FROM files WHERE id=?').run(fileId);
    await ok('wiki/createLinkKind', { projectId, key: 'about', label: 'about', reverseLabel: 'told in', fromTypes: [], toTypes: [] });
    const page = await entry('Lore of the Isles', null);
    await ok('wiki/addLink', { kindKey: 'about', fromCardId: wolf, toCardId: page });
    await ok('wiki/updateType', { id: types.creature, fields: [
      { key: 'loot', label: 'Loot', kind: 'entries', target: 'item' }, { key: 'origin', label: 'Origin', kind: 'entry' },
    ] });
    const pageKey = (db.prepare('SELECT entry_key k FROM cards WHERE id=?').get(page) as { k: string }).k;
    await setFields(wolf, { origin: pageKey });
    const q = (await ok('cards/create', { deckId: mkDeck(projectId, 'task', 2), content: '# Forge it' })).id;
    await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: sword });

    const d = await exported();
    const badge = campaignChecks(await clientState(), projectId);
    const key = (c: any) => `${c.entry} ${c.problem} ${c.detail}`;
    expect(badge.total).toBe(d.checks.length);
    expect(badge.checks.map(key).sort()).toEqual(d.checks.map(key).sort());
    expect(d.checks.map((c: any) => c.problem).sort()).toEqual(['broken_ref', 'broken_ref', 'invalid_value', 'missing_required']);
  });
});

describe('POST /api/query: wiki task columns', () => {
  it('tasks answer entryTypeId, entryKey, fields and wikiParentId, and filter on entryKey', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/query', headers: { ...headers({ cookie: ownerCookie }), 'content-type': 'application/json' },
      payload: { query: { _root: [{ [`cards(${JSON.stringify({ entryKey: 'fire_sword' })})`]: ['entryTypeId', 'entryKey', 'fields', 'wikiParentId'] }] } } as any,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cards[sword]).toMatchObject({ entryTypeId: types.weapon, entryKey: 'fire_sword', wikiParentId: null, fields: expect.objectContaining({ damage: 12 }) });
    expect(Object.keys(r.json().cards)).toEqual([sword]);
  });
});

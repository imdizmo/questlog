import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { cardRow, deckRow } from '../server/commands/rows';

const HOST = 'localhost:8780';
const SPACES = JSON.stringify([{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]);
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
let owner: string;
let ownerCookie: string;
let projectId: string;
let loreDeck: string;
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
const mkToken = async (input: Record<string, unknown>): Promise<string> =>
  (await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], ...input })).token;
const history = async (cardId: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/history`, headers: { host: HOST, cookie: ownerCookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { changes: any[] }[];
};
const entry = (name: string, extra: Record<string, unknown> = {}, p = projectId) => ok('wiki/createEntry', { projectId: p, typeId: null, name, ...extra });
const card = (id: string) => cardRow(db, id)!;

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
  loreDeck = mkDeck(projectId);
});
afterEach(async () => { await app.close(); });

describe('wiki/createEntry', () => {
  it('creates a Lore task "# name" in the first doc list, with a unique key', async () => {
    mkDeck(projectId, 'doc', 5);
    mkDeck(projectId, 'task', 0);
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const a = await entry('Fire Sword', { typeId: item });
    const b = await entry('Fire Sword', { typeId: item });
    expect(a.key).toBe('fire_sword');
    expect(b.key).toBe('fire_sword_2');
    expect(card(a.id)).toMatchObject({ deckId: loreDeck, isDoc: true, content: '# Fire Sword', entryTypeId: item, entryKey: 'fire_sword', fields: {} });
    expect((await history(a.id)).flatMap((h) => h.changes).map((c) => c.kind)).toContain('created');
  });

  it('creates the "Lore" doc list when the project has none', async () => {
    const other = mkProject('Q');
    mkDeck(other, 'task');
    const { id } = await entry('Old King', {}, other);
    const c = card(id);
    expect(c.isDoc).toBe(true);
    expect(deckRow(db, c.deckId as string)).toMatchObject({ title: 'Lore', deckType: 'doc', projectId: other });
    // The next entry reuses it.
    const second = await entry('Young King', {}, other);
    expect(card(second.id).deckId).toBe(c.deckId);
  });

  it('files the entry under a parent; refuses a type of another project', async () => {
    const parent = await entry('Kingdoms');
    const child = await entry('North', { parentId: parent.id });
    expect(card(child.id).wikiParentId).toBe(parent.id);
    const other = mkProject('Q');
    const foreign = (await ok('wiki/createType', { projectId: other, name: 'Item' })).id;
    await fail('wiki/createEntry', { projectId, typeId: foreign, name: 'X' }, 400, 'unknown_type');
  });
});

describe('wiki/setEntry', () => {
  it('patches fields: null removes a key, unsent keys stay', async () => {
    const { id } = await entry('Fire Sword');
    await ok('wiki/setEntry', { cardId: id, fields: { damage: 12 } });
    await ok('wiki/setEntry', { cardId: id, fields: { rarity: 'epic' } });
    expect(card(id).fields).toEqual({ damage: 12, rarity: 'epic' });
    await ok('wiki/setEntry', { cardId: id, fields: { damage: null } });
    expect(card(id).fields).toEqual({ rarity: 'epic' });
  });

  it('accepts scalars, arrays and {min,max}; refuses other shapes and over 64 KB', async () => {
    const { id } = await entry('Fire Sword');
    await ok('wiki/setEntry', { cardId: id, fields: { tags: ['a', 'b'], dmg: { min: 1, max: 3 }, sharp: true } });
    expect(card(id).fields).toEqual({ tags: ['a', 'b'], dmg: { min: 1, max: 3 }, sharp: true });
    await fail('wiki/setEntry', { cardId: id, fields: { x: { a: 1 } } }, 400, 'invalid_payload');
    await fail('wiki/setEntry', { cardId: id, fields: { x: [{ a: 1 }] } }, 400, 'invalid_payload');
    await fail('wiki/setEntry', { cardId: id, fields: { lore: 'x'.repeat(65 * 1024) } }, 413, 'too_large');
  });

  it('retyping keeps every value', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item', fields: [{ key: 'damage', label: 'Damage', kind: 'number' }] })).id;
    const spell = (await ok('wiki/createType', { projectId, name: 'Spell' })).id;
    const { id } = await entry('Fire Sword', { typeId: item });
    await ok('wiki/setEntry', { cardId: id, fields: { damage: 12, rarity: 'epic' } });
    await ok('wiki/setEntry', { cardId: id, typeId: spell });
    expect(card(id)).toMatchObject({ entryTypeId: spell, fields: { damage: 12, rarity: 'epic' } });
    await ok('wiki/setEntry', { cardId: id, typeId: null });
    expect(card(id)).toMatchObject({ entryTypeId: null, fields: { damage: 12, rarity: 'epic' } });
  });

  it('keys: an existing key → 409 duplicate_key; a bad key → 400; a free key is set', async () => {
    await entry('Fire Sword');
    const { id } = await entry('Ice Sword');
    await fail('wiki/setEntry', { cardId: id, key: 'fire_sword' }, 409, 'duplicate_key');
    await fail('wiki/setEntry', { cardId: id, key: 'Bad Key' }, 400, 'invalid_payload');
    await ok('wiki/setEntry', { cardId: id, key: 'frost_blade' });
    expect(card(id).entryKey).toBe('frost_blade');
    // Re-sending its own key is fine.
    await ok('wiki/setEntry', { cardId: id, key: 'frost_blade' });
  });

  it('a quest → 409 not_lore', async () => {
    const taskDeck = mkDeck(projectId, 'task');
    const quest = (await ok('cards/create', { deckId: taskDeck, content: 'Fix bug' })).id;
    await fail('wiki/setEntry', { cardId: quest, fields: { a: 1 } }, 409, 'not_lore');
  });

  it('writes one entry history change with the changed keys and the type change', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const { id } = await entry('Fire Sword');
    await ok('wiki/setEntry', { cardId: id, fields: { damage: 12, rarity: 'epic' } });
    await ok('wiki/setEntry', { cardId: id, typeId: item, fields: { damage: 12, rarity: null } });
    const rows = await history(id);
    expect(rows[0].changes).toEqual([{ kind: 'entry', fields: ['rarity'], type: { from: null, to: item } }]);
    expect(rows[1].changes).toEqual([{ kind: 'entry', fields: ['damage', 'rarity'] }]);
    // Nothing changed: no new history row.
    const v = card(id).version;
    await ok('wiki/setEntry', { cardId: id, fields: { damage: 12 } });
    expect(card(id).version).toBe(v);
  });

  it('an observer → 403; a token confined to another project → 403; a read token → 403', async () => {
    const { id } = await entry('Fire Sword');
    const observer = mkUser('observer', [{ projectId }]);
    await fail('wiki/setEntry', { cardId: id, fields: { a: 1 } }, 403, 'forbidden', cookieFor(observer));
    await fail('wiki/setParent', { cardId: id, parentId: null }, 403, 'forbidden', cookieFor(observer));
    await fail('wiki/createEntry', { projectId, typeId: null, name: 'X' }, 403, 'forbidden', cookieFor(observer));
    const other = mkProject('Q');
    const confined = { bearer: await mkToken({ role: 'producer', projectIds: [other] }) };
    await fail('wiki/setEntry', { cardId: id, fields: { a: 1 } }, 403, 'forbidden', confined);
    await fail('wiki/setParent', { cardId: id, parentId: null }, 403, 'forbidden', confined);
    await fail('wiki/createEntry', { projectId, typeId: null, name: 'X' }, 403, 'forbidden', confined);
    const read = { bearer: await mkToken({ access: 'read' }) };
    await fail('wiki/setEntry', { cardId: id, fields: { a: 1 } }, 403, 'missing_scope', read);
    expect(card(id).fields).toEqual({});
    // In its own project the confined token works.
    mkDeck(other);
    const own = await ok('wiki/createEntry', { projectId: other, typeId: null, name: 'Mine' }, confined);
    await ok('wiki/setEntry', { cardId: own.id, fields: { a: 1 } }, confined);
  });
});

describe('wiki/setParent', () => {
  it('sets and clears the parent; a cycle → 409 cycle; quests and other projects are refused', async () => {
    const a = (await entry('A')).id;
    const b = (await entry('B')).id;
    const c = (await entry('C')).id;
    await ok('wiki/setParent', { cardId: b, parentId: a });
    await ok('wiki/setParent', { cardId: c, parentId: b });
    await fail('wiki/setParent', { cardId: a, parentId: c }, 409, 'cycle');
    await fail('wiki/setParent', { cardId: a, parentId: a }, 409, 'cycle');
    const taskDeck = mkDeck(projectId, 'task');
    const quest = (await ok('cards/create', { deckId: taskDeck, content: 'Fix bug' })).id;
    await fail('wiki/setParent', { cardId: a, parentId: quest }, 409, 'not_lore');
    await fail('wiki/setParent', { cardId: quest, parentId: a }, 409, 'not_lore');
    const other = mkProject('Q');
    mkDeck(other);
    const far = (await entry('Far', {}, other)).id;
    await fail('wiki/setParent', { cardId: a, parentId: far }, 409, 'other_campaign');
    await ok('wiki/setParent', { cardId: c, parentId: null });
    expect(card(c).wikiParentId).toBeNull();
    expect(card(b).wikiParentId).toBe(a);
  });
});

describe('wiki/pruneValues', () => {
  it('removes values of hidden or unknown fields from the entries of the type', async () => {
    const fields = [{ key: 'damage', label: 'Damage', kind: 'number' }, { key: 'rarity', label: 'Rarity', kind: 'text' }];
    const item = (await ok('wiki/createType', { projectId, name: 'Item', fields })).id;
    const one = (await entry('One', { typeId: item })).id;
    const two = (await entry('Two', { typeId: item })).id;
    const three = (await entry('Three', { typeId: item })).id;
    const untyped = (await entry('Loose')).id;
    await ok('wiki/setEntry', { cardId: one, fields: { damage: 1, rarity: 'a' } });
    await ok('wiki/setEntry', { cardId: two, fields: { damage: 2, rarity: 'b' } });
    await ok('wiki/setEntry', { cardId: three, fields: { damage: 3 } });
    await ok('wiki/setEntry', { cardId: untyped, fields: { rarity: 'c' } });
    await ok('wiki/updateType', { id: item, fields: [fields[0], { ...fields[1], hidden: true }] });
    expect(await ok('wiki/pruneValues', { typeId: item })).toEqual({ entriesChanged: 2, done: true });
    expect(card(one).fields).toEqual({ damage: 1 });
    expect(card(two).fields).toEqual({ damage: 2 });
    expect(card(three).fields).toEqual({ damage: 3 });
    expect(card(untyped).fields).toEqual({ rarity: 'c' });
    expect((await history(one))[0].changes).toEqual([{ kind: 'entry', fields: ['rarity'] }]);
    const member = mkUser('member', [{ projectId }]);
    await fail('wiki/pruneValues', { typeId: item }, 403, 'forbidden', cookieFor(member));
  });
});

describe('tasks/update guard', () => {
  it('a typed entry cannot leave its project or become a quest; untyped lore can', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const typed = (await entry('Fire Sword', { typeId: item })).id;
    const loose = (await entry('Loose')).id;
    const other = mkProject('Q');
    const otherDeck = mkDeck(other);
    const sameCampaign = mkDeck(projectId, 'doc', 9);
    await fail('cards/update', { id: typed, deckId: otherDeck }, 409, 'entry_typed');
    await fail('cards/update', { id: typed, isDoc: false }, 409, 'entry_typed');
    await fail('cards/bulkUpdate', { ids: [typed], deckId: otherDeck }, 409, 'entry_typed');
    expect(card(typed).deckId).toBe(loreDeck);
    await ok('cards/update', { id: typed, deckId: sameCampaign });
    await ok('cards/update', { id: loose, deckId: otherDeck });
    expect(card(loose).deckId).toBe(otherDeck);
  });
});

describe('fix round 1', () => {
  it('pruneValues changes at most 500 entries per call and reports done', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item', fields: [{ key: 'damage', label: 'Damage', kind: 'number' }] })).id;
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at,is_doc,entry_type_id,entry_key,fields_json) VALUES (?,?,?,?,?,'default','[]',0,0,1,?,?,?)");
    for (let i = 0; i < 503; i++) ins.run(newId(), ++seq, loreDeck, owner, `# E${i}`, item, `e${i}`, i < 502 ? '{"damage":1,"junk":2}' : '{"damage":1}');
    expect(await ok('wiki/pruneValues', { typeId: item })).toEqual({ entriesChanged: 500, done: false });
    expect(await ok('wiki/pruneValues', { typeId: item })).toEqual({ entriesChanged: 2, done: true });
    expect(await ok('wiki/pruneValues', { typeId: item })).toEqual({ entriesChanged: 0, done: true });
    expect((db.prepare("SELECT COUNT(*) n FROM cards WHERE fields_json LIKE '%junk%'").get() as { n: number }).n).toBe(0);
  });

  it('untyped lore leaving its project drops its wiki parent and children, and is re-keyed on a clash', async () => {
    const other = mkProject('Q');
    const otherDeck = mkDeck(other);
    await entry('Kingdoms', {}, other);
    const top = (await entry('World')).id;
    const k = (await entry('Kingdoms', { parentId: top })).id;
    const kids = [(await entry('North', { parentId: k })).id, (await entry('South', { parentId: k })).id];
    await ok('cards/update', { id: k, deckId: otherDeck });
    expect(card(k)).toMatchObject({ deckId: otherDeck, wikiParentId: null, entryKey: 'kingdoms_2' });
    for (const c of kids) expect(card(c).wikiParentId).toBeNull();
    expect((await history(k))[0].changes).toEqual(expect.arrayContaining([{ kind: 'entry', fields: [], parent: { from: top, to: null }, key: { from: 'kingdoms', to: 'kingdoms_2' } }]));
  });

  it('untyped lore turned into a quest drops its wiki parent and children', async () => {
    const top = (await entry('World')).id;
    const mixed = mkDeck(projectId, 'mixed', 7);
    const k = (await entry('Kingdoms', { parentId: top })).id;
    const kid = (await entry('North', { parentId: k })).id;
    await ok('cards/update', { id: k, deckId: mixed });
    await ok('cards/update', { id: k, isDoc: false });
    expect(card(k)).toMatchObject({ isDoc: false, wikiParentId: null, entryKey: 'kingdoms' });
    expect(card(kid).wikiParentId).toBeNull();
  });

  it('a typed entry of a deleted list can be restored and moved back into its project, not out of it', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const id = (await entry('Fire Sword', { typeId: item })).id;
    const spare = mkDeck(projectId, 'doc', 9);
    const other = mkProject('Q');
    const otherDeck = mkDeck(other);
    await ok('decks/delete', { id: loreDeck });
    await ok('cards/update', { id, visibility: 'default' });
    expect(card(id).deckId).toBeNull();
    await fail('cards/update', { id, deckId: otherDeck }, 409, 'entry_typed');
    await ok('cards/update', { id, deckId: spare });
    expect(card(id).deckId).toBe(spare);
  });

  it('lore restored from a deleted list back into its project keeps its subtree and its parent', async () => {
    const spare = mkDeck(projectId, 'doc', 9);
    const top = (await entry('World')).id;
    await ok('cards/update', { id: top, deckId: spare });
    const k = (await entry('Kingdoms', { parentId: top })).id;
    const kids = [(await entry('North', { parentId: k })).id, (await entry('South', { parentId: k })).id];
    for (const c of kids) await ok('cards/update', { id: c, deckId: spare });
    await ok('decks/delete', { id: loreDeck });
    await ok('cards/update', { id: k, visibility: 'default' });
    expect(card(k).deckId).toBeNull();
    await ok('cards/update', { id: k, deckId: spare });
    expect(card(k)).toMatchObject({ deckId: spare, wikiParentId: top, entryKey: 'kingdoms' });
    for (const c of kids) expect(card(c).wikiParentId).toBe(k);
  });

  it('lore restored from a deleted list into another project leaves the old tree', async () => {
    const spare = mkDeck(projectId, 'doc', 9);
    const other = mkProject('Q');
    const otherDeck = mkDeck(other);
    const top = (await entry('World')).id;
    await ok('cards/update', { id: top, deckId: spare });
    const k = (await entry('Kingdoms', { parentId: top })).id;
    const kid = (await entry('North', { parentId: k })).id;
    await ok('cards/update', { id: kid, deckId: spare });
    await entry('Kingdoms', {}, other);
    await ok('decks/delete', { id: loreDeck });
    await ok('cards/update', { id: k, visibility: 'default' });
    await ok('cards/update', { id: k, deckId: otherDeck });
    expect(card(k)).toMatchObject({ deckId: otherDeck, wikiParentId: null, entryKey: 'kingdoms_2' });
    expect(card(kid).wikiParentId).toBeNull();
  });

  it('typing keyless lore gives it a key from its title', async () => {
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    await entry('Old Map');
    const plain = (await ok('cards/create', { deckId: loreDeck, content: '# Old Map\nfound in a cave' })).id;
    expect(card(plain).entryKey).toBeNull();
    await ok('wiki/setEntry', { cardId: plain, typeId: item });
    expect(card(plain).entryKey).toBe('old_map_2');
  });

  it('setParent writes history; a parent the caller cannot see is 404 like a missing one', async () => {
    const a = (await entry('A')).id;
    const b = (await entry('B')).id;
    await ok('wiki/setParent', { cardId: b, parentId: a });
    expect((await history(b))[0].changes).toEqual([{ kind: 'entry', fields: [], parent: { from: null, to: a } }]);
    const hidden = mkProject('Hidden');
    mkDeck(hidden);
    const secret = (await entry('Secret', {}, hidden)).id;
    const taskDeck = mkDeck(hidden, 'task');
    const quest = (await ok('cards/create', { deckId: taskDeck, content: 'Q' })).id;
    const member = cookieFor(mkUser('member', [{ projectId }]));
    await fail('wiki/setParent', { cardId: b, parentId: secret }, 404, 'not_found', member);
    await fail('wiki/setParent', { cardId: b, parentId: quest }, 404, 'not_found', member);
    await fail('wiki/setParent', { cardId: b, parentId: 'nope' }, 404, 'not_found', member);
    await fail('wiki/createEntry', { projectId, typeId: null, name: 'X', parentId: secret }, 404, 'not_found', member);
    // Visible to the owner, but in another project.
    await fail('wiki/createEntry', { projectId, typeId: null, name: 'X', parentId: secret }, 409, 'other_campaign');
  });

  it('refuses a bad field key; pruneValues refuses a token confined to another project', async () => {
    const { id } = await entry('Fire Sword');
    await fail('wiki/setEntry', { cardId: id, fields: { 'Bad Key': 1 } }, 400, 'invalid_payload');
    const item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
    const confined = { bearer: await mkToken({ role: 'producer', projectIds: [mkProject('Q')] }) };
    await fail('wiki/pruneValues', { typeId: item }, 403, 'forbidden', confined);
  });
});

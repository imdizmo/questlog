import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { LiveHub } from '../server/live';

const HOST = 'localhost:8780';
const SPACES = JSON.stringify([{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]);
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
let owner: string;
let ownerCookie: string;
let projectId: string;
let questDeck: string;
let types: Record<string, string>;
let drops: string;
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
const snap = async (a: Auth | string) => {
  const auth = typeof a === 'string' ? { cookie: a } : a;
  const r = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const mkToken = async (input: Record<string, unknown>): Promise<string> =>
  (await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], ...input })).token;
const entry = async (name: string, type: string | null, p = projectId): Promise<string> =>
  (await ok('wiki/createEntry', { projectId: p, typeId: type && types[type], name })).id;
const quest = async (title: string, deckId = questDeck): Promise<string> => (await ok('cards/create', { deckId, content: `# ${title}` })).id;
const linkIds = async (a: Auth | string = ownerCookie) => (await snap(a)).entryLinks.map((l: any) => l.id);
const me = () => ({ id: owner, email: '', name: 'o', timezone: null, disabled: false, createdAt: 0 });
type LinkEvent = { op: string; row: { id: string; projectId: string } & Record<string, unknown> };
/** The entryLink events of a batch, rows typed. */
const linkRows = (events: { model: string; op: string; row: unknown }[]): LinkEvent[] =>
  events.filter((e) => e.model === 'entryLink').map((e) => ({ op: e.op, row: e.row as LinkEvent['row'] }));
const linkEvents = (events: { model: string; op: string; row: unknown }[]) => linkRows(events).map((e) => ({ op: e.op, id: e.row.id }));
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

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
  mkDeck(projectId);
  questDeck = mkDeck(projectId, 'task', 2);
  types = {};
  types.item = (await ok('wiki/createType', { projectId, name: 'Item' })).id;
  types.weapon = (await ok('wiki/createType', { projectId, name: 'Weapon', parentTypeId: types.item })).id;
  types.creature = (await ok('wiki/createType', { projectId, name: 'Creature' })).id;
  types.location = (await ok('wiki/createType', { projectId, name: 'Location' })).id;
  drops = (await ok('wiki/createLinkKind', {
    projectId, key: 'drops', label: 'drops', reverseLabel: 'dropped by', fromTypes: ['creature'], toTypes: ['item'],
    props: [{ key: 'chance', label: 'Chance', kind: 'number', min: 0, max: 100 }, { key: 'qty', label: 'Qty', kind: 'integer', min: 1 }],
    sumRule: { prop: 'chance', max: 100 },
  })).id;
});
afterEach(async () => { await app.close(); });

describe('wiki/addLink', () => {
  it('links a Creature to a Weapon through toTypes ["item"] (inheritance), with props and an order', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const pelt = await entry('Pelt', 'item');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 40, qty: 1 } });
    const second = (await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: pelt })).id;
    const rows = (await snap(ownerCookie)).entryLinks;
    expect(rows).toEqual([
      expect.objectContaining({ id, projectId, kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 40, qty: 1 } }),
      expect.objectContaining({ id: second, props: {} }),
    ]);
    expect(rows[1].sortIndex).toBeGreaterThan(rows[0].sortIndex);
  });

  it('the sum rule is not enforced here: it is a check', async () => {
    const wolf = await entry('Wolf', 'creature');
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: await entry('A', 'item'), props: { chance: 80 } });
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: await entry('B', 'item'), props: { chance: 80 } });
  });

  it('a type outside fromTypes/toTypes → 409 type_not_allowed', async () => {
    const wolf = await entry('Wolf', 'creature');
    const cave = await entry('Cave', 'location');
    const fang = await entry('Fang', 'weapon');
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: cave }, 409, 'type_not_allowed');
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: fang, toCardId: fang }, 409, 'type_not_allowed');
    // An untyped page fits only a kind that allows any type.
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: await entry('Plain', null), toCardId: fang }, 409, 'type_not_allowed');
    // A quest is never the source of a typed kind.
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: await quest('Hunt'), toCardId: fang }, 409, 'type_not_allowed');
    expect(await linkIds()).toEqual([]);
  });

  it('props: {chance:150} with max 100 → 400 invalid_props with the problem codes', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const r = await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 150 } }, 400, 'invalid_props');
    expect(r.data).toEqual({ problems: { chance: 'above_max' } });
    const r2 = await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { qty: 1.5, color: 'red' } }, 400, 'invalid_props');
    expect(r2.data).toEqual({ problems: { qty: 'wrong_kind', color: 'unknown_prop' } });
  });

  it('an entry property resolves keys of the project: wrong type and missing keys are problems', async () => {
    await ok('wiki/createLinkKind', {
      projectId, key: 'sells', label: 'sells', reverseLabel: 'sold by', fromTypes: [], toTypes: [],
      props: [{ key: 'for', label: 'For', kind: 'entry', target: 'item' }],
    });
    const shop = await entry('Shop', 'location');
    await entry('Gold', 'item');
    const fang = await entry('Fang', 'weapon');
    await ok('wiki/addLink', { kindKey: 'sells', fromCardId: shop, toCardId: fang, props: { for: 'gold' } });
    const r = await fail('wiki/addLink', { kindKey: 'sells', fromCardId: shop, toCardId: fang, props: { for: 'shop' } }, 400, 'invalid_props');
    expect(r.data).toEqual({ problems: { for: 'wrong_type_ref' } });
    const r2 = await fail('wiki/addLink', { kindKey: 'sells', fromCardId: shop, toCardId: fang, props: { for: 'ghost' } }, 400, 'invalid_props');
    expect(r2.data).toEqual({ problems: { for: 'broken_ref' } });
  });

  it('works_on: quest → entry is fine; Lore → Lore, quest → quest and entry → quest → 409 type_not_allowed', async () => {
    const q = await quest('Slay the wolf');
    const wolf = await entry('Wolf', 'creature');
    const plain = await entry('Notes', null);
    const { id } = await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: wolf });
    await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: plain });
    expect(await linkIds()).toContain(id);
    await fail('wiki/addLink', { kindKey: 'works_on', fromCardId: plain, toCardId: wolf }, 409, 'type_not_allowed');
    await fail('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: await quest('Other') }, 409, 'type_not_allowed');
    await fail('wiki/addLink', { kindKey: 'works_on', fromCardId: wolf, toCardId: q }, 409, 'type_not_allowed');
    // works_on has no properties.
    await fail('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: wolf, props: { a: 1 } }, 400, 'invalid_props');
  });

  it('across projects → 409 other_campaign; an unknown kind → 400 unknown_kind; a deleted task → 409', async () => {
    const wolf = await entry('Wolf', 'creature');
    const q = mkProject('Q');
    mkDeck(q);
    const foreign = await entry('Foreign', null, q);
    await ok('wiki/createLinkKind', { projectId: q, key: 'near', label: 'near', reverseLabel: 'near', fromTypes: [], toTypes: [] });
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: foreign }, 409, 'other_campaign');
    await fail('wiki/addLink', { kindKey: 'works_on', fromCardId: await quest('Hunt'), toCardId: foreign }, 409, 'other_campaign');
    // A kind of another project is unknown here.
    await fail('wiki/addLink', { kindKey: 'near', fromCardId: wolf, toCardId: wolf }, 400, 'unknown_kind');
    const fang = await entry('Fang', 'weapon');
    await ok('cards/update', { id: fang, visibility: 'deleted' });
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang }, 409, 'invalid_transition');
    await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: 'nope' }, 404, 'not_found');
    expect(await linkIds()).toEqual([]);
  });

  it('keyless lore gets a key from its title when it is first linked, so the export can name it', async () => {
    await ok('wiki/createLinkKind', { projectId, key: 'about', label: 'about', reverseLabel: 'told in', fromTypes: [], toTypes: [] });
    const deck = (db.prepare("SELECT id FROM decks WHERE project_id=? AND deck_type='doc'").get(projectId) as { id: string }).id;
    const page = (await ok('cards/create', { deckId: deck, content: '# Old Map' })).id;
    const notes = (await ok('cards/create', { deckId: deck, content: '# Notes' })).id;
    const keyOf = (id: string) => (db.prepare('SELECT entry_key k FROM cards WHERE id=?').get(id) as { k: string | null }).k;
    expect([keyOf(page), keyOf(notes)]).toEqual([null, null]);
    await entry('Old Map', null);
    const wolf = await entry('Wolf', 'creature');
    const r = dispatch(db, me(), 'wiki/addLink', { kindKey: 'about', fromCardId: wolf, toCardId: page });
    expect(keyOf(page)).toBe('old_map_2');
    expect(r.events).toEqual(expect.arrayContaining([{ model: 'card', op: 'upsert', row: expect.objectContaining({ id: page, entryKey: 'old_map_2' }) }]));
    await ok('wiki/addLink', { kindKey: 'about', fromCardId: notes, toCardId: wolf });
    expect(keyOf(notes)).toBe('notes');
    // A quest link (works_on) leaves the target as it is: quest links are not game data.
    const other = (await ok('cards/create', { deckId: deck, content: '# Draft' })).id;
    await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: await quest('Draw it'), toCardId: other });
    expect(keyOf(other)).toBeNull();
  });

  it('at most 500 links from one task → 409 limit', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const ins = db.prepare("INSERT INTO entry_links (id,project_id,kind_key,from_card_id,to_card_id,props_json,sort_index,created_at) VALUES (?,?,'drops',?,?,'{}',?,0)");
    for (let i = 0; i < 499; i++) ins.run(newId(), projectId, wolf, fang, i);
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang });
    const r = await fail('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang }, 409, 'limit');
    expect(r.data).toEqual({ max: 500 });
  });
});

describe('wiki/updateLink and wiki/removeLink', () => {
  it('updates props (replacing them) and the order; removes; each emits one event', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 40, qty: 2 } });
    const up = dispatch(db, me(), 'wiki/updateLink', { id, props: { chance: 25 }, sortIndex: 7 });
    expect(up.events).toEqual([{ model: 'entryLink', op: 'upsert', row: expect.objectContaining({ id, props: { chance: 25 }, sortIndex: 7 }) }]);
    await ok('wiki/updateLink', { id, sortIndex: 3 });
    expect((await snap(ownerCookie)).entryLinks[0]).toMatchObject({ props: { chance: 25 }, sortIndex: 3 });
    const r = await fail('wiki/updateLink', { id, props: { chance: -1 } }, 400, 'invalid_props');
    expect(r.data).toEqual({ problems: { chance: 'below_min' } });
    const rm = dispatch(db, me(), 'wiki/removeLink', { id });
    expect(rm.events).toEqual([{ model: 'entryLink', op: 'remove', row: { id, projectId } }]);
    expect(db.prepare('SELECT 1 FROM entry_links WHERE id=?').get(id)).toBeUndefined();
    await fail('wiki/removeLink', { id }, 404, 'not_found');
    await fail('wiki/updateLink', { id, sortIndex: 1 }, 404, 'not_found');
  });

  it('a stored value of a hidden property is kept as it is: never rejected, never dropped', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 15, qty: 2 } });
    // qty is retired: hidden, the only removal the editor offers.
    await ok('wiki/updateLinkKind', { id: drops, props: [
      { key: 'chance', label: 'Chance', kind: 'number', min: 0, max: 100 }, { key: 'qty', label: 'Qty', kind: 'integer', min: 1, hidden: true },
    ] });
    const stored = () => JSON.parse((db.prepare('SELECT props_json p FROM entry_links WHERE id=?').get(id) as { p: string }).p);
    // The edit form sends the visible props only.
    await ok('wiki/updateLink', { id, props: { chance: 20 } });
    expect(stored()).toEqual({ chance: 20, qty: 2 });
    // An older client that sends the hidden value back (changed or not) is not refused; the stored value stays.
    await ok('wiki/updateLink', { id, props: { chance: 25, qty: 2 } });
    await ok('wiki/updateLink', { id, props: { chance: 30, qty: 'junk' } });
    expect(stored()).toEqual({ chance: 30, qty: 2 });
    // Clearing a visible value still works; a key the kind never had is still refused.
    await ok('wiki/updateLink', { id, props: {} });
    expect(stored()).toEqual({ qty: 2 });
    const r = await fail('wiki/updateLink', { id, props: { luck: 1 } }, 400, 'invalid_props');
    expect(r.data).toEqual({ problems: { luck: 'unknown_prop' } });
  });

  it('a link hidden by a deleted task → 404 until the task is restored', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang });
    await ok('cards/update', { id: fang, visibility: 'deleted' });
    await fail('wiki/updateLink', { id, sortIndex: 1 }, 404, 'not_found');
    await fail('wiki/removeLink', { id }, 404, 'not_found');
    await ok('cards/update', { id: fang, visibility: 'default' });
    await ok('wiki/updateLink', { id, sortIndex: 1 });
  });
});

describe('link permissions', () => {
  it('observer, read token and a token confined to another project → 403', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang });
    const add = { kindKey: 'drops', fromCardId: wolf, toCardId: fang };
    const observer = cookieFor(mkUser('observer', [{ projectId }]));
    await fail('wiki/addLink', add, 403, 'forbidden', observer);
    await fail('wiki/updateLink', { id, sortIndex: 2 }, 403, 'forbidden', observer);
    await fail('wiki/removeLink', { id }, 403, 'forbidden', observer);
    const read = { bearer: await mkToken({ access: 'read' }) };
    await fail('wiki/addLink', add, 403, 'missing_scope', read);
    await fail('wiki/updateLink', { id, sortIndex: 2 }, 403, 'missing_scope', read);
    await fail('wiki/removeLink', { id }, 403, 'missing_scope', read);
    const other = mkProject('Q');
    const confined = { bearer: await mkToken({ role: 'producer', projectIds: [other], mayDelete: true }) };
    await fail('wiki/addLink', add, 403, 'forbidden', confined);
    // The link's source is outside the token's project: it can't even see the link.
    await fail('wiki/updateLink', { id, sortIndex: 2 }, 404, 'not_found', confined);
    await fail('wiki/removeLink', { id }, 404, 'not_found', confined);
    expect((await snap(ownerCookie)).entryLinks).toEqual([expect.objectContaining({ id, sortIndex: expect.any(Number) })]);
    expect(db.prepare('SELECT COUNT(*) n FROM entry_links').get()).toEqual({ n: 1 });
  });

  it('a target the actor cannot see → 404, as for a missing task (member and confined token)', async () => {
    const q = mkProject('Q');
    mkDeck(q);
    const hidden = await entry('Hidden', 'weapon', projectId);
    const member = cookieFor(mkUser('member', [{ projectId: q }]));
    const confined = { bearer: await mkToken({ role: 'producer', projectIds: [q] }) };
    const kindKey = 'near';
    await ok('wiki/createLinkKind', { projectId: q, key: kindKey, label: 'near', reverseLabel: 'near', fromTypes: [], toTypes: [] });
    for (const a of [member, confined]) {
      const mine = (await ok('wiki/createEntry', { projectId: q, typeId: null, name: 'Mine' }, a)).id;
      const unseen = await fail('wiki/addLink', { kindKey, fromCardId: mine, toCardId: hidden }, 404, 'not_found', a);
      const missing = await fail('wiki/addLink', { kindKey, fromCardId: mine, toCardId: 'no_such_card' }, 404, 'not_found', a);
      expect(unseen).toEqual(missing);
      await ok('wiki/addLink', { kindKey, fromCardId: mine, toCardId: mine }, a);
    }
  });
});

describe('links of deleted tasks', () => {
  it('deleting the target hides the link (snapshot + remove event); restoring brings it back; the row stays', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const q = await quest('Hunt');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang, props: { chance: 5 } });
    const work = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: fang })).id;
    const other = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: q, toCardId: wolf })).id;
    const del = dispatch(db, me(), 'cards/update', { id: fang, visibility: 'deleted' });
    expect(linkEvents(del.events).sort(byId)).toEqual([{ op: 'remove', id }, { op: 'remove', id: work }].sort(byId));
    expect(linkRows(del.events).every((e) => e.row.projectId === projectId)).toBe(true);
    expect(await linkIds()).toEqual([other]);
    expect(db.prepare('SELECT COUNT(*) n FROM entry_links').get()).toEqual({ n: 3 });
    const back = dispatch(db, me(), 'cards/update', { id: fang, visibility: 'default' });
    expect(linkEvents(back.events).sort(byId)).toEqual([{ op: 'upsert', id }, { op: 'upsert', id: work }].sort(byId));
    expect(linkRows(back.events).find((e) => e.row.id === id)!.row).toMatchObject({ kindKey: 'drops', props: { chance: 5 } });
    expect((await linkIds()).sort()).toEqual([id, work, other].sort());
  });

  it('restoring one end keeps a link hidden while its other end is still deleted', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    const { id } = await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang });
    await ok('cards/update', { id: fang, visibility: 'deleted' });
    await ok('cards/update', { id: wolf, visibility: 'deleted' });
    const back = dispatch(db, me(), 'cards/update', { id: wolf, visibility: 'default' });
    expect(linkEvents(back.events)).toEqual([]);
    expect(await linkIds()).toEqual([]);
    const both = dispatch(db, me(), 'cards/update', { id: fang, visibility: 'default' });
    expect(linkEvents(both.events)).toEqual([{ op: 'upsert', id }]);
  });

  it('live never routes a link upsert whose task is deleted', () => {
    const hub = new LiveHub(db);
    const got: any[] = [];
    hub.add({ send: (d) => got.push(JSON.parse(d)), close() {} }, { id: owner });
    const a = dispatch(db, me(), 'wiki/createEntry', { projectId, typeId: types.creature, name: 'Wolf' }).payload as { id: string };
    const b = dispatch(db, me(), 'wiki/createEntry', { projectId, typeId: types.item, name: 'Pelt' }).payload as { id: string };
    const l = dispatch(db, me(), 'wiki/addLink', { kindKey: 'drops', fromCardId: a.id, toCardId: b.id });
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(b.id);
    hub.publish('a1', l.events);
    expect(got).toEqual([]);
  });

  it('a member without access to the project gets no links in the snapshot', async () => {
    const wolf = await entry('Wolf', 'creature');
    const fang = await entry('Fang', 'weapon');
    await ok('wiki/addLink', { kindKey: 'drops', fromCardId: wolf, toCardId: fang });
    const q = mkProject('Q');
    const outsider = cookieFor(mkUser('member', [{ projectId: q }]));
    const insider = cookieFor(mkUser('member', [{ projectId }]));
    expect((await snap(outsider)).entryLinks).toEqual([]);
    expect(await linkIds(insider)).toHaveLength(1);
  });
});

describe('links of a task leaving its project (ruling: deleted, with removes to the old project)', () => {
  let q: string;
  let qLore: string;
  let qTasks: string;
  let near: string;
  /** A hub with one user who sees only the first project; returns the events it received. */
  const oldCampaignViewer = () => {
    const hub = new LiveHub(db);
    const got: any[] = [];
    hub.add({ send: (d) => got.push(...JSON.parse(d).events), close() {} }, { id: mkUser('member', [{ projectId }]) });
    return { hub, got };
  };
  beforeEach(async () => {
    q = mkProject('Q');
    qLore = mkDeck(q);
    qTasks = mkDeck(q, 'task', 2);
    near = 'near';
    await ok('wiki/createLinkKind', { projectId, key: near, label: 'near', reverseLabel: 'near', fromTypes: [], toTypes: [] });
  });
  const rowsOf = (cardId: string) => (db.prepare('SELECT COUNT(*) n FROM entry_links WHERE from_card_id=? OR to_card_id=?').get(cardId, cardId) as { n: number }).n;

  it('lore moved to another project loses its links in and out; old viewers get only removes', async () => {
    const a = await entry('A', null);
    const b = await entry('B', null);
    const hunt = await quest('Hunt');
    const out = (await ok('wiki/addLink', { kindKey: near, fromCardId: a, toCardId: b })).id;
    const inn = (await ok('wiki/addLink', { kindKey: near, fromCardId: b, toCardId: a })).id;
    const work = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: hunt, toCardId: a })).id;
    const keep = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: hunt, toCardId: b })).id;
    const { hub, got } = oldCampaignViewer();
    const r = dispatch(db, me(), 'cards/update', { id: a, deckId: qLore });
    expect(linkEvents(r.events).sort(byId)).toEqual([out, inn, work].map((id) => ({ op: 'remove', id })).sort(byId));
    expect(linkRows(r.events).every((e) => e.row.projectId === projectId)).toBe(true);
    hub.publish('a1', r.events);
    const linkGot = got.filter((e) => e.model === 'entryLink');
    expect(linkGot).toHaveLength(3);
    expect(linkGot.every((e) => e.op === 'remove')).toBe(true);
    expect(rowsOf(a)).toBe(0);
    expect(await linkIds()).toEqual([keep]);
  });

  it('lore that becomes a quest loses its links', async () => {
    const a = await entry('A', null);
    const b = await entry('B', null);
    const l = (await ok('wiki/addLink', { kindKey: near, fromCardId: b, toCardId: a })).id;
    const r = dispatch(db, me(), 'cards/update', { id: a, deckId: questDeck, isDoc: false });
    expect(linkEvents(r.events)).toEqual([{ op: 'remove', id: l }]);
    expect(rowsOf(a)).toBe(0);
  });

  it('a quest moved to another project loses its works_on links; one that becomes lore too', async () => {
    const a = await entry('A', null);
    const hunt = await quest('Hunt');
    const l = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: hunt, toCardId: a })).id;
    const { hub, got } = oldCampaignViewer();
    const r = dispatch(db, me(), 'cards/update', { id: hunt, deckId: qTasks });
    expect(linkEvents(r.events)).toEqual([{ op: 'remove', id: l }]);
    expect(linkRows(r.events)[0].row.projectId).toBe(projectId);
    hub.publish('a1', r.events);
    expect(got.filter((e) => e.model === 'entryLink').map((e) => e.op)).toEqual(['remove']);
    expect(rowsOf(hunt)).toBe(0);
    // Same project, quest → lore: its works_on links would have a Lore source.
    const fix = await quest('Fix');
    const l2 = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: fix, toCardId: a })).id;
    const r2 = dispatch(db, me(), 'cards/update', { id: fix, deckId: (db.prepare("SELECT id FROM decks WHERE project_id=? AND deck_type='doc'").get(projectId) as { id: string }).id, isDoc: true });
    expect(linkEvents(r2.events)).toEqual([{ op: 'remove', id: l2 }]);
    expect(rowsOf(fix)).toBe(0);
  });

  it('deleting a list drops the links of its tasks, with removes', async () => {
    const a = await entry('A', null);
    const hunt = await quest('Hunt');
    const l = (await ok('wiki/addLink', { kindKey: 'works_on', fromCardId: hunt, toCardId: a })).id;
    const r = dispatch(db, me(), 'decks/delete', { id: questDeck });
    expect(linkEvents(r.events)).toEqual([{ op: 'remove', id: l }]);
    expect(rowsOf(a)).toBe(0);
  });
});

describe('link props size and live routing', () => {
  it('props above 4 KB → 413 too_large on add and update', async () => {
    await ok('wiki/createLinkKind', {
      projectId, key: 'notes', label: 'notes', reverseLabel: 'noted by', fromTypes: [], toTypes: [],
      props: [{ key: 'text', label: 'Text', kind: 'longtext' }],
    });
    const a = await entry('A', null);
    const big = { text: 'x'.repeat(4097) };
    const r = await fail('wiki/addLink', { kindKey: 'notes', fromCardId: a, toCardId: a, props: big }, 413, 'too_large');
    expect(r.data).toEqual({ maxBytes: 4096 });
    const { id } = await ok('wiki/addLink', { kindKey: 'notes', fromCardId: a, toCardId: a, props: { text: 'x'.repeat(4000) } });
    await fail('wiki/updateLink', { id, props: big }, 413, 'too_large');
  });

  it('a link upsert reaches only users who see both ends: an end outside the link project or deckless drops it', async () => {
    const q = mkProject('Q');
    const foreign = await entry('Foreign', null, (mkDeck(q), q));
    const a = await entry('A', null);
    const deckless = await entry('Loose', null);
    db.prepare('UPDATE cards SET deck_id=NULL WHERE id=?').run(deckless);
    const both = mkUser('member', [{ projectId }, { projectId: q }]);
    const onlyA = mkUser('member', [{ projectId }]);
    const hub = new LiveHub(db);
    const got: Record<string, any[]> = { both: [], onlyA: [] };
    hub.add({ send: (d) => got.both.push(...JSON.parse(d).events), close() {} }, { id: both });
    hub.add({ send: (d) => got.onlyA.push(...JSON.parse(d).events), close() {} }, { id: onlyA });
    const row = (to: string) => ({ id: newId(), projectId, kindKey: 'drops', fromCardId: a, toCardId: to, props: {}, sortIndex: 1 });
    hub.publish('a1', [{ model: 'entryLink', op: 'upsert', row: row(foreign) }, { model: 'entryLink', op: 'upsert', row: row(deckless) }]);
    expect(got.onlyA).toEqual([]);
    expect(got.both).toEqual([]);
    // Both ends in the project: its viewers get it.
    hub.publish('a1', [{ model: 'entryLink', op: 'upsert', row: row(a) }]);
    expect(got.onlyA).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { cardRow } from '../server/commands/rows';
import { entryTypeRow } from '../server/commands/wiki';
import { listAssets } from '../server/assets';
import type { Block } from '../shared/types';

// Template pages of blocks, entry layouts and typed block data (redesign phase 4), through the dispatch route.
const HOST = 'localhost:8780';
const SPACES = JSON.stringify([{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]);
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
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
function mkProject(name = 'P'): string {
  const id = newId();
  db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,'limited',0,?,0)").run(id, ++seq, name, SPACES);
  db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,sort_index,created_at) VALUES (?,?,?,1,'Lore','doc',1,0)").run(newId(), ++seq, id);
  return id;
}
function mkAsset(p: string, kind = 'model'): string {
  const id = newId();
  db.prepare("INSERT INTO assets (id,project_id,title,kind,source,created_at,updated_at) VALUES (?,?,'A',?,'uploaded',0,0)").run(id, p, kind);
  return id;
}
const send = (cookie: string, cmd: string, payload: unknown) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: { host: HOST, 'content-type': 'application/json', cookie },
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
const card = (id: string) => cardRow(db, id)!;
const typeOf = (id: string) => entryTypeRow(db, id)!;
const blk = (id: string, kind: Block['kind'], title: string, extra: Partial<Block> = {}): Block => ({ id, kind, title, width: 'full', ...extra });
const mkType = async (name: string, extra: Record<string, unknown> = {}) => (await ok('wiki/createType', { projectId, name, ...extra })).id as string;

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  ownerCookie = cookieFor(mkUser('owner'));
  projectId = mkProject();
});
afterEach(async () => { await app.close(); });

describe('wiki/setPage', () => {
  it('stores a page, its version one past the page the type followed', async () => {
    const t = await mkType('Creature');
    expect(typeOf(t).page).toBeNull();
    await ok('wiki/setPage', { typeId: t, page: { guided: true, blocks: [blk('a', 'facts', 'Facts', { width: 'half' })] } });
    expect(typeOf(t).page).toEqual({ version: 1, guided: true, blocks: [blk('a', 'facts', 'Facts', { width: 'half' })] });
    await ok('wiki/setPage', { typeId: t, page: { guided: false, blocks: [] } });
    expect(typeOf(t).page!.version).toBe(2);
  });
  it('a sub-type gets its own copy past the parent version; null follows the parent again', async () => {
    const item = await mkType('Item');
    const weapon = await mkType('Weapon', { parentTypeId: item });
    await ok('wiki/setPage', { typeId: item, page: { guided: false, blocks: [blk('a', 'lines', 'Barks')] } });
    await ok('wiki/setPage', { typeId: item, page: { guided: false, blocks: [blk('a', 'lines', 'Barks')] } });
    await ok('wiki/setPage', { typeId: weapon, page: { guided: false, blocks: [blk('b', 'steps', 'Use')] } });
    expect(typeOf(weapon).page!.version).toBe(3);
    await ok('wiki/setPage', { typeId: weapon, page: null });
    expect(typeOf(weapon).page).toBeNull();
  });
  it('refuses bad blocks: duplicate ids, a bad id, an empty title, too many', async () => {
    const t = await mkType('Creature');
    await fail('wiki/setPage', { typeId: t, page: { guided: false, blocks: [blk('a', 'text', 'A'), blk('a', 'text', 'B')] } }, 409, 'duplicate_key');
    await fail('wiki/setPage', { typeId: t, page: { guided: false, blocks: [blk('A-1', 'text', 'A')] } }, 400);
    await fail('wiki/setPage', { typeId: t, page: { guided: false, blocks: [blk('a', 'text', ' ')] } }, 400);
    await fail('wiki/setPage', { typeId: t, page: { guided: false, blocks: Array.from({ length: 41 }, (_, i) => blk(`b${i}`, 'text', `T${i}`)) } }, 400);
  });
  it('is a project setting: a member who only edits content may not', async () => {
    const t = await mkType('Creature');
    const member = cookieFor(mkUser('member', [{ projectId }]));
    const r = await send(member, 'wiki/setPage', { typeId: t, page: null });
    expect(r.statusCode).toBe(403);
  });
});

describe('wiki/createEntry with a page', () => {
  it('without any page: the headings as before, and no layout of its own', async () => {
    const t = await mkType('Place', { sections: ['Look and feel'] });
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Beach' });
    expect(card(e.id)).toMatchObject({ content: '# Beach\n\n## Look and feel', layout: null });
  });
  it('a page (here the parent\'s) gives the text blocks as headings and a layout at its version', async () => {
    const item = await mkType('Item', { sections: ['Old heading'] });
    const weapon = await mkType('Weapon', { parentTypeId: item });
    const blocks = [blk('f', 'facts', 'Facts'), blk('u', 'text', 'Use'), blk('l', 'lines', 'Barks')];
    await ok('wiki/setPage', { typeId: item, page: { guided: false, blocks } });
    const e = await ok('wiki/createEntry', { projectId, typeId: weapon, name: 'Axe' });
    expect(card(e.id).content).toBe('# Axe\n\n## Use');
    expect(card(e.id).layout).toEqual({ version: 1, owner: item, blocks, data: {} });
  });
  it('a guided start puts the answers in place', async () => {
    const t = await mkType('Quest');
    await ok('wiki/setPage', { typeId: t, page: { guided: true, blocks: [blk('w', 'text', 'What happens'), blk('s', 'steps', 'Steps')] } });
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Cooking', answers: { w: 'You cook.', s: 'Find fish\nCook it' } });
    expect(card(e.id).content).toBe('# Cooking\n\n## What happens\n\nYou cook.');
    expect(card(e.id).layout.data).toEqual({ s: { items: ['Find fish', 'Cook it'] } });
  });
});

describe('wiki/setBlock', () => {
  const setup = async () => {
    const t = await mkType('Creature');
    await ok('wiki/setPage', { typeId: t, page: { guided: false, blocks: [
      blk('m', 'model', 'Model', { width: 'half' }), blk('a', 'table', 'Attacks', { cols: ['Attack', 'Damage'] }), blk('k', 'links', 'Lives with', { to: '' }), blk('l', 'lines', 'Barks')] } });
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Drowned Man' });
    return { t, id: e.id as string };
  };
  it('stores typed data by block, and null clears it; text and fields stay as they were', async () => {
    const { id } = await setup();
    const before = card(id);
    const model = mkAsset(projectId);
    await ok('wiki/setBlock', { cardId: id, blockId: 'm', data: { assetId: model } });
    await ok('wiki/setBlock', { cardId: id, blockId: 'a', data: { rows: [['Claw', '12'], ['Bite', '20']] } });
    expect(card(id).layout.data).toEqual({ m: { assetId: model }, a: { rows: [['Claw', '12'], ['Bite', '20']] } });
    await ok('wiki/setBlock', { cardId: id, blockId: 'm', data: null });
    expect(card(id).layout.data).toEqual({ a: { rows: [['Claw', '12'], ['Bite', '20']] } });
    expect(card(id).content).toBe(before.content);
    expect(card(id).fields).toEqual(before.fields);
  });
  it('an entry with no layout of its own gets its type page first', async () => {
    const t = await mkType('Place');
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Beach' });
    expect(card(e.id).layout).toBeNull();
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'dpicture', data: { assetId: mkAsset(projectId, 'picture') } });
    expect(card(e.id).layout.blocks.map((b: Block) => b.id)).toEqual(['dfacts', 'dpicture']);
  });
  it('refuses an unknown block, data of another kind, and another project\'s asset or entry', async () => {
    const { id } = await setup();
    await fail('wiki/setBlock', { cardId: id, blockId: 'nope', data: { items: ['x'] } }, 400, 'unknown_block');
    await fail('wiki/setBlock', { cardId: id, blockId: 'l', data: { rows: [['x']] } }, 400, 'invalid_payload');
    await fail('wiki/setBlock', { cardId: id, blockId: 'm', data: { assetId: mkAsset(mkProject('Q')) } }, 400, 'unknown_asset');
    const other = mkProject('R');
    const far = await ok('wiki/createEntry', { projectId: other, typeId: null, name: 'Far' });
    await fail('wiki/setBlock', { cardId: id, blockId: 'k', data: { cardIds: [far.id] } }, 400, 'unknown_entry');
  });
});

describe('wiki/bringUpToDate', () => {
  it('lays older entries out by the page, keeping every value and the text byte for byte', async () => {
    const t = await mkType('Creature');
    await ok('wiki/setPage', { typeId: t, page: { guided: false, blocks: [blk('l', 'lines', 'Barks'), blk('o', 'lines', 'Old')] } });
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Gull' });
    await ok('cards/update', { id: e.id, content: '# Gull\n\nIntro.\n\n## Notes\n\nKept.', contentVersion: card(e.id).contentVersion });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'o', data: { items: ['written'] } });
    await ok('wiki/setPage', { typeId: t, page: { guided: false, blocks: [blk('n', 'steps', 'New', { width: 'half' }), blk('l', 'lines', 'Barks')] } });
    const before = card(e.id);
    expect(await ok('wiki/bringUpToDate', { typeId: t, cardIds: [e.id] })).toEqual({ updated: 1 });
    const after = card(e.id);
    expect(after.layout.version).toBe(2);
    expect(after.layout.blocks.map((b: Block) => b.id)).toEqual(['n', 'l', 'o']);
    expect(after.layout.data).toEqual({ o: { items: ['written'] } });
    expect(after.content).toBe(before.content);
    expect(after.fieldsJson ?? JSON.stringify(after.fields)).toBe(before.fieldsJson ?? JSON.stringify(before.fields));
    expect(await ok('wiki/bringUpToDate', { typeId: t, cardIds: [e.id] })).toEqual({ updated: 0 });
  });
});

describe('review fixes', () => {
  const page = async (t: string, blocks: Block[], guided = false) => ok('wiki/setPage', { typeId: t, page: { guided, blocks } });
  const history = async (cardId: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/cards/${cardId}/history`, headers: { host: HOST, cookie: ownerCookie } });
    return (r.json() as { changes: any[] }[]).flatMap((h) => h.changes);
  };

  it('a trashed entry or deleted asset in a block never locks it: new ids are checked, stale ones dropped', async () => {
    const t = await mkType('Faction');
    await page(t, [blk('k', 'links', 'Members', { to: '' }), blk('g', 'gallery', 'Banners')]);
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Fog Walkers' });
    const a = await ok('wiki/createEntry', { projectId, typeId: null, name: 'Ásdís' });
    const b = await ok('wiki/createEntry', { projectId, typeId: null, name: 'Bjorn' });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'k', data: { cardIds: [a.id] } });
    const p1 = mkAsset(projectId, 'picture'), p2 = mkAsset(projectId, 'picture');
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'g', data: { assetIds: [p1] } });
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(a.id);
    db.prepare('DELETE FROM assets WHERE id=?').run(p1);
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'k', data: { cardIds: [a.id, b.id] } });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'g', data: { assetIds: [p1, p2] } });
    expect(card(e.id).layout.data).toEqual({ k: { cardIds: [b.id] }, g: { assetIds: [p2] } });
    // A new id that is not the project's is still refused.
    await fail('wiki/setBlock', { cardId: e.id, blockId: 'g', data: { assetIds: [p2, mkAsset(mkProject('Q'), 'picture')] } }, 400, 'unknown_asset');
  });

  it('an asset used in a block is listed under "Used in"', async () => {
    const t = await mkType('Creature');
    await page(t, [blk('m', 'model', 'Model'), blk('g', 'gallery', 'More')]);
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Drowned Man' });
    const m = mkAsset(projectId, 'model'), g = mkAsset(projectId, 'picture');
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'm', data: { assetId: m } });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'g', data: { assetIds: [g, m] } });
    const used = new Map(listAssets(db, projectId).map((x) => [x.id, x.usedIn]));
    expect(used.get(m)).toEqual([{ cardId: e.id, title: 'Drowned Man' }]);
    expect(used.get(g)).toEqual([{ cardId: e.id, title: 'Drowned Man' }]);
  });

  it('a stale write is refused with 409 (expected data differs), and history keeps the old and new data', async () => {
    const t = await mkType('Creature');
    await page(t, [blk('l', 'lines', 'Barks')]);
    const e = await ok('wiki/createEntry', { projectId, typeId: t, name: 'Gull' });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'l', data: { items: ['Kree'] }, expected: null });
    const r = await send(ownerCookie, 'wiki/setBlock', { cardId: e.id, blockId: 'l', data: { items: ['Mine'] }, expected: null });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'conflict', data: { id: e.id, layout: { data: { l: { items: ['Kree'] } } } } });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'l', data: { items: ['Kree', 'Kraa'] }, expected: { items: ['Kree'] } });
    const change = (await history(e.id)).find((c) => c.kind === 'block' && c.to?.items?.length === 2);
    expect(change).toMatchObject({ kind: 'block', title: 'Barks', from: { items: ['Kree'] }, to: { items: ['Kree', 'Kraa'] } });
  });

  it('a guided start\'s answers keep the block limits', async () => {
    const t = await mkType('Quest');
    await page(t, [blk('s', 'steps', 'Steps'), blk('w', 'text', 'What happens')], true);
    await fail('wiki/createEntry', { projectId, typeId: t, name: 'A', answers: { s: Array.from({ length: 201 }, (_, i) => `step ${i}`).join('\n') } }, 400, 'invalid_payload');
    await fail('wiki/createEntry', { projectId, typeId: t, name: 'B', answers: { s: 'x'.repeat(2001) } }, 400, 'invalid_payload');
    const big = Array.from({ length: 40 }, () => 'y'.repeat(1990)).join('\n');
    await fail('wiki/createEntry', { projectId, typeId: t, name: 'C', answers: { s: big, w: 'ok' } }, 413, 'too_large');
  });

  it('out of date means another page owner too: following the parent again, a page dropped, a new type', async () => {
    const item = await mkType('Item');
    const weapon = await mkType('Weapon', { parentTypeId: item });
    await page(item, [blk('a', 'lines', 'Barks')]);
    await page(weapon, [blk('b', 'steps', 'Use'), blk('c', 'lines', 'Old')]);
    const e = await ok('wiki/createEntry', { projectId, typeId: weapon, name: 'Axe' });
    await ok('wiki/setBlock', { cardId: e.id, blockId: 'c', data: { items: ['kept'] } });
    expect(card(e.id).layout).toMatchObject({ owner: weapon, version: 2 });
    // Follow Item again: Item's page is version 1, but another owner, so the Axe is out of date.
    await ok('wiki/setPage', { typeId: weapon, page: null });
    expect(await ok('wiki/bringUpToDate', { typeId: weapon, cardIds: [e.id] })).toEqual({ updated: 1 });
    expect(card(e.id).layout).toMatchObject({ owner: item, version: 1 });
    expect(card(e.id).layout.blocks.map((b: Block) => b.id)).toEqual(['a', 'c']);
    // Retyped to a type with no page: the layout takes that page (made from headings), keeping blocks that hold data.
    const place = await mkType('Place', { sections: ['Look'] });
    await ok('wiki/setEntry', { cardId: e.id, typeId: place });
    expect(card(e.id).layout).toMatchObject({ owner: '', version: 0, data: { c: { items: ['kept'] } } });
    expect(card(e.id).layout.blocks.map((b: Block) => b.id)).toEqual(['dfacts', 'dpicture', 'dtext0', 'c']);
  });
});

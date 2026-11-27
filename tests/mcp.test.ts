import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, _resetLimiter } from '../server/auth';
import pkg from '../package.json' with { type: 'json' };
import { MCP_TOOL_NAMES } from '../server/mcp';
import * as Y from 'yjs';

const HOST = 'localhost:8780';
let db: Db;
let app: ReturnType<typeof buildApp>;
let seq = 0;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function mkUser(role: string, name = role): string {
  const id = newId();
  db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,'x',0)").run(id, `${id}@x.io`, name);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
function cookieFor(userId: string): string {
  const t = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(t), userId, Date.now() + 3600e3);
  return `jt_session=${t}`;
}
function mkProject(visibility: 'full' | 'limited' = 'full', name = 'P'): string {
  const id = newId();
  db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,?,0,?,0)')
    .run(id, ++seq, name, visibility, JSON.stringify([{ id: 1, name: 'Main', defaultDeckType: 'task' }]));
  return id;
}
function mkDeck(projectId: string): string {
  const id = newId();
  db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES (?,?,?,1,'D','task',0)").run(id, ++seq, projectId);
  return id;
}
function mkCard(deckId: string | null, creatorId: string, content = 'Task'): string {
  const id = newId();
  db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at) VALUES (?,?,?,?,?,'default','[]',0,0)")
    .run(id, ++seq, deckId, creatorId, content);
  return id;
}
function setSettings(s: Record<string, unknown>) {
  db.prepare('UPDATE account SET settings_json=?').run(JSON.stringify(s));
}

async function mkToken(userId: string, input: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/dispatch/apiTokens/create', headers: { host: HOST, 'content-type': 'application/json', cookie: cookieFor(userId) },
    payload: { kind: 'user', label: 'AI', role: 'admin', access: 'write', projectIds: [], ...input },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload.token;
}

let rpcId = 0;
const post = (bearer: string | null, body: unknown) => app.inject({
  method: 'POST', url: '/mcp', payload: body as any,
  headers: { host: HOST, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
});
const rpc = (bearer: string, method: string, params?: unknown) => post(bearer, { jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
async function call(bearer: string, name: string, args: unknown): Promise<{ isError: boolean; text: string; json: any }> {
  const r = await rpc(bearer, 'tools/call', { name, arguments: args });
  expect(r.statusCode, r.body).toBe(200);
  const res = r.json().result;
  expect(res, r.body).toBeDefined();
  const text = res.content[0].text as string;
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { isError: !!res.isError, text, json };
}

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
});
afterEach(async () => {
  setClock(() => Date.now());
  await app.close();
});

describe('MCP server', () => {
  it('initialize → tools capability', async () => {
    const owner = mkUser('owner');
    const token = await mkToken(owner);
    const r = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Code', version: '1.0' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const body = r.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('questlog');
    expect(body.result.serverInfo.version).toBe(pkg.version);
    expect(body.result.capabilities.tools).toEqual({});
    // An unknown version gets our latest one.
    const old = await rpc(token, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'X' } });
    expect(old.json().result.protocolVersion).toBe('2025-06-18');
    // The initialized notification has no response body.
    const n = await post(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.statusCode).toBe(202);
    expect(n.body).toBe('');
    // The connection is recorded with the client's name.
    const row = db.prepare('SELECT user_id, client_name FROM mcp_connections').get() as { user_id: string; client_name: string };
    expect(row).toEqual({ user_id: owner, client_name: 'X' });
  });

  it('tools/list has exactly the manual\'s tools', async () => {
    const token = await mkToken(mkUser('owner'));
    const r = await rpc(token, 'tools/list');
    const tools = r.json().result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    const expected = [
      'get_context', 'list_decks', 'search_cards', 'get_card', 'get_comments', 'get_card_history', 'list_conversations',
      'search_comments', 'list_hand', 'list_milestones', 'list_runs', 'list_members', 'list_assets',
      'create_card', 'create_cards', 'update_card', 'update_cards', 'add_comment', 'update_comment', 'set_thread_resolved',
      'set_thread_participation', 'add_to_hand', 'remove_from_hand', 'move_in_hand', 'create_deck', 'create_milestone',
      'update_milestone', 'track_time', 'log_time', 'create_project', 'delete_cards', 'delete_deck', 'delete_milestone',
      'get_vision_board', 'edit_vision_board',
    ];
    expect(tools.map((t) => t.name).sort()).toEqual([...expected].sort());
    expect([...MCP_TOOL_NAMES].sort()).toEqual([...expected].sort());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      // Every delete tool says it needs a "May delete" token; only the soft one promises a restore.
      if (t.name.startsWith('delete_')) expect(t.description).toMatch(/May delete/);
    }
    const desc = (n: string) => tools.find((t) => t.name === n)!;
    expect(desc('delete_cards').description).toMatch(/soft delete.*restored/i);
    for (const n of ['delete_deck', 'delete_milestone']) {
      expect(desc(n).description).toMatch(/for good/);
      expect((desc(n).inputSchema as any).required).toContain('confirm');
    }
  });

  it('create_card then get_card round-trip', async () => {
    const owner = mkUser('owner');
    const deck = mkDeck(mkProject());
    const token = await mkToken(owner);
    const c = await call(token, 'create_card', { deckId: deck, content: '# Fix the jump\nIt is floaty.', priority: 'a' });
    expect(c.isError, c.text).toBe(false);
    expect(c.json.id).toBeTruthy();
    const g = await call(token, 'get_card', { cardId: c.json.id });
    expect(g.isError, g.text).toBe(false);
    expect(g.json).toMatchObject({ id: c.json.id, title: 'Fix the jump', content: '# Fix the jump\nIt is floaty.', priority: 'a', deckId: deck, creatorId: owner });
    // By its number too.
    const bySeq = await call(token, 'get_card', { cardId: String(g.json.seq) });
    expect(bySeq.json.id).toBe(c.json.id);
    // History is written by the command pipeline.
    const h = await call(token, 'get_card_history', { cardId: c.json.id });
    expect(h.json.items[0].changes).toEqual([{ kind: 'created' }]);
    // search_cards finds it by text.
    const s = await call(token, 'search_cards', { text: 'jump' });
    expect(s.json.items.map((x: any) => x.id)).toEqual([c.json.id]);
  });

  it('org token → 401', async () => {
    const owner = mkUser('owner');
    const org = await mkToken(owner, { kind: 'org', label: 'Bot' });
    const r = await rpc(org, 'tools/list');
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('invalid_token');
    // No token at all is 401 too.
    const none = await post(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(none.statusCode).toBe(401);
  });

  it('expired, revoked and disabled-user tokens → 401; failed authentications per IP → 429', async () => {
    const owner = mkUser('owner');
    const member = mkUser('member');
    const expired = await mkToken(owner);
    db.prepare('UPDATE api_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, sha(expired));
    expect((await rpc(expired, 'tools/list')).json().error).toBe('token_expired');
    const revoked = await mkToken(owner);
    db.prepare('UPDATE api_tokens SET revoked_at=? WHERE token_hash=?').run(Date.now(), sha(revoked));
    expect((await rpc(revoked, 'tools/list')).json().error).toBe('invalid_token');
    const gone = await mkToken(member, { role: 'producer', projectIds: [mkProject()] });
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(member);
    const r = await rpc(gone, 'tools/list');
    expect([r.statusCode, r.json().error]).toEqual([401, 'not_a_member']);
    expect(r.headers['www-authenticate']).toMatch(/Bearer/);
    // 3 failures so far; the burst allows 40, then the IP waits even with a good token.
    const good = await mkToken(owner);
    for (let i = 0; i < 37; i++) expect((await rpc('jtut_nope', 'tools/list')).statusCode).toBe(401);
    const limited = await rpc(good, 'tools/list');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('mcpEnabled false → 403', async () => {
    const token = await mkToken(mkUser('owner'));
    setSettings({ mcpEnabled: false });
    const r = await rpc(token, 'tools/list');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('mcp_disabled');
  });

  it('daily limit 3 → 4th call 429', async () => {
    const token = await mkToken(mkUser('owner'));
    setSettings({ mcpDailyLimit: 3 });
    for (let i = 0; i < 3; i++) await call(token, 'get_context', {});
    const r = await rpc(token, 'tools/call', { name: 'get_context', arguments: {} });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('mcp_daily_limit');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    const day = new Date().toISOString().slice(0, 10);
    expect(db.prepare('SELECT count FROM mcp_calls WHERE day=?').get(day)).toEqual({ count: 3 });
  });

  it('61 rapid calls → 429', async () => {
    const token = await mkToken(mkUser('owner'));
    for (let i = 0; i < 60; i++) {
      const r = await rpc(token, 'tools/list');
      expect(r.statusCode, `call ${i + 1}`).toBe(200);
    }
    const r = await rpc(token, 'tools/list');
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('rate_limit');
    expect(r.headers['retry-after']).toBe('1');
  });

  it('a tool on a hidden project → isError not found', async () => {
    const owner = mkUser('owner');
    const member = mkUser('member');
    const hidden = mkProject('limited', 'Secret');
    const deck = mkDeck(hidden);
    const card = mkCard(deck, owner, 'Secret task');
    const open = mkProject('full', 'Open');
    const token = await mkToken(member, { role: 'producer', projectIds: [open] });
    const g = await call(token, 'get_card', { cardId: card });
    expect(g.isError).toBe(true);
    expect(g.text).toMatch(/not_found/);
    const u = await call(token, 'update_card', { cardId: card, priority: 'a' });
    expect(u.isError).toBe(true);
    expect(u.text).toMatch(/not_found/);
    const c = await call(token, 'add_comment', { cardId: card, content: 'hi' });
    expect(c.isError).toBe(true);
    const s = await call(token, 'search_cards', { text: 'Secret' });
    expect(s.json.items).toEqual([]);
    const d = await call(token, 'list_decks', {});
    expect(d.json.items).toEqual([]);
  });

  it('list_assets lists the Assets library of projects the token can see', async () => {
    const owner = mkUser('owner');
    const p = mkProject('full', 'Game');
    const hidden = mkProject('full', 'Hidden');
    for (const [id, pid, title] of [['a1', p, 'Ghoul'], ['a2', hidden, 'Secret']]) {
      db.prepare("INSERT INTO assets (id,project_id,title,kind,for_tag,source,link_json,picture_id,picture_mime,picture_size,created_at,updated_at) VALUES (?,?,?,'model','Creatures','asset-shelf',?,'b','image/png',5,1,1)")
        .run(id, pid, title, JSON.stringify({ server: 'nas', kind: 'asset', pack: 'P', path: 'G/Ghoul' }));
    }
    const all = await call(await mkToken(owner), 'list_assets', {});
    expect(all.json.items.map((a: any) => a.title).sort()).toEqual(['Ghoul', 'Secret']);
    const one = await call(await mkToken(owner), 'list_assets', { projectId: p });
    expect(one.json.items).toEqual([{ id: 'a1', projectId: p, title: 'Ghoul', kind: 'model', for: 'Creatures', source: 'asset-shelf',
      link: { server: 'nas', kind: 'asset', pack: 'P', path: 'G/Ghoul' }, hasPicture: true, hasModel: false, pictureUrl: '/api/assets/a1/picture' }]);
    const confined = await call(await mkToken(owner, { role: 'producer', projectIds: [p] } as any), 'list_assets', {});
    expect(confined.json.items.map((a: any) => a.title)).toEqual(['Ghoul']);
  });

  it('create_cards with 51 → isError', async () => {
    const deck = mkDeck(mkProject());
    const token = await mkToken(mkUser('owner'));
    const cards = Array.from({ length: 51 }, (_, i) => ({ deckId: deck, content: `Task ${i}` }));
    const r = await call(token, 'create_cards', { cards });
    expect(r.isError).toBe(true);
    expect((db.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n).toBe(0);
    const ok = await call(token, 'create_cards', { cards: cards.slice(0, 50) });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.json.items).toHaveLength(50);
  });

  it('write tools run as the token user through the command pipeline', async () => {
    setSettings({ timeTrackingMode: 'manual' });
    const owner = mkUser('owner');
    const p = mkProject();
    const deck = mkDeck(p);
    const token = await mkToken(owner);
    const publish = vi.spyOn(app.hub, 'publish');
    const { json: a } = await call(token, 'create_card', { deckId: deck, content: 'A' });
    // Live clients hear about it like any other write.
    expect(publish.mock.calls.at(-1)![1].some((e) => e.model === 'card' && (e.row as { id: string }).id === a.id)).toBe(true);
    const { json: b } = await call(token, 'create_card', { deckId: deck, content: 'B' });
    expect((await call(token, 'update_card', { cardId: a.id, content: 'A2', status: 'started' })).isError).toBe(false);
    expect((await call(token, 'update_cards', { cardIds: [a.id, b.id], priority: 'b' })).isError).toBe(false);
    const cm = await call(token, 'add_comment', { cardId: a.id, content: 'First' });
    expect(cm.isError, cm.text).toBe(false);
    expect((await call(token, 'add_comment', { cardId: a.id, threadId: cm.json.threadId, content: 'Second' })).isError).toBe(false);
    expect((await call(token, 'update_comment', { commentId: cm.json.commentId, content: 'First!' })).isError).toBe(false);
    const comments = await call(token, 'get_comments', { cardId: a.id });
    expect(comments.json.items[0].entries.map((e: any) => e.content)).toEqual(['First!', 'Second']);
    expect((await call(token, 'search_comments', { text: 'Second' })).json.items).toHaveLength(1);
    expect((await call(token, 'list_conversations', {})).json.items).toHaveLength(1);
    expect((await call(token, 'set_thread_participation', { threadId: cm.json.threadId, participating: false })).isError).toBe(false);
    expect((await call(token, 'set_thread_resolved', { threadId: cm.json.threadId, resolved: true })).isError).toBe(false);
    expect((await call(token, 'add_to_hand', { cardIds: [b.id] })).isError).toBe(false);
    const hand = await call(token, 'list_hand', {});
    expect(hand.json.items.map((c: any) => c.id)).toContain(b.id);
    expect((await call(token, 'move_in_hand', { cardId: b.id, slot: 1 })).isError).toBe(false);
    expect((await call(token, 'list_hand', {})).json.items[0].id).toBe(b.id);
    expect((await call(token, 'remove_from_hand', { cardIds: [b.id] })).isError).toBe(false);
    const deck2 = await call(token, 'create_deck', { projectId: p, title: 'Art' });
    expect(deck2.isError, deck2.text).toBe(false);
    const ms = await call(token, 'create_milestone', { name: 'Alpha', date: '2027-01-10', projectIds: [p] });
    expect(ms.isError, ms.text).toBe(false);
    expect((await call(token, 'update_milestone', { milestoneId: ms.json.id, name: 'Beta' })).isError).toBe(false);
    expect((await call(token, 'list_milestones', {})).json.items.map((m: any) => m.name)).toEqual(['Beta']);
    const logged = await call(token, 'log_time', { cardId: a.id, minutes: 30 });
    expect(logged.isError, logged.text).toBe(false);
    const start = await call(token, 'track_time', { cardId: b.id, action: 'start' });
    expect(start.isError, start.text).toBe(false);
    expect((await call(token, 'track_time', { cardId: b.id, action: 'stop' })).isError).toBe(false);
    expect((await call(token, 'list_members', {})).json.items.map((u: any) => u.id)).toEqual([owner]);
    expect((await call(token, 'list_runs', {})).json.items).toEqual([]);
    const history = db.prepare('SELECT changer_id FROM card_history WHERE card_id=?').all(a.id) as { changer_id: string }[];
    expect(history.every((h) => h.changer_id === owner)).toBe(true);
  });

  describe('vision boards', () => {
    it('places tasks, moves them into a frame, joins them with a line and reads it all back', async () => {
      const owner = mkUser('owner');
      const deck = mkDeck(mkProject());
      const host = mkCard(deck, owner, 'Zone 0');
      const a = mkCard(deck, owner, 'Beach');
      const b = mkCard(deck, owner, 'First boss');
      const token = await mkToken(owner);
      expect((await call(token, 'get_vision_board', { cardId: host })).json).toEqual({ board: null });
      // No board yet: the first edit makes one.
      const put = await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'add_task', taskId: a, x: 0, y: 0 }, { op: 'add_task', taskId: b }] });
      expect(put.isError, put.text).toBe(false);
      const [na, nb] = put.json.added as string[];
      // A frame drawn by a person (through the board's room, which the first edit loaded).
      const boardId = put.json.boardId as string;
      (app as any).rooms.edit(boardId, (doc: Y.Doc) => {
        const frame = new Y.Map<unknown>();
        frame.set('type', 'container'); frame.set('value', { label: 'Act 1' }); frame.set('pos', { x: 1000, y: 0, w: 600, h: 400, parent: null });
        doc.getMap('nodes').set('frame', frame);
      });
      const edit = await call(token, 'edit_vision_board', { cardId: host, ops: [
        { op: 'move', nodeId: nb, x: 1041, y: 59 }, { op: 'add_line', from: na, to: nb, label: 'then' },
      ] });
      expect(edit.isError, edit.text).toBe(false);
      const got = (await call(token, 'get_vision_board', { cardId: host })).json;
      expect(got.board).toMatchObject({ id: boardId, canEdit: true });
      const byId = new Map(got.items.map((n: any) => [n.id, n]));
      expect(byId.get(na)).toMatchObject({ type: 'card', x: 0, y: 0, w: 120, h: 160, parent: null, task: { id: a, title: 'Beach' } });
      expect(byId.get(nb)).toMatchObject({ x: 1040, y: 60, parent: 'frame', task: { id: b, title: 'First boss' } });
      expect(byId.get('frame')).toMatchObject({ type: 'container', text: 'Act 1' });
      expect(got.edges).toEqual([{ id: edit.json.lines[0], from: na, to: nb, fromSide: 'right', toSide: 'left', label: 'then' }]);
      // Moving the frame takes what is in it along.
      expect((await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'move', nodeId: 'frame', x: 2000, y: 100 }] })).isError).toBe(false);
      const shifted = new Map((await call(token, 'get_vision_board', { cardId: host })).json.items.map((n: any) => [n.id, n]));
      expect(shifted.get(nb)).toMatchObject({ x: 2040, y: 160, parent: 'frame' });
      // Removing a node takes its lines along; the task itself stays.
      expect((await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'remove', nodeId: na }] })).isError).toBe(false);
      const after = (await call(token, 'get_vision_board', { cardId: host })).json;
      expect(after.items.map((n: any) => n.id).sort()).toEqual([nb, 'frame'].sort());
      expect(after.edges).toEqual([]);
      expect(db.prepare('SELECT visibility FROM cards WHERE id=?').get(a)).toEqual({ visibility: 'default' });
    });

    it('all or nothing, write tokens only, and only on boards the user may edit', async () => {
      const owner = mkUser('owner');
      const deck = mkDeck(mkProject());
      const host = mkCard(deck, owner, 'Zone 0');
      const a = mkCard(deck, owner, 'Beach');
      const token = await mkToken(owner);
      const put = await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'add_task', taskId: a }] });
      const bad = await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'add_task', taskId: a }, { op: 'move', nodeId: 'nope', x: 0, y: 0 }] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/unknown_node/);
      expect((await call(token, 'get_vision_board', { cardId: host })).json.items).toHaveLength(1);
      // A failed first edit makes no board either.
      const other = mkCard(deck, owner, 'Zone 1');
      expect((await call(token, 'edit_vision_board', { cardId: other, ops: [{ op: 'remove', nodeId: 'nope' }] })).isError).toBe(true);
      expect((await call(token, 'get_vision_board', { cardId: other })).json).toEqual({ board: null });
      const read = await call(await mkToken(owner, { access: 'read' }), 'edit_vision_board', { cardId: host, ops: [{ op: 'remove', nodeId: put.json.added[0] }] });
      expect(read.text).toMatch(/missing_scope/);
      // Locked: people (and their tokens) only look.
      db.prepare("UPDATE vision_boards SET state='locked' WHERE id=?").run(put.json.boardId);
      const locked = await call(token, 'edit_vision_board', { cardId: host, ops: [{ op: 'remove', nodeId: put.json.added[0] }] });
      expect(locked.text).toMatch(/read_only/);
      expect((await call(token, 'get_vision_board', { cardId: host })).json.board.canEdit).toBe(false);
      setSettings({ visionBoardEnabled: false });
      expect((await call(token, 'get_vision_board', { cardId: host })).text).toMatch(/feature_disabled/);
    });
  });

  it('a read token cannot write', async () => {
    const deck = mkDeck(mkProject());
    const token = await mkToken(mkUser('owner'), { access: 'read' });
    const r = await call(token, 'create_card', { deckId: deck, content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/missing_scope/);
  });

  it('invalid input → isError; unknown method and tool → JSON-RPC errors', async () => {
    const token = await mkToken(mkUser('owner'));
    const bad = await call(token, 'get_card', {});
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/cardId/);
    const m = await rpc(token, 'nope/nope');
    expect(m.json().error.code).toBe(-32601);
    const t = await rpc(token, 'tools/call', { name: 'delete_everything', arguments: {} });
    expect(t.json().error.code).toBe(-32602);
    const batch = await post(token, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    expect(batch.json().error.code).toBe(-32600);
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { host: HOST } });
    expect(get.statusCode).toBe(405);
  });

  it('read results are capped at 50 KB', async () => {
    const owner = mkUser('owner');
    const deck = mkDeck(mkProject());
    for (let i = 0; i < 40; i++) mkCard(deck, owner, `Task ${i}\n${'x'.repeat(3000)}`);
    const big = mkCard(deck, owner, 'Big\n' + 'y'.repeat(200_000));
    const token = await mkToken(owner);
    const g = await call(token, 'get_card', { cardId: big });
    expect(Buffer.byteLength(g.text)).toBeLessThanOrEqual(50 * 1024);
    expect(g.json.truncated).toBe(true);
    const s = await call(token, 'search_cards', { limit: 200, includeContent: true });
    expect(Buffer.byteLength(s.text)).toBeLessThanOrEqual(50 * 1024);
    // Loading stops at the result cap (hasMore) instead of building all 41 cards first.
    expect(s.json.hasMore).toBe(true);
    expect(s.json.items.length).toBeLessThan(41);
  });

  it('comment and history reads load bounded text: cut per entry in SQL, stop at the result cap', async () => {
    const owner = mkUser('owner');
    const card = mkCard(mkDeck(mkProject()), owner, 'Talky');
    const big = 'z'.repeat(20_000);
    const addThread = db.prepare("INSERT INTO resolvables (id,card_id,context,creator_id,created_at) VALUES (?,?,'comment',?,?)");
    const addEntry = db.prepare('INSERT INTO resolvable_entries (id,resolvable_id,author_id,content,created_at) VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let t = 0; t < 200; t++) {
      const id = newId();
      addThread.run(id, card, owner, t);
      for (let e = 0; e < 10; e++) addEntry.run(newId(), id, owner, `needle ${t}/${e} ${big}`, t * 100 + e);
    }
    const addHist = db.prepare('INSERT INTO card_history (card_id,version,changer_id,at,changes_json) VALUES (?,?,?,?,?)');
    for (let v = 1; v <= 200; v++) addHist.run(card, v, owner, v, JSON.stringify([{ kind: 'title', from: big, to: big }]));
    db.exec('COMMIT');
    const token = await mkToken(owner);
    const prepare = vi.spyOn(db, 'prepare');

    const c = await call(token, 'get_comments', { cardId: card, limit: 200 });
    expect(c.isError, c.text).toBe(false);
    expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(50 * 1024);
    expect(c.json.truncated).toBeUndefined(); // bounded before capResult had anything to cut
    expect(c.json.hasMore).toBe(true);
    const entries = c.json.items.flatMap((t: any) => t.entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(2000);
    for (const e of entries) {
      expect(e.content.length).toBe(2000);
      expect(e.truncated).toBe(true);
    }
    // The cut happens in SQL: the entry query never selects the whole column.
    const entrySql = prepare.mock.calls.map(([q]) => q).find((q) => q.includes('FROM resolvable_entries WHERE resolvable_id=?'))!;
    expect(entrySql).toMatch(/substr\(content, 1, 2000\)/);
    expect(entrySql).toMatch(/LIMIT \?/);

    const s = await call(token, 'search_comments', { text: 'needle', limit: 200 });
    expect(Buffer.byteLength(s.text)).toBeLessThanOrEqual(50 * 1024);
    expect(s.json.hasMore).toBe(true);
    expect(s.json.items.every((e: any) => e.content.length === 2000 && e.truncated)).toBe(true);

    const h = await call(token, 'get_card_history', { cardId: card, limit: 200 });
    expect(h.isError, h.text).toBe(false);
    expect(h.json.items).toHaveLength(200);
    expect(h.json.items.every((r: any) => r.changes === null && r.truncated)).toBe(true);
    addHist.run(card, 201, owner, 201, JSON.stringify([{ kind: 'title', from: 'a', to: 'b' }]));
    expect((await call(token, 'get_card_history', { cardId: card, limit: 1 })).json.items[0].changes).toEqual([{ kind: 'title', from: 'a', to: 'b' }]);
    expect(prepare.mock.calls.some(([q]) => /FROM card_history/.test(q) && q.includes('length(changes_json) <= 2000'))).toBe(true);

    // A conversation list reads only the start of each card's text, for its title.
    db.prepare('UPDATE cards SET content=? WHERE id=?').run(`Talky\n${big}`, card);
    db.prepare('INSERT INTO resolvable_notifications (resolvable_id,user_id,is_participating,unseen_entry_count,created_at,last_updated_at) SELECT id,?,1,0,0,0 FROM resolvables').run(owner);
    const l = await call(token, 'list_conversations', { limit: 200 });
    expect(l.isError, l.text).toBe(false);
    expect(l.json.items[0].cardTitle).toBe('Talky');
    expect(prepare.mock.calls.some(([q]) => q.includes('substr(c.content, 1, 2000) card_content'))).toBe(true);
    prepare.mockRestore();
  });

  it('usage: tool calls today and connections (admins all, members their own)', async () => {
    const owner = mkUser('owner', 'Olga');
    const member = mkUser('member', 'Mo');
    const t1 = await mkToken(owner);
    const t2 = await mkToken(member, { role: 'producer', projectIds: [mkProject()] });
    await rpc(t1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'A' } });
    await call(t1, 'get_context', {});
    await call(t2, 'get_context', {});
    await call(t2, 'list_members', {});
    const get = (u: string) => app.inject({ method: 'GET', url: '/api/mcp/usage', headers: { host: HOST, cookie: cookieFor(u) } });
    const a = (await get(owner)).json();
    expect(a.toolCallsToday).toBe(3);
    expect(a.connections.map((c: any) => [c.name, c.calls]).sort()).toEqual([['Mo', 2], ['Olga', 1]]);
    const m = (await get(member)).json();
    expect(m.connections.map((c: any) => c.name)).toEqual(['Mo']);
  });

  describe('delete tools and create_project', () => {
    const vis = (id: string) => (db.prepare('SELECT visibility v FROM cards WHERE id=?').get(id) as { v: string }).v;
    const dispatchAs = (userId: string, cmd: string, payload: unknown) => app.inject({
      method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: { host: HOST, 'content-type': 'application/json', cookie: cookieFor(userId) },
    });

    it('refused without "May delete" (tokens made before it too) and for read tokens', async () => {
      const owner = mkUser('owner');
      const project = mkProject();
      const deck = mkDeck(project);
      const card = mkCard(deck, owner);
      const plain = await mkToken(owner);
      // A token from before the option: the migration default leaves it off.
      expect((db.prepare('SELECT may_delete m FROM api_tokens').get() as { m: number }).m).toBe(0);
      const m = await call(plain, 'create_milestone', { name: 'Alpha', projectIds: [project] });
      expect(m.isError, m.text).toBe(false);
      for (const [tool, args] of [['delete_cards', { cardIds: [card] }], ['delete_deck', { deckId: deck, confirm: true }], ['delete_milestone', { milestoneId: m.json.id, confirm: true }]] as const) {
        const r = await call(plain, tool, args);
        expect(r.isError, tool).toBe(true);
        expect(r.json.error).toBe('delete_not_allowed');
        expect(r.json.data.reason).toMatch(/May delete/);
      }
      expect(vis(card)).toBe('default');
      expect(db.prepare('SELECT 1 FROM decks WHERE id=?').get(deck)).toBeDefined();
      expect(db.prepare('SELECT 1 FROM milestones WHERE id=?').get(m.json.id)).toBeDefined();
      expect((await call(plain, 'get_context', {})).json.token.mayDelete).toBe(false);

      // Read tokens: "May delete" cannot be chosen, and a read row that somehow has it still cannot delete.
      const bad = await app.inject({
        method: 'POST', url: '/dispatch/apiTokens/create', headers: { host: HOST, 'content-type': 'application/json', cookie: cookieFor(owner) },
        payload: { kind: 'user', label: 'AI', role: 'admin', access: 'read', projectIds: [], mayDelete: true },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().data).toEqual({ field: 'mayDelete' });
      const read = await mkToken(owner, { access: 'read' });
      db.prepare('UPDATE api_tokens SET may_delete=1 WHERE prefix=?').run(read.slice(0, 9));
      const r = await call(read, 'delete_cards', { cardIds: [card] });
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe('missing_scope');
      expect(vis(card)).toBe('default');
    });

    it('with "May delete": tasks are soft-deleted (history, restorable), all or none, at most 100 per call', async () => {
      const owner = mkUser('owner');
      const deck = mkDeck(mkProject());
      const a = mkCard(deck, owner, 'A');
      const b = mkCard(deck, owner, 'B');
      const token = await mkToken(owner, { mayDelete: true });
      expect((await call(token, 'get_context', {})).json.token.mayDelete).toBe(true);

      // One unknown id: nothing is deleted.
      const miss = await call(token, 'delete_cards', { cardIds: [a, 'nope'] });
      expect(miss.isError).toBe(true);
      expect(miss.json.error).toBe('not_found');
      expect(vis(a)).toBe('default');

      const seqB = (db.prepare('SELECT seq FROM cards WHERE id=?').get(b) as { seq: number }).seq;
      const r = await call(token, 'delete_cards', { cardIds: [a, String(seqB), a] });
      expect(r.isError, r.text).toBe(false);
      expect(r.json.ids.sort()).toEqual([a, b].sort());
      expect([vis(a), vis(b)]).toEqual(['deleted', 'deleted']);
      const h = db.prepare('SELECT changer_id, changes_json FROM card_history WHERE card_id=? ORDER BY version DESC').get(a) as { changer_id: string; changes_json: string };
      expect(h.changer_id).toBe(owner);
      expect(JSON.parse(h.changes_json)).toEqual([{ kind: 'visibility', from: 'default', to: 'deleted' }]);
      // Gone for the tools; a second delete finds nothing.
      expect((await call(token, 'get_card', { cardId: a })).json.error).toBe('not_found');
      expect((await call(token, 'delete_cards', { cardIds: [a] })).json.error).toBe('not_found');
      // Restorable from Archive, as any deleted task.
      const back = await dispatchAs(owner, 'cards/update', { id: a, visibility: 'default' });
      expect(back.statusCode, back.body).toBe(200);
      expect(vis(a)).toBe('default');

      // Per-call cap.
      const many = Array.from({ length: 101 }, (_, i) => mkCard(deck, owner, `T${i}`));
      const over = await call(token, 'delete_cards', { cardIds: many });
      expect(over.isError).toBe(true);
      expect(over.json.error).toBe('invalid_arguments');
      expect(vis(many[0])).toBe('default');
      const ok = await call(token, 'delete_cards', { cardIds: many.slice(0, 100) });
      expect(ok.isError, ok.text).toBe(false);
      expect(vis(many[99])).toBe('deleted');
      expect(vis(many[100])).toBe('default');
    });

    it('the user\'s own rights still apply: observers and guarded lists', async () => {
      const owner = mkUser('owner');
      const project = mkProject();
      const deck = mkDeck(project);
      const card = mkCard(deck, owner);
      const observer = mkUser('observer');
      db.prepare('INSERT INTO project_access (project_id, user_id) VALUES (?,?)').run(project, observer);
      const t1 = await mkToken(observer, { role: 'limited', projectIds: [project], mayDelete: true });
      const r1 = await call(t1, 'delete_cards', { cardIds: [card] });
      expect(r1.isError).toBe(true);
      expect(r1.json.error).toBe('forbidden');
      expect(vis(card)).toBe('default');
      // A list with an active guardian: only the guardian may delete it, as through the API.
      db.prepare('UPDATE decks SET guardians_enabled=1 WHERE id=?').run(deck);
      db.prepare('INSERT INTO deck_guardians (deck_id, user_id) VALUES (?,?)').run(deck, owner);
      const member = mkUser('member');
      const t2 = await mkToken(member, { role: 'producer', projectIds: [project], mayDelete: true });
      const r2 = await call(t2, 'delete_deck', { deckId: deck, confirm: true });
      expect(r2.isError).toBe(true);
      expect(r2.json.error).toBe('guardian_only');
      expect(db.prepare('SELECT 1 FROM decks WHERE id=?').get(deck)).toBeDefined();
      // A list in a project the token cannot see does not exist for it.
      const other = mkDeck(mkProject());
      expect((await call(t2, 'delete_deck', { deckId: other, confirm: true })).json.error).toBe('not_found');
    });

    it('delete_deck and delete_milestone need confirm: true; the list goes, its tasks are deleted; tasks keep their place when a milestone goes', async () => {
      const owner = mkUser('owner');
      const project = mkProject();
      const deck = mkDeck(project);
      const card = mkCard(deck, owner);
      const keep = mkDeck(project);
      const kept = mkCard(keep, owner);
      const token = await mkToken(owner, { mayDelete: true });
      const noConfirm = await call(token, 'delete_deck', { deckId: deck });
      expect(noConfirm.isError).toBe(true);
      expect(noConfirm.json.error).toBe('invalid_arguments');
      expect((await call(token, 'delete_deck', { deckId: deck, confirm: false })).json.error).toBe('invalid_arguments');
      const d = await call(token, 'delete_deck', { deckId: deck, confirm: true });
      expect(d.isError, d.text).toBe(false);
      expect(db.prepare('SELECT 1 FROM decks WHERE id=?').get(deck)).toBeUndefined();
      expect(db.prepare('SELECT visibility, deck_id FROM cards WHERE id=?').get(card)).toEqual({ visibility: 'deleted', deck_id: null });

      const m = await call(token, 'create_milestone', { name: 'Beta', projectIds: [project] });
      await call(token, 'update_card', { cardId: kept, milestoneId: m.json.id });
      expect((await call(token, 'delete_milestone', { milestoneId: m.json.id })).json.error).toBe('invalid_arguments');
      const dm = await call(token, 'delete_milestone', { milestoneId: m.json.id, confirm: true });
      expect(dm.isError, dm.text).toBe(false);
      expect(db.prepare('SELECT 1 FROM milestones WHERE id=?').get(m.json.id)).toBeUndefined();
      expect(db.prepare('SELECT visibility, deck_id, milestone_id FROM cards WHERE id=?').get(kept)).toEqual({ visibility: 'default', deck_id: keep, milestone_id: null });
      expect((await call(token, 'delete_milestone', { milestoneId: m.json.id, confirm: true })).json.error).toBe('not_found');
    });

    it('create_project: admin-role write tokens of users who may create projects', async () => {
      const owner = mkUser('owner');
      const token = await mkToken(owner);
      const r = await call(token, 'create_project', { name: 'Moonfall' });
      expect(r.isError, r.text).toBe(false);
      expect(db.prepare('SELECT name, visibility FROM projects WHERE id=?').get(r.json.id)).toEqual({ name: 'Moonfall', visibility: 'full' });
      expect(r.json.seq).toBeGreaterThan(0);
      expect((await call(token, 'list_decks', { projectId: r.json.id })).isError).toBe(false);

      const read = await mkToken(owner, { access: 'read' });
      expect((await call(read, 'create_project', { name: 'X' })).json.error).toBe('missing_scope');
      const member = mkUser('member');
      seq += 10; // projects/create took the next project numbers
      const producer = await mkToken(member, { role: 'producer', projectIds: [mkProject()] });
      const p = await call(producer, 'create_project', { name: 'X' });
      expect(p.isError).toBe(true);
      expect(p.json.error).toBe('forbidden');
      expect((await call(token, 'create_project', { name: ' ' })).json.error).toBe('invalid_arguments');
      expect((db.prepare("SELECT COUNT(*) n FROM projects WHERE name='X'").get() as { n: number }).n).toBe(0);
    });
  });
});

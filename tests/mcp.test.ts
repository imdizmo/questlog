import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, _resetLimiter } from '../server/auth';
import { MCP_TOOL_NAMES } from '../server/mcp';

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
      'search_comments', 'list_hand', 'list_milestones', 'list_runs', 'list_members',
      'create_card', 'create_cards', 'update_card', 'update_cards', 'add_comment', 'update_comment', 'set_thread_resolved',
      'set_thread_participation', 'add_to_hand', 'remove_from_hand', 'move_in_hand', 'create_deck', 'create_milestone',
      'update_milestone', 'track_time', 'log_time',
    ];
    expect(tools.map((t) => t.name).sort()).toEqual([...expected].sort());
    expect([...MCP_TOOL_NAMES].sort()).toEqual([...expected].sort());
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(t.name).not.toMatch(/delete/);
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
    const t = await rpc(token, 'tools/call', { name: 'delete_card', arguments: {} });
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
});

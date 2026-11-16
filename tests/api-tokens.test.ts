import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, _resetLimiter } from '../server/auth';
import { people } from '../web/src/store';

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
/** A session cookie without going through the (slow, rate-limited) password login. */
function cookieFor(userId: string): string {
  const t = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(t), userId, Date.now() + 3600e3);
  return `jt_session=${t}`;
}
function mkProject(visibility: 'full' | 'limited' = 'full', name = 'P'): string {
  const id = newId();
  db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,?,0,?,0)')
    .run(id, ++seq, name, visibility, '[]');
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

type Auth = { cookie?: string; bearer?: string };
const headers = (a: Auth) => ({
  host: HOST, 'content-type': 'application/json',
  ...(a.cookie ? { cookie: a.cookie } : {}),
  ...(a.bearer ? { authorization: `Bearer ${a.bearer}` } : {}),
});
const send = (a: Auth, cmd: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: headers(a) });
const query = (a: Auth, root: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/query', payload: { query: { _root: root } }, headers: headers(a) });
const snapshot = (a: Auth) => app.inject({ method: 'GET', url: '/api/snapshot', headers: headers(a) });

async function mkToken(cookie: string, input: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const r = await send({ cookie }, 'apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [], ...input });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
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

describe('API tokens', () => {
  it('create returns the token once; only its hash is stored', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const { id, token } = await mkToken(cookie, { label: 'Build bot' });
    expect(token).toMatch(/^jtut_[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT * FROM api_tokens WHERE id=?').get(id) as Record<string, unknown>;
    expect(row.token_hash).toBe(sha(token));
    expect(row.kind).toBe('user');
    expect(row.user_id).toBe(owner);
    expect(row.creator_id).toBe(owner);
    for (const v of Object.values(row)) expect(String(v)).not.toContain(token.slice(5));
    expect(String(row.prefix)).toBe(token.slice(0, 9));
    // The snapshot lists it without any secret.
    const snap = (await snapshot({ cookie })).json();
    expect(snap.apiTokens).toHaveLength(1);
    const listed = snap.apiTokens[0];
    expect(listed).toMatchObject({ id, kind: 'user', label: 'Build bot', role: 'admin', access: 'write', userId: owner, prefix: token.slice(0, 9) });
    expect(JSON.stringify(snap)).not.toContain(sha(token));
    expect(JSON.stringify(snap)).not.toContain(token);
    expect(listed).not.toHaveProperty('tokenHash');
  });

  it('bearer read token can query but dispatch → 403 missing_scope requiredScope tasks:write', async () => {
    const owner = mkUser('owner');
    const p = mkProject();
    const d = mkDeck(p);
    const c = mkCard(d, owner, 'Hello');
    const { token } = await mkToken(cookieFor(owner), { access: 'read' });
    const q = await query({ bearer: token }, [{ cards: ['title'] }]);
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()._root.cards).toEqual([c]);
    expect((await snapshot({ bearer: token })).statusCode).toBe(200);
    const w = await send({ bearer: token }, 'cards/create', { deckId: d, content: 'Nope' });
    expect(w.statusCode).toBe(403);
    expect(w.json()).toEqual({ error: 'missing_scope', data: { requiredScope: 'cards:write' } });
  });

  it("limited token for project A can't read or write project B", async () => {
    const owner = mkUser('owner');
    const a = mkProject('full', 'A');
    const b = mkProject('full', 'B');
    const da = mkDeck(a);
    const db_ = mkDeck(b);
    const ca = mkCard(da, owner, 'In A');
    const cb = mkCard(db_, owner, 'In B');
    mkCard(null, owner, 'Private deckless');
    const { token } = await mkToken(cookieFor(owner), { role: 'limited', access: 'write', projectIds: [a] });
    const q = await query({ bearer: token }, [{ cards: ['title'] }, { projects: ['name'] }]);
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()._root.cards).toEqual([ca]);
    expect(q.json()._root.projects).toEqual([a]);
    const snap = (await snapshot({ bearer: token })).json();
    expect(snap.projects.map((p: any) => p.id)).toEqual([a]);
    expect(snap.cards.map((c: any) => c.id)).toEqual([ca]);
    expect(snap.apiTokens).toEqual([]);
    // Addresses as in /api/query: hidden from a token that is no admin, shown to an admin token and to sessions.
    expect(snap.users.length).toBeGreaterThan(0);
    expect(snap.users.every((u: any) => !('email' in u))).toBe(true);
    const admin = await mkToken(cookieFor(owner), { role: 'admin', access: 'read' });
    expect((await snapshot({ bearer: admin.token })).json().users.every((u: any) => typeof u.email === 'string')).toBe(true);
    expect((await snapshot({ cookie: cookieFor(owner) })).json().users.every((u: any) => typeof u.email === 'string')).toBe(true);
    // Writes: B is refused, A works; the token never touches B's cards.
    expect((await send({ bearer: token }, 'cards/create', { deckId: db_, content: 'x' })).statusCode).toBe(403);
    expect((await send({ bearer: token }, 'cards/update', { id: cb, content: 'Hacked' })).statusCode).toBe(403);
    expect((db.prepare('SELECT content FROM cards WHERE id=?').get(cb) as { content: string }).content).toBe('In B');
    const ok = await send({ bearer: token }, 'cards/create', { deckId: da, content: 'From the API' });
    expect(ok.statusCode, ok.body).toBe(200);
    // Not even an admin-only action: a limited token is no admin, whatever its owner is.
    expect((await send({ bearer: token }, 'projects/create', { name: 'New' })).statusCode).toBe(403);
  });

  it('a token never exceeds its owner', async () => {
    const member = mkUser('member');
    const p = mkProject('full');
    const hidden = mkProject('limited');
    mkCard(mkDeck(hidden), member, 'Secret');
    // A member may not mint an admin-role token, and a producer token does not make a non-producer a producer.
    const r = await send({ cookie: cookieFor(member) }, 'apiTokens/create', { kind: 'user', label: 'x', role: 'admin', access: 'write', projectIds: [] });
    expect(r.statusCode).toBe(403);
    const { token } = await mkToken(cookieFor(member), { role: 'producer', projectIds: [p] });
    expect((await send({ bearer: token }, 'projects/update', { id: p, name: 'Renamed' })).statusCode).toBe(403);
    // A project the owner can't see can't be put on a token.
    const bad = await send({ cookie: cookieFor(member) }, 'apiTokens/create', { kind: 'user', label: 'x', role: 'limited', access: 'read', projectIds: [hidden] });
    expect(bad.statusCode).toBe(400);
  });

  it('expired → 401 token_expired', async () => {
    const owner = mkUser('owner');
    const t0 = Date.now();
    const { token } = await mkToken(cookieFor(owner), { expiresAt: t0 + 60_000 });
    expect((await snapshot({ bearer: token })).statusCode).toBe(200);
    setClock(() => t0 + 61_000);
    const r = await snapshot({ bearer: token });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'token_expired' });
  });

  it('revoked → 401 invalid_token', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const { id, token } = await mkToken(cookie, {});
    expect((await send({ cookie }, 'apiTokens/revoke', { id })).statusCode).toBe(200);
    const r = await query({ bearer: token }, [{ cards: ['title'] }]);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'invalid_token' });
    // Unknown and malformed tokens look the same.
    expect((await snapshot({ bearer: 'jtut_' + 'A'.repeat(43) })).json()).toEqual({ error: 'invalid_token' });
    expect((await snapshot({ bearer: 'nonsense' })).json()).toEqual({ error: 'invalid_token' });
  });

  it('revoke: the owner, or an admin; never another member', async () => {
    const owner = mkUser('owner');
    const m1 = mkUser('member');
    const m2 = mkUser('member');
    const t1 = await mkToken(cookieFor(m1), { role: 'limited', projectIds: [mkProject()] });
    expect((await send({ cookie: cookieFor(m2) }, 'apiTokens/revoke', { id: t1.id })).statusCode).toBe(403);
    expect((await send({ cookie: cookieFor(owner) }, 'apiTokens/revoke', { id: t1.id })).statusCode).toBe(200);
    const org = await mkToken(cookieFor(owner), { kind: 'org', label: 'Org bot', role: 'limited', projectIds: [mkProject()] });
    expect((await send({ cookie: cookieFor(m1) }, 'apiTokens/revoke', { id: org.id })).statusCode).toBe(403);
    // Members see only their own tokens.
    expect((await snapshot({ cookie: cookieFor(m2) })).json().apiTokens).toEqual([]);
    expect((await snapshot({ cookie: cookieFor(owner) })).json().apiTokens).toHaveLength(2);
  });

  it('owner removed → 401 not_a_member', async () => {
    const owner = mkUser('owner');
    const member = mkUser('member');
    const { token } = await mkToken(cookieFor(member), { role: 'limited', projectIds: [mkProject()] });
    expect((await snapshot({ bearer: token })).statusCode).toBe(200);
    expect((await send({ cookie: cookieFor(owner) }, 'users/disable', { userId: member, disabled: true })).statusCode).toBe(200);
    const r = await snapshot({ bearer: token });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'not_a_member' });
  });

  it('personal tokens disabled → 401 user_api_tokens_disabled', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const { token } = await mkToken(cookie, {});
    const org = await mkToken(cookie, { kind: 'org', label: 'Org', role: 'admin' });
    const r0 = await send({ cookie }, 'accounts/update', { userApiTokensEnabled: false });
    expect(r0.statusCode, r0.body).toBe(200);
    const r = await snapshot({ bearer: token });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'user_api_tokens_disabled' });
    // Org tokens are not personal tokens.
    expect((await snapshot({ bearer: org.token })).statusCode).toBe(200);
    // And no new personal token while it is off.
    expect((await send({ cookie }, 'apiTokens/create', { kind: 'user', label: 'x', role: 'admin', access: 'read', projectIds: [] })).statusCode).toBe(403);
  });

  it('token calling apiTokens/create → 403', async () => {
    const owner = mkUser('owner');
    const { id, token } = await mkToken(cookieFor(owner), { role: 'admin', access: 'write' });
    const r = await send({ bearer: token }, 'apiTokens/create', { kind: 'user', label: 'x', role: 'admin', access: 'write', projectIds: [] });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('missing_scope');
    expect((await send({ bearer: token }, 'apiTokens/revoke', { id })).statusCode).toBe(403);
    expect((await send({ bearer: token }, 'invites/create', { role: 'admin', projectIds: [] })).statusCode).toBe(403);
    // Unlinking Tailscale is credential management, refused like invites, also for the self-unlink a session user has.
    const m = mkUser('member');
    for (const body of [{ userId: m }, { userId: owner }]) {
      const t = await send({ bearer: token }, 'users/unlinkTailscale', body);
      expect(t.statusCode).toBe(403);
      expect(t.json()).toEqual((await send({ bearer: token }, 'invites/create', { role: 'admin', projectIds: [] })).json());
    }
    // Nor may a token switch personal tokens back on (or off).
    expect((await send({ bearer: token }, 'accounts/update', { userApiTokensEnabled: false })).statusCode).toBe(403);
    // Nor switch MCP (an integration) on, or set its daily limit; other settings still work through a token.
    const mcpOf = () => {
      const s = JSON.parse((db.prepare('SELECT settings_json s FROM account').get() as { s: string }).s);
      return [s.mcpEnabled ?? true, s.mcpDailyLimit ?? null]; // unset = the defaults
    };
    const before = mcpOf();
    for (const settings of [{ mcpEnabled: !before[0] }, { mcpDailyLimit: 5 }]) {
      const m = await send({ bearer: token }, 'accounts/update', { settings });
      expect([m.statusCode, m.json().error, m.json().data]).toEqual([403, 'missing_scope', { requiredScope: 'session' }]);
    }
    expect((await send({ bearer: token }, 'accounts/update', { settings: { dueDateEnabled: true } })).statusCode).toBe(200);
    expect(mcpOf()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) n FROM api_tokens').get()).toEqual({ n: 1 });
  });

  it('41st request in 5 s → 429 with Retry-After', async () => {
    const owner = mkUser('owner');
    const { token } = await mkToken(cookieFor(owner), { access: 'read' });
    for (let i = 0; i < 40; i++) expect((await snapshot({ bearer: token })).statusCode).toBe(200);
    const r = await snapshot({ bearer: token });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'rate_limit' });
    const after = Number(r.headers['retry-after']);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(5);
    // Bad tokens count too (no free guessing), cookie sessions do not.
    expect((await snapshot({ bearer: 'nonsense' })).statusCode).toBe(429);
    expect((await snapshot({ cookie: cookieFor(owner) })).statusCode).toBe(200);
  });

  it('51st org token → 409 limit_reached', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    for (let i = 0; i < 50; i++) await mkToken(cookie, { kind: 'org', label: `Bot ${i}`, role: 'admin', access: 'read' });
    const r = await send({ cookie }, 'apiTokens/create', { kind: 'org', label: 'One too many', role: 'admin', access: 'read', projectIds: [] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('limit_reached');
    for (let i = 0; i < 20; i++) await mkToken(cookie, { label: `Mine ${i}` });
    expect((await send({ cookie }, 'apiTokens/create', { kind: 'user', label: 'x', role: 'admin', access: 'read', projectIds: [] })).statusCode).toBe(409);
  });

  it('service user not in the member list', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const p = mkProject('limited');
    const d = mkDeck(p);
    const { token } = await mkToken(cookie, { kind: 'org', label: 'Importer', role: 'producer', access: 'write', projectIds: [p] });
    // The org token acts as its own service user, with explicit access to its projects.
    const created = await send({ bearer: token }, 'cards/create', { deckId: d, content: 'From the importer' });
    expect(created.statusCode, created.body).toBe(200);
    const svc = db.prepare("SELECT * FROM users WHERE kind='service'").get() as Record<string, unknown>;
    expect(svc.name).toBe('Importer');
    expect(db.prepare('SELECT creator_id c FROM cards WHERE id=?').get(created.json().payload.id)).toEqual({ c: svc.id });
    expect(db.prepare('SELECT project_role r FROM project_access WHERE user_id=? AND project_id=?').get(svc.id as string, p)).toEqual({ r: 'producer' });
    // A service user can never log in.
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: svc.email, password: '' }, headers: headers({}) });
    expect(login.statusCode).toBe(401);
    const snap = (await snapshot({ cookie })).json();
    const users = new Map<string, any>(snap.users.map((u: any) => [u.id, u]));
    expect(users.get(svc.id as string)?.kind).toBe('service');
    expect(users.get(owner)?.kind).toBe('person');
    expect(people(users).map((u) => u.id)).toEqual([owner]);
  });

  it('cookie sessions unaffected', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const p = mkProject();
    const d = mkDeck(p);
    expect((await snapshot({ cookie })).statusCode).toBe(200);
    expect((await query({ cookie }, [{ cards: ['title'] }])).statusCode).toBe(200);
    expect((await send({ cookie }, 'cards/create', { deckId: d, content: 'By hand' })).statusCode).toBe(200);
    // No credentials at all is still 401 unauthenticated; an explicit bad bearer wins over a good cookie.
    expect((await snapshot({})).json()).toEqual({ error: 'unauthenticated' });
    expect((await snapshot({ cookie, bearer: 'nonsense' })).statusCode).toBe(401);
  });
});

describe('API token live routing', () => {
  it('token rows go to admins and the owner only', async () => {
    const { LiveHub } = await import('../server/live');
    const admin = mkUser('admin');
    const m1 = mkUser('member');
    const m2 = mkUser('member');
    const hub = new LiveHub(db);
    const got = new Map<string, string[]>();
    for (const id of [admin, m1, m2]) {
      got.set(id, []);
      hub.add({ send: (d: string) => got.get(id)!.push(d), close: () => {} }, { id });
    }
    hub.publish('a1', [{ model: 'apiToken', op: 'upsert', row: { id: 't', kind: 'user', userId: m1, creatorId: m1 } }]);
    expect(got.get(admin)).toHaveLength(1);
    expect(got.get(m1)).toHaveLength(1);
    expect(got.get(m2)).toHaveLength(0);
  });
});

describe('TokenRateLimiter', () => {
  it('slides its window and keeps at most maxIps keys (least recently seen evicted)', async () => {
    const { TokenRateLimiter, TOKEN_RATE } = await import('../server/tokens');
    expect(TOKEN_RATE).toEqual({ max: 40, windowMs: 5000, maxIps: 10_000 });
    const l = new TokenRateLimiter(2, 5000, 3);
    expect(l.hit('a', 0)).toBe(0);
    expect(l.hit('a', 1000)).toBe(0);
    expect(l.hit('a', 2000)).toBe(3); // first hit leaves the window at 5000
    expect(l.hit('a', 5001)).toBe(0);
    for (const k of ['b', 'c', 'd']) l.hit(k, 6000);
    expect(l.size).toBe(3);
    // 'a' was least recently seen: evicted, so it starts afresh.
    expect(l.hit('a', 6001)).toBe(0);
    expect(l.hit('a', 6002)).toBe(0);
    expect(l.size).toBe(3);
  });
});

describe('token confinement on workspace-wide and own-row commands', () => {
  async function setup() {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const a = mkProject('full', 'A');
    const b = mkProject('full', 'B');
    const da = mkDeck(a);
    const dbk = mkDeck(b);
    const confined = await mkToken(cookie, { role: 'producer', access: 'write', projectIds: [a] });
    const admin = await mkToken(cookie, { role: 'admin', access: 'write' });
    return { owner, cookie, a, b, da, dbk, confined: confined.token, admin: admin.token };
  }

  it('presets: refused for a project-confined token, allowed for an admin-role token and sessions', async () => {
    const { cookie, confined, admin } = await setup();
    const r = await send({ bearer: confined }, 'presets/create', { name: 'Bug', data: { content: 'x' } });
    expect(r.statusCode).toBe(403);
    const ok = await send({ bearer: admin }, 'presets/create', { name: 'Bug', data: { content: 'x' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const id = ok.json().payload.id;
    expect((await send({ bearer: confined }, 'presets/update', { id, name: 'Hacked' })).statusCode).toBe(403);
    expect((await send({ bearer: confined }, 'presets/delete', { id })).statusCode).toBe(403);
    expect((await send({ cookie }, 'presets/update', { id, name: 'Feature' })).statusCode).toBe(200);
    // An observer's admin-free session is still refused, as before.
    const obs = mkUser('observer');
    expect((await send({ cookie: cookieFor(obs) }, 'presets/create', { name: 'x', data: {} })).statusCode).toBe(403);
  });

  it('own workspace-wide rows (timezone, saved searches): refused for a project-confined token', async () => {
    const { owner, confined, admin } = await setup();
    expect((await send({ bearer: confined }, 'users/update', { id: owner, timezone: 'Europe/Berlin' })).statusCode).toBe(403);
    expect((await send({ bearer: confined }, 'search/save', { tokens: [], forceOr: false })).statusCode).toBe(403);
    expect((await send({ bearer: admin }, 'users/update', { id: owner, timezone: 'Europe/Berlin' })).statusCode).toBe(200);
  });

  it("own-row removals by task id (watch, bookmark, Hand, timer) can't reach another project's tasks", async () => {
    const { owner, cookie, da, dbk, confined } = await setup();
    const cb = mkCard(dbk, owner, 'In B');
    const ca = mkCard(da, owner, 'In A');
    expect((await send({ cookie }, 'watchings/addCard', { cardId: cb })).statusCode).toBe(200);
    expect((await send({ cookie }, 'bookmarks/addCards', { userId: owner, ids: [cb] })).statusCode).toBe(200);
    expect((await send({ cookie }, 'handQueue/addCards', { userId: owner, cardIds: [cb] })).statusCode).toBe(200);
    expect((await send({ bearer: confined }, 'watchings/removeCard', { cardId: cb })).statusCode).toBe(404);
    expect((await send({ bearer: confined }, 'bookmarks/removeCards', { userId: owner, ids: [cb] })).statusCode).toBe(404);
    expect((await send({ bearer: confined }, 'handQueue/removeCards', { userId: owner, cardIds: [cb] })).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) n FROM card_subscriptions WHERE card_id=?').get(cb)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM bookmarks WHERE card_id=?').get(cb)).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM hand_cards WHERE card_id=?').get(cb)).toEqual({ n: 1 });
    // A running timer on B can be neither stopped nor (by starting one on A) implicitly stopped.
    const seg = newId();
    db.prepare('INSERT INTO time_segments (id,card_id,user_id,started_at,duration_ms,created_at) VALUES (?,?,?,?,NULL,?)').run(seg, cb, owner, Date.now(), Date.now());
    expect((await send({ bearer: confined }, 'timeTracking/stop', { id: seg })).statusCode).toBe(404);
    expect((await send({ cookie }, 'accounts/update', { settings: { timeTrackingMode: 'manual' } })).statusCode).toBe(200);
    expect((await send({ bearer: confined }, 'timeTracking/start', { userId: owner, cardId: ca })).statusCode).toBe(404);
    expect(db.prepare('SELECT duration_ms d FROM time_segments WHERE id=?').get(seg)).toEqual({ d: null });
  });

  it("zones of a global milestone: not for a project-confined token", async () => {
    const { cookie, confined } = await setup();
    const m = await send({ cookie }, 'milestones/create', { name: 'Launch', date: null, startDate: null, color: 'blue', isGlobal: true, projectIds: [] });
    expect(m.statusCode, m.body).toBe(200);
    const id = m.json().payload.id;
    expect((await send({ bearer: confined }, 'milestoneZones/create', { milestoneId: id, name: 'Z' })).statusCode).toBe(403);
    expect((await send({ bearer: confined }, 'milestones/setPinned', { id, isPinned: true })).statusCode).toBe(403);
    expect((await send({ cookie }, 'milestoneZones/create', { milestoneId: id, name: 'Z' })).statusCode).toBe(200);
  });

  it('cross-project moves and deps are refused for a confined token', async () => {
    const { owner, cookie, da, dbk, confined } = await setup();
    const ca = mkCard(da, owner, 'In A');
    const cb = mkCard(dbk, owner, 'In B');
    expect((await send({ bearer: confined }, 'cards/update', { id: ca, deckId: dbk })).statusCode).toBe(403);
    expect((await send({ bearer: confined }, 'cards/update', { id: ca, parentCardId: cb })).statusCode).toBeOneOf([403, 404]);
    expect((await send({ cookie }, 'accounts/update', { settings: { dependenciesEnabled: true } })).statusCode).toBe(200);
    expect((await send({ bearer: confined }, 'cards/update', { id: ca, inDeps: [cb] })).statusCode).toBe(404);
    expect(db.prepare('SELECT deck_id d, parent_card_id p FROM cards WHERE id=?').get(ca)).toEqual({ d: da, p: null });
    expect(db.prepare('SELECT COUNT(*) n FROM card_deps').get()).toEqual({ n: 0 });
  });

  it('an admin-role token loses admin rights as soon as its owner does', async () => {
    const owner = mkUser('owner');
    const adm = mkUser('admin');
    const { token } = await mkToken(cookieFor(adm), { role: 'admin', access: 'write' });
    expect((await send({ bearer: token }, 'projects/create', { name: 'One' })).statusCode).toBe(200);
    expect((await send({ cookie: cookieFor(owner) }, 'users/setRole', { userId: adm, role: 'member' })).statusCode).toBe(200);
    expect((await send({ bearer: token }, 'projects/create', { name: 'Two' })).statusCode).toBe(403);
  });

  it('non-dispatch write routes stay cookie-only; a Basic auth header leaves the cookie in charge', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const c = mkCard(mkDeck(mkProject()), owner);
    const { token } = await mkToken(cookie, { role: 'admin', access: 'write' });
    const up = await app.inject({ method: 'POST', url: `/api/cards/${c}/files?name=a.txt`, payload: 'hi',
      headers: { host: HOST, 'content-type': 'text/plain', authorization: `Bearer ${token}` } });
    expect(up.statusCode).toBe(401);
    const basic = await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie, authorization: 'Basic dTpw' } });
    expect(basic.statusCode).toBe(200);
  });

  it('every command namespace is classified for tokens (the deny-list must not fail open)', async () => {
    const { registry } = await import('../server/dispatch');
    const { TOKEN_DENIED_NAMESPACES } = await import('../server/tokens');
    // Reviewed as token-safe: each command checks its own rights through can()/canSeeCard. A new namespace must be
    // added here (or to TOKEN_DENIED_NAMESPACES) after the same review.
    const allowed = new Set(['users', 'accounts', 'cards', 'decks', 'handQueue', 'bookmarks', 'journeys', 'milestones', 'milestoneZones',
      'presets', 'projects', 'missionControl', 'resolvables', 'search', 'sprints', 'timeTracking', 'visionBoard', 'watchings', 'wiki']);
    const unclassified = [...new Set(Object.keys(registry).map((k) => k.split('/')[0]))]
      .filter((ns) => !allowed.has(ns) && !TOKEN_DENIED_NAMESPACES.has(ns));
    expect(unclassified).toEqual([]);
  });

  it('org token rows go live to admins only', async () => {
    const { LiveHub } = await import('../server/live');
    const admin = mkUser('admin');
    const m1 = mkUser('member');
    const hub = new LiveHub(db);
    const got = new Map<string, number>([[admin, 0], [m1, 0]]);
    for (const id of [admin, m1]) hub.add({ send: () => got.set(id, got.get(id)! + 1), close: () => {} }, { id });
    hub.publish('a1', [{ model: 'apiToken', op: 'upsert', row: { id: 't', kind: 'org', userId: newId(), creatorId: m1 } }]);
    expect(got.get(admin)).toBe(1);
    expect(got.get(m1)).toBe(0);
  });
});

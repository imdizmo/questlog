import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp, CSP } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;

const hdr = (cookie?: string, extra: Record<string, string> = {}) => ({
  host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra,
});
const cookieOf = (res: any, name = 'jt_session') => {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === name);
  return c ? `${name}=${c.value}` : '';
};
const post = (url: string, payload: unknown, cookie?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as any, headers: hdr(cookie, extra) });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: hdr(cookie) });

const SETUP = { workspaceName: 'W', name: 'Own', email: 'o@x.io', password: 'pw-owner' };
let ownerCookie: string;

function mkUser(role: string, email: string): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const loginAs = async (email: string) => cookieOf(await post('/api/login', { email, password: 'pw' }));
const dispatchOk = async (name: string, payload: unknown, cookie: string) => {
  const r = await post(`/dispatch/${name}`, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function world() {
  ownerCookie = cookieOf(await post('/api/setup', SETUP));
  const memberId = mkUser('member', 'm@x.io');
  const obsId = mkUser('observer', 'ob@x.io');
  const member = await loginAs('m@x.io');
  const observer = await loginAs('ob@x.io');
  const open = (await dispatchOk('projects/create', { name: 'Open' }, ownerCookie)).id as string;
  const secret = (await dispatchOk('projects/create', { name: 'Secret', visibility: 'limited' }, ownerCookie)).id as string;
  const secretDeck = (await dispatchOk('decks/create', { title: 'SD', projectId: secret }, ownerCookie)).id as string;
  const openDeck = (await dispatchOk('decks/create', { title: 'OD', projectId: open }, ownerCookie)).id as string;
  return { memberId, obsId, member, observer, open, secret, secretDeck, openDeck };
}

describe('api', () => {
  it('setup flow', async () => {
    expect((await get('/api/status')).json()).toMatchObject({ setup: false, disabled: false });
    const r = await post('/api/setup', SETUP);
    expect(r.statusCode).toBe(200);
    const set = r.headers['set-cookie'] as string[];
    expect(set.some((c) => c.startsWith('jt_session=') && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c) && !/Secure/i.test(c))).toBe(true);
    expect(set.some((c) => c.startsWith('jt_device=') && /Max-Age=31536000/.test(c))).toBe(true);
    expect(JSON.stringify(r.json())).not.toMatch(/password/i);
    expect((await get('/api/status')).json()).toMatchObject({ setup: true, disabled: false });
    expect((await post('/api/setup', SETUP)).statusCode).toBe(409);
    const cookie = cookieOf(r);
    const snap = (await get('/api/snapshot', cookie)).json();
    expect(snap.me.email).toBe('o@x.io');
    expect(snap.account.name).toBe('W');
    expect(JSON.stringify(snap)).not.toMatch(/passwordHash|scrypt/);
    expect((await post('/api/logout', {}, cookie)).statusCode).toBe(200);
    expect((await get('/api/snapshot', cookie)).statusCode).toBe(401);
    const l = await post('/api/login', { email: 'o@x.io', password: 'pw-owner' });
    expect(l.statusCode).toBe(200);
    expect(cookieOf(l, 'jt_device')).toBeTruthy();
  });

  it('auth required', async () => {
    await post('/api/setup', SETUP);
    for (const r of [await get('/api/snapshot'), await post('/dispatch/projects/create', { name: 'x' }), await get('/api/cards/1')]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe('unauthenticated');
    }
  });

  it('rejects foreign Host', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP, headers: { host: 'evil.example:8780', 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(421);
    expect(r.json().error).toBe('bad_host');
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as any).c).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(421);
  });

  it('rejects foreign Origin', async () => {
    const c = cookieOf(await post('/api/setup', SETUP));
    const body = { name: 'P' };
    expect((await post('/dispatch/projects/create', body, c, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post('/dispatch/projects/create', body, c, { origin: 'http://evil.example:8780' })).json().error).toBe('cross_origin');
    expect((await post('/dispatch/projects/create', body, c, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post('/dispatch/projects/create', body, c, { origin: `http://${HOST}` })).statusCode).toBe(200);
  });

  it('snapshot scoped', async () => {
    const w = await world();
    const sd = await dispatchOk('cards/create', { content: 'secret task', deckId: w.secretDeck }, ownerCookie);
    await dispatchOk('cards/create', { content: 'open task', deckId: w.openDeck }, ownerCookie);
    const m = (await get('/api/snapshot', w.member)).json();
    expect(m.projects.map((p: any) => p.name)).toEqual(['Open']);
    expect(m.decks.map((d: any) => d.title)).toEqual(['OD']);
    expect(m.cards.map((c: any) => c.content)).toEqual(['open task']);
    const a = (await get('/api/snapshot', ownerCookie)).json();
    expect(a.projects).toHaveLength(2);
    expect(a.cards).toHaveLength(2);
    expect(a.users).toHaveLength(3);
    expect((await get(`/api/cards/${sd.accountSeq}`, w.member)).statusCode).toBe(404);
  });

  it('snapshot task rules', async () => {
    const w = await world();
    const c1 = await dispatchOk('cards/create', { content: 'arch', deckId: w.openDeck }, ownerCookie);
    const c2 = await dispatchOk('cards/create', { content: 'del', deckId: w.openDeck }, ownerCookie);
    const c3 = await dispatchOk('cards/create', { content: 'blk', deckId: w.openDeck }, ownerCookie);
    const c4 = await dispatchOk('cards/create', { content: 'closed', deckId: w.openDeck }, ownerCookie);
    await dispatchOk('cards/update', { id: c1.id, visibility: 'archived' }, ownerCookie);
    await dispatchOk('cards/update', { id: c2.id, visibility: 'deleted' }, ownerCookie);
    const open = await dispatchOk('resolvables/create', { cardId: c3.id, context: 'block', content: 'why' }, ownerCookie);
    const closed = await dispatchOk('resolvables/create', { cardId: c4.id, context: 'block', content: 'old' }, ownerCookie);
    await dispatchOk('resolvables/close', { id: closed.id }, ownerCookie);
    const s = (await get('/api/snapshot', ownerCookie)).json();
    const contents = s.cards.map((c: any) => c.content);
    expect(contents).toContain('arch');
    expect(contents).toContain('closed');
    expect(contents).not.toContain('del');
    expect(s.resolvables.map((r: any) => r.id)).toEqual([open.id]);
    expect(s.entries.map((e: any) => e.id)).toEqual([open.entryId]);
  });

  it('snapshot excludes secret-project resolvables, entries, hands and access', async () => {
    const w = await world();
    const sc = await dispatchOk('cards/create', { content: 's', deckId: w.secretDeck }, ownerCookie);
    const oc = await dispatchOk('cards/create', { content: 'o', deckId: w.openDeck }, ownerCookie);
    await dispatchOk('cards/bulkUpdate', { ids: [sc.id, oc.id], status: 'started' }, ownerCookie);
    await dispatchOk('resolvables/create', { cardId: sc.id, context: 'block', content: 'x' }, ownerCookie);
    await dispatchOk('projects/setAccess', { projectId: w.secret, userId: w.obsId, access: 'member' }, ownerCookie);
    const a = (await get('/api/snapshot', ownerCookie)).json();
    expect(a.resolvables).toHaveLength(1);
    expect(a.entries).toHaveLength(1);
    expect(a.handCards).toHaveLength(2);
    const m = (await get('/api/snapshot', w.member)).json();
    expect(m.resolvables).toEqual([]);
    expect(m.entries).toEqual([]);
    expect(m.handCards.map((h: any) => h.cardId)).toEqual([oc.id]);
    expect(m.projectAccess.filter((x: any) => x.projectId === w.secret)).toEqual([]);
    expect(a.projectAccess.some((x: any) => x.projectId === w.secret)).toBe(true);
  });

  it('observer not in full project', async () => {
    const w = await world();
    await dispatchOk('cards/create', { content: 'c', deckId: w.openDeck }, ownerCookie);
    const o = (await get('/api/snapshot', w.observer)).json();
    expect(o.projects).toEqual([]);
    expect(o.cards).toEqual([]);
    expect(o.decks).toEqual([]);
    await dispatchOk('projects/setAccess', { projectId: w.open, userId: w.obsId, access: 'member' }, ownerCookie);
    expect((await get('/api/snapshot', w.observer)).json().cards).toHaveLength(1);
  });

  it('deleted task by seq, history', async () => {
    const w = await world();
    const c = await dispatchOk('cards/create', { content: 'gone', deckId: w.openDeck }, ownerCookie);
    await dispatchOk('cards/update', { id: c.id, visibility: 'deleted' }, ownerCookie);
    const r = await get(`/api/cards/${c.accountSeq}`, w.member);
    expect(r.statusCode).toBe(200);
    expect(r.json().card.visibility).toBe('deleted');
    expect(r.json().deck.id).toBe(w.openDeck);
    const h = (await get(`/api/cards/${c.id}/history`, w.member)).json();
    expect(h.length).toBeGreaterThan(1);
    expect(h[0].version).toBeGreaterThan(h[1].version);
  });

  it('deleted task by seq withholds conversations from non-admins, like /threads, and carries reactions for admins', async () => {
    const w = await world();
    const c = await dispatchOk('cards/create', { content: 'gone2', deckId: w.openDeck }, ownerCookie);
    const { id: rid } = await dispatchOk('resolvables/create', { cardId: c.id, context: 'comment', content: 'hello' }, ownerCookie);
    const live = (await get(`/api/cards/${c.accountSeq}`, w.member)).json();
    expect(live.resolvables).toHaveLength(1);
    expect(live.reactions).toEqual([]);
    await dispatchOk('cards/update', { id: c.id, visibility: 'deleted' }, ownerCookie);
    const m = (await get(`/api/cards/${c.accountSeq}`, w.member)).json();
    expect([m.resolvables, m.entries, m.reactions]).toEqual([[], [], []]);
    expect((await get(`/api/cards/${c.id}/threads`, w.member)).statusCode).toBe(404);
    const a = (await get(`/api/cards/${c.accountSeq}`, ownerCookie)).json();
    expect(a.resolvables.map((r: any) => r.id)).toEqual([rid]);
  });

  it('invite flow', async () => {
    const w = await world();
    const { token } = await dispatchOk('invites/create', { role: 'member', projectIds: [w.secret] }, ownerCookie);
    expect((await get(`/api/invites/${token}`)).json()).toEqual({ role: 'member' });
    expect((await get('/api/invites/nope')).statusCode).toBe(404);
    const r = await post(`/api/invites/${token}/accept`, { name: 'New', email: 'n@x.io', password: 'pw' });
    expect(r.statusCode).toBe(200);
    const s = (await get('/api/snapshot', cookieOf(r))).json();
    expect(s.projects).toHaveLength(2);
  });

  it('lists active invites for admins only', async () => {
    const w = await world();
    const a = await dispatchOk('invites/create', { role: 'member', projectIds: [w.secret] }, ownerCookie);
    const b = await dispatchOk('invites/create', { role: 'observer', projectIds: [] }, ownerCookie);
    const c = await dispatchOk('invites/create', { role: 'admin', projectIds: [] }, ownerCookie);
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    await dispatchOk('invites/disable', { tokenHash: sha(b.token) }, ownerCookie);
    db.prepare('UPDATE invites SET expires_at=1 WHERE token_hash=?').run(sha(c.token));
    const r = await get('/api/invites', ownerCookie);
    expect(r.statusCode).toBe(200);
    const list = r.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tokenHash: sha(a.token), role: 'member', projectIds: [w.secret], createdBy: expect.any(String) });
    expect(list[0].expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(list)).not.toContain(a.token);
    expect((await get('/api/invites', w.member)).statusCode).toBe(403);
    expect((await get('/api/invites', w.observer)).statusCode).toBe(403);
    expect((await get('/api/invites')).statusCode).toBe(401);
  });

  it('dispatch errors map to status', async () => {
    await post('/api/setup', SETUP);
    const c = cookieOf(await post('/api/login', { email: 'o@x.io', password: 'pw-owner' }));
    expect((await post('/dispatch/nope/nope', {}, c)).statusCode).toBe(404);
    const r = await post('/dispatch/projects/create', { name: '' }, c);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_payload');
  });

  it('logs unexpected 500s', async () => {
    const a2 = buildApp({ db, hosts: [HOST] });
    a2.get('/api/boom/:token', async () => { throw new Error('kaboom'); });
    await a2.ready();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await a2.inject({ method: 'GET', url: '/api/boom/SECRET-TOKEN-123?x=SECRET-Q', headers: hdr() });
    expect(r.statusCode).toBe(500);
    expect(err).toHaveBeenCalled();
    const logged = err.mock.calls.flat().map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    expect(logged).toContain('kaboom');
    expect(logged).toContain('/api/boom/:token');
    expect(logged).not.toContain('SECRET');
    err.mockRestore();
    await a2.close();
  });
});

// ---- live ----
describe('live', () => {
  let port: number;
  const socks: WebSocket[] = [];
  afterEach(() => {
    for (const s of socks.splice(0)) s.terminate();
  });

  type Client = { ws: WebSocket; frames: any[]; closed: Promise<number> };
  async function connect(cookie: string, host = HOST): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/push`, { headers: { Host: host, Cookie: cookie, Origin: `http://${host}` } });
    socks.push(ws);
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); ws.on('close', () => res()); });
    return { ws, frames, closed };
  }
  const until = async (fn: () => boolean, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 10));
    return fn();
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const eventsOf = (c: Client) => c.frames.filter((f) => f.type === 'events').flatMap((f) => f.events);

  beforeEach(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  it('first frame is uuid', async () => {
    await post('/api/setup', SETUP);
    const c = await connect(cookieOf(await post('/api/login', { email: 'o@x.io', password: 'pw-owner' })));
    expect(await until(() => c.frames.length > 0)).toBe(true);
    expect(c.frames[0].type).toBe('uuid');
    expect(typeof c.frames[0].payload).toBe('string');
  });

  it('rejects unauthenticated, foreign Host and foreign Origin sockets', async () => {
    await post('/api/setup', SETUP);
    const cookie = cookieOf(await post('/api/login', { email: 'o@x.io', password: 'pw-owner' }));
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/push`, { headers: { Host: 'evil.example', Cookie: cookie } });
    socks.push(bad);
    expect(await new Promise((res) => { bad.on('unexpected-response', (_q, r) => res(r.statusCode)); bad.on('error', () => {}); })).toBe(421);
    const xo = new WebSocket(`ws://127.0.0.1:${port}/api/push`, { headers: { Host: HOST, Cookie: cookie, Origin: 'http://evil.example' } });
    socks.push(xo);
    expect(await new Promise((res) => { xo.on('unexpected-response', (_q, r) => res(r.statusCode)); xo.on('error', () => {}); })).toBe(403);
    const anon = await connect('');
    expect(await anon.closed).toBe(4401);
  });

  it('live filters by access', async () => {
    const w = await world();
    const admin = await connect(ownerCookie);
    const member = await connect(w.member);
    await until(() => admin.frames.length > 0 && member.frames.length > 0);
    await dispatchOk('cards/create', { content: 'hidden', deckId: w.secretDeck }, ownerCookie);
    expect(await until(() => eventsOf(admin).some((e) => e.model === 'card'), 1000)).toBe(true);
    await sleep(300);
    expect(eventsOf(member).filter((e) => e.model === 'card' || e.model === 'deck')).toEqual([]);
    // open project events do reach the member
    await dispatchOk('cards/create', { content: 'shown', deckId: w.openDeck }, ownerCookie);
    expect(await until(() => eventsOf(member).some((e) => e.model === 'card'), 1000)).toBe(true);
  });

  it('personal tags private', async () => {
    const w = await world();
    const mId = (await dispatchOk('cards/create', { content: 'shared', deckId: w.openDeck }, ownerCookie)).id as string;
    const admin = await connect(ownerCookie);
    const member = await connect(w.member);
    await until(() => admin.frames.length > 0 && member.frames.length > 0);
    await dispatchOk('users/setCardTags', { cardId: mId, tags: ['mine'] }, ownerCookie);
    expect(await until(() => eventsOf(admin).some((e) => e.model === 'userCardTag'), 1000)).toBe(true);
    await sleep(300);
    expect(eventsOf(member).filter((e) => e.model === 'userCardTag')).toEqual([]);
    const a = (await get('/api/snapshot', ownerCookie)).json();
    const m = (await get('/api/snapshot', w.member)).json();
    expect(a.userCardTags).toEqual([expect.objectContaining({ cardId: mId, tag: 'mine' })]);
    expect(m.userCardTags).toEqual([]);
    expect(JSON.stringify(m)).not.toContain('mine');
  });

  it('deps and files scoped', async () => {
    const w = await world();
    await dispatchOk('accounts/update', { settings: { dependenciesEnabled: true } }, ownerCookie);
    const mk = async (deckId: string) => (await dispatchOk('cards/create', { content: 'c', deckId }, ownerCookie)).id as string;
    const s1 = await mk(w.secretDeck), s2 = await mk(w.secretDeck), o1 = await mk(w.openDeck), o2 = await mk(w.openDeck);
    const member = await connect(w.member);
    await until(() => member.frames.length > 0);
    await dispatchOk('cards/update', { id: s1, inDeps: [s2] }, ownerCookie);
    await dispatchOk('cards/update', { id: o1, inDeps: [o2] }, ownerCookie);
    const up = (id: string) => app.inject({ method: 'POST', url: `/api/cards/${id}/files?name=a.txt`, payload: 'hi', headers: { host: HOST, cookie: ownerCookie, 'content-type': 'text/plain' } });
    expect((await up(s1)).statusCode).toBe(200);
    const of = (await up(o1)).json().id as string;
    expect(await until(() => eventsOf(member).some((e) => e.model === 'cardDep'), 1000)).toBe(true);
    expect(await until(() => eventsOf(member).some((e) => e.model === 'file'), 1000)).toBe(true);
    await sleep(200);
    const ev = eventsOf(member);
    expect(ev.filter((e) => e.model === 'cardDep').map((e) => e.row.lockedCardId)).toEqual([o1]);
    expect(ev.filter((e) => e.model === 'file').map((e) => e.row.cardId)).toEqual([o1]);
    const m = (await get('/api/snapshot', w.member)).json();
    expect(m.cardDeps).toEqual([{ lockedCardId: o1, lockingCardId: o2 }]);
    expect(m.files.map((f: any) => f.id)).toEqual([of]);
    const a = (await get('/api/snapshot', ownerCookie)).json();
    expect(a.cardDeps).toHaveLength(2);
    expect(a.files).toHaveLength(2);
  });

  it('snapshot carries presets for everyone', async () => {
    const w = await world();
    await dispatchOk('presets/create', { name: 'P1', data: {} }, ownerCookie);
    for (const c of [ownerCookie, w.member, w.observer]) expect((await get('/api/snapshot', c)).json().presets).toHaveLength(1);
  });

  it('limited -> full: members get an access signal and the reloaded snapshot has the lists', async () => {
    const w = await world();
    await dispatchOk('cards/create', { content: 'sc', deckId: w.secretDeck }, ownerCookie);
    const member = await connect(w.member);
    await until(() => member.frames.length > 0);
    await dispatchOk('projects/update', { id: w.secret, visibility: 'full' }, ownerCookie);
    expect(await until(() => eventsOf(member).some((e) => e.model === 'project' && e.op === 'access'))).toBe(true);
    expect(eventsOf(member).find((e) => e.op === 'access').row).toEqual({ id: w.secret });
    const snap = (await get('/api/snapshot', w.member)).json();
    expect(snap.decks.map((d: any) => d.id)).toContain(w.secretDeck);
    expect(snap.cards.some((c: any) => c.content === 'sc')).toBe(true);
  });

  it('full -> limited: members without access get the signal and lose the project', async () => {
    const w = await world();
    const member = await connect(w.member);
    const observer = await connect(w.observer);
    await until(() => member.frames.length > 0 && observer.frames.length > 0);
    await dispatchOk('projects/update', { id: w.open, visibility: 'limited' }, ownerCookie);
    expect(await until(() => eventsOf(member).some((e) => e.model === 'project' && e.op === 'access'))).toBe(true);
    expect(eventsOf(member).find((e) => e.op === 'access').row).toEqual({ id: w.open });
    // the signal carries only the id; the full row never reaches people who lost access
    expect(eventsOf(member).filter((e) => e.model === 'project' && e.op === 'upsert')).toEqual([]);
    const snap = (await get('/api/snapshot', w.member)).json();
    expect(snap.projects.map((p: any) => p.id)).not.toContain(w.open);
    // a rename alone sends no access signal
    const before = eventsOf(observer).length;
    await dispatchOk('projects/update', { id: w.secret, name: 'S2' }, ownerCookie);
    await sleep(200);
    expect(eventsOf(observer).slice(before).filter((e) => e.op === 'access')).toEqual([]);
  });

  it('projectPref events only reach their owner; account events reach everyone', async () => {
    const w = await world();
    const admin = await connect(ownerCookie);
    const member = await connect(w.member);
    await until(() => admin.frames.length > 0 && member.frames.length > 0);
    await dispatchOk('missionControl/setVisible', { projectId: w.open, visible: false }, w.member);
    expect(await until(() => eventsOf(member).some((e) => e.model === 'projectPref'))).toBe(true);
    await sleep(200);
    expect(eventsOf(admin).some((e) => e.model === 'projectPref')).toBe(false);
    await dispatchOk('accounts/update', { name: 'Renamed' }, ownerCookie);
    expect(await until(() => eventsOf(admin).some((e) => e.model === 'account') && eventsOf(member).some((e) => e.model === 'account'))).toBe(true);
  });

  it('accepting an invite announces the new person to everyone', async () => {
    const w = await world();
    const admin = await connect(ownerCookie);
    await until(() => admin.frames.length > 0);
    const { token } = await dispatchOk('invites/create', { role: 'observer', projectIds: [w.open] }, ownerCookie);
    expect((await post(`/api/invites/${token}/accept`, { name: 'Neo', email: 'neo@x.io', password: 'pw-neo-pw' })).statusCode).toBe(200);
    expect(await until(() => eventsOf(admin).some((e) => e.model === 'user' && e.row.email === 'neo@x.io'))).toBe(true);
    const ev = eventsOf(admin);
    expect(ev.some((e) => e.model === 'accountRole' && e.row.role === 'observer')).toBe(true);
    expect(ev.some((e) => e.model === 'projectAccess' && e.row.projectId === w.open)).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/password/i);
  });

  it('disabled user socket closed', async () => {
    const w = await world();
    const member = await connect(w.member);
    await until(() => member.frames.length > 0);
    await dispatchOk('users/disable', { userId: w.memberId, disabled: true }, ownerCookie);
    const code = await Promise.race([member.closed, sleep(1000).then(() => -1)]);
    expect(code).toBe(4001);
  });

  it('resolvable, entry and hand events for a secret card skip the member', async () => {
    const w = await world();
    const admin = await connect(ownerCookie);
    const member = await connect(w.member);
    await until(() => admin.frames.length > 0 && member.frames.length > 0);
    const sc = await dispatchOk('cards/create', { content: 's', deckId: w.secretDeck }, ownerCookie);
    await dispatchOk('cards/bulkUpdate', { ids: [sc.id], status: 'started' }, ownerCookie);
    await dispatchOk('resolvables/create', { cardId: sc.id, context: 'block', content: 'x' }, ownerCookie);
    const models = ['resolvable', 'resolvableEntry', 'handCard'];
    expect(await until(() => models.every((m) => eventsOf(admin).some((e) => e.model === m)))).toBe(true);
    await sleep(300);
    expect(eventsOf(member).filter((e) => e.model !== 'user' && e.model !== 'accountRole' && e.model !== 'account')).toEqual([]);
  });

  it('deckless task: creator and admin see it, other member does not', async () => {
    const w = await world();
    const otherId = mkUser('member', 'm2@x.io');
    expect(otherId).toBeTruthy();
    const other = await loginAs('m2@x.io');
    const id = newId();
    db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,created_at,last_updated_at) VALUES (?,?,NULL,?,'loose',0,0)").run(id, 999, w.memberId);
    const admin = await connect(ownerCookie);
    const creator = await connect(w.member);
    const stranger = await connect(other);
    await until(() => [admin, creator, stranger].every((c) => c.frames.length > 0));
    const row = { id, seq: 999, deckId: null, creatorId: w.memberId, content: 'loose' };
    app.hub.publish('a1', [{ model: 'card', op: 'upsert', row }]);
    expect(await until(() => eventsOf(admin).length > 0 && eventsOf(creator).length > 0)).toBe(true);
    await sleep(300);
    expect(eventsOf(stranger)).toEqual([]);
    for (const [c, seen] of [[ownerCookie, true], [w.member, true], [other, false]] as const) {
      const cards = (await get('/api/snapshot', c)).json().cards.map((x: any) => x.id);
      expect(cards.includes(id)).toBe(seen);
    }
  });

  it('logout closes the socket', async () => {
    const w = await world();
    const member = await connect(w.member);
    await until(() => member.frames.length > 0);
    await post('/api/logout', {}, w.member);
    expect(await Promise.race([member.closed, sleep(1000).then(() => -1)])).toBe(4401);
  });

  it('expired session socket is closed on the next publish', async () => {
    const w = await world();
    const member = await connect(w.member);
    const admin = await connect(ownerCookie);
    await until(() => member.frames.length > 0 && admin.frames.length > 0);
    db.prepare('UPDATE sessions SET expires_at=1 WHERE user_id=?').run(w.memberId);
    await dispatchOk('projects/create', { name: 'Another' }, ownerCookie);
    expect(await Promise.race([member.closed, sleep(1000).then(() => -1)])).toBe(4401);
    expect(await until(() => eventsOf(admin).some((e) => e.model === 'project'))).toBe(true);
  });

  it('a throwing publish does not fail a committed write', async () => {
    await post('/api/setup', SETUP);
    const c = cookieOf(await post('/api/login', { email: 'o@x.io', password: 'pw-owner' }));
    const spy = vi.spyOn(app.hub, 'publish').mockImplementation(() => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post('/dispatch/projects/create', { name: 'Kept' }, c);
    expect(r.statusCode).toBe(200);
    expect(r.json().payload.id).toBeTruthy();
    expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE name='Kept'").get() as any).c).toBe(1);
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });

  it('caps sockets at 200 with close code 1013', async () => {
    await post('/api/setup', SETUP);
    const { LiveHub, MAX_SOCKETS } = await import('../server/live');
    const hub = new LiveHub(db);
    let closedWith = 0;
    const mk = () => ({ send() {}, close(c?: number) { closedWith = c ?? 0; } });
    for (let i = 0; i < MAX_SOCKETS; i++) expect(hub.add(mk(), { id: 'u' })).toBe(true);
    expect(hub.add(mk(), { id: 'u' })).toBe(false);
    expect(closedWith).toBe(1013);
    expect(hub.size).toBe(MAX_SOCKETS);
  });
});

describe('content security policy', () => {
  it('is sent with the app page and static files, not with API responses', async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const base = join(process.env.HOME ?? '.', '.cache/gametracker/scratch');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, 'csp-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
    const web = buildApp({ db: openDb(':memory:'), hosts: [HOST], webRoot: root });
    try {
      await web.ready();
      const page = await web.inject({ method: 'GET', url: '/', headers: { host: HOST } });
      expect(page.statusCode).toBe(200);
      const csp = page.headers['content-security-policy'];
      expect(csp).toBe(CSP);
      for (const part of ["default-src 'self'", "img-src 'self' data: blob:", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
        expect(csp).toContain(part);
      }
      const spa = await web.inject({ method: 'GET', url: '/decks/1-x', headers: { host: HOST } });
      expect(spa.headers['content-security-policy']).toBe(CSP);
      const status = await web.inject({ method: 'GET', url: '/api/status', headers: { host: HOST } });
      expect(status.headers['content-security-policy']).toBeUndefined();
    } finally {
      await web.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

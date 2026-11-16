import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { cardCode } from '../shared/cards';
import { seatsInUse } from '../server/billing';
import { TOKEN_DENIED_NAMESPACES } from '../server/tokens';
import { GUEST_NAMESPACES } from '../server/dispatch';
import { LiveHub } from '../server/live';
import { runJob, runOpenDeckDigest, runOpenDeckUpdates, runOpenSignupPurge } from '../server/jobs';
import { EMAIL_KINDS, sendPendingEmails } from '../server/email';
import { OPEN_LIMITS, SIGNUP_EMAILS_PER_DAY, validUrlName } from '../server/open';

const HOST = 'localhost:8780';
const json = { host: HOST, 'content-type': 'application/json' };
let db: Db;
let app: ReturnType<typeof buildApp>;
let filesDir = '';
let owner = '';
let ownerId = '';
let projectId = '';
let deckId = '';
let deckSeq = 0;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return c ? `jt_session=${c.value}` : ''; };
const send = (cmd: string, payload: unknown, cookie = owner, ip?: string) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any, headers: { ...json, ...(cookie ? { cookie } : {}) }, ...(ip ? { remoteAddress: ip } : {}),
});
const ok = async (cmd: string, payload: unknown, cookie = owner) => {
  const r = await send(cmd, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const get = (url: string, cookie = '', ip?: string) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}) }, ...(ip ? { remoteAddress: ip } : {}) });
async function mkUser(role: string, name: string): Promise<{ id: string; email: string; cookie: string }> {
  const id = newId();
  const email = `${name.toLowerCase()}@secret.example`;
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, name, hashPassword('pw-user'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'pw-user' }, headers: json });
  return { id, email, cookie: cookieOf(r) };
}
const card = async (content: string, extra: Record<string, unknown> = {}, deck = deckId) => {
  const r = await ok('cards/create', { content, deckId: deck, ...extra });
  return { id: r.id as string, code: cardCode(r.accountSeq as number) };
};
const share = (extra: Record<string, unknown> = {}, pid = projectId) =>
  ok('openDecks/update', { projectId: pid, enabled: true, urlName: 'hollow-keep', displayName: 'Hollow Keep', ...extra });
const signUpRaw = (email: string, name = 'Visitor', ip = '10.0.0.1', password = 'guest-password') =>
  app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email, password, name, urlName: 'hollow-keep' }, headers: json, remoteAddress: ip });
const confirmTokenFor = (email: string) => {
  const m = (db.prepare("SELECT text FROM email_outbox WHERE kind='openDeckConfirm' AND to_addr=? ORDER BY id DESC").get(email) as { text: string } | undefined);
  return m ? /\/open\/confirm\/([A-Za-z0-9_-]+)/.exec(m.text)![1] : null;
};
const confirm = (token: string) => app.inject({ method: 'POST', url: '/api/open/confirm', payload: { token }, headers: json });
/** Signs a visitor up the whole way: the form, the emailed link, then signing in. */
async function signUp(name: string, ip = '10.0.0.1') {
  const email = `${name}@guest.example`;
  const r = await signUpRaw(email, name, ip);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toEqual({ pending: true });
  const c = await confirm(confirmTokenFor(email)!);
  expect(c.statusCode, c.body).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'guest-password' }, headers: json });
  return { cookie: cookieOf(login), id: (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id };
}
const job = (fn: (ctx: any, now: number) => void, now: number) => runJob(db, new LiveHub(db), (ctx) => fn(ctx, now));
const outbox = () => db.prepare('SELECT * FROM email_outbox ORDER BY id').all() as any[];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
const uploadCover = async (pid = projectId) => {
  const r = await app.inject({ method: 'POST', url: `/api/covers?projectId=${pid}`, payload: PNG, headers: { host: HOST, cookie: owner, 'content-type': 'image/png' } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
};

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  filesDir = mkdtempSync(join(base, 'open-decks-'));
  app = buildApp({ db, hosts: [HOST], filesDir, email: { publicUrl: 'http://tracker.test', secret: 'test-secret-for-open-decks' } });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann Owner', email: 'owner@secret.example', password: 'pw-owner' }, headers: json });
  owner = cookieOf(r);
  ownerId = r.json().user.id;
  projectId = (await ok('projects/create', { name: 'Internal codename' })).id;
  deckId = (await ok('decks/create', { title: 'Roadmap', projectId })).id;
  deckSeq = (db.prepare('SELECT seq FROM decks WHERE id=?').get(deckId) as { seq: number }).seq;
});
afterEach(async () => {
  await app.close();
  rmSync(filesDir, { recursive: true, force: true });
});

describe('public pages', () => {
  it('private project → 404', async () => {
    const c = await card('Secret plan');
    for (const url of ['/api/open/hollow-keep', `/api/open/hollow-keep/decks/${deckSeq}`, `/api/open/hollow-keep/cards/${c.code}`]) {
      expect((await get(url)).statusCode).toBe(404);
    }
    // Shared, then switched off: the same 404, and the gallery lists nothing.
    await share({ listed: true });
    expect((await get('/api/open/hollow-keep')).statusCode).toBe(200);
    await ok('openDecks/update', { projectId, enabled: false });
    for (const url of ['/api/open/hollow-keep', `/api/open/hollow-keep/decks/${deckSeq}`, `/api/open/hollow-keep/cards/${c.code}`]) {
      expect((await get(url)).statusCode).toBe(404);
    }
    expect((await get('/api/open/gallery')).json().projects).toEqual([]);
    // An archived project is not public either.
    await ok('openDecks/update', { projectId, enabled: true });
    await ok('projects/update', { id: projectId, isArchived: true });
    expect((await get('/api/open/hollow-keep')).statusCode).toBe(404);
    expect((await get(`/api/open/hollow-keep/cards/${c.code}`)).statusCode).toBe(404);
    // A card of another, private project is never reachable through a public project's address.
    await ok('projects/update', { id: projectId, isArchived: false });
    const other = (await ok('projects/create', { name: 'Other' })).id;
    const otherDeck = (await ok('decks/create', { title: 'Hidden list', projectId: other })).id;
    const hidden = await card('Other secret', {}, otherDeck);
    const otherSeq = (db.prepare('SELECT seq FROM decks WHERE id=?').get(otherDeck) as { seq: number }).seq;
    expect((await get(`/api/open/hollow-keep/cards/${hidden.code}`)).statusCode).toBe(404);
    expect((await get(`/api/open/hollow-keep/decks/${otherSeq}`)).statusCode).toBe(404);
    expect((await get('/api/open/hollow-keep/cards/not-a-code')).statusCode).toBe(404);
  });

  it('public project shows lists/tasks without emails; archived/deleted tasks hidden', async () => {
    const dev = await mkUser('member', 'Dana Dev');
    const live = await card('Grappling hook\nIt swings.', { assigneeId: dev.id, priority: 'a', effort: 3, masterTags: [] });
    const archived = await card('Archived idea');
    const deleted = await card('Deleted idea');
    await ok('cards/update', { id: archived.id, visibility: 'archived' });
    await ok('cards/update', { id: deleted.id, visibility: 'deleted' });
    const doc = await card('Read me first', { isDoc: true });
    await share({ welcome: 'Welcome, travellers!' });

    const p = await get('/api/open/hollow-keep');
    expect(p.statusCode).toBe(200);
    expect(p.json().project).toMatchObject({ urlName: 'hollow-keep', displayName: 'Hollow Keep', welcome: 'Welcome, travellers!' });
    expect(p.json().project.decks).toEqual([{ seq: deckSeq, title: 'Roadmap', cardCount: 2 }]);
    expect(p.json().viewer).toBeNull();

    const d = await get(`/api/open/hollow-keep/decks/${deckSeq}`);
    expect(d.statusCode).toBe(200);
    const titles = d.json().deck.cards.map((c: any) => c.title);
    expect(titles).toContain('Grappling hook');
    expect(titles).toContain('Read me first');
    expect(titles).not.toContain('Archived idea');
    expect(titles).not.toContain('Deleted idea');
    const tile = d.json().deck.cards.find((c: any) => c.title === 'Grappling hook');
    // Exactly the allowed fields.
    expect(Object.keys(tile).sort()).toEqual(['code', 'deckSeq', 'effort', 'id', 'isDoc', 'priority', 'status', 'tags', 'title', 'upvoted', 'upvotes'].sort());
    expect(tile).toMatchObject({ code: live.code, priority: 'a', effort: 3, status: 'notStarted', upvotes: 0, deckSeq });

    const c = await get(`/api/open/hollow-keep/cards/${live.code}`);
    expect(c.statusCode).toBe(200);
    expect(c.json().card).toMatchObject({ title: 'Grappling hook', owner: 'Dana Dev', deckSeq, deckTitle: 'Roadmap' });
    expect(c.json().card.content).toContain('It swings.');
    expect(c.json().card.comments).toBeUndefined();
    expect((await get(`/api/open/hollow-keep/cards/${archived.code}`)).statusCode).toBe(404);
    expect((await get(`/api/open/hollow-keep/cards/${deleted.code}`)).statusCode).toBe(404);
    expect((await get(`/api/open/hollow-keep/cards/${doc.code}`)).statusCode).toBe(200);

    for (const body of [p.body, d.body, c.body]) {
      expect(body).not.toMatch(/@secret\.example/);
      expect(body).not.toMatch(/password|passwordHash|creatorId|assigneeId|Internal codename|projectId/);
      expect(body).not.toContain(dev.id);
      expect(body).not.toContain(ownerId);
    }
  });

  it('comments hidden unless show_comments', async () => {
    const c = await card('Milestone');
    await ok('resolvables/create', { cardId: c.id, context: 'comment', content: 'Love this one' });
    await ok('resolvables/create', { cardId: c.id, context: 'block', content: 'Blocked by the internal art budget' });
    await share();
    const off = await get(`/api/open/hollow-keep/cards/${c.code}`);
    expect(off.json().card.comments).toBeUndefined();
    expect(off.body).not.toContain('Love this one');
    expect(off.body).not.toContain('art budget');

    await ok('openDecks/update', { projectId, showComments: true });
    const on = await get(`/api/open/hollow-keep/cards/${c.code}`);
    expect(on.json().card.comments).toEqual([{ author: 'Ann Owner', content: 'Love this one', createdAt: expect.any(Number) }]);
    expect(on.body).not.toContain('art budget');
    expect(on.body).not.toMatch(/@secret\.example/);
  });

  it('list order follows the "default for visitors" order', async () => {
    await card('Low', { priority: 'c' });
    await card('High', { priority: 'a' });
    await card('Mid', { priority: 'b' });
    await share();
    await ok('decks/update', { id: deckId, publicOrder: { prop: 'priority', isReversed: false, mode: 'miniCard', secondary: null } });
    const d = await get(`/api/open/hollow-keep/decks/${deckSeq}`);
    expect(d.json().deck.cards.map((x: any) => x.title)).toEqual(['High', 'Mid', 'Low']);
    await ok('decks/update', { id: deckId, publicOrder: { prop: 'priority', isReversed: true, mode: 'miniCard', secondary: null } });
    expect((await get(`/api/open/hollow-keep/decks/${deckSeq}`)).json().deck.cards.map((x: any) => x.title)).toEqual(['Low', 'Mid', 'High']);
    // Only project managers set it.
    const m = await mkUser('member', 'Mo');
    expect((await send('decks/update', { id: deckId, publicOrder: null }, m.cookie)).statusCode).toBe(403);
  });

  it('gallery lists only listed public projects, with no private fields', async () => {
    await share({ listed: false });
    expect((await get('/api/open/gallery')).json().projects).toEqual([]);
    await ok('openDecks/update', { projectId, listed: true, welcome: 'Hi' });
    const g = await get('/api/open/gallery');
    expect(g.json().projects).toEqual([{ urlName: 'hollow-keep', displayName: 'Hollow Keep', welcome: 'Hi', promoUrl: null, deckCount: 1, cardCount: 0 }]);
    expect(g.body).not.toMatch(/@secret\.example|Internal codename/);
  });

  it('banner and promo images: public only while referenced by an enabled open list', async () => {
    const banner = await uploadCover();
    const unrelated = await uploadCover();
    await share({ bannerFileId: banner, listed: true });
    const p = await get('/api/open/hollow-keep');
    expect(p.json().project.bannerUrl).toBe(`/api/open/hollow-keep/images/${banner}`);
    const img = await get(`/api/open/hollow-keep/images/${banner}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(`/api/open/hollow-keep/images/${unrelated}`)).statusCode).toBe(404);
    // The normal cover route still needs a session.
    expect((await get(`/api/covers/${banner}`)).statusCode).toBe(401);
    // A cover of another project can't be picked.
    const other = (await ok('projects/create', { name: 'Other' })).id;
    const foreign = await uploadCover(other);
    expect((await send('openDecks/update', { projectId, promoFileId: foreign })).statusCode).toBe(400);
    await ok('openDecks/update', { projectId, enabled: false });
    expect((await get(`/api/open/hollow-keep/images/${banner}`)).statusCode).toBe(404);
  });
});

describe('settings', () => {
  it('url_name unique and slug-safe', async () => {
    for (const bad of ['ab', 'a'.repeat(41), 'Hollow-Keep', 'hollow keep', '-hollow', 'hollow-', 'höllow', 'api', 'gallery', 'confirm', '../x']) {
      expect(validUrlName(bad), bad).toBe(false);
      const r = await send('openDecks/update', { projectId, enabled: true, urlName: bad, displayName: 'X' });
      expect(r.statusCode, bad).toBe(400);
    }
    expect(validUrlName('hollow-keep-2')).toBe(true);
    await share();
    const other = (await ok('projects/create', { name: 'Other' })).id;
    const dup = await send('openDecks/update', { projectId: other, enabled: true, urlName: 'hollow-keep', displayName: 'X' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('url_taken');
    // First switch-on needs a URL name.
    expect((await send('openDecks/update', { projectId: other, enabled: true })).statusCode).toBe(400);
  });

  it('needs project manage rights; members read the settings of projects they see', async () => {
    const m = await mkUser('member', 'Mo');
    expect((await send('openDecks/update', { projectId, enabled: true, urlName: 'hollow-keep', displayName: 'X' }, m.cookie)).statusCode).toBe(403);
    await share();
    const r = await get('/api/open-decks', m.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.json().openDecks).toEqual([expect.objectContaining({ projectId, enabled: true, urlName: 'hollow-keep', upvoting: true, showComments: false, listed: false })]);
    expect((await get('/api/open-decks')).statusCode).toBe(401);
  });

  it('open and openDecks are token-denied; guests may dispatch only open', () => {
    expect(TOKEN_DENIED_NAMESPACES.has('open')).toBe(true);
    expect(TOKEN_DENIED_NAMESPACES.has('openDecks')).toBe(true);
    expect([...GUEST_NAMESPACES]).toEqual(['open']);
    expect(EMAIL_KINDS).toHaveProperty('openDeckUpdates');
    expect(EMAIL_KINDS).toHaveProperty('openDeckDigest');
  });
});

describe('guests', () => {
  it('guest upvote counts once; upvoting off → 403', async () => {
    const c = await card('Co-op mode');
    await share();
    const g = await signUp('gina');
    expect(seatsInUse(db)).toBe(1);
    await ok('open/upvote', { cardId: c.id }, g.cookie);
    await ok('open/upvote', { cardId: c.id }, g.cookie);
    let tile = (await get(`/api/open/hollow-keep/cards/${c.code}`, g.cookie)).json().card;
    expect(tile).toMatchObject({ upvotes: 1, upvoted: true });
    // A team member upvotes from the app too.
    await ok('open/upvote', { cardId: c.id });
    expect((await get(`/api/cards/${c.id}/upvotes`, owner)).json()).toEqual({ count: 2, mine: true });
    await ok('open/unvote', { cardId: c.id }, g.cookie);
    tile = (await get(`/api/open/hollow-keep/cards/${c.code}`, g.cookie)).json().card;
    expect(tile).toMatchObject({ upvotes: 1, upvoted: false });

    await ok('openDecks/update', { projectId, upvoting: false });
    const off = await send('open/upvote', { cardId: c.id }, g.cookie);
    expect(off.statusCode).toBe(403);
    expect(off.json().error).toBe('upvoting_off');
    expect((await send('open/upvote', { cardId: c.id })).statusCode).toBe(403);

    // A card outside any public project is not found for a guest.
    const other = (await ok('projects/create', { name: 'Other' })).id;
    const otherDeck = (await ok('decks/create', { title: 'X', projectId: other })).id;
    const hidden = await card('Hidden', {}, otherDeck);
    expect((await send('open/upvote', { cardId: hidden.id }, g.cookie)).statusCode).toBe(404);
    // Anonymous visitors can't vote.
    expect((await send('open/upvote', { cardId: c.id }, '')).statusCode).toBe(401);
  });

  it("guest can't call the snapshot", async () => {
    await share();
    const g = await signUp('gus');
    expect((await get('/api/snapshot', g.cookie)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/query', payload: { query: {} }, headers: { ...json, cookie: g.cookie } })).statusCode).toBe(403);
    expect((await send('cards/create', { content: 'x', deckId }, g.cookie)).statusCode).toBe(403);
    expect((await send('openDecks/update', { projectId, upvoting: false }, g.cookie)).statusCode).toBe(403);
    expect((await get('/api/open-decks', g.cookie)).statusCode).toBe(403);
    expect((await get('/api/open-stats', g.cookie)).statusCode).toBe(403);
    // The public page knows who is visiting.
    expect((await get('/api/open/hollow-keep', g.cookie)).json().viewer).toEqual({ name: 'gus', guest: true, subscription: null });
  });

  it('sign-up: validated, the same answer for every address, rate limited per IP', async () => {
    // Nothing is public yet: nothing to join.
    expect((await signUpRaw('early@guest.example', 'E', '10.8.8.8')).statusCode).toBe(404);
    await share();
    expect((await signUpRaw('nope')).statusCode).toBe(400);
    expect((await signUpRaw('a@guest.example', 'N', '10.0.0.1', 'short')).statusCode).toBe(400);
    // An address with an account: the same answer, a notice to that address, no change.
    const before = db.prepare("SELECT password_hash FROM users WHERE email='owner@secret.example'").get();
    const taken = await signUpRaw('owner@secret.example', 'Mallory');
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toEqual({ pending: true });
    expect(db.prepare("SELECT password_hash FROM users WHERE email='owner@secret.example'").get()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM open_signups WHERE email='owner@secret.example'").get()).toBeUndefined();
    const notices = () => outbox().filter((m) => m.kind === 'openDeckNotice');
    expect(notices().map((m) => m.to_addr)).toEqual(['owner@secret.example']);
    expect(notices()[0].text).not.toContain('Mallory');
    // At most one notice per address a day.
    await signUpRaw('owner@secret.example', 'Mallory');
    expect(notices()).toHaveLength(1);
    // Per-IP limit.
    for (let i = 0; i < OPEN_LIMITS.signUpsPerHour; i++) expect((await signUpRaw(`g${i}@guest.example`, 'G', '10.9.9.9')).statusCode).toBe(200);
    expect((await signUpRaw('late@guest.example', 'L', '10.9.9.9')).statusCode).toBe(429);
    expect((await signUpRaw('elsewhere@guest.example', 'E', '10.9.9.10')).statusCode).toBe(200);
  });

  it('no account until the emailed link is used; links are single-use, expire after 24 h and are purged', async () => {
    await share();
    const r = await signUpRaw('sam@guest.example', 'EVIL http://spam.example', '10.0.0.1');
    expect(r.json()).toEqual({ pending: true });
    expect(db.prepare("SELECT 1 FROM users WHERE email='sam@guest.example'").get()).toBeUndefined();
    const mail = outbox().find((m) => m.kind === 'openDeckConfirm')!;
    // Fixed text: nothing the visitor typed.
    expect(mail.subject + mail.text + mail.html).not.toContain('spam.example');
    expect(mail.subject + mail.text + mail.html).not.toContain('EVIL');
    const token = confirmTokenFor('sam@guest.example')!;
    // Signing up again while it is pending: no second email, and the pending password can't be swapped.
    await signUpRaw('sam@guest.example', 'Sam', '10.0.0.2', 'attacker-password');
    expect(outbox().filter((m) => m.kind === 'openDeckConfirm')).toHaveLength(1);
    expect((await confirm('wrong')).statusCode).toBe(400);
    const ok1 = await confirm(token);
    expect(ok1.json()).toEqual({ ok: true, urlName: 'hollow-keep' });
    expect((db.prepare("SELECT r.role FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.email='sam@guest.example'").get() as { role: string }).role).toBe('guest');
    expect((await confirm(token)).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'sam@guest.example', password: 'attacker-password' }, headers: json })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'sam@guest.example', password: 'guest-password' }, headers: json })).statusCode).toBe(200);

    // Expired links fail and the job purges them.
    await signUpRaw('late@guest.example', 'Late', '10.0.0.3');
    const late = confirmTokenFor('late@guest.example')!;
    db.prepare("UPDATE open_signups SET expires_at=? WHERE email='late@guest.example'").run(Date.now() - 1);
    expect((await confirm(late)).statusCode).toBe(400);
    await signUpRaw('later@guest.example', 'Later', '10.0.0.3');
    db.prepare("UPDATE open_signups SET expires_at=1 WHERE email='later@guest.example'").run();
    job(runOpenSignupPurge, Date.now());
    expect(db.prepare('SELECT COUNT(*) n FROM open_signups').get()).toEqual({ n: 0 });
  });

  it('a pending sign-up never blocks an invite', async () => {
    await share();
    await signUpRaw('newhire@company.example', 'Squatter', '10.0.0.4');
    const token = confirmTokenFor('newhire@company.example')!;
    const link = (await ok('invites/create', { role: 'member', projectIds: [] })).token as string;
    const acc = await app.inject({ method: 'POST', url: `/api/invites/${link}/accept`, payload: { name: 'New Hire', email: 'newhire@company.example', password: 'pw-newhire' }, headers: json });
    expect(acc.statusCode, acc.body).toBe(200);
    // The squatter's link is dead now, and the pending row is gone.
    expect((await confirm(token)).statusCode).toBe(400);
    expect(db.prepare("SELECT 1 FROM open_signups WHERE email='newhire@company.example'").get()).toBeUndefined();
    expect((db.prepare("SELECT r.role FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.email='newhire@company.example'").get() as { role: string }).role).toBe('member');
  });

  it('a hostile or non-public urlName never reaches an email', async () => {
    await share();
    const hostile = ['evil.example/x', '//evil.example', 'a b', '../../x', 'https:', 'API', 'x'.repeat(41)];
    for (const [i, u] of hostile.entries()) {
      const r = await app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email: 'owner@secret.example', password: 'guest-password', name: 'N', urlName: u }, headers: json, remoteAddress: `10.7.6.${i}` });
      expect(r.statusCode, u).toBe(400);
    }
    // A valid slug that is not a public project: the notice links to the gallery, not to it.
    const other = (await ok('projects/create', { name: 'Other' })).id;
    await ok('openDecks/update', { projectId: other, enabled: false, urlName: 'secret-thing', displayName: 'S' });
    await app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email: 'owner@secret.example', password: 'guest-password', name: 'N', urlName: 'secret-thing' }, headers: json, remoteAddress: '10.7.7.8' });
    const notice = outbox().find((m) => m.kind === 'openDeckNotice');
    expect(notice.text).toContain('Sign in: http://tracker.test/open\n');
    expect(notice.text + notice.html).not.toContain('secret-thing');
    await app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email: 'fresh@guest.example', password: 'guest-password', name: 'N', urlName: 'secret-thing' }, headers: json, remoteAddress: '10.7.7.8' });
    expect(db.prepare("SELECT url_name FROM open_signups WHERE email='fresh@guest.example'").get()).toEqual({ url_name: null });
    for (const m of outbox()) for (const u of hostile) expect(m.text + (m.html ?? ''), u).not.toContain(u);
  });

  it(`at most ${SIGNUP_EMAILS_PER_DAY} sign-up emails a day for the workspace; beyond, the same answer and nothing queued`, async () => {
    await share();
    const ins = db.prepare("INSERT INTO email_outbox (to_addr, subject, text, kind, status, created_at, next_attempt_at) VALUES (?, 's', 't', ?, 'log', ?, ?)");
    for (let i = 0; i < SIGNUP_EMAILS_PER_DAY; i++) ins.run(`x${i}@guest.example`, i % 2 ? 'openDeckConfirm' : 'openDeckNotice', Date.now() - 1000, Date.now());
    const r = await signUpRaw('over@guest.example');
    expect(r.json()).toEqual({ pending: true });
    expect(db.prepare("SELECT 1 FROM open_signups WHERE email='over@guest.example'").get()).toBeUndefined();
    expect(outbox().filter((m) => m.to_addr === 'over@guest.example')).toEqual([]);
    await signUpRaw('owner@secret.example');
    expect(outbox().filter((m) => m.to_addr === 'owner@secret.example')).toEqual([]);
    // A day later there is room again.
    db.prepare('UPDATE email_outbox SET created_at=?').run(Date.now() - 25 * 3600e3);
    await signUpRaw('over@guest.example');
    expect(confirmTokenFor('over@guest.example')).not.toBeNull();
  });

  it('in log mode admins see the confirmation link in the outbox (members do not); other sensitive bodies stay removed', async () => {
    await share();
    await signUpRaw('lan@guest.example', 'Lan');
    await ok('invites/create', { role: 'member', projectIds: [], email: 'invitee@company.example' });
    await sendPendingEmails(db, { transport: 'log', smtp: null, publicUrl: 'http://tracker.test' }, Date.now());
    const st = (await get('/api/email/status', owner)).json();
    const row = st.outbox.find((o: any) => o.kind === 'openDeckConfirm');
    expect(row.link).toMatch(/^http:\/\/tracker\.test\/open\/confirm\/[A-Za-z0-9_-]+$/);
    expect(st.outbox.find((o: any) => o.kind === 'invite').link).toBeUndefined();
    expect(st.outbox.every((o: any) => o.text === undefined)).toBe(true);
    const m = await mkUser('member', 'Mo');
    expect((await get('/api/email/status', m.cookie)).statusCode).toBe(403);
    // The link from the outbox finishes the sign-up.
    expect((await confirm(/confirm\/(.+)$/.exec(row.link)![1])).statusCode).toBe(200);
  });

  it('admins list and remove guests', async () => {
    const c = await card('Thing');
    await share();
    const g = await signUp('gone');
    await ok('open/upvote', { cardId: c.id }, g.cookie);
    const list = await get('/api/guests', owner);
    expect(list.json().guests).toEqual([expect.objectContaining({ id: g.id, name: 'gone', email: 'gone@guest.example', upvotes: 1 })]);
    const m = await mkUser('member', 'Mo');
    expect((await get('/api/guests', m.cookie)).statusCode).toBe(403);
    expect((await send('guests/remove', { userId: g.id }, m.cookie)).statusCode).toBe(403);
    expect((await send('guests/remove', { userId: m.id })).statusCode).toBe(404);
    expect((await send('guests/remove', { userId: g.id }, g.cookie)).statusCode).toBe(403);
    await ok('guests/remove', { userId: g.id });
    expect(db.prepare('SELECT 1 FROM users WHERE id=?').get(g.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM upvotes').get()).toEqual({ n: 0 });
    expect((await get('/api/open/hollow-keep', g.cookie)).json().viewer).toBeNull();
    expect(TOKEN_DENIED_NAMESPACES.has('guests')).toBe(true);
  });

  it('public reads are rate limited per IP', async () => {
    await share();
    for (let i = 0; i < OPEN_LIMITS.readsPerMinute; i++) expect((await get('/api/open/hollow-keep', '', '10.1.1.1')).statusCode).toBe(200);
    const r = await get('/api/open/hollow-keep', '', '10.1.1.1');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get('/api/open/hollow-keep', '', '10.1.1.2')).statusCode).toBe(200);
  });
});

describe('fresh install', () => {
  it('no guest account before the workspace exists', async () => {
    const fresh = openDb(':memory:');
    const a = buildApp({ db: fresh, hosts: [HOST], filesDir });
    const r = await a.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email: 'first@guest.example', password: 'guest-password', name: 'F' }, headers: json });
    expect(r.statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/status', headers: { host: HOST } })).json().setup).toBe(false);
    await a.close();
  });
});

describe('disabled workspace', () => {
  it('disabled workspace → 404', async () => {
    const c = await card('Thing');
    const banner = await uploadCover();
    await share({ listed: true, bannerFileId: banner });
    db.prepare('UPDATE account SET is_disabled=1').run();
    for (const url of ['/api/open/gallery', '/api/open/hollow-keep', `/api/open/hollow-keep/decks/${deckSeq}`, `/api/open/hollow-keep/cards/${c.code}`, `/api/open/hollow-keep/images/${banner}`]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    const g = await app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: { email: 'x@guest.example', password: 'guest-password', name: 'X' }, headers: json });
    expect(g.statusCode).toBe(404);
    expect(db.prepare("SELECT 1 FROM users WHERE email='x@guest.example'").get()).toBeUndefined();
  });
});

describe('stats and emails', () => {
  it('visits are counted once per visitor per day; the Hand widget shows top upvoted and visits this week', async () => {
    const a = await card('Alpha');
    const b = await card('Beta');
    await share();
    await get('/api/open/hollow-keep', '', '10.2.0.1');
    await get('/api/open/hollow-keep', '', '10.2.0.1');
    await get('/api/open/hollow-keep', '', '10.2.0.2');
    const g1 = await signUp('v1');
    const g2 = await signUp('v2');
    for (const g of [g1, g2]) await ok('open/upvote', { cardId: b.id }, g.cookie);
    await ok('open/upvote', { cardId: a.id }, g1.cookie);
    const s = await get('/api/open-stats', owner);
    expect(s.statusCode).toBe(200);
    expect(s.json().visitsThisWeek).toBe(2);
    expect(s.json().top.map((x: any) => [x.title, x.upvotes])).toEqual([['Beta', 2], ['Alpha', 1]]);
    // A member who can't see the project sees nothing of it.
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    const m = await mkUser('member', 'Mo');
    expect((await get('/api/open-stats', m.cookie)).json()).toEqual({ visitsThisWeek: 0, top: [] });
  });

  it('subscribers get daily or weekly update emails with an unsubscribe link; nothing while disabled', async () => {
    await share();
    const g = await signUp('sub');
    await ok('open/subscribe', { projectId, cadence: 'daily' }, g.cookie);
    expect((await get('/api/open/hollow-keep', g.cookie)).json().viewer.subscription).toBe('daily');
    const w = await signUp('weekly');
    await ok('open/subscribe', { projectId, cadence: 'weekly' }, w.cookie);
    const t0 = Date.parse('2026-11-16T07:00:00Z'); // Monday, before 08:00 UTC
    db.prepare('UPDATE open_subscriptions SET created_at=?').run(t0 - 3600e3);
    const c = await card('Fresh feature');
    db.prepare('UPDATE cards SET created_at=? WHERE id=?').run(t0 - 1000, c.id);
    job(runOpenDeckUpdates, t0);
    expect(outbox().filter((m) => m.kind === 'openDeckUpdates')).toEqual([]);
    job(runOpenDeckUpdates, t0 + 2 * 3600e3);
    let mails = outbox().filter((m) => m.kind === 'openDeckUpdates');
    expect(mails.map((m) => m.to_addr).sort()).toEqual(['sub@guest.example', 'weekly@guest.example']);
    expect(mails[0].text).toContain('Fresh feature');
    expect(mails[0].text).toContain('http://tracker.test/open/hollow-keep');
    expect(mails[0].text).toContain('/email/unsubscribe?t=');
    expect(mails[0].text).not.toMatch(/@secret\.example|Internal codename/);
    // Once per slot.
    job(runOpenDeckUpdates, t0 + 3 * 3600e3);
    expect(outbox().filter((m) => m.kind === 'openDeckUpdates')).toHaveLength(2);
    // Next day: nothing new → no email; something new → the daily subscriber only.
    job(runOpenDeckUpdates, t0 + 25 * 3600e3);
    expect(outbox().filter((m) => m.kind === 'openDeckUpdates')).toHaveLength(2);
    const d = await card('Second feature');
    db.prepare('UPDATE cards SET created_at=? WHERE id=?').run(t0 + 30 * 3600e3, d.id);
    db.prepare('UPDATE account SET is_disabled=1').run();
    job(runOpenDeckUpdates, t0 + 49 * 3600e3);
    expect(outbox().filter((m) => m.kind === 'openDeckUpdates')).toHaveLength(2);
    db.prepare('UPDATE account SET is_disabled=0').run();
    job(runOpenDeckUpdates, t0 + 49 * 3600e3);
    mails = outbox().filter((m) => m.kind === 'openDeckUpdates');
    expect(mails).toHaveLength(3);
    expect(mails[2].to_addr).toBe('sub@guest.example');
    expect(mails[2].text).toContain('Second feature');
    expect(mails[2].text).not.toContain('Fresh feature');
    // Unsubscribing stops it.
    await ok('open/unsubscribe', { projectId }, g.cookie);
    expect(db.prepare('SELECT COUNT(*) c FROM open_subscriptions').get()).toEqual({ c: 1 });
  });

  it('admins get a weekly upvote digest on Mondays', async () => {
    const c = await card('Popular');
    await share();
    const g = await signUp('fan');
    await ok('open/upvote', { cardId: c.id }, g.cookie);
    const monday = Date.parse('2026-11-23T09:00:00Z');
    db.prepare('UPDATE upvotes SET created_at=?').run(monday - 2 * 86400e3);
    job(runOpenDeckDigest, Date.parse('2026-11-22T09:00:00Z')); // Sunday
    expect(outbox().filter((m) => m.kind === 'openDeckDigest')).toEqual([]);
    job(runOpenDeckDigest, monday);
    job(runOpenDeckDigest, monday + 3600e3);
    const mails = outbox().filter((m) => m.kind === 'openDeckDigest');
    expect(mails).toHaveLength(1);
    expect(mails[0].to_addr).toBe('owner@secret.example');
    expect(mails[0].text).toContain('Popular');
    expect(mails[0].text).toContain('/email/unsubscribe?t=');
    expect(mails[0].text).not.toContain('fan@guest.example');
  });
});

describe('update job batches', () => {
  it('looks at a bounded batch of subscriptions per tick and carries on where it stopped', async () => {
    await share();
    const ids: string[] = [];
    for (const n of ['b1', 'b2', 'b3']) ids.push((await signUp(n)).id);
    const t0 = Date.parse('2026-11-16T09:00:00Z');
    for (const id of ids) db.prepare("INSERT INTO open_subscriptions (project_id, user_id, cadence, created_at) VALUES (?, ?, 'daily', ?)").run(projectId, id, t0 - 7200e3);
    const c = await card('News');
    db.prepare('UPDATE cards SET created_at=? WHERE id=?').run(t0 - 1000, c.id);
    const sent = () => outbox().filter((m) => m.kind === 'openDeckUpdates').length;
    job((ctx, now) => runOpenDeckUpdates(ctx, now, 2), t0);
    expect(sent()).toBe(2);
    job((ctx, now) => runOpenDeckUpdates(ctx, now, 2), t0 + 60e3);
    expect(sent()).toBe(3);
    // A full pass later: nothing twice.
    for (let i = 2; i < 5; i++) job((ctx, now) => runOpenDeckUpdates(ctx, now, 2), t0 + i * 60e3);
    expect(sent()).toBe(3);
  });
});

describe('public routes in the web app', () => {
  it('parses the Open Lists paths', async () => {
    const { parse, OPEN_ROUTES } = await import('../web/src/router');
    expect(parse('/open')).toEqual({ name: 'openGallery' });
    expect(parse('/open/hollow-keep')).toEqual({ name: 'openProject', urlName: 'hollow-keep' });
    expect(parse('/open/hollow-keep/deck/12')).toEqual({ name: 'openDeck', urlName: 'hollow-keep', seq: 12 });
    expect(parse('/open/hollow-keep/card/1a3-grappling-hook')).toEqual({ name: 'openCard', urlName: 'hollow-keep', code: '1a3' });
    expect(parse('/open/confirm/abc_DEF-1')).toEqual({ name: 'openConfirm', token: 'abc_DEF-1' });
    expect(parse('/open/Hollow/deck/x').name).toBe('notFound');
    for (const r of ['openGallery', 'openProject', 'openDeck', 'openCard', 'openConfirm'] as const) expect(OPEN_ROUTES.has(r)).toBe(true);
  });
});

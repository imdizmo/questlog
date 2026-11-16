import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, now, _resetLimiter } from '../server/auth';
import { runJob, runTrialExpiry } from '../server/jobs';
import { LiveHub } from '../server/live';
import { accountRow } from '../server/commands/rows';
import { mcpDailyLimit, uploadRoom } from '../server/billing';
import { limitsFor, featureAllowed, seatsUsed, PLANS, ALL_FEATURES } from '../shared/plans';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST = 'localhost:8780';
const WEBHOOK_SECRET = 'whsec_test_secret';
const DAY = 86_400_000;
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
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(t), userId, now() + 3600e3);
  return `jt_session=${t}`;
}
function mkProject(): string {
  const id = newId();
  db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,?,0,?,0)')
    .run(id, ++seq, 'P', 'full', JSON.stringify([{ id: 1, name: 'Main', icon: null, defaultDeckType: 'task' }]));
  return id;
}
function mkDeck(projectId: string): string {
  const id = newId();
  db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES (?,?,?,1,'D','task',0)").run(id, ++seq, projectId);
  return id;
}
function mkCard(deckId: string, creatorId: string): string {
  const id = newId();
  db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at) VALUES (?,?,?,?,'Card','default','[]',0,0)")
    .run(id, ++seq, deckId, creatorId);
  return id;
}
const send = (cookie: string, cmd: string, payload: unknown, bearer?: string) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any,
  headers: { host: HOST, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }) },
});
const raw = (sql: string) => db.prepare(sql).get() as Record<string, any>;
const setFree = () => db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();

// ---- a local stand-in for the Stripe API (tests never reach api.stripe.com) ----
interface Seen { method: string; path: string; auth: string; form: URLSearchParams }
let stripe: Server;
let stripeUrl = '';
let seen: Seen[] = [];
const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
async function startStripeMock(): Promise<void> {
  seen = [];
  stripe = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    seen.push({ method: req.method ?? '', path: url.pathname, auth: String(req.headers.authorization ?? ''), form: new URLSearchParams(req.method === 'GET' ? url.search : body) });
    const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.example.test/cs_1' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: 'https://portal.example.test/p' });
    if (url.pathname === '/v1/invoices') return json({ data: [{ number: 'INV-1', created: 1_700_000_000, total: 1200, currency: 'eur', status: 'paid', hosted_invoice_url: 'https://invoice.example.test/1' }] });
    if (url.pathname === '/v1/subscriptions/sub_1') return json({ id: 'sub_1', items: { data: [{ id: 'si_1', quantity: 3 }] } });
    if (url.pathname === '/v1/subscription_items/si_1') return json({ id: 'si_1', quantity: Number(new URLSearchParams(body).get('quantity')) });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"no such route"}}');
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', () => r()));
  stripeUrl = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
}

async function stripeApp(): Promise<void> {
  await app.close();
  app = buildApp({
    db, hosts: [HOST],
    billing: { secretKey: 'sk_test_x', webhookSecret: WEBHOOK_SECRET, baseUrl: stripeUrl, prices: { PLUS_MONTH: 'price_plus_m', PRO_MONTH: 'price_pro_m', PRO_YEAR: 'price_pro_y' } },
  });
  await app.ready();
}

function sign(body: string, t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
const webhook = (event: unknown, signature?: string) => {
  const body = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/api/billing/stripe-webhook', payload: body,
    headers: { host: HOST, 'content-type': 'application/json', 'stripe-signature': signature ?? sign(body) } });
};
const subUpdated = (id: string, quantity: number, price = 'price_plus_m', status = 'active') => ({
  id, type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status, current_period_end: 1_800_000_000, items: { data: [{ id: 'si_1', quantity, price: { id: price } }] } } },
});

beforeEach(async () => {
  db = openDb(':memory:');
  seq = 0;
  _resetLimiter();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  await startStripeMock();
});
afterEach(async () => {
  setClock(() => Date.now());
  await app.close();
  await new Promise<void>((r) => stripe.close(() => r()));
});

describe('plans and limits', () => {
  it('mode off: limits unlimited, all features', async () => {
    const acc = accountRow(db);
    expect(acc.billingMode).toBe('off');
    const l = limitsFor(acc);
    expect(l).toMatchObject({ users: null, projects: null, storageBytes: null, fileBytes: null, mcpDaily: null });
    for (const f of ALL_FEATURES) expect(featureAllowed(acc, f)).toBe(true);
    // Nothing is refused: a sixth member and a fourth project go through, billing commands say billing is off.
    const owner = mkUser('owner');
    for (let i = 0; i < 6; i++) mkUser('member');
    const cookie = cookieFor(owner);
    expect((await send(cookie, 'invites/create', { role: 'member', projectIds: [] })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await send(cookie, 'projects/create', { name: `P${i}` })).statusCode).toBe(200);
    const r = await send(cookie, 'billing/listInvoices', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('billing_off');
  });

  it('seatsUsed counts owners, admins and members only', () => {
    expect(seatsUsed([{ role: 'owner' }, { role: 'admin' }, { role: 'member' }, { role: 'observer' }, { role: 'guest' }, { role: 'member', disabled: true }, { role: 'admin', kind: 'service' }])).toBe(3);
    expect(PLANS.free.users).toBe(5);
  });

  it('Free: 6th member invite → 409 plan_limit; observer invite → 409 plan_feature (Plus: allowed, no seat)', async () => {
    setFree();
    const owner = mkUser('owner');
    for (let i = 0; i < 4; i++) mkUser('member');
    mkUser('observer');
    const cookie = cookieFor(owner);
    const r = await send(cookie, 'invites/create', { role: 'member', projectIds: [] });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'users' } });
    const o = await send(cookie, 'invites/create', { role: 'observer', projectIds: [] });
    expect(o.statusCode).toBe(409);
    expect(o.json()).toEqual({ error: 'plan_feature', data: { feature: 'observerRole' } });
    const m = mkUser('member');
    expect((await send(cookie, 'users/setRole', { userId: m, role: 'observer' })).json().data).toEqual({ feature: 'observerRole' });
    db.prepare('DELETE FROM users WHERE id=?').run(m);
    // Plus with every bought seat taken: observers still join, members don't.
    db.prepare("UPDATE account SET plan_type='plus', purchased_seats=5").run();
    expect((await send(cookie, 'invites/create', { role: 'observer', projectIds: [] })).statusCode).toBe(200);
    expect((await send(cookie, 'invites/create', { role: 'member', projectIds: [] })).json().error).toBe('plan_limit');
    db.prepare("UPDATE account SET plan_type='free', purchased_seats=0").run();
    // Promoting an observer would take a sixth seat too.
    const obs = mkUser('observer');
    expect((await send(cookie, 'users/setRole', { userId: obs, role: 'member' })).json().error).toBe('plan_limit');
  });

  it('Free: a 4th live project → 409 plan_limit', async () => {
    setFree();
    const cookie = cookieFor(mkUser('owner'));
    for (let i = 0; i < 3; i++) expect((await send(cookie, 'projects/create', { name: `P${i}` })).statusCode).toBe(200);
    const r = await send(cookie, 'projects/create', { name: 'P4' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'projects' } });
  });

  it('Free: an upload over the 10 MB file size → 413 plan_limit', async () => {
    setFree();
    const owner = mkUser('owner');
    const card = mkCard(mkDeck(mkProject()), owner);
    const r = await app.inject({ method: 'POST', url: `/api/cards/${card}/files?name=big.bin`, payload: Buffer.alloc(10 * 1024 * 1024 + 1),
      headers: { host: HOST, cookie: cookieFor(owner), 'content-type': 'application/octet-stream' } });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'fileSize' } });
  });

  it('trial expiry job moves trialing → free and Pro gates close; due dates stay readable, new due date → 409 plan_feature', async () => {
    await stripeApp();
    let acc = accountRow(db);
    expect(acc).toMatchObject({ billingMode: 'stripe', planType: 'pro', planStatus: 'trialing' });
    expect(acc.trialEndsAt).toBeGreaterThan(now() + 13 * DAY);
    db.prepare('UPDATE account SET settings_json=?').run(JSON.stringify({ dueDateEnabled: true }));
    const owner = mkUser('owner');
    let cookie = cookieFor(owner);
    const card = mkCard(mkDeck(mkProject()), owner);
    expect((await send(cookie, 'cards/update', { id: card, dueDate: '2099-01-01' })).statusCode).toBe(200);

    const later = now() + 15 * DAY;
    setClock(() => later);
    runJob(db, new LiveHub(db), (ctx) => runTrialExpiry(ctx, later));
    cookie = cookieFor(owner);
    acc = accountRow(db);
    expect(acc).toMatchObject({ planType: 'free', planStatus: 'active', trialEndsAt: null });
    expect(featureAllowed(acc, 'dueDates', later)).toBe(false);
    const snap = (await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie } })).json();
    expect(snap.cards.find((c: any) => c.id === card).dueDate).toBe('2099-01-01');
    const r = await send(cookie, 'cards/update', { id: card, dueDate: '2099-02-01' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'plan_feature', data: { feature: 'dueDates' } });
    // Re-sending the stored date is no new write; clearing the old value is still allowed.
    expect((await send(cookie, 'cards/update', { id: card, dueDate: '2099-01-01' })).statusCode).toBe(200);
    expect((await send(cookie, 'cards/update', { id: card, dueDate: null })).statusCode).toBe(200);
  });

  it('Free: new Pro feature writes → 409 plan_feature; removing old ones still works', async () => {
    setFree();
    db.prepare('UPDATE account SET settings_json=?').run(JSON.stringify({ dependenciesEnabled: true, timeTrackingMode: 'strict' }));
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const project = mkProject();
    const deck = mkDeck(project);
    const [a, b] = [mkCard(deck, owner), mkCard(deck, owner)];
    db.prepare('INSERT INTO card_deps (locked_card_id, locking_card_id) VALUES (?,?)').run(a, b);
    const feature = async (cmd: string, payload: unknown) => (await send(cookie, cmd, payload)).json();
    expect(await feature('cards/update', { id: b, inDeps: [a] })).toEqual({ error: 'plan_feature', data: { feature: 'dependencies' } });
    expect((await send(cookie, 'cards/update', { id: a, inDeps: [] })).statusCode).toBe(200);
    expect((await feature('decks/update', { id: deck, guardiansEnabled: true })).data).toEqual({ feature: 'guardians' });
    expect((await feature('projects/update', { id: project, visibility: 'limited' })).data).toEqual({ feature: 'limitedVisibility' });
    expect((await feature('projects/create', { name: 'L', visibility: 'limited' })).data).toEqual({ feature: 'limitedVisibility' });
    expect((await feature('timeTracking/start', { userId: owner, cardId: a })).data).toEqual({ feature: 'timeTracking' });
  });

  it('accepting an invite over the seats → 409 plan_limit', async () => {
    const owner = mkUser('owner');
    const r = await send(cookieFor(owner), 'invites/create', { role: 'member', projectIds: [] });
    const token = r.json().payload.token;
    setFree();
    for (let i = 0; i < 4; i++) mkUser('member');
    const join = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { name: 'N', email: 'n@x.io', password: 'pw-123456' },
      headers: { host: HOST, 'content-type': 'application/json' } });
    expect(join.statusCode).toBe(409);
    expect(join.json().error).toBe('plan_limit');
  });

  it('MCP daily calls: the lower of the setting and the plan', () => {
    expect(mcpDailyLimit(db, null)).toBeNull();
    expect(mcpDailyLimit(db, 50)).toBe(50);
    setFree();
    expect(mcpDailyLimit(db, null)).toBe(100);
    expect(mcpDailyLimit(db, 50)).toBe(50);
    expect(mcpDailyLimit(db, 500)).toBe(100);
    db.prepare("UPDATE account SET plan_type='plus', purchased_seats=3").run();
    expect(mcpDailyLimit(db, null)).toBe(750);
  });

  it('Free: cloning a project whose attachments exceed the storage left → 413 plan_limit', async () => {
    const dir = join(homedir(), '.cache/gametracker/scratch', `billing-test-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      await app.close();
      app = buildApp({ db, hosts: [HOST], filesDir: dir });
      await app.ready();
      setFree();
      const owner = mkUser('owner');
      const project = mkProject();
      const card = mkCard(mkDeck(project), owner);
      // 600 MB of attachments on record: a copy would need 1.2 GB of the plan's 1 GB.
      db.prepare("INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,'a.bin','application/octet-stream',?,0)")
        .run(newId(), card, owner, 600 * 1024 * 1024);
      const r = await app.inject({ method: 'POST', url: '/dispatch/clone/projects', payload: { projectIds: [project], visibility: 'full' },
        headers: { host: HOST, 'content-type': 'application/json', cookie: cookieFor(owner) } });
      expect(r.statusCode).toBe(413);
      expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'storage' } });
      expect(raw('SELECT COUNT(*) n FROM projects').n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Free: covers count toward storage; a cover upload past the storage left → 413 plan_limit', async () => {
    const dir = join(homedir(), '.cache/gametracker/scratch', `billing-cover-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      await app.close();
      app = buildApp({ db, hosts: [HOST], filesDir: dir });
      await app.ready();
      setFree();
      const owner = mkUser('owner');
      const project = mkProject();
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const up = () => app.inject({ method: 'POST', url: `/api/covers?projectId=${project}`, payload: png as any,
        headers: { host: HOST, cookie: cookieFor(owner), 'content-type': 'image/png' } });
      // 1 GB plan: files and covers together fill it up to 10 bytes short of the limit.
      const gb = 1024 * 1024 * 1024;
      db.prepare("INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,?,'image/png',?,0)").run(newId(), project, owner, gb - 10);
      expect(uploadRoom(db).storageLeft).toBe(10);
      const r = await up();
      expect(r.statusCode).toBe(413);
      expect(r.json()).toEqual({ error: 'plan_limit', data: { limit: 'storage' } });
      expect(raw('SELECT COUNT(*) n FROM covers').n).toBe(1);
      // Room left: the same upload goes through.
      db.prepare('UPDATE covers SET size=?').run(gb - 10_000);
      expect((await up()).statusCode).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('billing mode follows the keys: removed → off (all unlocked), back → stripe without a new trial', async () => {
    await stripeApp();
    expect(accountRow(db).billingMode).toBe('stripe');
    setFree();
    await app.close();
    app = buildApp({ db, hosts: [HOST] });
    await app.ready();
    const acc = accountRow(db);
    expect(acc.billingMode).toBe('off');
    expect(limitsFor(acc).projects).toBeNull();
    const cookie = cookieFor(mkUser('owner'));
    for (let i = 0; i < 4; i++) expect((await send(cookie, 'projects/create', { name: `P${i}` })).statusCode).toBe(200);
    await stripeApp();
    expect(accountRow(db)).toMatchObject({ billingMode: 'stripe', planType: 'free', planStatus: 'active', trialEndsAt: null });
  });

  it('a paid plan with 0 purchased seats counts as 1 seat, never unlimited', () => {
    const acc = { billingMode: 'stripe', planType: 'pro', planStatus: 'active', purchasedSeats: 0, trialEndsAt: null, planOverwrites: null } as any;
    expect(limitsFor(acc).users).toBe(1);
    expect(limitsFor({ ...acc, planType: 'plus', planStatus: 'past_due' }).users).toBe(1);
    expect(limitsFor({ ...acc, purchasedSeats: 4 }).users).toBe(4);
  });

  it('planOverwrites raises a limit', async () => {
    setFree();
    db.prepare(`UPDATE account SET plan_overwrites='{"users":10}'`).run();
    expect(limitsFor(accountRow(db)).users).toBe(10);
    const owner = mkUser('owner');
    for (let i = 0; i < 5; i++) mkUser('member');
    expect((await send(cookieFor(owner), 'invites/create', { role: 'member', projectIds: [] })).statusCode).toBe(200);
  });
});

describe('Stripe webhook', () => {
  beforeEach(async () => {
    await stripeApp();
    db.prepare("UPDATE account SET stripe_customer_id='cus_1'").run();
  });

  it('webhook with bad signature → 400, no change', async () => {
    const ev = subUpdated('evt_bad', 7);
    const body = JSON.stringify(ev);
    const before = raw('SELECT plan_type, purchased_seats FROM account');
    for (const sig of [sign(body, undefined, 'whsec_wrong'), 'garbage', sign(body, Math.floor(Date.now() / 1000) - 301)]) {
      const r = await webhook(ev, sig);
      expect(r.statusCode).toBe(400);
    }
    expect(raw('SELECT plan_type, purchased_seats FROM account')).toEqual(before);
    expect(raw('SELECT COUNT(*) n FROM stripe_events').n).toBe(0);
  });

  it('subscription.updated sets plan and seats', async () => {
    const r = await webhook(subUpdated('evt_1', 7, 'price_pro_y'));
    expect(r.statusCode, r.body).toBe(200);
    expect(accountRow(db)).toMatchObject({ planType: 'pro', planStatus: 'active', purchasedSeats: 7, billingCycleEnd: 1_800_000_000_000 });
    expect(raw('SELECT stripe_subscription_id s FROM account').s).toBe('sub_1');
  });

  it('replayed event id → no double apply', async () => {
    expect((await webhook(subUpdated('evt_2', 4))).statusCode).toBe(200);
    db.prepare('UPDATE account SET purchased_seats=9').run();
    expect((await webhook(subUpdated('evt_2', 4))).statusCode).toBe(200);
    expect(accountRow(db).purchasedSeats).toBe(9);
    expect(raw('SELECT COUNT(*) n FROM stripe_events').n).toBe(1);
  });

  it('events of another customer are ignored', async () => {
    const ev = subUpdated('evt_3', 4);
    (ev.data.object as any).customer = 'cus_other';
    expect((await webhook(ev)).statusCode).toBe(200);
    expect(accountRow(db).purchasedSeats).toBe(0);
  });

  it('only the recorded subscription counts: other or old subscriptions change nothing', async () => {
    await webhook(subUpdated('evt_a', 4));
    expect(raw('SELECT stripe_subscription_id s FROM account').s).toBe('sub_1');
    const other = subUpdated('evt_b', 9, 'price_pro_m');
    (other.data.object as any).id = 'sub_old';
    expect((await webhook(other)).statusCode).toBe(200);
    await webhook({ id: 'evt_c', type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', object: 'subscription', customer: 'cus_1', status: 'canceled', items: { data: [] } } } });
    await webhook({ id: 'evt_d', type: 'invoice.payment_failed', data: { object: { object: 'invoice', customer: 'cus_1', subscription: 'sub_old' } } });
    expect(accountRow(db)).toMatchObject({ planType: 'plus', planStatus: 'active', purchasedSeats: 4 });
  });

  it('checkout completion records the ids; an early subscription event is adopted by its metadata', async () => {
    db.prepare('UPDATE account SET stripe_customer_id=NULL').run();
    const id = accountRow(db).id;
    // The subscription event may come first: it names the workspace in its metadata.
    const early = subUpdated('evt_e', 3, 'price_pro_m');
    Object.assign(early.data.object, { customer: 'cus_9', id: 'sub_9', metadata: { account_id: id, plan: 'pro' } });
    await webhook(early);
    expect(raw('SELECT stripe_customer_id c, stripe_subscription_id s FROM account')).toEqual({ c: 'cus_9', s: 'sub_9' });
    await webhook({ id: 'evt_f', type: 'checkout.session.completed', data: { object: { object: 'checkout.session', client_reference_id: id, customer: 'cus_9', subscription: 'sub_9', payment_status: 'paid', metadata: { plan: 'pro', seats: '3' } } } });
    expect(accountRow(db)).toMatchObject({ planType: 'pro', planStatus: 'active', purchasedSeats: 3, hasCustomer: true, hasSubscription: true });
    // An unpaid checkout records the ids but does not activate anything.
    db.prepare("UPDATE account SET stripe_customer_id=NULL, stripe_subscription_id=NULL, plan_type='free', plan_status='active', purchased_seats=0").run();
    await webhook({ id: 'evt_g', type: 'checkout.session.completed', data: { object: { object: 'checkout.session', client_reference_id: id, customer: 'cus_8', subscription: 'sub_8', payment_status: 'unpaid', metadata: { plan: 'pro', seats: '3' } } } });
    expect(accountRow(db)).toMatchObject({ planType: 'free', hasSubscription: true });
  });

  it('subscription.deleted drops to Free; invoice.payment_failed marks past_due', async () => {
    await webhook(subUpdated('evt_4', 4));
    await webhook({ id: 'evt_5', type: 'invoice.payment_failed', data: { object: { object: 'invoice', customer: 'cus_1', subscription: 'sub_1' } } });
    expect(accountRow(db).planStatus).toBe('past_due');
    await webhook({ id: 'evt_6', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'canceled', items: { data: [] } } } });
    expect(accountRow(db)).toMatchObject({ planType: 'free', planStatus: 'canceled' });
  });
});

describe('billing commands', () => {
  beforeEach(async () => { await stripeApp(); });

  it('Stripe client against a local mock creates a checkout session with the right price and quantity', async () => {
    const owner = mkUser('owner');
    mkUser('member');
    const cookie = cookieFor(owner);
    const r = await send(cookie, 'billing/startCheckout', { plan: 'pro', interval: 'month', seats: 4 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().payload).toEqual({ url: 'https://checkout.example.test/cs_1' });
    const call = seen.find((s) => s.path === '/v1/checkout/sessions')!;
    expect(call.method).toBe('POST');
    expect(call.auth).toBe('Bearer sk_test_x');
    expect(call.form.get('mode')).toBe('subscription');
    expect(call.form.get('line_items[0][price]')).toBe('price_pro_m');
    expect(call.form.get('line_items[0][quantity]')).toBe('4');
    expect(call.form.get('client_reference_id')).toBe(accountRow(db).id);
    expect(call.form.get('customer')).toBeNull();
    // A known customer is reused; fewer seats than are in use is refused.
    db.prepare("UPDATE account SET stripe_customer_id='cus_1'").run();
    seen = [];
    expect((await send(cookie, 'billing/startCheckout', { plan: 'plus', interval: 'month', seats: 2 })).statusCode).toBe(200);
    expect(seen[0].form.get('customer')).toBe('cus_1');
    expect(seen[0].form.get('line_items[0][price]')).toBe('price_plus_m');
    expect((await send(cookie, 'billing/startCheckout', { plan: 'pro', interval: 'month', seats: 1 })).json().error).toBe('plan_limit');
    // A plan and interval without a configured price is refused.
    expect((await send(cookie, 'billing/startCheckout', { plan: 'plus', interval: 'year', seats: 2 })).statusCode).toBe(409);
  });

  it('portal, invoices and seats go through the client', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    expect((await send(cookie, 'billing/openPortal', {})).json().error).toBe('no_customer');
    db.prepare("UPDATE account SET stripe_customer_id='cus_1', stripe_subscription_id='sub_1', plan_type='plus', plan_status='active', purchased_seats=3").run();
    expect((await send(cookie, 'billing/openPortal', {})).json().payload).toEqual({ url: 'https://portal.example.test/p' });
    expect(seen.find((s) => s.path === '/v1/billing_portal/sessions')!.form.get('customer')).toBe('cus_1');
    const inv = await send(cookie, 'billing/listInvoices', {});
    expect(inv.json().payload).toEqual({ invoices: [{ number: 'INV-1', date: 1_700_000_000_000, amountCents: 1200, currency: 'eur', status: 'paid', hostedUrl: 'https://invoice.example.test/1' }] });
    expect(seen.find((s) => s.path === '/v1/invoices')!.form.get('limit')).toBe('24');
    const again = await send(cookie, 'billing/startCheckout', { plan: 'pro', interval: 'month', seats: 3 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_subscribed');
    const s = await send(cookie, 'billing/setSeats', { seats: 5 });
    expect(s.statusCode, s.body).toBe(200);
    expect(seen.find((x) => x.path === '/v1/subscription_items/si_1')!.form.get('quantity')).toBe('5');
    expect(accountRow(db).purchasedSeats).toBe(5);
  });

  it('members may not run billing commands', async () => {
    const member = mkUser('member');
    expect((await send(cookieFor(member), 'billing/openPortal', {})).statusCode).toBe(403);
  });

  it('token actor → 403', async () => {
    const owner = mkUser('owner');
    const cookie = cookieFor(owner);
    const t = await send(cookie, 'apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [] });
    const token = t.json().payload.token;
    for (const cmd of ['billing/startCheckout', 'billing/openPortal', 'billing/setSeats', 'billing/listInvoices']) {
      const r = await send('', cmd, { plan: 'pro', interval: 'month', seats: 2 }, token);
      expect(r.statusCode).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it('the account the clients see carries no Stripe ids', async () => {
    db.prepare("UPDATE account SET stripe_customer_id='cus_1', stripe_subscription_id='sub_1'").run();
    const cookie = cookieFor(mkUser('owner'));
    const snap = (await app.inject({ method: 'GET', url: '/api/snapshot', headers: { host: HOST, cookie } })).json();
    expect(snap.account.planType).toBe('pro');
    expect(JSON.stringify(snap.account)).not.toMatch(/cus_1|sub_1/);
  });
});

describe('Billing tab', () => {
  const render = async (account: any, invoices?: any[]) => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Billing } = await import('../web/src/views/settings/Billing');
    return renderToStaticMarkup(createElement(Billing, { account, seatsInUse: 2, invoices, now: 1_000_000 }));
  };

  it('mode off says the workspace is self-hosted', async () => {
    expect(await render({ id: 'a', name: 'W', settings: {}, billingMode: 'off' })).toContain('This workspace is self-hosted. All features are on and there is no billing.');
    expect(await render(null)).toContain('self-hosted');
  });

  it('never crashes on a trial, with or without its end date', async () => {
    const html = await render({ id: 'a', name: 'W', settings: {}, billingMode: 'stripe', planType: 'pro', planStatus: 'trialing', trialEndsAt: 1_000_000 + 3 * DAY });
    expect(html).toContain('Pro');
    expect(html).toContain('3 days of the Pro trial left');
    expect(html).toContain('Upgrade');
    for (const acc of [
      { billingMode: 'stripe', planStatus: 'trialing' },
      { billingMode: 'stripe', planStatus: 'trialing', trialEndsAt: null, planOverwrites: null, purchasedSeats: null },
      { billingMode: 'stripe', planType: 'bogus', planStatus: 'bogus' },
    ]) expect(await render({ id: 'a', name: 'W', settings: {}, ...acc })).toContain('Seats in use');
  });

  it('a paid plan shows seats, Manage payment and the invoices', async () => {
    const html = await render({ id: 'a', name: 'W', settings: {}, billingMode: 'stripe', planType: 'plus', planStatus: 'active', purchasedSeats: 4, hasCustomer: true, hasSubscription: true },
      [{ number: 'INV-1', date: 1_700_000_000_000, amountCents: 1200, currency: 'eur', status: 'paid', hostedUrl: 'https://invoice.example.test/1' }]);
    expect(html).toContain('Plus');
    expect(html).toContain('Manage payment');
    expect(html).toMatch(/Seats in use: <strong>2<\/strong> of <strong>4<\/strong>/);
    expect(html).toContain('INV-1');
    // A subscribed workspace changes plan in the portal: no second checkout.
    expect(html).not.toContain('>Upgrade<');
  });
});

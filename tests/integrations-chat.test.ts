import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { ALLOWED_HOSTS, OutboundClient, OutboundError } from '../server/integrations/http';
import { TOKEN_DENIED_NAMESPACES } from '../server/tokens';

const HOST = 'localhost:8780';
const MILESTONE_COLOR = 'green';
let db: Db;
let app: ReturnType<typeof buildApp>;
let owner = '';
let ownerId = '';
let projectId = '';
let deckId = '';

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie'] ?? '').split(';')[0];
const json = (cookie: string, url: string, payload: unknown) => app.inject({
  method: 'POST', url, payload: payload as any, headers: { host: HOST, 'content-type': 'application/json', cookie },
});
async function ok(cmd: string, payload: unknown, cookie = owner): Promise<any> {
  const r = await json(cookie, `/dispatch/${cmd}`, payload);
  if (r.statusCode !== 200) throw new Error(`${cmd}: ${r.statusCode} ${r.body}`);
  return r.json().payload;
}

// ---- one local mock for discord.com, hooks.slack.com and slack.com (tests never reach the real hosts) ----
interface Seen { method: string; path: string; auth: string; body: string }
let mock: Server;
let mockUrl = '';
let seen: Seen[] = [];
let failNext = 0;
let slackEmail = 'm@x.io';
/** Extra users.info fields of the next answers (a guest, an unconfirmed email, another team...). */
let slackUserExtra: Record<string, unknown> = {};
const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
async function startMock(): Promise<void> {
  seen = [];
  failNext = 0;
  slackEmail = 'm@x.io';
  slackUserExtra = {};
  mock = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, auth: String(req.headers.authorization ?? ''), body });
    const send = (status: number, o: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (failNext > 0) { failNext--; return send(500, { message: 'down' }); }
    if (url.pathname === '/api/users.info') return send(200, { ok: true, user: { id: url.searchParams.get('user'), team_id: 'T0001', is_email_confirmed: true, profile: { email: slackEmail }, ...slackUserExtra } });
    if (url.pathname.startsWith('/api/webhooks/')) { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/services/')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (/^\/api\/v10\/applications\/\d+\/guilds\/\d+\/commands$/.test(url.pathname)) return send(200, JSON.parse(body));
    send(404, { message: 'no such route' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
}

const SECRET = 'integration-test-secret-0123456789';
beforeEach(async () => {
  _resetLimiter();
  await startMock();
  db = openDb(':memory:');
  app = buildApp({
    db, hosts: [HOST], email: { publicUrl: 'http://tracker.test', secret: SECRET },
    outbound: { mocks: { 'discord.com': mockUrl, 'hooks.slack.com': mockUrl, 'slack.com': mockUrl } },
  });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  ownerId = (db.prepare('SELECT id FROM users WHERE email=?').get('o@x.io') as any).id;
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'Bugs', projectId })).id;
});
afterEach(async () => {
  await app.close();
  await new Promise<void>((r) => mock.close(() => r()));
});

// ---- Discord ----
const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CHANNEL_ID = '323456789012345678';
const BOT_TOKEN = 'MTIzNDU2Nzg5.discord-bot-token-value.abcdefghijk';
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/423456789012345678/' + 'w'.repeat(68);
let keys: { publicKey: KeyObject; privateKey: KeyObject };
const publicHex = () => Buffer.from(keys.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');
function discordReq(payload: unknown, opts: { ts?: number; badSig?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  let sig = edSign(null, Buffer.from(ts + body), keys.privateKey).toString('hex');
  if (opts.badSig) sig = sig.slice(0, -2) + (sig.endsWith('00') ? '11' : '00');
  return app.inject({
    method: 'POST', url: '/integrations/discord/interactions', payload: body,
    headers: { host: HOST, 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
  });
}
async function setupDiscord(extra: Record<string, unknown> = {}) {
  keys = generateKeyPairSync('ed25519');
  await ok('integrations/updateDiscord', {
    applicationId: APP_ID, publicKey: publicHex(), guildId: GUILD_ID, botToken: BOT_TOKEN,
    commands: [{ channelId: CHANNEL_ID, name: 'bug', deckId }], ...extra,
  });
}
const slash = (id: string, name: string, text: string, channel = CHANNEL_ID) => ({
  id, type: 2, guild_id: GUILD_ID, channel_id: channel, member: { user: { id: '1', username: 'mira' } },
  data: { name, options: [{ name: 'text', type: 3, value: text }] },
});

describe('discord', () => {
  it('discord PING with a valid Ed25519 signature → PONG; bad signature → 401', async () => {
    await setupDiscord();
    const pong = await discordReq({ id: '1', type: 1 });
    expect(pong.statusCode).toBe(200);
    expect(pong.json()).toEqual({ type: 1 });
    expect((await discordReq({ id: '1', type: 1 }, { badSig: true })).statusCode).toBe(401);
    // A signature more than 5 minutes old is refused even when it is valid.
    expect((await discordReq({ id: '1', type: 1 }, { ts: Math.floor(Date.now() / 1000) - 600 })).statusCode).toBe(401);
    // Missing headers.
    const r = await app.inject({ method: 'POST', url: '/integrations/discord/interactions', payload: '{"type":1}', headers: { host: HOST, 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
  });

  it('answers 404 while Discord is not set up', async () => {
    keys = generateKeyPairSync('ed25519');
    expect((await discordReq({ id: '1', type: 1 })).statusCode).toBe(404);
  });

  it('/bug creates a card in the mapped deck', async () => {
    await setupDiscord();
    const r = await discordReq(slash('900000000000000001', 'bug', 'The door does not open'));
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out.type).toBe(4);
    expect(out.data.flags).toBe(64);
    const cards = db.prepare('SELECT * FROM cards WHERE deck_id=?').all(deckId) as any[];
    expect(cards).toHaveLength(1);
    expect(cards[0].content).toContain('The door does not open');
    expect(out.data.content).toContain('http://tracker.test/card/');
    // The same interaction again (a replay): no second card.
    expect((await discordReq(slash('900000000000000001', 'bug', 'The door does not open'))).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM cards WHERE deck_id=?').get(deckId)).toEqual({ n: 1 });
    // A channel or command without a mapping makes nothing, and says so.
    const none = await discordReq(slash('900000000000000002', 'card', 'Elsewhere'));
    expect(none.json().data.content).toMatch(/not linked/i);
    // Another guild is refused.
    const other = await discordReq({ ...slash('900000000000000003', 'bug', 'x'), guild_id: '999999999999999999' });
    expect(other.json().data.content).toMatch(/server/i);
    expect(db.prepare('SELECT COUNT(*) n FROM cards').get()).toEqual({ n: 1 });
    // An interaction that made nothing is not marked handled: once the channel is linked, Discord's retry works.
    await ok('integrations/updateDiscord', { commands: [{ channelId: CHANNEL_ID, name: 'bug', deckId }, { channelId: CHANNEL_ID, name: 'card', deckId }] });
    const retry = await discordReq(slash('900000000000000002', 'card', 'Elsewhere'));
    expect(retry.json().data.content).toMatch(/created/);
    expect(db.prepare('SELECT COUNT(*) n FROM cards').get()).toEqual({ n: 2 });
  });

  it('"Register commands" calls Discord only when the admin asks, with the bot token', async () => {
    await setupDiscord();
    expect(seen).toEqual([]);
    const r = await json(owner, '/dispatch/integrations/registerDiscordCommands', {});
    expect(r.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'PUT', path: `/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, auth: `Bot ${BOT_TOKEN}` });
    expect(JSON.parse(seen[0].body).map((c: any) => c.name).sort()).toEqual(['bug', 'card']);
  });

  it('karma role thresholds are stored and shown, marked inactive', async () => {
    await setupDiscord({ karmaRoleThresholds: [{ roleId: '523456789012345678', upvotes: 10 }] });
    const s = (await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: owner } })).json();
    expect(s.discord.karmaRoleThresholds).toEqual([{ roleId: '523456789012345678', upvotes: 10 }]);
    expect(s.discord.karmaActive).toBe(false);
  });
});

// ---- Slack ----
const SIGNING = 'a'.repeat(8) + '0123456789abcdef0123456789';
const SLACK_BOT = 'xoxb-1234-5678-slackbottokenvalue';
const SLACK_WEBHOOK = 'https://hooks.slack.com/services/T0001/B0002/abcdefghijklmnopqrstuvwx';
function slackReq(form: Record<string, string>, opts: { ts?: number; secret?: string } = {}) {
  const body = new URLSearchParams(form).toString();
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = 'v0=' + createHmac('sha256', opts.secret ?? SIGNING).update(`v0:${ts}:${body}`).digest('hex');
  return app.inject({
    method: 'POST', url: '/integrations/slack/commands', payload: body,
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
  });
}
const addcard = (text: string, trigger = 't1', user = 'U123') => ({ command: '/addcard', text, user_id: user, team_id: 'T0001', trigger_id: trigger });

describe('slack', () => {
  it('slack bad signature/old timestamp → 401', async () => {
    await ok('integrations/updateSlack', { signingSecret: SIGNING });
    expect((await slackReq(addcard('x'), { secret: 'b'.repeat(32) })).statusCode).toBe(401);
    expect((await slackReq(addcard('x'), { ts: Math.floor(Date.now() / 1000) - 301 })).statusCode).toBe(401);
    // A timestamp too far in the future is refused as well.
    expect((await slackReq(addcard('x'), { ts: Math.floor(Date.now() / 1000) + 301 })).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) n FROM cards').get()).toEqual({ n: 0 });
  });

  it('/addcard bookmarks the new card for the mapped user', async () => {
    const member = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'M@x.io','Mo','x',0)").run(member);
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?,'member')").run(member);
    await ok('projects/setAccess', { projectId, userId: member, access: 'member' });
    await ok('integrations/updateSlack', { signingSecret: SIGNING, botToken: SLACK_BOT, teamId: 'T0001', addCardDeckId: deckId });
    const r = await slackReq(addcard('Polish the menu'));
    expect(r.statusCode).toBe(200);
    expect(r.json().response_type).toBe('ephemeral');
    const card = db.prepare('SELECT * FROM cards WHERE deck_id=?').get(deckId) as any;
    expect(card.content).toBe('Polish the menu');
    expect(card.creator_id).toBe(member);
    expect(db.prepare('SELECT user_id FROM bookmarks WHERE card_id=?').all(card.id)).toEqual([{ user_id: member }]);
    // The Slack user's email came from Slack's users.info (bot token), case-insensitively matched.
    expect(seen.find((s) => s.path.startsWith('/api/users.info'))?.auth).toBe(`Bearer ${SLACK_BOT}`);
    // Another Slack user whose email no member has: nothing is created.
    slackEmail = 'nobody@x.io';
    const u = await slackReq(addcard('Another', 't2', 'U456'));
    expect(u.json().text).toMatch(/no member/i);
    slackEmail = 'm@x.io';
    expect(db.prepare('SELECT COUNT(*) n FROM cards').get()).toEqual({ n: 1 });
  });

  /** A member with access to the project, Slack set up for team T0001. */
  async function slackMember(role = 'member'): Promise<string> {
    const id = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'m@x.io','Mo','x',0)").run(id);
    db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
    db.prepare('INSERT INTO project_access (project_id, user_id) VALUES (?,?)').run(projectId, id);
    await ok('integrations/updateSlack', { signingSecret: SIGNING, botToken: SLACK_BOT, teamId: 'T0001', addCardDeckId: deckId });
    return id;
  }
  const cards = () => (db.prepare('SELECT COUNT(*) n FROM cards').get() as { n: number }).n;

  it('/addcard only from the configured Slack team, and only with a trigger id', async () => {
    await slackMember();
    const other = await slackReq({ ...addcard('x', 't-other'), team_id: 'T9999' });
    expect(other.json().text).toMatch(/not connected/i);
    const noTrigger = await slackReq({ command: '/addcard', text: 'x', user_id: 'U123', team_id: 'T0001' });
    expect(noTrigger.json().text).toMatch(/not supported/i);
    expect(cards()).toBe(0);
    // Without a team id in the settings, /addcard is off.
    await ok('integrations/updateSlack', { teamId: null });
    expect((await slackReq(addcard('x', 't-off'))).json().text).toMatch(/not set up/i);
    expect(cards()).toBe(0);
    expect(seen.filter((x) => x.path.startsWith('/api/users.info'))).toHaveLength(0);
  });

  it('/addcard trusts users.info only for confirmed full members of the same team', async () => {
    await slackMember();
    const refusals: Record<string, unknown>[] = [
      { is_email_confirmed: false }, { is_email_confirmed: undefined }, { is_restricted: true }, { is_ultra_restricted: true },
      { is_bot: true }, { deleted: true }, { team_id: 'T9999' }, { enterprise_user: { enterprise_id: 'E1' } },
    ];
    for (const [i, extra] of refusals.entries()) {
      slackUserExtra = extra;
      // A new Slack user each time: the email cache never answers for these.
      const r = await slackReq(addcard('Sneaky', `t-r${i}`, `U90${i}`));
      expect(r.statusCode).toBe(200);
      expect(r.json().text, JSON.stringify(extra)).toMatch(/only for members/i);
    }
    // Enterprise Grid: accepted only when the command and the user name the same enterprise.
    slackUserExtra = { enterprise_user: { enterprise_id: 'E1' } };
    expect((await slackReq({ ...addcard('Grid', 't-e1', 'U950'), enterprise_id: 'E2' })).json().text).toMatch(/only for members/i);
    expect(cards()).toBe(0);
    expect((await slackReq({ ...addcard('Grid', 't-e2', 'U951'), enterprise_id: 'E1' })).json().text).toMatch(/bookmarks/);
    expect(cards()).toBe(1);
  });

  it('/addcard by an observer (no right to add cards) creates nothing', async () => {
    await slackMember('observer');
    const r = await slackReq(addcard('Observed', 't-obs'));
    expect(r.json().text).toMatch(/can't add tasks/i);
    expect(cards()).toBe(0);
  });
});

// ---- notifications ----
describe('notifications', () => {
  it('notifications post to a local mock webhook with the expected body', async () => {
    await setupDiscord({ projectNotifications: [{ projectId, webhookUrl: DISCORD_WEBHOOK }] });
    await ok('integrations/updateSlack', { webhookUrl: SLACK_WEBHOOK, projectIds: [projectId] });
    const { id } = await ok('cards/create', { deckId, content: '@everyone Fix the *door*' });
    const seq = (db.prepare('SELECT seq FROM cards WHERE id=?').get(id) as any).seq;
    await ok('cards/update', { id, status: 'done' });
    await ok('resolvables/create', { cardId: id, context: 'comment', content: 'Looks good <!channel>' });
    expect(seen).toEqual([]); // nothing is sent on the request path
    await (app as any).integrations.flush();
    const discord = seen.filter((s) => s.path.startsWith('/api/webhooks/'));
    const slack = seen.filter((s) => s.path.startsWith('/services/'));
    expect(discord.map((s) => s.path)).toEqual(Array(3).fill(new URL(DISCORD_WEBHOOK).pathname));
    expect(slack.map((s) => s.path)).toEqual(Array(3).fill(new URL(SLACK_WEBHOOK).pathname));
    const d = discord.map((s) => JSON.parse(s.body));
    expect(d[0].allowed_mentions).toEqual({ parse: [] });
    expect(d[0].content).toContain('New task');
    expect(d[0].content).toContain('Fix the \\*door\\*');
    expect(d[0].content).toContain(`http://tracker.test/card/`);
    expect(d[1].content).toContain('Done');
    expect(d[2].content).toContain('Comment');
    const s = slack.map((x) => JSON.parse(x.body));
    expect(s[0].text).toContain('New task');
    expect(s[2].text).toContain('&lt;!channel&gt;');
    expect(s[2].text).not.toContain('<!channel>');
    expect(seq).toBeGreaterThan(0);
    // Each event goes out once.
    await (app as any).integrations.flush();
    expect(seen.filter((x) => x.method === 'POST')).toHaveLength(6);
    // A new milestone of the project goes to both.
    await ok('milestones/create', { name: 'Beta <3', date: '2027-01-15', startDate: null, color: MILESTONE_COLOR, isGlobal: false, projectIds: [projectId] });
    await (app as any).integrations.flush();
    const last = seen.slice(-2).map((x) => JSON.parse(x.body));
    expect(last[0].content ?? last[1].content).toBe('**New milestone**: Beta <3 (2027-01-15)');
    expect(last[0].text ?? last[1].text).toBe('*New milestone*: Beta &lt;3 (2027-01-15)');
  });

  it('only chosen projects, only comment threads, only live tasks', async () => {
    await setupDiscord({ projectNotifications: [{ projectId, webhookUrl: DISCORD_WEBHOOK }] });
    await ok('integrations/updateSlack', { webhookUrl: SLACK_WEBHOOK, projectIds: [projectId] });
    // Another project nobody chose: nothing about it goes anywhere.
    const other = (await ok('projects/create', { name: 'Secret' })).id;
    const otherDeck = (await ok('decks/create', { title: 'Hidden', projectId: other })).id;
    const hidden = (await ok('cards/create', { deckId: otherDeck, content: 'Secret plan' })).id;
    await ok('resolvables/create', { cardId: hidden, context: 'comment', content: 'psst' });
    // In the chosen project: a blocker is not a "comment" (a review thread goes the same way: context != 'comment').
    const { id } = await ok('cards/create', { deckId, content: 'Visible' });
    await ok('resolvables/create', { cardId: id, context: 'block', content: 'Blocked' });
    // A comment on an archived card is not news either.
    const archived = (await ok('cards/create', { deckId, content: 'Old one' })).id;
    db.prepare("UPDATE cards SET visibility='archived' WHERE id=?").run(archived);
    await ok('resolvables/create', { cardId: archived, context: 'comment', content: 'late note' });
    await (app as any).integrations.flush();
    const bodies = seen.map((x) => x.body).join('\n');
    expect(bodies).not.toContain('Secret');
    expect(bodies).not.toContain('psst');
    expect(bodies).not.toContain('Blocked');
    expect(bodies).not.toContain('late note');
    // Only the two "New card" posts per integration (Visible, Old one, made before it was archived).
    expect(seen.filter((x) => x.path.startsWith('/api/webhooks/'))).toHaveLength(2);
    expect(seen.filter((x) => x.path.startsWith('/services/'))).toHaveLength(2);
  });

  it('a burst queues up to the cap for each integration (one cannot starve the other)', async () => {
    await setupDiscord({ projectNotifications: [{ projectId, webhookUrl: DISCORD_WEBHOOK }] });
    await ok('integrations/updateSlack', { webhookUrl: SLACK_WEBHOOK, projectIds: [projectId] });
    await ok('cards/bulkImport', { deckId, cards: Array.from({ length: 30 }, (_, i) => ({ content: `Bulk ${i}` })) });
    const counts = db.prepare('SELECT kind, COUNT(*) n FROM integration_outbox GROUP BY kind ORDER BY kind').all();
    expect(counts).toEqual([{ kind: 'discord', n: 20 }, { kind: 'slack', n: 20 }]);
  });

  it('a failed post is retried later; nothing goes out while the workspace is disabled', async () => {
    await ok('integrations/updateSlack', { webhookUrl: SLACK_WEBHOOK, projectIds: [projectId] });
    failNext = 1;
    await ok('cards/create', { deckId, content: 'Retry me' });
    await (app as any).integrations.flush();
    expect(seen).toHaveLength(1);
    const row = db.prepare('SELECT status, attempts FROM integration_outbox').get() as any;
    expect(row).toEqual({ status: 'pending', attempts: 1 });
    // Later (past the backoff), while the workspace is disabled: nothing.
    db.prepare('UPDATE account SET is_disabled=1').run();
    await (app as any).integrations.flush(Date.now() + 3600e3);
    expect(seen).toHaveLength(1);
    db.prepare('UPDATE account SET is_disabled=0').run();
    await (app as any).integrations.flush(Date.now() + 3600e3);
    expect(seen).toHaveLength(2);
    expect(db.prepare('SELECT status FROM integration_outbox').get()).toEqual({ status: 'sent' });
  });

  it('webhook URLs must have the expected shape', async () => {
    for (const webhookUrl of ['https://evil.test/services/T1/B1/x', 'http://hooks.slack.com/services/T1/B1/abc', 'https://hooks.slack.com.evil.test/services/T1/B1/abc', 'https://hooks.slack.com/other']) {
      const r = await json(owner, '/dispatch/integrations/updateSlack', { webhookUrl });
      expect(r.statusCode, webhookUrl).toBe(400);
    }
    const r = await json(owner, '/dispatch/integrations/updateDiscord', { projectNotifications: [{ projectId, webhookUrl: 'https://discordapp.evil/api/webhooks/1/x' }] });
    expect(r.statusCode).toBe(400);
  });
});

// ---- the outbound client ----
describe('outbound client', () => {
  it('outbound to a host outside the allow-list → refused', async () => {
    const client = new OutboundClient();
    for (const url of ['https://example.com/x', 'http://discord.com/api', 'https://discord.com:8443/api', 'https://user:pw@discord.com/api', 'https://discord.com.evil.test/api', 'https://127.0.0.1/']) {
      await expect(client.request(url, { method: 'GET' }), url).rejects.toMatchObject({ kind: 'refused' });
    }
    await expect(client.request('https://example.com/x', { method: 'GET' })).rejects.toBeInstanceOf(OutboundError);
    expect([...ALLOWED_HOSTS].sort()).toEqual(['api.hacknplan.com', 'api.stripe.com', 'discord.com', 'hooks.slack.com', 'slack.com']);
    // The test seam only points allowed hosts at loopback addresses.
    expect(() => new OutboundClient({ mocks: { 'discord.com': 'https://example.com' } })).toThrow();
    expect(() => new OutboundClient({ mocks: { 'example.com': mockUrl } as any })).toThrow();
  });

  it('under test an allowed host without a mock is refused, never called', async () => {
    const client = new OutboundClient();
    await expect(client.request('https://discord.com/api/x', { method: 'GET' })).rejects.toMatchObject({ kind: 'refused', message: expect.stringContaining('no mock') });
    await expect(client.request('https://api.stripe.com/v1/x', { method: 'GET' })).rejects.toMatchObject({ kind: 'refused' });
  });
});

// ---- secrets at rest ----
describe('secrets', () => {
  it('secrets are encrypted in the DB', async () => {
    await setupDiscord({ projectNotifications: [{ projectId, webhookUrl: DISCORD_WEBHOOK }] });
    await ok('integrations/updateSlack', { signingSecret: SIGNING, botToken: SLACK_BOT, webhookUrl: SLACK_WEBHOOK });
    const plain = [BOT_TOKEN, SIGNING, SLACK_BOT, DISCORD_WEBHOOK, SLACK_WEBHOOK, 'w'.repeat(68)];
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
      for (const p of plain) expect(dump.includes(p), `${t} holds a secret in plain text`).toBe(false);
    }
    expect((db.prepare('SELECT COUNT(*) n FROM integration_secrets').get() as any).n).toBe(5);
    // The settings read says only set / not set.
    const r = await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: owner } });
    expect(r.statusCode).toBe(200);
    for (const p of plain) expect(r.body.includes(p)).toBe(false);
    const s = r.json();
    expect(s.discord.botTokenSet).toBe(true);
    expect(s.discord.projectNotifications).toEqual([{ projectId, webhookSet: true }]);
    expect(s.slack).toMatchObject({ signingSecretSet: true, botTokenSet: true, webhookSet: true });
    // Another server secret can't read them: a new app with a different secret sees them as unreadable, not as values.
    await app.close();
    app = buildApp({ db, hosts: [HOST], email: { publicUrl: 'http://tracker.test', secret: 'some-other-secret-0123456789' } });
    const again = (await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: owner } })).json();
    expect(again.slack.signingSecretSet).toBe(false);
    // Clearing removes the row.
    app = (await app.close(), buildApp({ db, hosts: [HOST], email: { publicUrl: 'http://tracker.test', secret: SECRET } }));
    await ok('integrations/updateSlack', { signingSecret: null });
    expect((db.prepare('SELECT COUNT(*) n FROM integration_secrets').get() as any).n).toBe(4);
  });

  it('only admins with a session change integrations; tokens never', async () => {
    expect(TOKEN_DENIED_NAMESPACES.has('integrations')).toBe(true);
    const member = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'m2@x.io','M','x',0)").run(member);
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?,'member')").run(member);
    const t = 'membersession0123456789';
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(t).digest('hex'), member, Date.now() + 3600e3);
    const r = await json(`jt_session=${t}`, '/dispatch/integrations/updateSlack', { signingSecret: SIGNING });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: `jt_session=${t}` } })).statusCode).toBe(403);
    expect((await json(`jt_session=${t}`, '/dispatch/integrations/registerDiscordCommands', {})).statusCode).toBe(403);
  });

  it('the disabled workspace answers 423 on the integration endpoints', async () => {
    await setupDiscord();
    db.prepare('UPDATE account SET is_disabled=1').run();
    expect((await discordReq({ id: '1', type: 1 })).statusCode).toBe(423);
    expect((await slackReq(addcard('x'))).statusCode).toBe(423);
  });
});

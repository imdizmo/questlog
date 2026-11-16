import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, now, _resetLimiter } from '../server/auth';
import { seatsInUse } from '../server/billing';
import { TOKEN_DENIED_NAMESPACES } from '../server/tokens';
import { deleteWorkspace, disabledGate, EXIT_OPTIONS } from '../server/commands/dangerZone';

const HOST = 'localhost:8780';
const ORIGIN = 'http://localhost:8780';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
let db: Db;
let app: ReturnType<typeof buildApp>;
let port = 0;
let webRoot = '';
let owner = '';
let ownerId = '';

const json = { host: HOST, 'content-type': 'application/json' };
const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
function mkUser(role: string, email = `${newId()}@x.io`, password = 'pw-user'): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, email, role, hashPassword(password));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
function cookieFor(userId: string): string {
  const t = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(t), userId, now() + 3600e3);
  return `jt_session=${t}`;
}
const send = (cmd: string, payload: unknown, cookie = owner, bearer?: string) => app.inject({
  method: 'POST', url: `/dispatch/${cmd}`, payload: payload as any,
  headers: { ...json, ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }) },
});
const get = (url: string, cookie = owner, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...extra } });
const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/login', payload: { email, password }, headers: json });
const isDisabled = () => (db.prepare('SELECT is_disabled d FROM account').get() as { d: number }).d === 1;

/** Opens a websocket and resolves with how it ended: the close code, or the HTTP status of a refused upgrade. */
function wsOutcome(path: string, cookie: string): { opened: Promise<boolean>; ended: Promise<number> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Host: HOST, Cookie: cookie, Origin: ORIGIN } });
  ws.on('error', () => {});
  return {
    opened: new Promise((res) => { ws.on('open', () => res(true)); ws.on('unexpected-response', () => res(false)); ws.on('close', () => res(false)); }),
    ended: new Promise((res) => { ws.on('close', (code) => res(code)); ws.on('unexpected-response', (_q, r) => { res(r.statusCode ?? 0); ws.terminate(); }); }),
  };
}

async function start(extra: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<void> {
  app = buildApp({ db, hosts: [HOST], webRoot, ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  webRoot = mkdtempSync(join(base, 'danger-zone-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Jatify</title>');
  writeFileSync(join(webRoot, 'app.js'), 'console.log(1)');
  await start();
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  owner = cookieOf(r);
  ownerId = r.json().user.id;
});
afterEach(async () => {
  await app.close();
  rmSync(webRoot, { recursive: true, force: true });
});

describe('exit options', () => {
  it('lists our own reasons, each with a follow-up question', async () => {
    const r = await get('/api/exit-options');
    expect(r.statusCode).toBe(200);
    const ids = r.json().options.map((o: { id: string }) => o.id);
    expect(ids).toEqual(['havingTrouble', 'foundAlternative', 'tooExpensive', 'projectEnded', 'other']);
    for (const o of r.json().options) {
      expect(typeof o.label).toBe('string');
      expect(o.followUp).toMatch(/\?$/);
    }
    expect(EXIT_OPTIONS.length).toBe(5);
    expect((await get('/api/exit-options', '')).statusCode).toBe(401);
  });
});

describe('danger zone', () => {
  it('disable needs owner and a reason', async () => {
    expect(TOKEN_DENIED_NAMESPACES.has('dangerZone')).toBe(true);
    const admin = cookieFor(mkUser('admin'));
    const member = cookieFor(mkUser('member'));
    expect((await send('dangerZone/disable', { reason: 'other' }, admin)).statusCode).toBe(403);
    expect((await send('dangerZone/disable', { reason: 'other' }, member)).statusCode).toBe(403);
    expect((await send('dangerZone/disable', {}, owner)).statusCode).toBe(400);
    expect((await send('dangerZone/disable', { reason: 'bored' }, owner)).statusCode).toBe(400);
    expect((await send('dangerZone/disable', { reason: 'other', detail: 'x'.repeat(5000) }, owner)).statusCode).toBe(400);
    expect((await send('dangerZone/nope', {}, owner)).statusCode).toBe(404);
    // An owner's API token never reaches the danger zone.
    const token = (await send('apiTokens/create', { kind: 'user', label: 'AI', role: 'admin', access: 'write', projectIds: [] })).json().payload.token;
    const viaToken = await send('dangerZone/disable', { reason: 'other' }, '', token);
    expect(viaToken.statusCode).toBe(403);
    expect(viaToken.json().error).toBe('missing_scope');
    expect(isDisabled()).toBe(false);

    const r = await send('dangerZone/disable', { reason: 'projectEnded', detail: 'The game shipped.' });
    expect(r.statusCode, r.body).toBe(200);
    expect(isDisabled()).toBe(true);
    const row = db.prepare('SELECT disabled_reason r FROM account').get() as { r: string };
    expect(JSON.parse(row.r)).toMatchObject({ reason: 'projectEnded', detail: 'The game shipped.' });
    // Data is kept.
    expect((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(3);
  });

  it('after disable: member login → 423, API token → 423, MCP → 423, report → 423, room connect closed, Open List page → 404', async () => {
    mkUser('member', 'm@x.io', 'pw-member');
    const member = cookieFor(mkUser('member'));
    const token = (await send('apiTokens/create', { kind: 'user', label: 'AI', role: 'admin', access: 'write', projectIds: [] })).json().payload.token;
    const projectId = (await send('projects/create', { name: 'P' })).json().payload.id;
    const deckId = (await send('decks/create', { title: 'D', projectId })).json().payload.id;
    const cardId = (await send('cards/create', { deckId, content: 'Task' })).json().payload.id;
    const board = await send('visionBoard/createBoard', { cardId });
    expect(board.statusCode, board.body).toBe(200);
    const boardId = board.json().payload.id as string;

    // Sockets open before the switch are closed with their own code.
    const push = wsOutcome('/api/push', member);
    expect(await push.opened).toBe(true);
    const room = wsOutcome(`/api/rooms/vision-board/${boardId}`, owner);
    expect(await room.opened).toBe(true);

    expect((await send('dangerZone/disable', { reason: 'tooExpensive' })).statusCode).toBe(200);
    expect(await push.ended).toBe(4423);
    expect(await room.ended).toBe(4423);

    const locked = (r: { statusCode: number; json(): any }) => { expect(r.statusCode).toBe(423); expect(r.json().error).toBe('workspace_disabled'); };
    // Logins: members are refused (no session is made), the owner gets in to reactivate.
    const ml = await login('m@x.io', 'pw-member');
    locked(ml);
    expect(ml.cookies.find((c: any) => c.name === 'jt_session')).toBeUndefined();
    expect((await login('m@x.io', 'wrong')).statusCode).toBe(401);
    const ol = await login('o@x.io', 'pw-owner');
    expect(ol.statusCode).toBe(200);
    expect(ol.json().workspaceDisabled).toBe(true);
    const owner2 = cookieOf(ol);
    // Every entry point, for members and the owner alike.
    for (const c of [member, owner, owner2]) {
      locked(await get('/api/snapshot', c));
      locked(await send('cards/create', { deckId, content: 'x' }, c));
      locked(await app.inject({ method: 'POST', url: '/api/query', payload: { query: { _root: [{ cards: ['title'] }] } }, headers: { ...json, cookie: c } }));
      locked(await get(`/api/cards/1`, c));
      locked(await get('/api/activity', c));
      locked(await get('/api/files/x', c));
      locked(await get('/api/covers/x', c));
      locked(await get('/api/invites', c));
      locked(await get('/api/exit-options', c));
      locked(await send('billing/listInvoices', {}, c));
      locked(await send('dangerZone/disable', { reason: 'other' }, c));
    }
    locked(await get('/api/%73napshot', member)); // an encoded path still routes, and is still gated
    // API tokens and MCP.
    locked(await get('/api/snapshot', '', { authorization: `Bearer ${token}` }));
    locked(await send('cards/create', { deckId, content: 'x' }, '', token));
    locked(await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { ...json, authorization: `Bearer ${token}` } }));
    // User reports (game builds) and integrations webhooks.
    locked(await app.inject({ method: 'POST', url: '/user-report/v1/create-report', payload: { content: 'x' }, headers: { ...json, authorization: 'Bearer jtrt_x' } }));
    locked(await app.inject({ method: 'POST', url: '/integrations/github/abc', payload: {}, headers: json }));
    // Invite links can't add anyone.
    locked(await get('/api/invites/abc', ''));
    // New sockets are refused at the upgrade.
    expect(await wsOutcome('/api/push', owner2).ended).toBe(423);
    expect(await wsOutcome(`/api/rooms/vision-board/${boardId}`, owner2).ended).toBe(423);
    // Open Deck pages and their API: gone.
    expect((await app.inject({ method: 'POST', url: '/dispatch/open/signUp', payload: {}, headers: json })).statusCode).toBe(404);
    expect((await get('/open/my-game', '')).statusCode).toBe(404);
    expect((await get('/api/open/my-game', '')).statusCode).toBe(404);
    // The app shell and static files stay, so the reactivate screen can render; status says why.
    const shell = await get('/decks', '');
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain('Jatify');
    expect((await get('/app.js', '')).statusCode).toBe(200);
    const status = await get('/api/status', '');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ setup: true, disabled: true });
    // Logging out still works.
    expect((await app.inject({ method: 'POST', url: '/api/logout', headers: { host: HOST, cookie: member } })).statusCode).toBe(200);
  });

  it('owner can reactivate', async () => {
    const memberId = mkUser('member', 'm@x.io', 'pw-member');
    const member = cookieFor(memberId);
    expect((await send('dangerZone/disable', { reason: 'havingTrouble', detail: 'Too slow' })).statusCode).toBe(200);
    // Not with a member session, and not anonymously.
    expect((await send('dangerZone/reactivate', {}, member)).statusCode).toBe(403);
    expect((await send('dangerZone/reactivate', {}, '')).statusCode).toBe(401);
    expect(isDisabled()).toBe(true);
    // From the login screen: the owner signs in, then reactivates.
    const ol = await login('o@x.io', 'pw-owner');
    const r = await send('dangerZone/reactivate', {}, cookieOf(ol));
    expect(r.statusCode, r.body).toBe(200);
    expect(isDisabled()).toBe(false);
    expect((db.prepare('SELECT disabled_reason r FROM account').get() as { r: string | null }).r).toBe(null);
    expect((await get('/api/snapshot', member)).statusCode).toBe(200);
    expect((await login('m@x.io', 'pw-member')).statusCode).toBe(200);
    expect((await get('/api/status', '')).json()).toEqual({ setup: true, disabled: false });
    // Reactivating an active workspace changes nothing.
    expect((await send('dangerZone/reactivate', {})).statusCode).toBe(200);
  });

  it('stripe mode: disable cancels the subscription at the period end, reactivate resumes it', async () => {
    const seen: { method: string; path: string; form: URLSearchParams }[] = [];
    const readBody = (req: IncomingMessage) => new Promise<string>((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
    const stripe: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: url.pathname, form: new URLSearchParams(await readBody(req)) });
      res.writeHead(url.pathname === '/v1/subscriptions/sub_1' ? 200 : url.pathname === '/v1/subscriptions/sub_err' ? 400 : 404, { 'content-type': 'application/json' });
      res.end(url.pathname === '/v1/subscriptions/sub_1' ? '{"id":"sub_1"}' : '{"error":{"message":"no"}}');
    });
    await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', () => r()));
    try {
      await app.close();
      await start({ billing: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x', baseUrl: `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`, prices: {} } });
      db.prepare("UPDATE account SET plan_type='pro', plan_status='active', stripe_customer_id='cus_1', stripe_subscription_id='sub_1'").run();
      expect((await send('dangerZone/disable', { reason: 'foundAlternative' })).statusCode).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/subscriptions/sub_1' });
      expect(seen[0].form.get('cancel_at_period_end')).toBe('true');
      expect(isDisabled()).toBe(true);
      const r = await send('dangerZone/reactivate', {});
      expect(r.statusCode).toBe(200);
      expect(r.json().payload.subscriptionResumed).toBe(true);
      expect(seen[1].form.get('cancel_at_period_end')).toBe('false');

      // A subscription Stripe no longer knows (404): nothing left to bill, so disabling goes ahead.
      db.prepare("UPDATE account SET stripe_subscription_id='sub_gone'").run();
      expect((await send('dangerZone/disable', { reason: 'other' })).statusCode).toBe(200);
      expect(isDisabled()).toBe(true);
      expect((await send('dangerZone/reactivate', {})).statusCode).toBe(200);

      // Any other refusal: nothing is disabled (the owner would otherwise keep paying for a closed workspace).
      db.prepare("UPDATE account SET stripe_subscription_id='sub_err'").run();
      const failed = await send('dangerZone/disable', { reason: 'other' });
      expect(failed.statusCode).toBe(502);
      expect(isDisabled()).toBe(false);
    } finally {
      await new Promise<void>((r) => stripe.close(() => r()));
    }
  });
});

describe('deleting a workspace (CLI)', () => {
  it('only a disabled, stopped workspace with its name repeated; only its own blobs go, other files survive', () => {
    const dir = mkdtempSync(join(homedir(), '.cache/gametracker/scratch', 'delete-ws-'));
    try {
      const path = join(dir, 'jt.db');
      const files = join(dir, 'files');
      mkdirSync(join(files, 'covers'), { recursive: true });
      const fileId = newId();
      const coverId = newId();
      writeFileSync(join(files, fileId), 'attachment');
      writeFileSync(join(files, 'covers', coverId), 'cover');
      writeFileSync(join(files, 'someone-elses.bin'), 'keep me'); // not this workspace's
      writeFileSync(join(dir, 'outside.txt'), 'keep me too');
      const d = openDb(path);
      const accountId = newId();
      d.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'Studio','{}',0)").run(accountId);
      const owner = newId();
      d.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'o@x.io','O','x',0)").run(owner);
      const project = newId();
      d.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,1,?,?,0,?,0)')
        .run(project, 'P', 'full', JSON.stringify([{ id: 1, name: 'Main', icon: null, defaultDeckType: 'task' }]));
      const deck = newId();
      d.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES (?,2,?,1,'D','task',0)").run(deck, project);
      const card = newId();
      d.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,visibility,master_tags_json,created_at,last_updated_at) VALUES (?,3,?,?,'C','default','[]',0,0)").run(card, deck, owner);
      const fileCols = (d.prepare('PRAGMA table_info(files)').all() as { name: string; notnull: number; dflt_value: unknown }[]);
      const insertFile = (id: string) => {
        const vals: Record<string, unknown> = { id, card_id: card, uploader_id: owner, name: 'a.bin', mime: 'application/octet-stream', size: 1, created_at: 0 };
        const cols = fileCols.filter((c) => c.name in vals || (c.notnull && c.dflt_value === null)).map((c) => c.name);
        d.prepare(`INSERT INTO files (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => (vals[c] ?? '') as any));
      };
      insertFile(fileId);
      insertFile('../outside.txt'); // a row whose id would leave the folder: refused
      insertFile(newId()); // a row whose blob is already gone
      d.prepare("INSERT INTO covers (id,project_id,mime,size,created_at) VALUES (?,?,'image/png',1,0)").run(coverId, project);
      d.close();

      expect(() => deleteWorkspace(path, files, 'Studio')).toThrow(/still active/);
      const d2 = openDb(path);
      d2.prepare('UPDATE account SET is_disabled=1').run();
      // A server holding the database open: refused, nothing removed.
      d2.prepare('SELECT 1 FROM account').get();
      expect(() => deleteWorkspace(path, files, 'Studio')).toThrow(/Stop the server/);
      d2.close();
      expect(() => deleteWorkspace(path, files, undefined)).toThrow(/--confirm "Studio"/);
      expect(() => deleteWorkspace(path, files, 'studio')).toThrow();
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(files, fileId))).toBe(true);

      const r = deleteWorkspace(path, files, 'Studio');
      expect(r).toEqual({ removed: 2, missing: 1, refused: 1, unknown: 1 });
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(join(files, fileId))).toBe(false);
      expect(existsSync(join(files, 'covers', coverId))).toBe(false);
      expect(existsSync(join(files, 'covers'))).toBe(false); // emptied, so removed
      expect(existsSync(join(files, 'someone-elses.bin'))).toBe(true);
      expect(existsSync(join(dir, 'outside.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the gate judges every path form', () => {
  it('table', () => {
    const cases: [string, string][] = [
      ['/api/status', 'pass'], ['/api/login', 'pass'], ['/dispatch/dangerZone/reactivate', 'pass'], ['/api/billing/stripe-webhook', 'pass'],
      ['/api/snapshot', 'locked'], ['/dispatch/dangerZone/:action', 'locked'], ['/dispatch/dangerZone/reactivate;x', 'locked'],
      ['/dispatch/dangerZone/%72eactivate', 'locked'], ['/mcp', 'locked'], ['/user-report/v1/create-report', 'locked'],
      ['/integrations', 'locked'], ['/integrations/slack/commands', 'locked'], ['/open', 'hidden'], ['/open/x', 'hidden'],
      ['/api/open/x', 'hidden'], ['/dispatch/open/signUp', 'hidden'], ['/dispatch/open/signUp/', 'hidden'], ['/dispatch/open/other', 'locked'], ['/', 'pass'], ['/decks', 'pass'], ['/assets/app.js', 'pass'],
      ['/mcpx', 'pass'], ['/integrations.png', 'pass'], ['/opener', 'pass'],
    ];
    for (const [path, want] of cases) expect(disabledGate(path), path).toBe(want);
  });

  it('odd request forms stay locked', async () => {
    const member = cookieFor(mkUser('member'));
    expect((await send('dangerZone/disable', { reason: 'other' })).statusCode).toBe(200);
    for (const [method, url] of [['HEAD', '/api/snapshot'], ['GET', '/api/snapshot/'], ['POST', '/dispatch/dangerZone/%72eactivate'], ['POST', '/dispatch/dangerZone/reactivate;x']] as const) {
      const r = await app.inject({ method, url, headers: { host: HOST, cookie: member, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(423);
    }
    // Forms the router doesn't resolve reach only the app shell, never workspace data.
    for (const url of ['//api/snapshot', '/API/snapshot']) {
      const r = await get(url, member);
      expect(r.body, url).not.toContain('"projects"');
    }
    expect(isDisabled()).toBe(true);
  });
});

describe('guest role', () => {
  it("guest session can't load the snapshot or dispatch task commands", async () => {
    const projectId = (await send('projects/create', { name: 'P' })).json().payload.id;
    const deckId = (await send('decks/create', { title: 'D', projectId })).json().payload.id;
    await send('cards/create', { deckId, content: 'Secret' });
    const guestId = mkUser('guest', 'g@x.io', 'pw-guest');
    const guest = cookieFor(guestId);
    const refused = (r: { statusCode: number; json(): any }) => { expect(r.statusCode).toBe(403); expect(r.json().error).toBe('forbidden'); };
    refused(await get('/api/snapshot', guest));
    refused(await send('cards/create', { deckId, content: 'x' }, guest));
    refused(await send('users/update', { id: guestId, timezone: 'Europe/Berlin' }, guest));
    refused(await send('apiTokens/create', { kind: 'user', label: 'AI', role: 'admin', access: 'write', projectIds: [] }, guest));
    refused(await app.inject({ method: 'POST', url: '/api/query', payload: { query: { _root: [{ cards: ['title'] }] } }, headers: { ...json, cookie: guest } }));
    refused(await get('/api/cards/1', guest));
    refused(await get('/api/activity', guest));
    refused(await get('/api/mcp/usage', guest));
    refused(await get('/api/exit-options', guest));
    expect(await wsOutcome('/api/push', guest).ended).toBe(4403);
    // A guest row given project access by hand still sees nothing.
    db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(projectId, guestId);
    refused(await get('/api/snapshot', guest));
    // Never a seat, never in member lists or pickers, never assignable or granted access.
    expect(seatsInUse(db)).toBe(1);
    const snap = (await get('/api/snapshot')).json();
    expect(snap.users.map((u: { id: string }) => u.id)).not.toContain(guestId);
    expect(snap.accountRoles.map((r: { userId: string }) => r.userId)).not.toContain(guestId);
    const q = await app.inject({ method: 'POST', url: '/api/query', payload: { query: { _root: [{ users: ['name'] }] } }, headers: { ...json, cookie: owner } });
    expect(q.statusCode, q.body).toBe(200);
    expect(JSON.stringify(q.json())).not.toContain(guestId);
    expect((await send('projects/setAccess', { projectId, userId: guestId, access: 'member' })).statusCode).toBe(404);
    expect((await send('users/setRole', { userId: guestId, role: 'member' })).statusCode).toBe(404);
    expect((await send('cards/create', { deckId, content: 'x', assigneeId: guestId })).statusCode).toBe(400);
    expect(ownerId).toBeTruthy();
  });
});

describe('Danger Zone screens', () => {
  it('render: the settings tab and the reactivate screen', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { DangerZonePanel, WorkspaceDisabled } = await import('../web/src/views/settings/DangerZone');
    const tab = renderToStaticMarkup(createElement(DangerZonePanel, { owner: false }));
    expect(tab).toContain('Every project, task and file is kept.');
    expect(tab).toContain('Only the workspace owner can disable it.');
    expect(tab).not.toContain('Disable workspace…');
    expect(renderToStaticMarkup(createElement(DangerZonePanel, { owner: true }))).toContain('Disable workspace…');
    const screen = renderToStaticMarkup(createElement(WorkspaceDisabled));
    expect(screen).toContain('This workspace is disabled');
    expect(screen).toContain('Reactivate workspace');
  });
});

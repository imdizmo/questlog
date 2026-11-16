import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openDb, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { setClock, _resetLimiter } from '../server/auth';
import { pendingReportEmails, REPORT_BUDGET, REPORT_LIMITS } from '../server/reports';
import { can, systemActor } from '../server/permissions';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

const HOST = 'localhost:8780';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
let db: Db;
let app: FastifyInstance;
let dir: string;
let owner: string;
let projectId: string;
let deckId: string;
let t0: number;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const json = { host: HOST, 'content-type': 'application/json' };
const send = (name: string, payload: unknown, cookie = owner) =>
  app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { ...json, cookie } });
const ok = async (name: string, payload: unknown, cookie = owner) => {
  const r = await send(name, payload, cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const report = (token: string, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/user-report/v1/create-report?token=${encodeURIComponent(token)}`, payload: body as any, headers: { ...json, ...extra } });
const mintToken = (accessKey: string, label: string) =>
  app.inject({ method: 'POST', url: `/user-report/v1/create-report-token?accessKey=${encodeURIComponent(accessKey)}`, payload: { label }, headers: json });
const put = (url: string, body: Buffer, type = 'image/png') =>
  app.inject({ method: 'PUT', url, payload: body, headers: { host: HOST, 'content-type': type } });
const card = (id: string) => db.prepare('SELECT * FROM cards WHERE id=?').get(id) as Record<string, any>;
const settings = async () => {
  const r = await app.inject({ method: 'GET', url: '/api/user-reports', headers: { host: HOST, cookie: owner } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

/** Sets up user reports into `deckId`; returns the one-time access key and default token. */
const setup = async () => ok('userReports/setup', { name: 'Star Cave', deckId }) as Promise<{ accessKey: string; token: string }>;

beforeEach(async () => {
  _resetLimiter();
  t0 = Date.now();
  setClock(() => t0);
  dir = join(homedir(), '.cache/gametracker/scratch', `reports-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 50 });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw-owner' }, headers: json });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'Reports', projectId })).id;
});
afterEach(async () => {
  setClock(() => Date.now());
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('user reports', () => {
  it('create-report creates a task in the list mapped by severity, tagged with the token label, priority from severity', async () => {
    const critical = (await ok('decks/create', { title: 'Crashes', projectId })).id;
    const { token } = await setup();
    await ok('userReports/update', { severityDecks: { critical }, severityPriority: true });

    const r = await report(token, { content: 'Game crashes on load\nWhen I press start.', severity: 'critical' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const body = r.json();
    expect(body).toEqual({ ok: true, cardId: expect.any(String), uploadUrls: [] });
    const c = card(body.cardId);
    expect(c.deck_id).toBe(critical);
    expect(c.content).toBe('Game crashes on load\nWhen I press start.');
    expect(JSON.parse(c.master_tags_json)).toEqual(['default']);
    expect(c.priority).toBe('a');
    expect(c.creator_id).toBe('system');
    const tags = JSON.parse((db.prepare('SELECT tags_json t FROM projects WHERE id=?').get(projectId) as { t: string }).t);
    expect(tags.map((t: { name: string }) => t.name)).toContain('default');
    const hist = db.prepare('SELECT changer_id FROM card_history WHERE card_id=?').all(body.cardId) as { changer_id: string }[];
    expect(hist.map((h) => h.changer_id)).toEqual(['system']);

    // Unmapped severity: the main deck. Low → priority c; no severity → no priority.
    const low = card((await report(token, { content: 'Typo', severity: 'low' })).json().cardId);
    expect(low.deck_id).toBe(deckId);
    expect(low.priority).toBe('c');
    const high = card((await report(token, { content: 'Slow', severity: 'high' })).json().cardId);
    expect(high.priority).toBe('a');
    const none = card((await report(token, { content: 'Idea' })).json().cardId);
    expect(none.priority).toBe(null);

    // A labelled token tags its reports with the label (as a project tag); with the switch off severity sets nothing.
    const created = await ok('userReports/createToken', { label: 'Beta Testers' });
    await ok('userReports/update', { severityPriority: false });
    const beta = card((await report(created.token, { content: 'Beta bug', severity: 'low' })).json().cardId);
    expect(JSON.parse(beta.master_tags_json)).toEqual(['beta-testers']);
    expect(beta.priority).toBe(null);
  });

  it('disabled token → 403', async () => {
    const { token } = await setup();
    const id = (await settings()).tokens[0].id;
    await ok('userReports/setTokenEnabled', { id, enabled: false });
    const r = await report(token, { content: 'Bug' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('token_disabled');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect((await report('jtrt_' + 'x'.repeat(43), { content: 'Bug' })).statusCode).toBe(401);
    await ok('userReports/setTokenEnabled', { id, enabled: true });
    expect((await report(token, { content: 'Bug' })).statusCode).toBe(200);
  });

  it('31 reports/min → 429', async () => {
    const { token } = await setup();
    for (let i = 0; i < REPORT_LIMITS.perMinute; i++) {
      const r = await report(token, { content: `Bug ${i}` });
      expect(r.statusCode, r.body).toBe(200);
    }
    const r = await report(token, { content: 'One too many' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('rate_limit');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    t0 += 60_001;
    expect((await report(token, { content: 'Next minute' })).statusCode).toBe(200);
  });

  it('daily budget per token: 500 reports per UTC day → 429 report_budget until midnight; old days pruned', async () => {
    const { token } = await setup();
    const tokenId = (db.prepare('SELECT id FROM report_tokens').get() as { id: string }).id;
    t0 = Date.parse('2026-11-15T23:00:00Z');
    const usage = () => db.prepare('SELECT day, reports, bytes FROM report_token_usage WHERE token_id=? ORDER BY day').all(tokenId);
    db.prepare("INSERT INTO report_token_usage (token_id, day, reports, bytes) VALUES (?, '2026-11-11', 7, 0), (?, '2026-11-15', ?, 0)")
      .run(tokenId, tokenId, REPORT_BUDGET.reports - 1);
    expect((await report(token, { content: 'Last one today' })).statusCode).toBe(200);
    const r = await report(token, { content: 'One too many' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('report_budget');
    expect(r.headers['retry-after']).toBe(String(3600));
    expect(db.prepare('SELECT COUNT(*) n FROM cards').get()).toEqual({ n: 1 });
    // A restart keeps the count: it lives in the database.
    await app.close();
    app = buildApp({ db, hosts: [HOST], filesDir: dir, maxFileMb: 50 });
    expect((await report(token, { content: 'Still today' })).json().error).toBe('report_budget');
    // The next UTC day starts afresh, and its first row prunes days older than two.
    t0 = Date.parse('2026-11-16T00:00:01Z');
    expect((await report(token, { content: 'New day' })).statusCode).toBe(200);
    expect(usage()).toEqual([{ day: '2026-11-15', reports: 500, bytes: 0 }, { day: '2026-11-16', reports: 1, bytes: 0 }]);
  });

  it('daily budget per token: 1 GB of files per UTC day → 429 report_budget; failed uploads give their bytes back', async () => {
    const { token } = await setup();
    const tokenId = (db.prepare('SELECT id FROM report_tokens').get() as { id: string }).id;
    t0 = Date.parse('2026-11-15T23:50:00Z');
    const bytes = () => (db.prepare("SELECT bytes FROM report_token_usage WHERE token_id=? AND day='2026-11-15'").get(tokenId) as { bytes: number }).bytes;
    const r = (await report(token, { content: 'Crash', fileNames: ['a.log', 'b.log', 'c.log', 'd.bin'] })).json();
    db.prepare("UPDATE report_token_usage SET bytes=? WHERE token_id=? AND day='2026-11-15'").run(REPORT_BUDGET.bytes - 100, tokenId);
    const ok1 = await put(r.uploadUrls[0].url, Buffer.alloc(50, 1), 'text/plain');
    expect(ok1.statusCode, ok1.body).toBe(200);
    expect(bytes()).toBe(REPORT_BUDGET.bytes - 50);
    // Declared over what is left: refused before the claim, so the URL still works later.
    const over = await put(r.uploadUrls[1].url, Buffer.alloc(60, 1), 'text/plain');
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('report_budget');
    expect(over.headers['retry-after']).toBe(String(600));
    expect(bytes()).toBe(REPORT_BUDGET.bytes - 50);
    // A refused upload (here: empty) hands its reservation back.
    expect((await put(r.uploadUrls[2].url, Buffer.alloc(0), 'text/plain')).statusCode).toBe(400);
    expect(bytes()).toBe(REPORT_BUDGET.bytes - 50);
    // No declared length: the stream is cut off where the budget ends.
    const streamed = await app.inject({ method: 'PUT', url: r.uploadUrls[2].url, payload: Readable.from([Buffer.alloc(60, 1)]), headers: { host: HOST, 'content-type': 'text/plain' } });
    expect(streamed.statusCode).toBe(429);
    expect(streamed.json().error).toBe('report_budget');
    expect(bytes()).toBe(REPORT_BUDGET.bytes - 50);
    expect((await put(r.uploadUrls[2].url, Buffer.alloc(50, 1), 'text/plain')).statusCode).toBe(200);
    expect(bytes()).toBe(REPORT_BUDGET.bytes);
    // Budget used up: new reports and uploads are refused until the next UTC day.
    expect((await put(r.uploadUrls[3].url, Buffer.alloc(1, 1), 'text/plain')).json().error).toBe('report_budget');
    expect((await report(token, { content: 'More' })).json().error).toBe('report_budget');
    t0 = Date.parse('2026-11-16T00:00:00Z'); // the upload URLs are still within their 15 minutes
    expect((await put(r.uploadUrls[1].url, Buffer.alloc(60, 1), 'text/plain')).statusCode).toBe(200);
    expect((await report(token, { content: 'More' })).statusCode).toBe(200);
  });

  it('content 10001 chars → 400', async () => {
    const { token } = await setup();
    expect((await report(token, { content: 'x'.repeat(10_001) })).statusCode).toBe(400);
    expect((await report(token, { content: '' })).statusCode).toBe(400);
    expect((await report(token, { content: 'x', fileNames: ['1', '2', '3', '4', '5', '6'] })).statusCode).toBe(400);
    expect((await report(token, { content: 'x', userEmail: 'not an email' })).statusCode).toBe(400);
    expect((await report(token, { content: 'x'.repeat(10_000) })).statusCode).toBe(200);
    // Bodies over 64 KB are refused before parsing.
    expect((await report(token, { content: 'x', pad: 'y'.repeat(70_000) })).statusCode).toBe(413);
  });

  it('upload URL works once and expires after 15 min (fake clock)', async () => {
    const { token } = await setup();
    const r = (await report(token, { content: 'With a screenshot', fileNames: ['shot.png', '../log.txt'] })).json();
    expect(r.uploadUrls).toHaveLength(2);
    expect(r.uploadUrls[0]).toEqual({ fileName: 'shot.png', url: expect.stringMatching(/^\/user-report\/v1\/upload\/[A-Za-z0-9_-]{43}$/), fields: {} });
    expect(r.uploadUrls[1].fileName).toBe('..log.txt');

    const up = await put(r.uploadUrls[0].url, PNG);
    expect(up.statusCode, up.body).toBe(200);
    expect(up.headers['access-control-allow-origin']).toBe('*');
    const f = db.prepare('SELECT * FROM files WHERE card_id=?').get(r.cardId) as Record<string, any>;
    expect(f).toMatchObject({ name: 'shot.png', mime: 'image/png', size: PNG.length, uploader_id: 'system' });
    expect(card(r.cardId).cover_file_id).toBe(f.id);
    expect((await put(r.uploadUrls[0].url, PNG)).statusCode).toBe(409);
    // The id in the URL is the secret: only its hash is stored.
    const secret = r.uploadUrls[1].url.split('/').pop();
    expect(db.prepare('SELECT 1 FROM report_uploads WHERE id=?').get(secret)).toBeUndefined();

    t0 += 15 * 60_000 + 1;
    const late = await put(r.uploadUrls[1].url, Buffer.from('log'), 'text/plain');
    expect(late.statusCode).toBe(410);
    expect((await put('/user-report/v1/upload/' + 'a'.repeat(43), PNG)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) n FROM files').get()).toEqual({ n: 1 });
  });

  it('upload: an image type whose bytes are not that image is stored as a plain download; over 10 MB → 413', async () => {
    const { token } = await setup();
    const r = (await report(token, { content: 'x', fileNames: ['fake.png', 'big.bin', 'plain.log'] })).json();
    expect((await put(r.uploadUrls[0].url, Buffer.from('<script>alert(1)</script>'))).statusCode).toBe(200);
    expect((db.prepare('SELECT mime FROM files WHERE card_id=?').get(r.cardId) as { mime: string }).mime).toBe('application/octet-stream');
    const big = await put(r.uploadUrls[1].url, Buffer.alloc(REPORT_LIMITS.fileBytes + 1), 'application/octet-stream');
    expect(big.statusCode).toBe(413);
    // No content-type at all (some HTTP clients send none): a plain download.
    const bare = await app.inject({ method: 'PUT', url: r.uploadUrls[2].url, payload: Buffer.from('log line'), headers: { host: HOST } });
    expect(bare.statusCode, bare.body).toBe(200);
    expect(db.prepare("SELECT mime FROM files WHERE name='plain.log'").get()).toEqual({ mime: 'application/octet-stream' });
  });

  it('create-report-token with the access key returns a working token; wrong key → 403', async () => {
    const { accessKey } = await setup();
    const r = await mintToken(accessKey, 'Steam build');
    expect(r.statusCode, r.body).toBe(200);
    const { ok: done, token } = r.json();
    expect(done).toBe(true);
    expect(token).toMatch(/^jtrt_/);
    const c = card((await report(token, { content: 'From Steam' })).json().cardId);
    expect(JSON.parse(c.master_tags_json)).toEqual(['steam-build']);

    expect((await mintToken('jtrk_' + 'x'.repeat(43), 'Nope')).statusCode).toBe(403);
    expect((await mintToken('', 'Nope')).statusCode).toBe(403);
    // Only hashes are stored.
    expect(db.prepare('SELECT 1 FROM report_tokens WHERE token_hash=?').get(sha(token))).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM report_apps WHERE access_key_hash=?').get(sha(accessKey))).toBeTruthy();
    // Regenerate: the old key stops working.
    const { accessKey: next } = await ok('userReports/regenerateAccessKey', {});
    expect((await mintToken(accessKey, 'Old')).statusCode).toBe(403);
    expect((await mintToken(next, 'New')).statusCode).toBe(200);
  });

  it('done task with userEmail leaves a report_emails row', async () => {
    const { token } = await setup();
    const withMail = (await report(token, { content: 'Bug', userEmail: 'player@example.com' })).json().cardId;
    const without = (await report(token, { content: 'Bug 2' })).json().cardId;
    expect(pendingReportEmails(db)).toEqual([]);
    await ok('cards/update', { id: withMail, status: 'done' });
    await ok('cards/update', { id: without, status: 'done' });
    expect(db.prepare('SELECT card_id, email, notified_at FROM report_emails').all())
      .toEqual([{ card_id: withMail, email: 'player@example.com', notified_at: null }]);
    expect(pendingReportEmails(db)).toEqual([{ cardId: withMail, email: 'player@example.com' }]);
  });

  it('report paths: CORS * and preflight, no origin check, host check kept, never cookie-authenticated', async () => {
    const { token } = await setup();
    const pre = await app.inject({ method: 'OPTIONS', url: '/user-report/v1/create-report?token=x', headers: { host: HOST, origin: 'http://game.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(String(pre.headers['access-control-allow-methods'])).toContain('POST');
    expect(String(pre.headers['access-control-allow-headers'])).toBe('content-type, x-report-token, x-access-key');
    const cross = await report(token, { content: 'From a web build' }, { origin: 'http://game.example', 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode, cross.body).toBe(200);
    expect(cross.headers['content-security-policy']).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: `/user-report/v1/create-report?token=${token}`, payload: { content: 'x' }, headers: { ...json, host: 'evil.example' } })).statusCode).toBe(421);
    // A session cookie is not a report token.
    expect((await report('', { content: 'x' }, { cookie: owner })).statusCode).toBe(401);
    // Other paths keep the origin check and stay without CORS.
    const dispatchCross = await send('cards/create', { content: 'x', deckId }, owner);
    expect(dispatchCross.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('settings: admins only, never through an API token, plain secrets never listed', async () => {
    const { token, accessKey } = await setup();
    expect((await send('userReports/setup', { name: 'Again', deckId })).statusCode).toBe(409);
    const s = await settings();
    expect(s.app).toMatchObject({ name: 'Star Cave', deckId, severityDecks: {}, severityPriority: true });
    expect(s.tokens).toEqual([expect.objectContaining({ label: 'default', enabled: true })]);
    expect(JSON.stringify(s)).not.toContain(token);
    expect(JSON.stringify(s)).not.toContain(accessKey);
    expect(JSON.stringify(s)).not.toContain('Hash');

    // A member can't manage reports.
    const memberId = 'member-1';
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'m@x.io','M','x',0)").run(memberId);
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?,'member')").run(memberId);
    const memberCookie = 'jt_session=member-session';
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha('member-session'), memberId, Date.now() + 3600e3);
    expect((await send('userReports/createToken', { label: 'x' }, memberCookie)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/user-reports', headers: { host: HOST, cookie: memberCookie } })).statusCode).toBe(403);
    const api = await ok('apiTokens/create', { kind: 'user', label: 'CI', role: 'admin', access: 'write', projectIds: [] });
    const viaToken = await app.inject({ method: 'POST', url: '/dispatch/userReports/createToken', payload: { label: 'x' }, headers: { ...json, authorization: `Bearer ${api.token}` } });
    expect(viaToken.statusCode).toBe(403);
    expect(viaToken.json().error).toBe('missing_scope');
    // Doc decks can't receive reports.
    db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES ('doc',999,?,1,'Docs','doc',0)").run(projectId);
    expect((await send('userReports/update', { deckId: 'doc' })).statusCode).toBe(400);
  });

  it('secrets in headers: X-Report-Token and X-Access-Key work; the query parameters still work', async () => {
    const { token, accessKey } = await setup();
    const viaHeader = await app.inject({ method: 'POST', url: '/user-report/v1/create-report', payload: { content: 'Header' }, headers: { ...json, 'x-report-token': token } });
    expect(viaHeader.statusCode, viaHeader.body).toBe(200);
    expect(card(viaHeader.json().cardId).content).toBe('Header');
    expect((await report(token, { content: 'Query' })).statusCode).toBe(200);
    // The header wins over the query parameter.
    const bad = await app.inject({ method: 'POST', url: `/user-report/v1/create-report?token=${token}`, payload: { content: 'x' }, headers: { ...json, 'x-report-token': 'jtrt_' + 'y'.repeat(43) } });
    expect(bad.statusCode).toBe(401);

    const minted = await app.inject({ method: 'POST', url: '/user-report/v1/create-report-token', payload: { label: 'Header build' }, headers: { ...json, 'x-access-key': accessKey } });
    expect(minted.statusCode, minted.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/user-report/v1/create-report-token', payload: { label: 'x' }, headers: { ...json, 'x-access-key': 'jtrk_' + 'z'.repeat(43) } })).statusCode).toBe(403);
    expect((await mintToken(accessKey, 'Query build')).statusCode).toBe(200);
  });

  it('report text cannot @mention members', async () => {
    const { token } = await setup();
    const c = card((await report(token, { content: 'Hey @o look at this' })).json().cardId);
    expect(JSON.parse(c.mentioned_user_ids_json)).toEqual([]);
    // The same text from a member does mention (so the check above means something).
    const own = card((await ok('cards/create', { content: 'Hey @o look at this', deckId })).id);
    expect(JSON.parse(own.mentioned_user_ids_json)).toHaveLength(1);
  });

  it('the system actor may only view and edit content in existing projects', () => {
    const sys = systemActor();
    expect(can(db, sys, 'content.edit', projectId)).toBe(true);
    expect(can(db, sys, 'project.view', projectId)).toBe(true);
    for (const a of ['account.manage', 'user.manage', 'project.create', 'workspace.edit', 'workspace.personal'] as const) expect(can(db, sys, a)).toBe(false);
    expect(can(db, sys, 'project.manage', projectId)).toBe(false);
    expect(can(db, sys, 'content.edit')).toBe(false);
    expect(can(db, sys, 'content.edit', 'no-such-project')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';
import { parseCommitRefs } from '../shared/commitRefs';
import { cardCode } from '../shared/cards';

const HOST = 'localhost:8780';
let db: Db;
let app: ReturnType<typeof buildApp>;
let owner = '';
let deckId = '';
let projectId = '';

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie'] ?? '').split(';')[0];
const json = (cookie: string, url: string, payload: unknown) => app.inject({
  method: 'POST', url, payload: payload as any, headers: { host: HOST, 'content-type': 'application/json', cookie },
});
async function ok(cmd: string, payload: unknown, cookie = owner): Promise<any> {
  const r = await json(cookie, `/dispatch/${cmd}`, payload);
  if (r.statusCode !== 200) throw new Error(`${cmd}: ${r.statusCode} ${r.body}`);
  return r.json().payload;
}
const codeOf = (id: string) => cardCode((db.prepare('SELECT seq FROM cards WHERE id=?').get(id) as { seq: number }).seq);
const history = (id: string) => (db.prepare('SELECT changes_json c FROM card_history WHERE card_id=? ORDER BY version').all(id) as { c: string }[]).flatMap((r) => JSON.parse(r.c));
const status = (id: string) => (db.prepare('SELECT status s FROM cards WHERE id=?').get(id) as { s: string }).s;

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST], email: { publicUrl: 'http://tracker.test', secret: 'integration-test-secret-0123456789' } });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'Bugs', projectId })).id;
});
afterEach(async () => { await app.close(); });

const sig = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const ghPush = (commits: object[]) => JSON.stringify({ commits });
const commit = (message: string, over: object = {}) => ({ id: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', message, url: 'https://git.example/c/a1b2c3d', author: { name: 'Dev One', email: 'dev@x.io' }, ...over });

function gh(hook: { id: string; secret: string }, body: string, over: { sig?: string; event?: string; delivery?: string } = {}) {
  return app.inject({
    method: 'POST', url: `/integrations/github/${hook.id}`, payload: body,
    headers: {
      host: HOST, 'content-type': 'application/json', 'x-github-event': over.event ?? 'push',
      'x-hub-signature-256': over.sig ?? sig(hook.secret, body), ...(over.delivery ? { 'x-github-delivery': over.delivery } : {}),
    },
  });
}

describe('parseCommitRefs', () => {
  it('finds $codes and commands, skips URLs', () => {
    const r = parseCommitRefs('Fix door $110 and $11a\n\nCloses $11c, review $11e. See https://x.example/a$11f and http://y.example/?q=$11g');
    expect(r.refs).toEqual(['110', '11a', '11c', '11e']);
    expect(r.commands).toEqual([{ action: 'close', code: '11c' }, { action: 'review', code: '11e' }]);
  });
  it('is case-insensitive for command words, ignores non-codes', () => {
    const r = parseCommitRefs('CLOSES $110 Review $11a costs $5 and $bad and a$110');
    expect(r.commands).toEqual([{ action: 'close', code: '110' }, { action: 'review', code: '11a' }]);
    expect(r.refs).toEqual(['110', '11a']);
  });
  it('ignores codes in scheme-less www links', () => {
    expect(parseCommitRefs('see www.example.com/a/$110 and $11a').refs).toEqual(['11a']);
  });
  it('caps references per commit', () => {
    const many = Array.from({ length: 100 }, (_, i) => `$${cardCode(i)}`).join(' ');
    expect(parseCommitRefs(many).refs.length).toBeLessThanOrEqual(20);
  });
});

describe('hooks', () => {
  async function makeHook(kind: string, extra: object = {}) { return ok('integrations/createGitHook', { kind, ...extra }); }
  async function card(content = 'Door'): Promise<string> { return (await ok('cards/create', { deckId, content })).id; }

  it('creating shows the secret once; the listing and the database never hold it in the clear', async () => {
    const h = await makeHook('github');
    expect(h.url).toBe(`http://tracker.test/integrations/github/${h.id}`);
    expect(h.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const list = (await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: owner } })).json();
    expect(JSON.stringify(list)).not.toContain(h.secret);
    expect(list.gitHooks).toMatchObject([{ id: h.id, kind: 'github', lastDeliveryAt: null }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM git_hooks').all())).not.toContain(h.secret);
    const b = await makeHook('bitbucket');
    expect(b.url).toMatch(new RegExp(`^http://tracker\\.test/integrations/bitbucket/${b.id}/[A-Za-z0-9_-]{32,}$`));
    expect(JSON.stringify(db.prepare('SELECT * FROM git_hooks').all())).not.toContain(b.url.split('/').pop());
  });

  it('github push with a valid signature adds history on referenced tasks; bad signature → 401', async () => {
    const h = await makeHook('github');
    const id = await card();
    const body = ghPush([commit(`Fix the door $${codeOf(id)}`)]);
    expect((await gh(h, body, { sig: sig('wrong-secret', body) })).statusCode).toBe(401);
    expect((await gh(h, body, { sig: 'nope' })).statusCode).toBe(401);
    expect(history(id).some((c) => c.kind === 'commit')).toBe(false);
    const r = await gh(h, body);
    expect(r.statusCode).toBe(200);
    const c = history(id).find((x) => x.kind === 'commit');
    expect(c.to).toEqual({ sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', author: 'Dev One', url: 'https://git.example/c/a1b2c3d' });
    expect(JSON.stringify(history(id))).not.toContain('dev@x.io');
    const row = (await app.inject({ method: 'GET', url: '/api/integrations', headers: { host: HOST, cookie: owner } })).json().gitHooks[0];
    expect(row.lastDeliveryAt).toBeGreaterThan(0);
    // The same commit again (new delivery) adds no second row.
    await gh(h, body);
    expect(history(id).filter((x) => x.kind === 'commit')).toHaveLength(1);
  });

  it('a link that is not http(s) is dropped; other events are ignored; a repeated delivery id is handled once', async () => {
    const h = await makeHook('github');
    const id = await card();
    const bad = ghPush([commit(`$${codeOf(id)}`, { url: 'javascript:alert(1)' })]);
    expect((await gh(h, bad)).statusCode).toBe(200);
    expect(history(id).find((x) => x.kind === 'commit').to.url).toBeNull();
    const other = await card('Other');
    const body = ghPush([commit(`$${codeOf(other)}`, { id: 'b'.repeat(40) })]);
    expect((await gh(h, body, { event: 'issues' })).statusCode).toBe(200);
    expect(history(other).some((c) => c.kind === 'commit')).toBe(false);
    await gh(h, body, { delivery: 'd-1' });
    const again = await gh(h, body, { delivery: 'd-1' });
    expect(again.json()).toMatchObject({ duplicate: true });
    expect(history(other).filter((c) => c.kind === 'commit')).toHaveLength(1);
  });

  it('caps commits per push', async () => {
    const h = await makeHook('github');
    const ids = [await card('A'), await card('B')];
    const filler = Array.from({ length: 50 }, (_, i) => commit('no refs', { id: String(i).padStart(40, '0') }));
    const r = await gh(h, ghPush([...filler, commit(`$${codeOf(ids[0])}`, { id: 'c'.repeat(40) })]));
    expect(r.statusCode).toBe(200);
    expect(history(ids[0]).some((c) => c.kind === 'commit')).toBe(false);
  });

  it('gitlab wrong token → 401, right token handles Push Hook', async () => {
    const h = await makeHook('gitlab');
    const id = await card();
    const body = JSON.stringify({ commits: [{ id: 'f'.repeat(40), message: `x $${codeOf(id)}`, url: 'https://gl.example/c/f', author: { name: 'Gia' } }] });
    const send = (token: string, event = 'Push Hook') => app.inject({ method: 'POST', url: `/integrations/gitlab/${h.id}`, payload: body, headers: { host: HOST, 'content-type': 'application/json', 'x-gitlab-token': token, 'x-gitlab-event': event } });
    expect((await send('nope')).statusCode).toBe(401);
    expect((await send('')).statusCode).toBe(401);
    expect((await send(h.secret, 'Issue Hook')).statusCode).toBe(200);
    expect(history(id).some((c) => c.kind === 'commit')).toBe(false);
    expect((await send(h.secret)).statusCode).toBe(200);
    expect(history(id).find((c) => c.kind === 'commit').to.author).toBe('Gia');
  });

  it('bitbucket wrong secret → 404, right secret handles repo:push', async () => {
    const h = await makeHook('bitbucket');
    const id = await card();
    const secret = h.url.split('/').pop();
    const body = JSON.stringify({ push: { changes: [{ commits: [{ hash: '9'.repeat(40), message: `x $${codeOf(id)}`, author: { raw: 'Bo <bo@x.io>' }, links: { html: { href: 'https://bb.example/c/9' } } }] }] } });
    const send = (s: string, key = 'repo:push', hook = h.id) => app.inject({ method: 'POST', url: `/integrations/bitbucket/${hook}/${s}`, payload: body, headers: { host: HOST, 'content-type': 'application/json', 'x-event-key': key } });
    expect((await send('wrong')).statusCode).toBe(404);
    expect((await send(secret, 'repo:push', 'nohook')).statusCode).toBe(404);
    // A GitHub hook's id doesn't answer on the BitBucket path.
    const g = await makeHook('github');
    expect((await send(g.secret, 'repo:push', g.id)).statusCode).toBe(404);
    expect((await send(secret)).statusCode).toBe(200);
    const c = history(id).find((x) => x.kind === 'commit');
    expect(c.to.author).toBe('Bo');
    expect(JSON.stringify(c)).not.toContain('bo@x.io');
  });

  it('"closes $code" marks done only if the hook creator can edit it', async () => {
    const h = await makeHook('github');
    const id = await card();
    expect((await gh(h, ghPush([commit(`closes $${codeOf(id)}`)]))).statusCode).toBe(200);
    expect(status(id)).toBe('done');
    expect(history(id).filter((c) => c.kind === 'status').length).toBeGreaterThan(0);

    // The creator became an observer: the command is skipped silently (the card is still visible to them, so its reference is kept).
    const other = await card('Other');
    const member = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,'m@x.io','Mo','x',0)").run(member);
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'observer')").run(member);
    db.prepare('UPDATE git_hooks SET creator_id=? WHERE id=?').run(member, h.id);
    const r = await gh(h, ghPush([commit(`closes $${codeOf(other)}`, { id: 'e'.repeat(40) })]));
    expect(r.statusCode).toBe(200);
    expect(status(other)).toBe('not_started');
  });

  it('"review $code" opens a review thread as the creator; a task the creator cannot see is skipped', async () => {
    const h = await makeHook('github');
    const id = await card();
    await gh(h, ghPush([commit(`review $${codeOf(id)}`)]));
    const rev = db.prepare("SELECT creator_id c FROM resolvables WHERE card_id=? AND context='review'").get(id) as { c: string };
    expect(rev.c).toBe((db.prepare('SELECT creator_id c FROM git_hooks').get() as { c: string }).c);
    // A disabled creator does nothing at all.
    const other = await card('Other');
    db.prepare('UPDATE users SET disabled=1 WHERE id=(SELECT creator_id FROM git_hooks)').run();
    await gh(h, ghPush([commit(`closes $${codeOf(other)} $${codeOf(other)}`, { id: 'd'.repeat(40) })]));
    expect(status(other)).toBe('not_started');
    expect(history(other).some((c) => c.kind === 'commit')).toBe(false);
  });

  it('a hook scoped to a project ignores tasks of other projects', async () => {
    const p2 = (await ok('projects/create', { name: 'Q' })).id;
    const d2 = (await ok('decks/create', { title: 'D2', projectId: p2 })).id;
    const inside = await card('In');
    const outside = (await ok('cards/create', { deckId: d2, content: 'Out' })).id;
    const h = await makeHook('github', { projectId });
    await gh(h, ghPush([commit(`$${codeOf(inside)} $${codeOf(outside)}`)]));
    expect(history(inside).some((c) => c.kind === 'commit')).toBe(true);
    expect(history(outside).some((c) => c.kind === 'commit')).toBe(false);
  });

  it('deleting a hook stops it; only admins manage hooks; tokens are denied', async () => {
    const h = await makeHook('github');
    await ok('integrations/deleteGitHook', { id: h.id });
    expect((await gh(h, ghPush([]))).statusCode).toBe(404);
    expect((await json('', '/dispatch/integrations/createGitHook', { kind: 'github' })).statusCode).toBe(401);
    const t = await ok('apiTokens/create', { kind: 'org', label: 'ci', role: 'admin', access: 'write', projectIds: [] });
    const r = await app.inject({ method: 'POST', url: '/dispatch/integrations/createGitHook', payload: { kind: 'github' }, headers: { host: HOST, 'content-type': 'application/json', authorization: `Bearer ${t.token}` } });
    expect(r.statusCode).toBe(403);
  });

  it('the same commit under another delivery id does not re-run its commands or add a second reference', async () => {
    const h = await makeHook('github');
    const a = await card('A');
    const b = await card('B');
    const body = ghPush([commit(`closes $${codeOf(a)} review $${codeOf(b)}`)]);
    expect((await gh(h, body, { delivery: 'd-1' })).statusCode).toBe(200);
    expect(status(a)).toBe('done');
    // Someone reopens the card and closes the review; the branch is merged and the push lists the commit again.
    await ok('cards/update', { id: a, status: 'not_started' });
    db.prepare("UPDATE resolvables SET is_closed=1 WHERE card_id=?").run(b);
    expect((await gh(h, body, { delivery: 'd-2' })).statusCode).toBe(200);
    expect(status(a)).toBe('not_started');
    expect(db.prepare("SELECT COUNT(*) n FROM resolvables WHERE card_id=? AND context='review'").get(b)).toEqual({ n: 1 });
    expect(history(a).filter((c) => c.kind === 'commit')).toHaveLength(1);
  });

  it('hook of a disabled workspace → 423', async () => {
    const h = await makeHook('github');
    db.prepare('UPDATE account SET is_disabled=1').run();
    expect((await gh(h, ghPush([]))).statusCode).toBe(423);
  });

  it('bodies over 1 MB are refused; a hook is rate limited', async () => {
    const h = await makeHook('github');
    const big = 'x'.repeat(1024 * 1024 + 10);
    expect((await gh(h, big)).statusCode).toBe(413);
    let last = 0;
    for (let i = 0; i < 80 && last !== 429; i++) last = (await gh(h, ghPush([]))).statusCode;
    expect(last).toBe(429);
  });
});

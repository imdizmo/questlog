import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import type { FastifyInstance } from 'fastify';

vi.setConfig({ testTimeout: 30_000 });

// Home's "Recently worked on" (server/home.ts): the cards a person changed or commented on lately, newest first.
const HOST = 'localhost:8780';
let db: Db;
let app: FastifyInstance;
const hdr = (cookie?: string) => ({ host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
const cookieOf = (res: any) => {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session');
  return c ? `jt_session=${c.value}` : '';
};
const run = async (name: string, payload: unknown, cookie: string) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: hdr(cookie) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const recent = async (cookie?: string) => app.inject({ method: 'GET', url: '/api/me/recent', headers: hdr(cookie) });
const ids = async (cookie: string) => ((await recent(cookie)).json().items as { cardId: string }[]).map((i) => i.cardId);
const history = (cardId: string, version: number, who: string, at: number) =>
  db.prepare('INSERT INTO card_history (card_id, version, changer_id, at, changes_json) VALUES (?,?,?,?,?)').run(cardId, version, who, at, '[]');

let ada: string, adaId: string, bob: string, bobId: string;
let a: string, b: string, c: string, projectId: string, deckId: string;

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  await app.ready();
  ada = cookieOf(await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ada', email: 'a@x.io', password: 'pw-owner' }, headers: hdr() }));
  adaId = (db.prepare("SELECT id FROM users WHERE email='a@x.io'").get() as { id: string }).id;
  bobId = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(bobId, 'b@x.io', 'Bob', hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(bobId, 'member');
  bob = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'b@x.io', password: 'pw' }, headers: hdr() }));
  projectId = (await run('projects/create', { name: 'P' }, ada)).id;
  deckId = (await run('decks/create', { title: 'L', projectId, spaceId: 1 }, ada)).id;
  a = (await run('cards/create', { deckId, content: 'A' }, ada)).id;
  b = (await run('cards/create', { deckId, content: 'B' }, ada)).id;
  c = (await run('cards/create', { deckId, content: 'C' }, ada)).id;
  db.prepare('DELETE FROM card_history').run();
});
afterEach(async () => { await app.close(); db.close(); });

describe('recently worked on', () => {
  it('recent: own edits only, newest first, one per card', async () => {
    history(a, 10, adaId, 1000);
    history(b, 10, adaId, 3000);
    history(a, 11, adaId, 2000);
    history(c, 10, bobId, 5000); // Bob's, not Ada's
    expect(await ids(ada)).toEqual([b, a]);
    expect(await ids(bob)).toEqual([c]);
    expect((await recent(ada)).json().items[0]).toEqual({ cardId: b, at: 3000 });
  });

  it('counts the person\'s comments too', async () => {
    history(a, 10, adaId, 1000);
    const rid = newId();
    db.prepare("INSERT INTO resolvables (id, card_id, creator_id, context, is_closed, created_at) VALUES (?,?,?,'comment',0,?)").run(rid, c, adaId, 4000);
    db.prepare('INSERT INTO resolvable_entries (id, resolvable_id, author_id, content, created_at) VALUES (?,?,?,?,?)').run(newId(), rid, adaId, 'hi', 4000);
    expect(await ids(ada)).toEqual([c, a]);
  });

  it('recent: hides cards of projects the person cannot see and deleted ones', async () => {
    history(a, 10, bobId, 1000);
    history(b, 10, bobId, 2000);
    db.prepare("UPDATE cards SET visibility='deleted' WHERE id=?").run(b);
    expect(await ids(bob)).toEqual([a]);
    db.prepare("UPDATE projects SET visibility='limited' WHERE id=?").run(projectId);
    expect(await ids(bob)).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await recent()).statusCode).toBe(401);
  });

  it('reads by person through the indexes, not a scan', () => {
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(adaId) as { detail: string }[]).map((r) => r.detail).join(' ');
    expect(plan('SELECT card_id, at FROM card_history WHERE changer_id=? ORDER BY at DESC LIMIT 500')).toContain('card_history_changer_at');
    expect(plan('SELECT resolvable_id, created_at FROM resolvable_entries WHERE author_id=? ORDER BY created_at DESC LIMIT 200')).toContain('resolvable_entries_author_at');
  });
});

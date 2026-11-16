import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';
import { LiveHub } from '../server/live';
import { runJob, runStaleSnooze, runAutoArchive, startScheduler } from '../server/jobs';
import { derivedStatus } from '../shared/cards';
import type { FastifyInstance } from 'fastify';

const HOST = 'localhost:8780';
const H = 3600e3;
let db: Db;
let app: FastifyInstance;
let owner: string;
let deckId: string;
const NOW = 1_800_000_000_000;

const cookieOf = (res: any) => { const c = res.cookies.find((x: any) => x.name === 'jt_session'); return `jt_session=${c.value}`; };
const ok = async (name: string, payload: unknown) => {
  const r = await app.inject({ method: 'POST', url: `/dispatch/${name}`, payload: payload as any, headers: { host: HOST, cookie: owner, 'content-type': 'application/json' } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const card = (id: string) => db.prepare('SELECT * FROM cards WHERE id=?').get(id) as any;
/** A started card whose last update was `ageH` hours before NOW. */
const stale = async (ageH: number, extra = '') => {
  const id = (await ok('cards/create', { content: 'C' + extra, deckId })).id as string;
  await ok('cards/update', { id, status: 'started' });
  db.prepare('UPDATE cards SET last_updated_at=? WHERE id=?').run(NOW - ageH * H, id);
  return id;
};
const snooze = (n = NOW) => runJob(db, new LiveHub(db), (ctx) => runStaleSnooze(ctx, n));
const archive = (n = NOW) => runJob(db, new LiveHub(db), (ctx) => runAutoArchive(ctx, n));

beforeEach(async () => {
  _resetLimiter();
  db = openDb(':memory:');
  app = buildApp({ db, hosts: [HOST] });
  const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { workspaceName: 'W', name: 'Ann', email: 'o@x.io', password: 'pw-owner' }, headers: { host: HOST, 'content-type': 'application/json' } });
  owner = cookieOf(r);
  void hashPassword;
  const projectId = (await ok('projects/create', { name: 'P' })).id;
  deckId = (await ok('decks/create', { title: 'D', projectId })).id;
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

describe('stale snooze', () => {
  it('snoozes a task started 121h ago, leaves 119h alone', async () => {
    const old = await stale(121), fresh = await stale(119);
    snooze();
    expect(card(old).snoozed_at).toBe(NOW);
    expect(card(fresh).snoozed_at).toBeNull();
    const h = db.prepare('SELECT changer_id, changes_json FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(old) as any;
    expect(h.changer_id).toBe('system');
    expect(JSON.parse(h.changes_json)).toEqual([{ kind: 'snoozed' }]);
  });

  it('derives the snoozing status', () => {
    expect(derivedStatus({ status: 'started', assigneeId: null, isDoc: false, snoozedAt: 5 }, new Set())).toBe('snoozing');
    expect(derivedStatus({ status: 'started', assigneeId: null, isDoc: false, snoozedAt: null }, new Set())).toBe('started');
  });

  it('skips doc tasks and tasks with an open thread', async () => {
    const doc = await stale(200);
    db.prepare('UPDATE cards SET is_doc=1 WHERE id=?').run(doc);
    const talk = await stale(200);
    await ok('resolvables/create', { cardId: talk, context: 'comment', content: 'hi' });
    db.prepare('UPDATE cards SET last_updated_at=? WHERE id=?').run(NOW - 200 * H, talk);
    snooze();
    expect(card(doc).snoozed_at).toBeNull();
    expect(card(talk).snoozed_at).toBeNull();
  });

  it('a user edit clears the snooze', async () => {
    const id = await stale(200);
    snooze();
    await ok('cards/update', { id, content: 'C edited', contentVersion: card(id).content_version });
    expect(card(id).snoozed_at).toBeNull();
    const last = db.prepare('SELECT changes_json FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(id) as any;
    expect(JSON.parse(last.changes_json).map((c: any) => c.kind)).toEqual(['title', 'unsnoozed']);
  });

  it('a status change clears the snooze without an unsnoozed row', async () => {
    const id = await stale(200);
    snooze();
    await ok('cards/update', { id, status: 'not_started' });
    expect(card(id).snoozed_at).toBeNull();
    const last = db.prepare('SELECT changes_json FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(id) as any;
    expect(JSON.parse(last.changes_json).map((c: any) => c.kind)).toEqual(['status']);
  });

  it('emits task events through the hub after commit', async () => {
    const id = await stale(200);
    const hub = new LiveHub(db);
    const spy = vi.spyOn(hub, 'publish');
    runJob(db, hub, (ctx) => runStaleSnooze(ctx, NOW));
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1][0] as any).row.id).toBe(id);
  });

  it('catch-up batches of 200', async () => {
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,status,created_at,last_updated_at) VALUES (?,?,?,?,?,'started',0,?)");
    db.exec('BEGIN');
    for (let i = 0; i < 450; i++) ins.run(`bulk${i}`, 1000 + i, deckId, 'x', 'B', NOW - 300 * H);
    db.exec('COMMIT');
    const snoozed = () => (db.prepare('SELECT COUNT(*) n FROM cards WHERE snoozed_at IS NOT NULL').get() as any).n;
    snooze(); expect(snoozed()).toBe(200);
    snooze(); expect(snoozed()).toBe(400);
    snooze(); expect(snoozed()).toBe(450);
  });
});

describe('auto archive', () => {
  const done = async (ageH: number) => {
    const id = (await ok('cards/create', { content: 'D', deckId })).id as string;
    await ok('cards/update', { id, status: 'done' });
    db.prepare('UPDATE cards SET done_at=? WHERE id=?').run(NOW - ageH * H, id);
    return id;
  };
  it('archives done 49h ago, keeps 47h', async () => {
    const a = await done(49), b = await done(47);
    archive();
    expect(card(a).visibility).toBe('archived');
    expect(card(b).visibility).toBe('default');
    const h = db.prepare('SELECT changer_id, changes_json FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT 1').get(a) as any;
    expect(h.changer_id).toBe('system');
    expect(JSON.parse(h.changes_json)).toEqual([{ kind: 'visibility', from: 'default', to: 'archived', by: 'system' }]);
  });
  it('catch-up batches of 200', async () => {
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,status,visibility,created_at,last_updated_at,done_at) VALUES (?,?,?,?,?,'done','default',0,0,?)");
    db.exec('BEGIN');
    for (let i = 0; i < 450; i++) ins.run(`arch${i}`, 5000 + i, deckId, 'x', 'B', NOW - 100 * H);
    db.exec('COMMIT');
    const archived = () => (db.prepare("SELECT COUNT(*) n FROM cards WHERE visibility='archived'").get() as any).n;
    archive(); expect(archived()).toBe(200);
    archive(); expect(archived()).toBe(400);
    archive(); expect(archived()).toBe(450);
  });

  it('does nothing when autoArchiveHours is null', async () => {
    const a = await done(500);
    await ok('accounts/update', { settings: { autoArchiveHours: null } });
    archive();
    expect(card(a).visibility).toBe('default');
  });
  it('done_at is set on done and cleared on reopen', async () => {
    const id = (await ok('cards/create', { content: 'D', deckId })).id as string;
    await ok('cards/update', { id, status: 'done' });
    expect(card(id).done_at).toBeGreaterThan(0);
    await ok('cards/update', { id, status: 'not_started' });
    expect(card(id).done_at).toBeNull();
  });
});

describe('scheduler', () => {
  it('ticks on the interval and stops', async () => {
    const id = await stale(200);
    vi.useFakeTimers();
    const stop = startScheduler(db, new LiveHub(db), { intervalMs: 1000, now: () => NOW });
    expect(card(id).snoozed_at).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(card(id).snoozed_at).toBe(NOW);
    stop();
    db.prepare('UPDATE cards SET snoozed_at=NULL WHERE id=?').run(id);
    vi.advanceTimersByTime(5000);
    expect(card(id).snoozed_at).toBeNull();
  });

  it('one throwing job rolls back only itself and does not stop the others or the interval', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await stale(200);
    const seen: string[] = [];
    vi.useFakeTimers();
    const stop = startScheduler(db, new LiveHub(db), {
      intervalMs: 1000, now: () => NOW,
      extraJobs: [['boom', (ctx) => { ctx.db.prepare("UPDATE account SET name='half-done'").run(); throw new Error('boom'); }], ['after', () => { seen.push('after'); }]],
    });
    vi.advanceTimersByTime(2000);
    expect(card(id).snoozed_at).toBe(NOW); // the job before it committed
    expect((db.prepare('SELECT name FROM account').get() as any).name).not.toBe('half-done'); // the failing job rolled back
    expect(seen).toEqual(['after', 'after']); // the job after it ran on both ticks
    expect(err).toHaveBeenCalled();
    stop();
    err.mockRestore();
  });

  it('skips every job quietly until a workspace exists', () => {
    const fresh = openDb(':memory:');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    vi.useFakeTimers();
    const stop = startScheduler(fresh, new LiveHub(fresh), { intervalMs: 1000, now: () => NOW, extraJobs: [['probe', () => { ran.push('probe'); }]] });
    vi.advanceTimersByTime(3000);
    expect(err).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    stop();
    err.mockRestore();
    fresh.close();
  });

  it('afterCommit callbacks run after the transaction closed', () => {
    let open: boolean | null = null;
    runJob(db, new LiveHub(db), (ctx) => { ctx.afterCommit(() => { open = (db as any).isTransaction; }); });
    expect(open).toBe(false);
  });

  it('action ids never repeat within one millisecond', () => {
    const ids = new Set<string>();
    const hub = { publish: (id: string) => { ids.add(id); } };
    for (let i = 0; i < 50; i++) runJob(db, hub, (ctx) => ctx.emit('account', 'upsert', { i }));
    expect(ids.size).toBe(50);
  });
});

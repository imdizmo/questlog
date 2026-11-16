import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { AppError } from '../server/errors';
import { allowedActions, derivedStatus } from '../shared/cards';
import type { User } from '../shared/types';

let db: Db;
let me: User;
let deck: string;
let docDeck: string;
let pid: string;
function mkUser(role: string, disabled = false): User {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,?,0)')
    .run(id, `${id}@x.io`, role, 'x', disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return { id, email: `${id}@x.io`, name: role, timezone: null, disabled, createdAt: 0 };
}
const run = (name: string, p: unknown, u: User = me) => dispatch(db, u, name, p);
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};
const mk = (content = 'Task', extra: object = {}) =>
  (run('cards/create', { content, deckId: deck, ...extra }).payload as { id: string; accountSeq: number });
const card = (id: string) => db.prepare('SELECT * FROM cards WHERE id=?').get(id) as any;
const hand = (uid = me.id) =>
  (db.prepare('SELECT card_id FROM hand_cards WHERE user_id=? ORDER BY sort_index').all(uid) as any[]).map((r) => r.card_id);
const derived = (id: string) => {
  const c = card(id);
  const open = new Set(
    (db.prepare('SELECT context FROM resolvables WHERE card_id=? AND is_closed=0').all(id) as any[]).map((r) => r.context),
  );
  return derivedStatus({ status: c.status, assigneeId: c.assignee_id, isDoc: !!c.is_doc }, open as any);
};
const bulk = (ids: string[], p: object) => run('cards/bulkUpdate', { ids, ...p });
const openRes = (cardId: string) =>
  (db.prepare('SELECT id FROM resolvables WHERE card_id=? AND is_closed=0').get(cardId) as any).id as string;

beforeEach(() => {
  db = openDb(':memory:');
  me = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
  pid = (run('projects/create', { name: 'P' }).payload as any).id;
  deck = (run('decks/create', { title: 'D', projectId: pid }).payload as any).id;
  docDeck = (run('decks/create', { title: 'Docs', projectId: pid }).payload as any).id;
  run('decks/update', { id: docDeck, deckType: 'doc' });
});

describe('tasks commands', () => {
  it('codes count up', () => {
    expect(mk().accountSeq).toBe(1);
    expect(mk().accountSeq).toBe(2);
  });
  it('start takes hand slot 1', () => {
    const a = mk('A').id, b = mk('B').id;
    bulk([a], { status: 'started' });
    bulk([b], { status: 'started' });
    expect(hand()).toEqual([b, a]);
    expect(card(a).assignee_id).toBe(me.id);
  });
  it('start keeps existing owner', () => {
    const other = mkUser('member');
    const a = mk('A', { assigneeId: other.id }).id;
    bulk([a], { status: 'started' });
    expect(card(a).assignee_id).toBe(other.id);
    expect(hand()).toEqual([a]);
  });
  it('block resets started', () => {
    const a = mk().id;
    bulk([a], { status: 'started' });
    run('resolvables/create', { cardId: a, context: 'block', content: 'waiting' });
    expect(card(a).status).toBe('not_started');
    expect(derived(a)).toBe('blocked');
    run('resolvables/close', { id: openRes(a) });
    expect(derived(a)).toBe('assigned');
    expect(hand()).toEqual([a]);
  });
  it('review locks', () => {
    const a = mk().id;
    run('resolvables/create', { cardId: a, context: 'review', content: 'pls' });
    expect(code(() => bulk([a], { status: 'done' }))).toBe('409:invalid_transition');
    expect(run('resolvables/close', { id: openRes(a), markCardDone: true }).payload).toEqual({ cardId: a });
    expect(card(a).status).toBe('done');
    const b = mk().id;
    run('resolvables/create', { cardId: b, context: 'review', content: 'pls' });
    run('resolvables/close', { id: openRes(b) });
    expect(card(b).status).toBe('not_started');
  });
  it('block needs a message', () => {
    const a = mk().id;
    expect(code(() => run('resolvables/create', { cardId: a, context: 'block', content: '' }))).toBe('400:invalid_payload');
  });
  it('done task cannot be blocked', () => {
    const a = mk().id;
    bulk([a], { status: 'done' });
    expect(code(() => run('resolvables/create', { cardId: a, context: 'block', content: 'x' }))).toBe('409:invalid_transition');
  });
  it('delete without archive; restore', () => {
    const a = mk().id;
    bulk([a], { visibility: 'deleted' });
    expect(card(a).visibility).toBe('deleted');
    bulk([a], { visibility: 'default' });
    expect(card(a).visibility).toBe('default');
  });
  it('doc list rule', () => {
    expect(code(() => run('cards/create', { content: 'x', deckId: docDeck, isDoc: false }))).toBe('409:deck_type_mismatch');
    const d = run('cards/create', { content: 'x', deckId: docDeck }).payload as any;
    expect(card(d.id).is_doc).toBe(1);
    const a = mk().id;
    expect(code(() => run('cards/update', { id: a, deckId: docDeck }))).toBe('409:deck_type_mismatch');
  });
  it('content conflict', () => {
    const a = mk('v0').id;
    run('cards/update', { id: a, content: 'first', contentVersion: 1 });
    try {
      run('cards/update', { id: a, content: 'second', contentVersion: 1 });
      expect.unreachable();
    } catch (e: any) {
      expect(e.status).toBe(409);
      expect(e.code).toBe('conflict');
      expect(e.data.content).toBe('first');
    }
    expect(card(a).content).toBe('first');
  });
  it('status change does not conflict', () => {
    const a = mk('v0').id;
    bulk([a], { status: 'started' });
    run('cards/update', { id: a, content: 'text', contentVersion: 1 });
    expect(card(a).content).toBe('text');
    expect(card(a).content_version).toBe(2);
  });
  it('one history row per command', () => {
    const a = mk().id;
    bulk([a], { status: 'started' });
    run('resolvables/create', { cardId: a, context: 'block', content: 'why' });
    const rows = db.prepare('SELECT version, changes_json j FROM card_history WHERE card_id=? ORDER BY version').all(a) as any[];
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    const kinds = JSON.parse(rows[2].j).map((c: any) => c.kind).sort();
    expect(kinds).toEqual(['blocked', 'status']);
    expect(card(a).version).toBe(3);
  });
  it('batch rolls back', () => {
    const ok = mk().id, rv = mk().id;
    run('resolvables/create', { cardId: rv, context: 'review', content: 'r' });
    expect(code(() => bulk([ok, rv], { status: 'done' }))).toBe('409:invalid_transition');
    expect(card(ok).status).toBe('not_started');
  });
  it('putInQueue uses slot 1 and owner change is logged', () => {
    const a = mk('A', { putInQueue: true }).id;
    const b = mk('B', { putInQueue: true }).id;
    expect(hand()).toEqual([b, a]);
    const zed = mkUser('member');
    run('cards/update', { id: a, assigneeId: zed.id });
    const last = db.prepare('SELECT changes_json j FROM card_history WHERE card_id=? ORDER BY version DESC').get(a) as any;
    expect(JSON.parse(last.j)[0]).toMatchObject({ kind: 'owner', to: zed.id });
  });
  it('allowedActions agrees', () => {
    const a = mk().id;
    expect(allowedActions({ status: 'not_started', isDoc: false, visibility: 'default' }, new Set()).start).toBe(true);
  });

  it('assignee validation', () => {
    const a = mk().id;
    const bad = (id: string) => [
      code(() => run('cards/update', { id: a, assigneeId: id })),
      code(() => run('cards/create', { content: 'x', deckId: deck, assigneeId: id, putInQueue: true })),
    ];
    expect(bad('nope')).toEqual(['400:invalid_assignee', '400:invalid_assignee']);
    expect(bad(mkUser('member', true).id)).toEqual(['400:invalid_assignee', '400:invalid_assignee']);
    expect(bad(mkUser('observer').id)).toEqual(['400:invalid_assignee', '400:invalid_assignee']);
    const lp = (run('projects/create', { name: 'L', visibility: 'limited' }).payload as any).id;
    const ld = (run('decks/create', { title: 'L', projectId: lp }).payload as any).id;
    const m = mkUser('member');
    expect(code(() => run('cards/create', { content: 'x', deckId: ld, assigneeId: m.id }))).toBe('400:invalid_assignee');
    expect(db.prepare('SELECT COUNT(*) c FROM hand_cards').get()).toEqual({ c: 0 });
    expect(code(() => run('cards/update', { id: a, assigneeId: m.id }))).toBe('no throw');
  });
  it('deckless task: creator member ok, demoted creator not, admin ok', () => {
    const m = mkUser('member');
    const c = mk('x', { assigneeId: null }).id;
    db.prepare('UPDATE cards SET deck_id=NULL, creator_id=? WHERE id=?').run(m.id, c);
    expect(code(() => run('cards/update', { id: c, content: 'y', contentVersion: 1 }, m))).toBe('no throw');
    db.prepare("UPDATE account_roles SET role='observer' WHERE user_id=?").run(m.id);
    expect(code(() => run('cards/update', { id: c, content: 'z', contentVersion: 2 }, m))).toBe('403:forbidden');
    expect(code(() => run('cards/update', { id: c, content: 'z', contentVersion: 2 }))).toBe('no throw');
  });
  it('moving a task to another project emits a remove for the old project first', () => {
    const a = mk().id;
    const p2 = (run('projects/create', { name: 'P2' }).payload as any).id;
    const d2 = (run('decks/create', { title: 'D2', projectId: p2 }).payload as any).id;
    const ev = run('cards/update', { id: a, deckId: d2 }).events.filter((e) => e.model === 'card');
    expect(ev.map((e) => e.op)).toEqual(['remove', 'upsert']);
    expect(ev[0].row).toEqual({ id: a, projectId: pid });
    // same-project move: no remove
    const ev2 = run('cards/update', { id: a, deckId: (run('decks/create', { title: 'D3', projectId: p2 }).payload as any).id }).events;
    expect(ev2.filter((e) => e.model === 'card').map((e) => e.op)).toEqual(['upsert']);
  });
  it('list move rechecks the kept assignee against the new project', () => {
    const m = mkUser('member');
    const a = mk('x', { assigneeId: m.id }).id;
    const lp = (run('projects/create', { name: 'L', visibility: 'limited' }).payload as any).id;
    const ld = (run('decks/create', { title: 'L', projectId: lp }).payload as any).id;
    expect(code(() => run('cards/update', { id: a, deckId: ld }))).toBe('400:invalid_assignee');
    expect(card(a).deck_id).toBe(deck);
    run('projects/setAccess', { projectId: lp, userId: m.id, access: 'member' });
    expect(code(() => run('cards/update', { id: a, deckId: ld }))).toBe('no throw');
  });
  it('unblocked and review closed quote the thread\'s first message', () => {
    const a = mk().id;
    run('resolvables/create', { cardId: a, context: 'block', content: 'waiting on art' });
    run('resolvables/close', { id: openRes(a) });
    run('resolvables/create', { cardId: a, context: 'review', content: 'please check' });
    run('resolvables/close', { id: openRes(a) });
    const rows = (db.prepare('SELECT changes_json j FROM card_history WHERE card_id=? ORDER BY version').all(a) as any[])
      .map((r) => JSON.parse(r.j)).flat();
    expect(rows.find((c: any) => c.kind === 'unblocked')).toEqual({ kind: 'unblocked', quote: 'waiting on art' });
    expect(rows.find((c: any) => c.kind === 'reviewClosed')).toEqual({ kind: 'reviewClosed', quote: 'please check' });
  });
  it('account settings reject negative, fractional and zero-stale numbers', () => {
    const bad = (settings: object) => code(() => run('accounts/update', { settings }));
    expect(bad({ staleHours: 0 })).toBe('400:invalid_payload');
    expect(bad({ staleHours: 1.5 })).toBe('400:invalid_payload');
    expect(bad({ autoArchiveHours: -1 })).toBe('400:invalid_payload');
    expect(bad({ fallbackEffort: -2 })).toBe('400:invalid_payload');
    expect(bad({ fallbackEffort: 0.5 })).toBe('400:invalid_payload');
    expect(bad({ staleHours: 1, autoArchiveHours: null, fallbackEffort: 0 })).toBe('no throw');
    expect(bad({ autoArchiveHours: 0 })).toBe('no throw');
  });
  it('space ids must be positive integers', () => {
    const sp = (id: number) => code(() => run('projects/update', { id: pid, spaces: [{ id, name: null, icon: null, defaultDeckType: 'mixed' }, { id: 99, name: 'x', icon: null, defaultDeckType: 'task' }] }));
    expect(sp(0)).toBe('400:invalid_payload');
    expect(sp(-3)).toBe('400:invalid_payload');
    expect(sp(1)).toBe('no throw');
  });
  it('deleted task only restores', () => {
    const a = mk().id;
    run('resolvables/create', { cardId: a, context: 'review', content: 'r' });
    const rid = openRes(a);
    bulk([a], { visibility: 'deleted' });
    expect(code(() => run('cards/update', { id: a, content: 'n', contentVersion: 1 }))).toBe('409:invalid_transition');
    expect(code(() => run('cards/update', { id: a, status: 'done' }))).toBe('409:invalid_transition');
    expect(code(() => run('resolvables/close', { id: rid, markCardDone: true }))).toBe('409:invalid_transition');
    expect(code(() => run('resolvables/create', { cardId: a, context: 'block', content: 'x' }))).toBe('409:invalid_transition');
    expect(card(a).status).toBe('not_started');
    expect(code(() => run('cards/update', { id: a, visibility: 'default' }))).toBe('no throw');
  });
});

describe('bulk property updates', () => {
  it('bulk owner and priority on 3 tasks writes 3 history rows each with one change per property', () => {
    const ids = [mk('A').id, mk('B').id, mk('C').id];
    const m = mkUser('member');
    run('projects/setAccess', { projectId: pid, userId: m.id, access: 'member' });
    const before = (db.prepare('SELECT COUNT(*) c FROM card_history').get() as any).c;
    bulk(ids, { assigneeId: m.id, priority: 'a' });
    const rows = db.prepare('SELECT card_id, changes_json c FROM card_history ORDER BY rowid DESC LIMIT 3').all() as any[];
    expect((db.prepare('SELECT COUNT(*) c FROM card_history').get() as any).c - before).toBe(3);
    for (const r of rows) {
      expect(ids).toContain(r.card_id);
      expect(JSON.parse(r.c).map((c: any) => c.kind).sort()).toEqual(['owner', 'priority']);
    }
    for (const id of ids) expect(card(id)).toMatchObject({ assignee_id: m.id, priority: 'a' });
  });
  it('bulk with one task in a project I can\'t edit -> 403 and none changed', () => {
    const lp = (run('projects/create', { name: 'L', visibility: 'limited' }).payload as any).id;
    const ld = (run('decks/create', { title: 'L', projectId: lp }).payload as any).id;
    const hidden = (run('cards/create', { content: 'h', deckId: ld }).payload as any).id;
    const a = mk('A').id;
    const m = mkUser('member');
    run('projects/setAccess', { projectId: pid, userId: m.id, access: 'member' });
    expect(code(() => run('cards/bulkUpdate', { ids: [a, hidden], priority: 'a' }, m))).toBe('403:forbidden');
    expect(card(a).priority).toBeNull();
    expect(card(hidden).priority).toBeNull();
  });
  it('bulk done with a guarded task -> refused, none changed', () => {
    const g = mkUser('member');
    const m = mkUser('member');
    for (const u of [g, m]) run('projects/setAccess', { projectId: pid, userId: u.id, access: 'member' });
    const free = mk('F').id;
    const gd = (run('decks/create', { title: 'G', projectId: pid }).payload as any).id;
    run('decks/update', { id: gd, guardiansEnabled: true, guardianIds: [g.id] });
    const guarded = (run('cards/create', { content: 'G', deckId: gd }).payload as any).id;
    expect(code(() => run('cards/bulkUpdate', { ids: [free, guarded], status: 'done' }, m))).toBe('403:guardian_only');
    expect(card(free).status).toBe('not_started');
    expect(card(guarded).status).toBe('not_started');
  });
  it('bulk milestone while milestones are off -> 409 feature_disabled', () => {
    const a = mk('A').id;
    run('accounts/update', { settings: { milestonesEnabled: false } });
    expect(code(() => bulk([a], { milestoneId: 'x' }))).toBe('409:feature_disabled');
  });
  it('bulk sprint while runs are off -> 409 feature_disabled', () => {
    const a = mk('A').id;
    run('accounts/update', { settings: { sprintsEnabled: false } });
    expect(code(() => bulk([a], { sprintId: 'x' }))).toBe('409:feature_disabled');
  });
  it('addMasterTags/removeMasterTags merge with existing tags', () => {
    run('projects/update', { id: pid, tags: [{ name: 'a', emoji: null }, { name: 'b', emoji: null }, { name: 'c', emoji: null }] });
    const x = mk('X', { masterTags: ['a', 'b'] }).id;
    const y = mk('Y', { masterTags: ['b'] }).id;
    bulk([x, y], { addMasterTags: ['c'], removeMasterTags: ['b'] });
    expect(JSON.parse(card(x).master_tags_json).sort()).toEqual(['a', 'c']);
    expect(JSON.parse(card(y).master_tags_json)).toEqual(['c']);
  });
  it('bulk done stops timers and takes the task off the hand like a single update', () => {
    const a = mk('A').id;
    bulk([a], { status: 'started' });
    expect(hand()).toEqual([a]);
    bulk([a], { status: 'done', priority: 'b' });
    expect(hand()).toEqual([]);
    expect(card(a)).toMatchObject({ status: 'done', priority: 'b' });
  });
  it('bulk deckId moves tasks into another list, and a list in a project I can\'t edit -> 403', () => {
    const a = mk('A').id;
    const d2 = (run('decks/create', { title: 'D2', projectId: pid }).payload as any).id;
    bulk([a], { deckId: d2 });
    expect(card(a).deck_id).toBe(d2);
    const lp = (run('projects/create', { name: 'L', visibility: 'limited' }).payload as any).id;
    const ld = (run('decks/create', { title: 'L', projectId: lp }).payload as any).id;
    const m = mkUser('member');
    run('projects/setAccess', { projectId: pid, userId: m.id, access: 'member' });
    expect(code(() => run('cards/bulkUpdate', { ids: [a], deckId: ld }, m))).toBe('403:forbidden');
    expect(card(a).deck_id).toBe(d2);
  });
  it('501 ids -> 400; duplicate ids and empty change -> 400', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id${i}`);
    expect(code(() => bulk(ids, { priority: 'a' }))).toBe('400:invalid_payload');
    const a = mk().id;
    expect(code(() => bulk([a, a], { priority: 'a' }))).toBe('400:invalid_payload');
    expect(code(() => bulk([a], {}))).toBe('400:invalid_payload');
  });
});

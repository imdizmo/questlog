import { mentionHandle } from '../shared/content';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace, setClock } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { localDay } from '../server/commands/cards';
import { AppError } from '../server/errors';
import { LiveHub } from '../server/live';
import type { User } from '../shared/types';

let db: Db;
let me: User;
let deck: string;
let pid: string;
function mkUser(role: string, name = role): User {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,0,0)')
    .run(id, `${id}@x.io`, name, 'x');
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return { id, email: `${id}@x.io`, name, timezone: null, disabled: false, createdAt: 0 };
}
const run = (name: string, p: unknown, u: User = me) => dispatch(db, u, name, p);
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};
const mk = (content = 'Task', extra: object = {}, d = deck) =>
  (run('cards/create', { content, deckId: d, ...extra }).payload as { id: string }).id;
const card = (id: string) => {
  const c = db.prepare('SELECT * FROM cards WHERE id=?').get(id) as any;
  return { ...c, tags: JSON.parse(c.tags_json), masterTags: JSON.parse(c.master_tags_json), mentioned: JSON.parse(c.mentioned_user_ids_json), stats: c.checkbox_stats_json && JSON.parse(c.checkbox_stats_json) };
};
const hist = (id: string) =>
  (db.prepare('SELECT changes_json c FROM card_history WHERE card_id=? ORDER BY version').all(id) as any[]).map((r) => JSON.parse(r.c));
const upd = (id: string, p: object, u: User = me) => run('cards/update', { id, ...p }, u);

beforeEach(() => {
  db = openDb(':memory:');
  me = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
  pid = (run('projects/create', { name: 'P' }).payload as any).id;
  deck = (run('decks/create', { title: 'D', projectId: pid }).payload as any).id;
});
afterEach(() => setClock(() => Date.now()));

describe('properties', () => {
  it('priority/effort/tags round-trip', () => {
    const id = mk();
    upd(id, { priority: 'a' });
    upd(id, { effort: 5 });
    upd(id, { masterTags: ['bug', 'design'] });
    const c = card(id);
    expect([c.priority, c.effort, c.masterTags]).toEqual(['a', 5, ['bug', 'design']]);
    const h = hist(id);
    expect(h.map((x) => x.map((y: any) => y.kind))).toEqual([['created'], ['priority'], ['effort'], ['tags']]);
    expect(h[3][0]).toEqual({ kind: 'tags', from: [], to: ['bug', 'design'] });
    upd(id, { priority: null, effort: null });
    expect(card(id).priority).toBeNull();
    expect(code(() => upd(id, { masterTags: ['nope'] }))).toBe('400:unknown_tag');
    expect(code(() => upd(id, { effort: -1 }))).toBe('400:invalid_payload');
    expect(code(() => upd(id, { priority: 'z' }))).toBe('400:invalid_payload');
  });

  it('due date', () => {
    // One frozen instant, read through the server's own clock and localDay: no midnight flake.
    const t0 = Date.now();
    setClock(() => t0);
    const id = mk();
    const d = (off: number) => localDay(-off);
    expect(code(() => upd(id, { dueDate: d(0) }))).toBe('409:feature_disabled');
    run('accounts/update', { settings: { dueDateEnabled: true } });
    expect(code(() => upd(id, { dueDate: d(-3) }))).toBe('400:past_date');
    expect(code(() => upd(id, { dueDate: 'tomorrow' }))).toBe('400:invalid_payload');
    upd(id, { dueDate: d(0) });
    expect(card(id).due_date).toBe(d(0));
    upd(id, { dueDate: d(-1) });
    expect(card(id).due_date).toBe(d(-1));
    upd(id, { dueDate: null });
    expect(card(id).due_date).toBeNull();
    expect(hist(id).flat().filter((c: any) => c.kind === 'dueDate')).toHaveLength(3);
  });

  it('due date uses the injectable clock', () => {
    run('accounts/update', { settings: { dueDateEnabled: true } });
    const id = mk();
    setClock(() => new Date(2030, 5, 15, 12).getTime());
    expect(code(() => upd(id, { dueDate: '2030-06-13' }))).toBe('400:past_date');
    upd(id, { dueDate: '2030-06-14' });
    upd(id, { dueDate: '2030-06-15' });
  });
});

describe('content derives', () => {
  it('sets tags, mentions, stats and merges project tags', () => {
    const ada = mkUser('member', 'Ada Lovelace');
    const id = mk('start');
    upd(id, { content: 'fix #design @adalovelace $<code> #other\n- [x] a\n- [ ] b', contentVersion: 1 });
    const c = card(id);
    expect(c.tags).toEqual(['design', 'other']);
    expect(c.mentioned).toEqual([ada.id]);
    expect(c.masterTags).toEqual(['design']);
    expect(c.stats).toEqual({ checked: 1, total: 2 });
    // Handles drop what a mention can't hold, so names with apostrophes or accents still resolve.
    const ob = mkUser('member', "O'Brien");
    const ana = mkUser('member', 'Ana María');
    const id3 = mk('hi');
    upd(id3, { content: `hi @${mentionHandle(ob.name)} and @${mentionHandle(ana.name)}`, contentVersion: 1 });
    expect(card(id3).mentioned.sort()).toEqual([ob.id, ana.id].sort());
    // An NFD-typed handle (decomposed accents) resolves like the renderer does.
    const maria = mkUser('member', 'María');
    const nfd = `@${mentionHandle(maria.name)}`.normalize('NFD');
    expect(nfd).not.toBe(`@${mentionHandle(maria.name)}`);
    expect(card(mk(`ping ${nfd}`)).mentioned).toEqual([maria.id]);
    const id2 = mk('hello #bug @nobody');
    expect(card(id2).masterTags).toEqual(['bug']);
    expect(card(id2).mentioned).toEqual([]);
  });
});

describe('automations', () => {
  it('auto tag on create and move', () => {
    const d2 = (run('decks/create', { title: 'B', projectId: pid }).payload as any).id;
    run('decks/update', { id: d2, autoTag: 'bug' });
    expect(card(mk('x', {}, d2)).masterTags).toContain('bug');
    const id = mk('y');
    upd(id, { deckId: d2 });
    expect(card(id).masterTags).toContain('bug');
    upd(id, { deckId: deck });
    expect(card(id).masterTags).toContain('bug');
    expect(code(() => run('decks/update', { id: d2, autoTag: 'nope' }))).toBe('400:unknown_tag');
    run('decks/update', { id: d2, autoTag: null });
  });

  it('default task', () => {
    const tpl = mk('Template', { priority: 'a' });
    run('decks/update', { id: deck, defaultCardId: tpl });
    const a = card(mk(''));
    expect([a.content, a.priority]).toEqual(['Template', 'a']);
    const b = card(mk('', { priority: 'c' }));
    expect(b.priority).toBe('c');
    const other = mk('o', {}, (run('decks/create', { title: 'E', projectId: pid }).payload as any).id);
    expect(code(() => run('decks/update', { id: deck, defaultCardId: other }))).toBe('400:invalid_payload');
    run('decks/update', { id: deck, defaultCardId: null });
  });

  it('preset', () => {
    const pr = (run('presets/create', { name: 'Bug', data: { content: 'Bug: ', priority: 'b', effort: 3, masterTags: ['bug'] } }).payload as any).id;
    const c = card(mk('', { presetId: pr, effort: 8 }));
    expect([c.content, c.priority, c.effort, c.masterTags]).toEqual(['Bug: ', 'b', 8, ['bug']]);
    run('presets/update', { id: pr, name: 'Bug2' });
    expect((db.prepare('SELECT name FROM card_presets WHERE id=?').get(pr) as any).name).toBe('Bug2');
    expect(code(() => run('presets/create', { name: 'x', data: { priority: 'q' } }))).toBe('400:invalid_payload');
    expect(code(() => mk('x', { presetId: 'zzz' }))).toBe('404:not_found');
    run('presets/delete', { id: pr });
    expect(db.prepare('SELECT 1 FROM card_presets').get()).toBeUndefined();
  });

  it('observer can not preset', () => {
    const obs = mkUser('observer');
    expect(code(() => run('presets/create', { name: 'x', data: {} }, obs))).toBe('403:forbidden');
    const mem = mkUser('member');
    run('presets/create', { name: 'x', data: {} }, mem);
  });
});

describe('project tags', () => {
  it('validates and strips removed tags from tasks', () => {
    const id = mk('c');
    upd(id, { masterTags: ['bug', 'design'] });
    const tags = (n: string[]) => n.map((name) => ({ name, emoji: null }));
    expect(code(() => run('projects/update', { id: pid, tags: tags(['Bug']) }))).toBe('400:invalid_payload');
    expect(code(() => run('projects/update', { id: pid, tags: tags(['a', 'a']) }))).toBe('400:invalid_payload');
    expect(code(() => run('projects/update', { id: pid, tags: [{ name: 'a', emoji: '123456789' }] }))).toBe('400:invalid_payload');
    const r = run('projects/update', { id: pid, tags: tags(['design', 'new']) });
    expect(card(id).masterTags).toEqual(['design']);
    expect(r.events.filter((e) => e.model === 'card')).toHaveLength(1);
    expect((db.prepare('SELECT tags_json t FROM projects WHERE id=?').get(pid) as any).t).toContain('new');
  });
});

describe('personal tags', () => {
  it('private per user and routed to the owner only', () => {
    const b = mkUser('member', 'bee');
    const id = mk();
    const ra = run('users/setCardTags', { cardId: id, tags: ['x', 'y'] });
    run('users/setCardTags', { cardId: id, tags: ['z'] }, b);
    const rows = (u: User) => (db.prepare('SELECT tag FROM user_card_tags WHERE user_id=? AND card_id=? ORDER BY tag').all(u.id, id) as any[]).map((r) => r.tag);
    expect(rows(me)).toEqual(['x', 'y']);
    expect(rows(b)).toEqual(['z']);
    expect(ra.events.every((e) => e.model === 'userCardTag' && (e.row as any).userId === me.id)).toBe(true);
    run('users/setCardTags', { cardId: id, tags: ['x'] });
    expect(rows(me)).toEqual(['x']);
    const hidden = mkUser('observer');
    expect(code(() => run('users/setCardTags', { cardId: id, tags: ['q'] }, hidden))).toBe('404:not_found');
  });

  it('live hub routes by user, preset to all, unknown to nobody', () => {
    const b = mkUser('member', 'bee');
    const hub = new LiveHub(db);
    const got: Record<string, any[]> = { a: [], b: [] };
    hub.add({ send: (s) => got.a.push(JSON.parse(s)), close() {} }, me);
    hub.add({ send: (s) => got.b.push(JSON.parse(s)), close() {} }, b);
    hub.publish('1', [
      { model: 'userCardTag', op: 'upsert', row: { userId: me.id, cardId: 'c', tag: 't' } },
      { model: 'preset', op: 'upsert', row: { id: 'p' } },
      { model: 'bogus' as any, op: 'upsert', row: {} },
    ]);
    expect(got.a[0].events.map((e: any) => e.model)).toEqual(['userCardTag', 'preset']);
    expect(got.b[0].events.map((e: any) => e.model)).toEqual(['preset']);
  });
});

describe('fix round 1', () => {
  it('rejects impossible dates', () => {
    run('accounts/update', { settings: { dueDateEnabled: true } });
    const id = mk();
    expect(code(() => upd(id, { dueDate: '2099-02-31' }))).toBe('400:invalid_payload');
    expect(code(() => upd(id, { dueDate: '2099-02-30' }))).toBe('400:invalid_payload');
    upd(id, { dueDate: '2096-02-29' });
  });

  it('default task is ignored and released when moved, archived or deleted', () => {
    const other = (run('decks/create', { title: 'O', projectId: pid }).payload as any).id;
    const defOf = () => (db.prepare('SELECT default_card_id d FROM decks WHERE id=?').get(deck) as any).d;
    const set = (content: string) => { const t = mk(content, { priority: 'a' }); run('decks/update', { id: deck, defaultCardId: t }); return t; };
    let t = set('T1');
    expect(upd(t, { deckId: other }).events.some((e) => e.model === 'deck')).toBe(true);
    expect(defOf()).toBeNull();
    t = set('T2');
    upd(t, { visibility: 'archived' });
    expect(defOf()).toBeNull();
    t = set('T3');
    run('cards/bulkUpdate', { ids: [t], visibility: 'deleted' });
    expect(defOf()).toBeNull();
    // stale pointer set behind the command layer is never copied
    t = set('T4');
    db.prepare("UPDATE cards SET deck_id=? WHERE id=?").run(other, t);
    expect(card(mk('')).content).toBe('');
    db.prepare("UPDATE cards SET deck_id=?, visibility='deleted' WHERE id=?").run(deck, t);
    expect(card(mk('')).content).toBe('');
  });

  it('removing a project tag clears list autoTag', () => {
    run('decks/update', { id: deck, autoTag: 'bug' });
    const r = run('projects/update', { id: pid, tags: [{ name: 'design', emoji: null }] });
    expect((db.prepare('SELECT auto_tag a FROM decks WHERE id=?').get(deck) as any).a).toBeNull();
    expect(r.events.some((e) => e.model === 'deck')).toBe(true);
  });

  it('rejects empty autoTag and defaultCardId', () => {
    expect(code(() => run('decks/update', { id: deck, autoTag: '' }))).toBe('400:invalid_payload');
    expect(code(() => run('decks/update', { id: deck, defaultCardId: '' }))).toBe('400:invalid_payload');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { runQuery, QUERY_LIMITS } from '../server/query';
import { AppError } from '../server/errors';
import { buildApp } from '../server/app';
import { hashPassword, _resetLimiter } from '../server/auth';

let db: Db;
let seq = 0;

function mkUser(role: string, name = role): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, `${id}@x.io`, name, hashPassword('pw'));
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
function mkProject(visibility: 'full' | 'limited', name = 'P'): string {
  const id = newId();
  db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,?,0,?,0)')
    .run(id, ++seq, name, visibility, '[]');
  return id;
}
function mkDeck(projectId: string, title = 'D'): string {
  const id = newId();
  db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,created_at) VALUES (?,?,?,1,?,'task',0)")
    .run(id, ++seq, projectId, title);
  return id;
}
interface CardOpts { content?: string; assigneeId?: string | null; parentCardId?: string | null; lastUpdatedAt?: number; visibility?: string; masterTags?: string[] }
function mkCard(deckId: string | null, creatorId: string, o: CardOpts = {}): string {
  const id = newId();
  db.prepare(`INSERT INTO cards (id,seq,deck_id,creator_id,assignee_id,content,visibility,parent_card_id,master_tags_json,created_at,last_updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
    .run(id, ++seq, deckId, creatorId, o.assigneeId ?? null, o.content ?? 'Card', o.visibility ?? 'default', o.parentCardId ?? null,
      JSON.stringify(o.masterTags ?? []), o.lastUpdatedAt ?? 0);
  return id;
}
const actor = (id: string) => ({ id });
const q = (root: unknown[]) => ({ _root: root });
const k = (name: string, filter: object) => `${name}(${JSON.stringify(filter)})`;

function errorOf(fn: () => unknown): AppError {
  try { fn(); } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected an AppError');
}

let accountId: string;
beforeEach(() => {
  db = openDb(':memory:');
  seq = 0;
  accountId = newId();
  db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(accountId);
});

describe('runQuery', () => {
  it('cards({deckId}) returns normalized rows and _root ids', () => {
    const owner = mkUser('owner');
    const p = mkProject('full');
    const d1 = mkDeck(p);
    const d2 = mkDeck(p);
    const a = mkCard(d1, owner, { content: '# First\nbody' });
    const b = mkCard(d1, owner, { content: 'Second' });
    mkCard(d2, owner);
    const key = k('cards', { deckId: d1 });
    const r: any = runQuery(db, actor(owner), q([{ [key]: ['title', 'deckId'] }]));
    expect(r._root[key]).toEqual([a, b]);
    expect(r.cards[a]).toEqual({ id: a, title: 'First', deckId: d1 });
    expect(r.cards[b]).toEqual({ id: b, title: 'Second', deckId: d1 });
    expect(Object.keys(r.cards)).toHaveLength(2);
  });

  it('title contains (case-insensitive) and search matches words', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const bug = mkCard(d, owner, { content: 'Fix the Bug in save\nmore' });
    mkCard(d, owner, { content: 'Debugger polish' });
    mkCard(d, owner, { content: 'Other\nbug only in body' });
    const key = k('cards', { title: { op: 'contains', value: 'BUG IN' } });
    expect((runQuery(db, actor(owner), q([{ [key]: ['title'] }])) as any)._root[key]).toEqual([bug]);
    // search: every word must occur, ignoring case (plain substring match, kept cheap on purpose).
    const s = k('cards', { title: { op: 'search', value: 'save  BUG' } });
    expect((runQuery(db, actor(owner), q([{ [s]: ['title'] }])) as any)._root[s]).toEqual([bug]);
    const s2 = k('cards', { title: { op: 'search', value: 'bug' } });
    expect((runQuery(db, actor(owner), q([{ [s2]: ['title'] }])) as any)._root[s2]).toHaveLength(2);
    const pct = k('cards', { title: { op: 'contains', value: '%' } });
    expect((runQuery(db, actor(owner), q([{ [pct]: ['title'] }])) as any)._root[pct]).toEqual([]);
  });

  it('$order -lastUpdatedAt with $limit/$offset', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const ids = [10, 40, 20, 30].map((t) => mkCard(d, owner, { lastUpdatedAt: t }));
    const key = k('cards', { $order: '-lastUpdatedAt', $limit: 2, $offset: 1 });
    const r: any = runQuery(db, actor(owner), q([{ [key]: ['lastUpdatedAt'] }]));
    expect(r._root[key]).toEqual([ids[3], ids[2]]);
    expect(r.cards[ids[3]].lastUpdatedAt).toBe(30);
  });

  it('$or across deckId and assigneeId', () => {
    const owner = mkUser('owner');
    const m = mkUser('member');
    const p = mkProject('full');
    const d1 = mkDeck(p);
    const d2 = mkDeck(p);
    const inDeck = mkCard(d1, owner);
    const assigned = mkCard(d2, owner, { assigneeId: m });
    mkCard(d2, owner);
    const key = k('cards', { $or: [{ deckId: d1 }, { assigneeId: { op: 'eq', value: m } }] });
    expect((runQuery(db, actor(owner), q([{ [key]: ['title'] }])) as any)._root[key]).toEqual([inDeck, assigned]);
  });

  it('has / overlaps / in / neq null work', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const a = mkCard(d, owner, { masterTags: ['bug', 'ui'] });
    const b = mkCard(d, owner, { masterTags: ['design'] });
    const c = mkCard(d, owner, { assigneeId: owner });
    const run = (f: object) => { const key = k('cards', f); return (runQuery(db, actor(owner), q([{ [key]: ['title'] }])) as any)._root[key]; };
    expect(run({ masterTags: { op: 'has', value: 'ui' } })).toEqual([a]);
    expect(run({ masterTags: { op: 'overlaps', value: ['design', 'ui'] } })).toEqual([a, b]);
    expect(run({ id: { op: 'in', value: [c, a] } })).toEqual([a, c]);
    expect(run({ assigneeId: { op: 'neq', value: null } })).toEqual([c]);
    expect(run({ assigneeId: null })).toEqual([a, b]);
  });

  it('$first returns a single id', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    mkCard(d, owner);
    const last = mkCard(d, owner);
    const key = k('cards', { $order: '-seq', $first: true });
    const none = k('cards', { deckId: 'nope', $first: true });
    const r: any = runQuery(db, actor(owner), q([{ [key]: ['title'] }, { [none]: ['title'] }]));
    expect(r._root[key]).toBe(last);
    expect(r._root[none]).toBeNull();
  });

  it('nested task → list → project, through the account', () => {
    const owner = mkUser('owner');
    const p = mkProject('full', 'Game');
    const d = mkDeck(p, 'Backlog');
    const c = mkCard(d, owner, { content: 'Task' });
    const key = k('cards', { deckId: d });
    const r: any = runQuery(db, actor(owner), q([{ account: ['name', { [key]: ['title', { deck: ['title', { project: ['name'] }] }] }] }]));
    expect(r._root.account).toBe(accountId);
    expect(r.account[accountId]).toEqual({ id: accountId, name: 'W', [key]: [c] });
    expect(r.cards[c]).toEqual({ id: c, title: 'Task', deck: d });
    expect(r.decks[d]).toEqual({ id: d, title: 'Backlog', project: p });
    expect(r.projects[p]).toEqual({ id: p, name: 'Game' });
  });

  it('hasMany relations per parent honour $limit and $order', () => {
    const owner = mkUser('owner');
    const p = mkProject('full');
    const d1 = mkDeck(p);
    const d2 = mkDeck(p);
    const a1 = mkCard(d1, owner);
    const a2 = mkCard(d1, owner);
    mkCard(d1, owner);
    const b1 = mkCard(d2, owner);
    const r: any = runQuery(db, actor(owner), q([{ decks: [{ 'cards({"$limit":2})': ['title'] }] }]));
    expect(r.decks[d1]['cards({"$limit":2})']).toEqual([a1, a2]);
    expect(r.decks[d2]['cards({"$limit":2})']).toEqual([b1]);
  });

  it('tasks in a project I can\'t see never appear, even through a relation from a visible task', () => {
    const owner = mkUser('owner');
    const member = mkUser('member');
    const other = mkUser('member', 'Other');
    const open = mkProject('full', 'Open');
    const secret = mkProject('limited', 'Secret');
    const od = mkDeck(open);
    const sd = mkDeck(secret);
    const hiddenParent = mkCard(sd, owner, { content: 'Hidden parent' });
    const visible = mkCard(od, owner, { content: 'Visible', parentCardId: hiddenParent });
    const hiddenChild = mkCard(sd, owner, { content: 'Hidden child', parentCardId: visible });
    const deleted = mkCard(od, owner, { visibility: 'deleted', parentCardId: visible });
    const othersDeckless = mkCard(null, other, { content: 'Private' });
    const mineDeckless = mkCard(null, member, { content: 'Mine' });
    for (const c of [hiddenParent, visible, hiddenChild]) {
      db.prepare("INSERT INTO resolvables (id,card_id,context,creator_id,created_at) VALUES (?,?,'comment',?,0)").run(`r-${c}`, c, owner);
      db.prepare('INSERT INTO resolvable_entries (id,resolvable_id,author_id,content,created_at) VALUES (?,?,?,?,0)').run(`e-${c}`, `r-${c}`, owner, 'x');
      db.prepare('INSERT INTO hand_cards (user_id,card_id,sort_index) VALUES (?,?,0)').run(owner, c);
    }
    // Two queries (12 lists each at most), merged row by row.
    const r: any = { _root: {} };
    for (const part of [
      [
        { cards: ['title', { parentCard: ['title'] }, { childCards: ['title'] }, { resolvables: [{ entries: ['content'] }] }] },
        { decks: ['title', { cards: ['title'] }] },
        { projects: ['name', { decks: ['title'] }] },
      ],
      [
        { resolvables: ['cardId'] },
        { resolvableEntries: ['content', { resolvable: [{ card: ['title'] }] }] },
        { handCards: ['cardId', { card: ['title'] }] },
      ],
    ]) {
      const res: any = runQuery(db, actor(member), q(part));
      Object.assign(r._root, res._root);
      for (const [m, rows] of Object.entries(res)) {
        if (m === '_root') continue;
        for (const [id, row] of Object.entries(rows as object)) Object.assign((r[m] ??= {})[id] ??= {}, row);
      }
    }
    expect(r._root.cards).toEqual([visible, mineDeckless]);
    expect(Object.keys(r.cards).sort()).toEqual([visible, mineDeckless].sort());
    expect(r.cards[visible].parentCard).toBeNull();
    expect(r.cards[visible].childCards).toEqual([]);
    expect(r._root.decks).toEqual([od]);
    expect(Object.keys(r.decks)).toEqual([od]);
    expect(Object.keys(r.projects)).toEqual([open]);
    expect(Object.keys(r.resolvables)).toEqual([`r-${visible}`]);
    expect(Object.keys(r.resolvableEntries)).toEqual([`e-${visible}`]);
    expect(r._root.handCards).toEqual([`${owner}|${visible}`]);
    const all = JSON.stringify(r);
    for (const hidden of [hiddenParent, hiddenChild, deleted, othersDeckless, secret, sd]) expect(all).not.toContain(hidden);
    expect(all).not.toContain('Hidden');

    // The admin sees everything except deleted cards, including other people's deckless cards.
    const ra: any = runQuery(db, actor(owner), q([{ cards: ['title'] }]));
    expect(ra._root.cards).toEqual([hiddenParent, visible, hiddenChild, othersDeckless, mineDeckless]);
  });

  it('a user without a role sees nothing', () => {
    const owner = mkUser('owner');
    mkCard(mkDeck(mkProject('full')), owner);
    const ghost = newId();
    const r: any = runQuery(db, actor(ghost), q([{ account: ['name'] }, { cards: ['title'] }, { users: ['name'] }, { projects: ['name'] }]));
    expect(r._root).toEqual({ account: null, cards: [], users: [], projects: [] });
  });

  it('users expose id, name and role; email only to admins', () => {
    const owner = mkUser('owner', 'Olga');
    const member = mkUser('member', 'Max');
    const r: any = runQuery(db, actor(member), q([{ users: ['name', 'role'] }]));
    expect(r.users[owner]).toEqual({ id: owner, name: 'Olga', role: 'owner' });
    expect(JSON.stringify(r)).not.toMatch(/password|@x\.io/);
    const e = errorOf(() => runQuery(db, actor(member), q([{ users: ['email'] }])));
    expect([e.status, e.code, e.data]).toEqual([400, 'unknown_field', { path: '_root.users.email' }]);
    for (const f of ['passwordHash', 'password_hash', 'disabled']) {
      expect(errorOf(() => runQuery(db, actor(owner), q([{ users: [f] }]))).code).toBe('unknown_field');
    }
    const ra: any = runQuery(db, actor(owner), q([{ users: ['email'] }]));
    expect(ra.users[member].email).toBe(`${member}@x.io`);
  });

  it('unknown field → 400 unknown_field with path', () => {
    const owner = mkUser('owner');
    const cases: [unknown, string][] = [
      [q([{ cards: ['titel'] }]), '_root.cards.titel'],
      [q([{ bogus: ['title'] }]), '_root.bogus'],
      [q([{ account: [{ cards: [{ deck: [{ projekt: ['name'] }] }] }] }]), '_root.account.cards.deck.projekt'],
      [q([{ [k('cards', { dekId: 'x' })]: ['title'] }]), '_root.cards.dekId'],
      [q([{ [k('cards', { title: { op: 'like', value: 'x' } })]: ['title'] }]), '_root.cards.title.like'],
      [q([{ [k('cards', { masterTags: { op: 'contains', value: 'x' } })]: ['title'] }]), '_root.cards.masterTags.contains'],
      [q([{ [k('cards', { $order: '-nope' })]: ['title'] }]), '_root.cards.$order.nope'],
      // Long text is never a sort key (sorting 50k card bodies took ~0.25 s per list).
      [q([{ [k('cards', { $order: ['-seq', 'content'] })]: ['title'] }]), '_root.cards.$order.content'],
      [q([{ [k('resolvableEntries', { $order: 'content' })]: ['id'] }]), '_root.resolvableEntries.$order.content'],
      [q([{ [k('decks', { $order: '-description' })]: ['id'] }]), '_root.decks.$order.description'],
      [q([{ [k('cards', { $or: [{ nope: 1 }] })]: ['title'] }]), '_root.cards.nope'],
      [q([{ [k('cards', { $bogus: 1 })]: ['title'] }]), '_root.cards.$bogus'],
    ];
    for (const [query, path] of cases) {
      const e = errorOf(() => runQuery(db, actor(owner), query));
      expect([e.status, e.code, e.data], path).toEqual([400, 'unknown_field', { path }]);
    }
  });

  it('malformed queries → 400 invalid_query', () => {
    const owner = mkUser('owner');
    for (const bad of [null, {}, { _root: 'x' }, q(['title']), q([{ cards: 'title' }]), q([{ 'cards({oops)': ['title'] }]),
      q([{ [k('cards', { $limit: -1 })]: ['title'] }]), q([{ [k('cards', { seq: { op: 'gt', value: 'x' } })]: ['title'] }])]) {
      const e = errorOf(() => runQuery(db, actor(owner), bad));
      expect([e.status, e.code], JSON.stringify(bad)).toEqual([400, 'invalid_query']);
    }
  });

  it('3001 tasks → 3000 returned', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,created_at,last_updated_at) VALUES (?,?,?,?,'c',0,0)");
    db.exec('BEGIN');
    for (let i = 0; i < 3001; i++) ins.run(`c${i}`, ++seq, d, owner);
    db.exec('COMMIT');
    const r: any = runQuery(db, actor(owner), q([{ cards: ['seq'] }, { 'cards({"$limit":5000})': ['seq'] }, { decks: [{ cards: ['seq'] }] }]));
    expect(r._root.cards).toHaveLength(3000);
    expect(r._root['cards({"$limit":5000})']).toHaveLength(3000);
    expect(r.decks[d].cards).toHaveLength(3000);
  });

  it('7 levels → 400; 6 levels are fine', () => {
    const owner = mkUser('owner');
    const six = q([{ cards: [{ deck: [{ project: [{ decks: [{ cards: [{ deck: ['title'] }] }] }] }] }] }]);
    expect(() => runQuery(db, actor(owner), six)).not.toThrow();
    const seven = q([{ cards: [{ deck: [{ project: [{ decks: [{ cards: [{ deck: [{ project: ['name'] }] }] }] }] }] }] }]);
    const e = errorOf(() => runQuery(db, actor(owner), seven));
    expect([e.status, e.code]).toEqual([400, 'query_too_deep']);
  });

  it('20001 total rows → 400 query_too_large', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,created_at,last_updated_at) VALUES (?,?,?,?,'c',0,0)");
    db.exec('BEGIN');
    for (let i = 0; i < 3001; i++) ins.run(`c${i}`, ++seq, d, owner);
    db.exec('COMMIT');
    // 6 lists of 3000 + 2000 = exactly 20000 rows is allowed; one more row is not.
    const lists = (extra: number) => [...Array.from({ length: 6 }, (_, i) => ({ [k('cards', { seq: { op: 'gt', value: -i } })]: ['seq'] })),
      { [k('cards', { $limit: 2000 + extra })]: ['seq'] }];
    expect(() => runQuery(db, actor(owner), q(lists(0)))).not.toThrow();
    const e = errorOf(() => runQuery(db, actor(owner), q(lists(1))));
    expect([e.status, e.code]).toEqual([400, 'query_too_large']);
  });

  it('refuses costly filters before any SQL runs: query_too_large {reason, path}', () => {
    const owner = mkUser('owner');
    const L = QUERY_LIMITS;
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const nest = (n: number): object => (n === 0 ? { seq: 1 } : { $or: [nest(n - 1)] });
    const cases: [string, object, string][] = [
      // The review's attack: 199 search terms of 20 words in one $or (about 29 KB).
      ['or_branches', { $or: Array.from({ length: 199 }, () => ({ content: { op: 'search', value: `${words(19)} zzz` } })) }, '_root.cards.$or'],
      ['value_length', { content: { op: 'contains', value: 'x'.repeat(L.maxValueChars + 1) } }, '_root.cards.content'],
      ['value_length', { id: { op: 'in', value: ['x'.repeat(L.maxValueChars + 1)] } }, '_root.cards.id'],
      ['words', { content: { op: 'search', value: words(L.maxWords + 1) } }, '_root.cards.content'],
      ['text_terms_per_list', { $or: Array.from({ length: L.maxTextTermsPerList + 1 }, () => ({ content: { op: 'contains', value: 'a' } })) }, '_root.cards.content'],
      ['text_words', { $or: [{ content: { op: 'search', value: words(8) } }, { content: { op: 'search', value: words(L.maxTextWords - 8 + 1) } }] }, '_root.cards.content'],
      ['text_words', { title: { op: 'search', value: words(3) } }, '_root.cards.title'], // the computed title weighs 5 per word
      ['values', { id: { op: 'in', value: Array(L.maxValues + 1).fill('x') } }, '_root.cards.id'],
      ['values', { masterTags: { op: 'overlaps', value: Array(L.maxValues + 1).fill('x') } }, '_root.cards.masterTags'],
      ['array_terms', { $or: Array.from({ length: L.maxArrayTerms + 1 }, () => ({ masterTags: { op: 'has', value: 'x' } })) }, '_root.cards.masterTags'],
      ['or_depth', nest(L.maxOrDepth + 1), '_root.cards.$or'],
      ['or_depth', nest(3000), '_root.cards.$or'], // deep nesting is a clean 400, never a stack overflow
      // 25 = a $or group + 20 terms + 4 fields; the 26th predicate is refused.
      ['predicates', { $or: Array.from({ length: 20 }, (_, i) => ({ seq: i })), createdAt: 0, version: 1, sortIndex: 0, carryCount: 0, effort: 1 }, '_root.cards.effort'],
      // Sorting by the computed title takes 8 of the 25.
      ['predicates', { $order: '-title', $or: Array.from({ length: 16 }, (_, i) => ({ seq: i })), version: 1 }, '_root.cards.version'],
      ['offset', { $offset: L.maxOffset + 1 }, '_root.cards.$offset'],
    ];
    for (const [reason, filter, path] of cases) {
      const e = errorOf(() => runQuery(db, actor(owner), q([{ [k('cards', filter)]: ['title'] }])));
      expect([e.status, e.code, e.data], reason).toEqual([400, 'query_too_large', { reason, path }]);
    }
    const lists = Array.from({ length: L.maxLists + 1 }, (_, i) => ({ [k('cards', { seq: i })]: ['title'] }));
    expect(errorOf(() => runQuery(db, actor(owner), q(lists))).data).toEqual({ reason: 'lists', path: '_root.cards' });
    // Sort keys draw on the predicate budget too: 5 lists x 5 keys = 25 is the most a query can sort by.
    const sorted = (n: number) => Array.from({ length: n }, (_, i) => ({ [k('cards', { seq: { op: 'gt', value: -i }, $order: ['-status', 'priority', 'dueDate', 'visibility'] })]: ['title'] }));
    expect(() => runQuery(db, actor(owner), q(sorted(5)))).not.toThrow();
    expect(errorOf(() => runQuery(db, actor(owner), q(sorted(6)))).data).toEqual({ reason: 'predicates', path: '_root.cards.$order.status' });
    // At the limits, the same shapes are accepted.
    expect(() => runQuery(db, actor(owner), q([{ [k('cards', {
      $or: [{ content: { op: 'search', value: words(L.maxWords) } }, { content: { op: 'search', value: words(L.maxTextWords - L.maxWords) } }],
      $offset: L.maxOffset,
    })]: ['title'] }]))).not.toThrow();
  });

  it('the worst allowed query stays fast on a realistic dataset', () => {
    const owner = mkUser('owner');
    const d = mkDeck(mkProject('full'));
    const W = Array.from({ length: 8 }, (_, i) => `word${i}`.padEnd(24, 'x'));
    const content = (`#   ${W.join(' ')}\n`).repeat(5); // ~1 KB, contains every search word
    const ins = db.prepare("INSERT INTO cards (id,seq,deck_id,creator_id,content,master_tags_json,created_at,last_updated_at) VALUES (?,?,?,?,?,?,0,0)");
    const tags = JSON.stringify(Array.from({ length: 10 }, (_, i) => `tag${i}`));
    db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) ins.run(`c${i}`, ++seq, d, owner, content, tags);
    db.exec('COMMIT');
    const L = QUERY_LIMITS;
    // Every word but the last letter of the last one matches, so no LIKE stops early; all inside one $or.
    const hit = [...W.slice(0, 7), `${W[7].slice(0, 23)}y`].join(' ');
    const worst = {
      $or: [
        { content: { op: 'search', value: hit } },
        { content: { op: 'search', value: hit.split(' ').slice(0, L.maxTextWords - 8).join(' ') } },
        ...Array.from({ length: L.maxArrayTerms }, () => ({ masterTags: { op: 'overlaps', value: Array.from({ length: L.maxValues }, (_, i) => `n${i}`) } })),
      ],
      $order: '-title', $offset: L.maxOffset,
    };
    // The rest of the predicate budget (25 - 8 for -title - 1 $or - 2 searches - the overlaps) goes to one-key sorts of
    // other lists over all rows (content can never be a sort key); the remaining lists use the default order.
    const sorts = L.maxPredicates - 8 - 1 - 2 - L.maxArrayTerms;
    const rest = Array.from({ length: L.maxLists - 1 }, (_, i) => ({ [k('cards', { ...(i < sorts ? { $order: '-status' } : {}), $offset: L.maxOffset - i })]: ['title'] }));
    expect(errorOf(() => runQuery(db, actor(owner), q([{ [k('cards', { $order: 'content' })]: ['title'] }]))).code).toBe('unknown_field');
    const t = performance.now();
    runQuery(db, actor(owner), q([{ [k('cards', worst)]: ['title'] }, ...rest]));
    // ~50 ms here; ~0.7 s on 50k cards (see the Task 1 report). Generous bound against slow CI machines.
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('stops when the time budget runs out between lists', () => {
    const owner = mkUser('owner');
    let t = 0;
    const clock = () => (t += 3000);
    const e = errorOf(() => runQuery(db, actor(owner), q([{ cards: ['title'] }, { decks: ['title'] }, { projects: ['name'] }]), { now: clock }));
    expect([e.status, e.code]).toEqual([400, 'query_too_large']);
  });

  it('milestones, sprints and project tags follow project visibility', () => {
    const owner = mkUser('owner');
    const member = mkUser('member');
    const open = mkProject('full');
    const secret = mkProject('limited');
    const ms = (name: string, global: number, pid?: string) => {
      const id = newId();
      db.prepare("INSERT INTO milestones (id,account_seq,name,color,is_global,created_at) VALUES (?,?,?,'blue',?,0)").run(id, ++seq, name, global);
      if (pid) db.prepare('INSERT INTO milestone_projects (milestone_id,project_id) VALUES (?,?)').run(id, pid);
      return id;
    };
    const g = ms('Global', 1);
    const o = ms('Open', 0, open);
    ms('Secret', 0, secret);
    db.prepare("UPDATE projects SET tags_json='[{\"name\":\"bug\",\"emoji\":null}]'").run();
    const r: any = runQuery(db, actor(member), q([{ milestones: ['name'] }, { projectTags: ['name', 'projectId'] }]));
    expect(r._root.milestones.sort()).toEqual([g, o].sort());
    expect(r._root.projectTags).toEqual([`${open}|bug`]);
    expect(r.projectTags[`${open}|bug`]).toEqual({ id: `${open}|bug`, name: 'bug', projectId: open });
    void owner;
  });
});

describe('POST /api/query', () => {
  const HOST = 'localhost:8780';
  let app: ReturnType<typeof buildApp>;
  beforeEach(async () => { _resetLimiter(); app = buildApp({ db, hosts: [HOST] }); await app.ready(); });
  afterEach(async () => { await app.close(); });
  const post = (payload: unknown, cookie?: string) => app.inject({
    method: 'POST', url: '/api/query', payload: payload as any,
    headers: { host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  });

  it('needs a session, then answers with the normalized result or 400 unknown_field', async () => {
    const owner = mkUser('owner');
    db.prepare('UPDATE users SET email=? WHERE id=?').run('o@x.io', owner);
    const p = mkProject('full');
    const c = mkCard(mkDeck(p), owner, { content: 'Hello' });
    expect((await post({ query: q([{ cards: ['title'] }]) })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'o@x.io', password: 'pw' }, headers: { host: HOST, 'content-type': 'application/json' } });
    const sc = (login.cookies as { name: string; value: string }[]).find((x) => x.name === 'jt_session')!;
    const cookie = `jt_session=${sc.value}`;
    const ok = await post({ query: q([{ cards: ['title'] }]) }, cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ _root: { cards: [c] }, cards: { [c]: { id: c, title: 'Hello' } } });
    const bad = await post({ query: q([{ cards: ['titel'] }]) }, cookie);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'unknown_field', data: { path: '_root.cards.titel' } });
  });
});

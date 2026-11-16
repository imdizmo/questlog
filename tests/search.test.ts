import { describe, expect, it } from 'vitest';
import { cardCode, derivedStatus } from '../shared/cards';
import {
  compileSearch, decodeChips, encodeChips, quickResults, savedSearchName, suggest,
  type SearchCtx, type SearchToken, type SuggestCtx,
} from '../shared/search';
import type { Card, ResolvableEntry, Sprint } from '../shared/types';

let seq = 0;
function card(o: Partial<Card> = {}): Card {
  seq++;
  return {
    id: `c${seq}`, seq, deckId: 'd1', creatorId: 'u1', assigneeId: null, content: `Task ${seq}`, status: 'not_started',
    visibility: 'default', isDoc: false, version: 1, contentVersion: 1, sortIndex: seq, createdAt: 1, lastUpdatedAt: seq,
    snoozedAt: null, doneAt: null, priority: null, effort: null, dueDate: null, parentCardId: null, milestoneId: null,
    milestoneZoneId: null, sprintId: null, carryCount: 0, sprintJoinedAt: null, masterTags: [], tags: [],
    mentionedUserIds: [], checkboxStats: null, coverFileId: null,
    entryTypeId: null, entryKey: null, fields: {}, wikiParentId: null, ...o,
  } as Card;
}
const sprints = [
  { id: 'sp1', configId: 'cfg', startDay: '2026-11-02', endDay: '2026-11-15' },
  { id: 'sp2', configId: 'cfg', startDay: '2026-11-16', endDay: '2026-11-29' },
  { id: 'sp0', configId: 'cfg', startDay: '2026-10-19', endDay: '2026-11-01' },
] as Sprint[];
function ctx(o: Partial<SearchCtx> = {}): SearchCtx {
  return {
    status: (c) => derivedStatus(c, new Set()), personalTags: () => [], subCount: () => 0,
    todayDay: '2026-11-14', sprints, now: Date.UTC(2026, 10, 14), ...o,
  };
}
const t = (category: SearchToken['category'], value: string | null, extra: Partial<SearchToken> = {}): SearchToken =>
  ({ category, value, isNegated: false, ...extra });
const run = (tokens: SearchToken[], cards: Card[], forceOr = false, c = ctx()) =>
  cards.filter(compileSearch(tokens, forceOr, c));

describe('compileSearch', () => {
  it('a token with an unknown category (stored data) does not throw and matches nothing, negated or not', () => {
    const a = card(); const b = card();
    const bogus = { category: 'bogus', value: null, isNegated: false } as unknown as SearchToken;
    expect(() => compileSearch([bogus], false, ctx())).not.toThrow();
    expect(run([bogus], [a, b])).toEqual([]);
    expect(run([{ ...bogus, isNegated: true }], [a, b])).toEqual([]);
    // with forceOr the other tokens still match
    expect(run([bogus, t('content', 'Task')], [a, b], true)).toEqual([a, b]);
    expect(savedSearchName([bogus], sctx)).toBe('Unknown filter tasks');
  });
  it('content chip matches titles case-insensitively', () => {
    const a = card({ content: '# Fix the GETS bug\nbody' });
    const b = card({ content: 'Other\ngets in body only' });
    expect(run([t('content', 'gets')], [a, b])).toEqual([a]);
  });
  it('!blocked excludes blocked tasks', () => {
    const a = card(); const b = card();
    const c = ctx({ status: (x) => (x === b ? 'blocked' : 'unassigned') });
    expect(run([t('status', 'blocked', { isNegated: true })], [a, b], false, c)).toEqual([a]);
  });
  it('status snoozing and undone', () => {
    const a = card({ status: 'started', snoozedAt: 5 }); const b = card({ status: 'done' }); const c = card();
    expect(run([t('status', 'snoozing')], [a, b, c])).toEqual([a]);
    expect(run([t('status', 'undone')], [a, b, c])).toEqual([a, c]);
  });
  it('priority >= High matches a only; <= Medium matches b, c and none', () => {
    const a = card({ priority: 'a' }); const b = card({ priority: 'b' }); const c = card({ priority: 'c' }); const n = card();
    expect(run([t('priority', 'a', { op: 'gte' })], [a, b, c, n])).toEqual([a]);
    expect(run([t('priority', 'b', { op: 'lte' })], [a, b, c, n])).toEqual([b, c, n]);
    expect(run([t('priority', null, { op: 'eq' })], [a, n])).toEqual([n]);
  });
  it('effort eq / none', () => {
    const a = card({ effort: 3 }); const n = card();
    expect(run([t('effort', '3')], [a, n])).toEqual([a]);
    expect(run([t('effort', null)], [a, n])).toEqual([n]);
  });
  it('owner null matches unowned tasks', () => {
    const a = card({ assigneeId: 'u2' }); const n = card();
    expect(run([t('owner', null)], [a, n])).toEqual([n]);
    expect(run([t('owner', 'u2')], [a, n])).toEqual([a]);
  });
  it('forceOr switches AND to OR', () => {
    const a = card({ priority: 'a' }); const b = card({ effort: 2 }); const c = card({ priority: 'a', effort: 2 }); const n = card();
    const toks = [t('priority', 'a'), t('effort', '2')];
    expect(run(toks, [a, b, c, n])).toEqual([c]);
    expect(run(toks, [a, b, c, n], true)).toEqual([a, b, c]);
  });
  it('due week includes today and the next 6 days', () => {
    const days = ['2026-11-13', '2026-11-14', '2026-11-20', '2026-11-21'];
    const cs = days.map((d) => card({ dueDate: d }));
    expect(run([t('due', 'week')], cs).map((c) => c.dueDate)).toEqual(['2026-11-14', '2026-11-20']);
    expect(run([t('due', 'today')], cs).map((c) => c.dueDate)).toEqual(['2026-11-14']);
    expect(run([t('due', 'any')], [...cs, card()])).toHaveLength(4);
  });
  it('sprintConfig current/future/past use the sprint dates', () => {
    const past = card({ sprintId: 'sp0' }); const cur = card({ sprintId: 'sp1' }); const fut = card({ sprintId: 'sp2' }); const none = card();
    const all = [past, cur, fut, none];
    expect(run([t('sprintConfig', 'cfg:current')], all)).toEqual([cur]);
    expect(run([t('sprintConfig', 'cfg:future')], all)).toEqual([fut]);
    expect(run([t('sprintConfig', 'cfg:past')], all)).toEqual([past]);
    expect(run([t('sprintConfig', 'other:current')], all)).toEqual([]);
  });
  it('tags, milestone, sprint, card flags, deck, creator, mentioned', () => {
    const a = card({ tags: ['ui'], milestoneId: 'm1', sprintId: 'sp1', parentCardId: 'x', hasBlockingDeps: true, coverFileId: 'f', mentionedUserIds: ['u2'], deckId: 'd2' });
    const n = card({ isDoc: true, isBlockingDep: true });
    const all = [a, n];
    expect(run([t('projectTag', 'UI')], all)).toEqual([a]);
    expect(run([t('personalTag', 'mine')], all, false, ctx({ personalTags: (id) => (id === n.id ? ['mine'] : []) }))).toEqual([n]);
    expect(run([t('milestone', 'm1')], all)).toEqual([a]);
    expect(run([t('milestone', null)], all)).toEqual([n]);
    expect(run([t('sprint', 'sp1')], all)).toEqual([a]);
    expect(run([t('card', 'sub')], all)).toEqual([a]);
    expect(run([t('card', 'locked')], all)).toEqual([a]);
    expect(run([t('card', 'locking')], all)).toEqual([n]);
    expect(run([t('card', 'cover')], all)).toEqual([a]);
    expect(run([t('card', 'doc')], all)).toEqual([n]);
    expect(run([t('card', 'hero')], all, false, ctx({ subCount: (id) => (id === n.id ? 2 : 0) }))).toEqual([n]);
    expect(run([t('deck', 'd2')], all)).toEqual([a]);
    expect(run([t('creator', 'u1')], all)).toEqual(all);
    expect(run([t('mentioned', 'u2')], all)).toEqual([a]);
  });
  it('project tag search matches master tags as well as inline #tags', () => {
    const m = card({ masterTags: ['Bug'], tags: [] });
    const inline = card({ tags: ['bug'] });
    const none = card();
    expect(run([t('projectTag', '#bug')], [m, inline, none])).toEqual([m, inline]);
  });
  it('no tokens matches everything', () => {
    const a = card();
    expect(run([], [a])).toEqual([a]);
    expect(run([], [a], true)).toEqual([a]);
  });
  it('compileSearch over 5000 tasks runs in under 50 ms', () => {
    const cards = Array.from({ length: 5000 }, (_, i) => card({ content: `Task number ${i}`, priority: i % 2 ? 'a' : 'b', effort: i % 9, tags: ['x'] }));
    const toks = [t('content', 'number'), t('priority', 'a', { op: 'gte' }), t('effort', '3', { op: 'lte' }), t('projectTag', 'x'), t('status', 'blocked', { isNegated: true })];
    const t0 = performance.now();
    const out = cards.filter(compileSearch(toks, false, ctx()));
    const ms = performance.now() - t0;
    expect(out.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});

const sctx: SuggestCtx = {
  users: [{ id: 'u1', name: 'Zed' }, { id: 'u2', name: 'Amy' }],
  decks: [{ id: 'd1', title: 'Backlog' }],
  projectTags: ['ui', 'bug'], personalTags: ['later'],
  milestones: [{ id: 'm1', name: 'M1 Alpha' }],
  sprints: [{ id: 'sp1', configId: 'cfg', label: 'Run 1' }],
  sprintConfigs: [{ id: 'cfg', name: 'Sprint' }],
  priorityLabel: (p) => ({ a: 'High', b: 'Medium', c: 'Low' })[p],
  cardBySeq: (s) => (s === 5 ? card({ seq: 5, content: 'Five' }) : null),
};
const items = (gs: ReturnType<typeof suggest>) => gs.flatMap((g) => g.items);

describe('suggest', () => {
  it("suggest('high') offers Priority eq, gte and lte", () => {
    const gs = suggest('high', sctx);
    const pri = gs.find((g) => g.heading === 'Priority')!;
    expect(pri.items.map((i) => [i.token?.value, i.token?.op])).toEqual([['a', 'eq'], ['a', 'gte'], ['a', 'lte']]);
  });
  it('free text always keeps Content and Go to rows; keyword hits are added', () => {
    const fixed = ['Content', 'Go to list', 'Go to task', 'Go to comment'];
    for (const text of ['e', 'no', 'a', '3', 'high', 'run']) {
      const heads = suggest(text, sctx).map((g) => g.heading);
      expect(heads).toEqual(expect.arrayContaining(fixed));
    }
    expect(suggest('high', sctx).map((g) => g.heading)).toEqual([...fixed, 'Priority']);
    expect(suggest('blocked', sctx).map((g) => g.heading)).toEqual(['Status', ...fixed]);
    expect(suggest('e', sctx).find((g) => g.heading === 'Content')!.items[0].token).toEqual({ category: 'content', value: 'e', isNegated: false });
  });
  it("suggest('!') offers negatable groups only", () => {
    const gs = suggest('!', sctx);
    const heads = gs.map((g) => g.heading);
    expect(heads).toEqual(expect.arrayContaining(['Task', 'Effort', 'Priority', 'Status', 'Milestone']));
    expect(heads).not.toContain('Content');
    expect(heads).not.toContain('Go to list');
    expect(items(gs).every((i) => i.token?.isNegated === true)).toBe(true);
    expect(items(suggest('!block', sctx)).map((i) => i.token?.value)).toEqual(['blocked']);
  });
  it("suggest('$11i') offers the task or the \"no task\" row", () => {
    const miss = suggest('$11i', sctx);
    expect(miss[0].heading).toBe('Go to task');
    expect(miss[0].items[0].label).toBe('No task with this code');
    expect(miss[0].items[0].disabled).toBe(true);
    const hit = suggest(`$${cardCode(5)}`, sctx);
    expect(hit[0].items[0].goto).toEqual({ kind: 'card', id: expect.any(String) });
  });
  it('free text, tags, people, go-to prefixes', () => {
    expect(suggest('gets', sctx).map((g) => g.heading)).toEqual(['Content', 'Go to list', 'Go to task', 'Go to comment']);
    expect(suggest('gets', sctx)[0].items[0].token).toEqual({ category: 'content', value: 'gets', isNegated: false });
    expect(suggest('blocked', sctx)[0].heading).toBe('Status');
    expect(suggest('#u', sctx).map((g) => g.heading)).toEqual(['Project tag']);
    expect(suggest('#', sctx).map((g) => g.heading)).toEqual(['Project tag', 'Personal tag']);
    expect(suggest('@', sctx).map((g) => g.heading)).toEqual(['Owner', 'Created by', 'Mentioned']);
    expect(items(suggest('@', sctx))[0].token).toEqual({ category: 'owner', value: null, isNegated: false });
    const gd = suggest('gd:back', sctx);
    expect(gd).toHaveLength(1);
    expect(gd[0].items[0].goto).toEqual({ kind: 'deck', id: 'd1' });
    expect(suggest('gm:hello', sctx)[0].items[0].goto).toEqual({ kind: 'comment', text: 'hello' });
    expect(suggest('', sctx)).toEqual([]);
  });
  it('run, milestone, due, effort, card', () => {
    const g = (text: string, h: string) => suggest(text, sctx).find((x) => x.heading === h)!;
    expect(suggest('run', sctx).map((x) => x.heading)).toEqual(expect.arrayContaining(['Sprint', 'Sprint track']));
    expect(g('M1', 'Milestone')).toBeDefined();
    expect(g('due', 'Due date').items.map((i) => i.token?.value)).toEqual(['today', 'week', 'any']);
    expect(g('effort', 'Effort').items).toHaveLength(7);
    expect(g('hero', 'Task')).toBeDefined();
  });
});

describe('savedSearchName', () => {
  it('names from chips', () => {
    expect(savedSearchName([t('content', 'gets')], sctx)).toBe("'gets' tasks");
    expect(savedSearchName([t('priority', 'a', { op: 'eq' })], sctx)).toBe('High priority tasks');
    expect(savedSearchName([t('status', 'blocked', { isNegated: true })], sctx)).toBe('Not blocked tasks');
    expect(savedSearchName([], sctx)).toBe('All tasks');
    expect(savedSearchName([t('owner', null, { isNegated: true })], sctx)).toBe('Owned tasks');
    expect(savedSearchName([t('content', 'a'), t('status', 'done')], sctx, true)).toBe("'a' or done tasks");
  });
});

describe('quickResults', () => {
  it('caps 10 tasks and 5 comments, newest first', () => {
    const cards = Array.from({ length: 15 }, (_, i) => card({ content: `Alpha ${i}`, lastUpdatedAt: i }));
    const entries = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, resolvableId: 'r', authorId: 'u1', content: `Hello Alpha world ${i}`, createdAt: i, version: 1, lastChangedAt: null }) as ResolvableEntry);
    const r = quickResults('alpha', cards, entries, ctx());
    expect(r.cards).toHaveLength(10);
    expect(r.cards[0].lastUpdatedAt).toBe(14);
    expect(r.comments).toHaveLength(5);
    expect(r.comments[0].id).toBe('e7');
    expect(r.codeHit).toBeNull();
  });
  it('comment match is by whole word', () => {
    const e = { id: 'e', resolvableId: 'r', authorId: 'u', content: 'alphabet', createdAt: 1, version: 1, lastChangedAt: null } as ResolvableEntry;
    expect(quickResults('alpha', [], [e], ctx()).comments).toEqual([]);
  });
  it('code jump', () => {
    const c = card({ seq: 42 });
    expect(quickResults(`$${cardCode(42)}`, [c], [], ctx()).codeHit).toBe(c);
    expect(quickResults(cardCode(42), [c], [], ctx()).codeHit).toBe(c);
    expect(quickResults('zzz!', [c], [], ctx()).codeHit).toBeNull();
  });
});

describe('chips url form', () => {
  it('round-trips', () => {
    const tokens = [t('content', 'ünï & café'), t('priority', 'a', { op: 'gte', isNegated: true }), t('owner', null)];
    const s = encodeChips(tokens, true);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeChips(s)).toEqual({ tokens, forceOr: true });
  });
  it('decodeChips rejects garbage', () => {
    expect(decodeChips('')).toBeNull();
    expect(decodeChips('%%%')).toBeNull();
    expect(decodeChips('bm90LWpzb24')).toBeNull();
    const bad = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    expect(decodeChips(bad({ tokens: [{ category: 'nope', value: 'x', isNegated: false }], forceOr: false }))).toBeNull();
    expect(decodeChips(bad({ tokens: [{ category: 'content', value: 3, isNegated: false }], forceOr: false }))).toBeNull();
    expect(decodeChips(bad({ tokens: 'x', forceOr: false }))).toBeNull();
    expect(decodeChips(bad({ tokens: [], forceOr: 'yes' }))).toBeNull();
  });
});

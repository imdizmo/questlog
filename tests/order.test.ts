import { describe, expect, it } from 'vitest';
import { derivedStatus } from '../shared/cards';
import { addSortKey, groupCards, normalizeView, NOT_SECONDARY, ORDER_PROPS, type DeckView, type OrderCtx } from '../shared/order';
import type { Card, Milestone, Sprint, User } from '../shared/types';

let seq = 0;
function card(o: Partial<Card> & { carryCount?: number; sprintJoinedAt?: number | null } = {}): Card {
  seq++;
  return {
    id: `c${seq}`, seq, deckId: 'd', creatorId: 'u1', assigneeId: null, content: `Task ${seq}`, status: 'not_started',
    visibility: 'default', isDoc: false, version: 1, contentVersion: 1, sortIndex: seq, createdAt: 1, lastUpdatedAt: 1,
    snoozedAt: null, doneAt: null, priority: null, effort: null, dueDate: null, parentCardId: null, milestoneId: null,
    milestoneZoneId: null, sprintId: null, masterTags: [], tags: [], mentionedUserIds: [], checkboxStats: null,
    coverFileId: null, entryTypeId: null, entryKey: null, fields: {}, wikiParentId: null, aliases: [], linkIgnores: [], ...o,
  } as Card;
}
const users = [
  { id: 'u1', name: 'Zed' }, { id: 'u2', name: 'Amy' },
] as User[];
const milestones = [{ id: 'm1', name: 'Alpha' }, { id: 'm2', name: 'Beta' }] as Milestone[];
const sprints = [{ id: 's1', configId: 'cfg', label: 'Run 1' }, { id: 's2', configId: 'cfg', label: 'Run 2' }] as Sprint[];
function ctx(o: Partial<OrderCtx> = {}): OrderCtx {
  return {
    users, milestones, sprints,
    isDone: (c) => c.status === 'done',
    status: (c) => derivedStatus(c, new Set()),
    hasOpenNotification: () => false,
    timeTotal: () => 0,
    subCount: () => 0,
    personalTags: () => [],
    fallbackEffort: 2,
    priorityLabel: (p) => ({ a: 'High', b: 'Medium', c: 'Low' })[p],
    currentSprintStart: () => 1000,
    ...o,
  };
}
const view = (prop: DeckView['prop'], extra: Partial<DeckView> = {}): DeckView => ({ prop, isReversed: false, mode: 'miniCard', secondary: null, ...extra });
const labels = (gs: { label: string }[]) => gs.map((x) => x.label);
const feats = { milestonesEnabled: true, sprintsEnabled: true, dueDateEnabled: true, timeTrackingOn: true };

describe('groupCards', () => {
  it('groups by priority with labels and a "No priority" group last', () => {
    const gs = groupCards([card(), card({ priority: 'c' }), card({ priority: 'a' })], view('priority'), ctx());
    expect(labels(gs)).toEqual(['High', 'Low', 'No priority']);
    expect(gs[0]!.filterToken).toEqual({ category: 'priority', value: 'a', isNegated: false, op: 'eq' });
  });

  it('effort groups: 3, 8, then "Doc Task", then "No effort"', () => {
    const gs = groupCards([card(), card({ isDoc: true }), card({ effort: 8 }), card({ effort: 3 })], view('effort'), ctx());
    expect(labels(gs)).toEqual(['3 effort', '8 effort', 'Lore', 'No effort']);
  });

  it('state reversed gives Doc task, Done, Review, Blocked, Started, Assigned, Unassigned', () => {
    const cards = [
      card(), card({ assigneeId: 'u1' }), card({ status: 'started' }), card({ status: 'done' }), card({ isDoc: true }),
    ];
    const review = card();
    const blocked = card();
    const c = ctx({
      status: (x) => (x.id === review.id ? 'review' : x.id === blocked.id ? 'blocked' : derivedStatus(x, new Set())),
    });
    const gs = groupCards([...cards, review, blocked], view('status', { isReversed: true }), c);
    expect(labels(gs)).toEqual(['Lore', 'Done', 'In review', 'Blocked', 'Started', 'Assigned', 'Unassigned']);
  });

  it('owner groups use the user name, then "No owner"', () => {
    const gs = groupCards([card(), card({ assigneeId: 'u1' }), card({ assigneeId: 'u2' })], view('assignee'), ctx());
    expect(labels(gs)).toEqual(['Amy', 'Zed', 'No owner']);
    expect(gs[0]!.filterToken).toEqual({ category: 'owner', value: 'u2', isNegated: false });
  });

  it('changes puts tasks with open notifications first, then "Tasks with no open notifications"', () => {
    const a = card();
    const b = card();
    const gs = groupCards([b, a], view('changes'), ctx({ hasOpenNotification: (id) => id === a.id }));
    expect(labels(gs)).toEqual(['Tasks with open notifications', 'Tasks with no open notifications']);
    expect(gs[0]!.cards).toEqual([a]);
    expect(gs[0]!.filterToken).toBeNull();
  });

  it('secondary keys order inside a group but do not create groups', () => {
    const a = card({ priority: 'a', effort: 8 });
    const b = card({ priority: 'a', effort: 3 });
    const c = card({ priority: 'a' });
    const v = view('priority', { secondary: [{ prop: 'effort', isReversed: false }] });
    const gs = groupCards([a, b, c], v, ctx());
    expect(gs).toHaveLength(1);
    expect(gs[0]!.cards).toEqual([b, a, c]);
    const rev = groupCards([a, b, c], view('priority', { secondary: [{ prop: 'effort', isReversed: true }] }), ctx());
    expect(rev[0]!.cards).toEqual([c, a, b]);
  });

  it('hideEmpty removes groups with zero tasks for sprint and milestone keys', () => {
    const cards = [card({ sprintId: 's1', milestoneId: 'm2' })];
    expect(labels(groupCards(cards, view('sprint'), ctx()))).toEqual(['Run 1', 'Run 2']);
    expect(labels(groupCards(cards, view('sprint', { hideEmpty: true }), ctx()))).toEqual(['Run 1']);
    expect(labels(groupCards(cards, view('milestone'), ctx()))).toEqual(['Alpha', 'Beta']);
    expect(labels(groupCards(cards, view('milestone', { hideEmpty: true }), ctx()))).toEqual(['Beta']);
  });

  it('group effort: effortDone and effortTotal use fallbackEffort for tasks without effort; doc tasks count 0', () => {
    const cards = [
      card({ priority: 'a', effort: 5, status: 'done' }), card({ priority: 'a' }),
      card({ priority: 'a', status: 'done' }), card({ priority: 'a', isDoc: true, effort: 9 }),
    ];
    const [gr] = groupCards(cards, view('priority'), ctx());
    expect(gr!.effortTotal).toBe(9);
    expect(gr!.effortDone).toBe(7);
  });

  it('beastLevel: carryCount groups "1", "2"...; "new" for a task joined after its run start; else "No beast level"', () => {
    const cards = [
      card({ carryCount: 2 }), card({ carryCount: 1 }),
      card({ sprintId: 's1', sprintJoinedAt: 2000 }),
      card({ sprintId: 's1', sprintJoinedAt: 500 }),
      card(),
    ];
    expect(labels(groupCards(cards, view('beastLevel'), ctx()))).toEqual(['1', '2', 'new', 'No difficulty']);
  });

  it('each group carries a filterToken matching its key', () => {
    const done = card({ status: 'done' });
    const [gr] = groupCards([done], view('status'), ctx());
    expect(gr!.filterToken).toEqual({ category: 'status', value: 'done', isNegated: false });
    for (const p of ['title', 'createdAt', 'lastUpdatedAt', 'timeTracked', 'changes'] as const) {
      expect(groupCards([done], view(p), ctx())[0]!.filterToken).toBeNull();
    }
    expect(groupCards([card({ tags: ['ui'] })], view('projectTags'), ctx())[0]!.filterToken).toEqual({ category: 'projectTag', value: 'ui', isNegated: false });
    const hero = card();
    expect(groupCards([hero], view('heroCard'), ctx({ subCount: () => 1 }))[0]!.filterToken).toEqual({ category: 'card', value: 'hero', isNegated: false });
  });

  it('projectTags and tags order keys use master tags united with inline tags', () => {
    const c = card({ masterTags: ['bug'], tags: ['ui', 'bug'] });
    for (const p of ['projectTags', 'tags'] as const) {
      const keys = groupCards([c], view(p), ctx()).map((x) => x.key).sort();
      expect(keys).toEqual(['projectTag:bug', 'projectTag:ui']);
    }
    expect(groupCards([card({ masterTags: ['bug'] })], view('projectTags'), ctx())[0]!.filterToken).toMatchObject({ category: 'projectTag', value: 'bug' });
  });

  it('due date buckets, time tracked hours, title letters and manual order', () => {
    const now = new Date(2026, 10, 14, 12).getTime();
    const day = (n: number) => { const d = new Date(now + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const due = [card({ dueDate: day(-1) }), card({ dueDate: day(0) }), card({ dueDate: day(3) }), card({ dueDate: day(20) }), card()];
    expect(labels(groupCards(due, view('dueDate'), ctx({ now })))).toEqual(['Overdue', 'Today', 'This week', 'Later', 'No due date']);
    const t = card();
    expect(labels(groupCards([t], view('timeTracked'), ctx({ timeTotal: () => 2.5 * 3_600_000 })))).toEqual(['2 h']);
    expect(labels(groupCards([card({ content: 'banana' }), card({ content: '# apple' })], view('title'), ctx()))).toEqual(['A', 'B']);
    const m1 = card({ sortIndex: 5 });
    const m2 = card({ sortIndex: 1 });
    expect(groupCards([m1, m2], view('manual'), ctx())[0]!.cards).toEqual([m2, m1]);
    expect(groupCards([m1, m2], view('manual', { isReversed: true }), ctx())[0]!.cards).toEqual([m1, m2]);
  });

  it('stays fast on a large list', () => {
    const cards = Array.from({ length: 20000 }, (_, i) => card({ priority: (['a', 'b', 'c'] as const)[i % 3], effort: i % 7 }));
    const t = Date.now();
    groupCards(cards, view('priority', { secondary: [{ prop: 'effort', isReversed: false }] }), ctx());
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('addSortKey', () => {
  it('multi appends; same key flips; non-multi resets secondary', () => {
    let v = view('priority');
    v = addSortKey(v, 'effort', false, true);
    expect(v.secondary).toEqual([{ prop: 'effort', isReversed: false }]);
    v = addSortKey(v, 'effort', false, true);
    expect(v.secondary).toEqual([{ prop: 'effort', isReversed: true }]);
    v = addSortKey(v, 'priority', false, true);
    expect(v.isReversed).toBe(true);
    v = addSortKey(v, 'title', true, false);
    expect(v).toMatchObject({ prop: 'title', isReversed: true, secondary: null });
  });
});

describe('normalizeView', () => {
  it('drops secondary keys in NOT_SECONDARY, duplicates of the primary, unknown props, and keys whose feature is off', () => {
    const raw = {
      prop: 'priority', isReversed: true, mode: 'tableView',
      secondary: [
        { prop: 'manual' }, { prop: 'priority' }, { prop: 'bogus' }, { prop: 'milestone' }, { prop: 'dueDate' },
        { prop: 'effort', isReversed: true }, { prop: 'effort' }, { prop: 'title' },
      ],
    };
    const v = normalizeView(raw, { ...feats, milestonesEnabled: false, dueDateEnabled: false });
    expect(v.secondary).toEqual([{ prop: 'effort', isReversed: true }, { prop: 'title', isReversed: false }]);
    expect(v).toMatchObject({ prop: 'priority', isReversed: true, mode: 'tableView' });
    expect(NOT_SECONDARY).toEqual(['manual', 'changes', 'heroCard']);
  });

  it('falls back to the default view for junk or a disabled primary', () => {
    const d = { prop: 'priority', isReversed: false, mode: 'miniCard', secondary: null };
    expect(normalizeView(null, feats)).toEqual(d);
    expect(normalizeView({ prop: 'sprint' }, { ...feats, sprintsEnabled: false })).toEqual(d);
    expect(ORDER_PROPS).toHaveLength(19);
  });
});

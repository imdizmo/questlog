import { describe, it, expect } from 'vitest';
import {
  childrenOf, depCandidates, liveCardIds, formatSize, heroCandidates, lockersOf, lockedByCard, subCandidates, unfinishedLockers, subCountLabel,
} from '../web/src/relations';
import { describeChange } from '../web/src/components/HistoryTab';
import { sameSet, shouldRelease } from '../web/src/pending';

const deck = (id: string, projectId: string) => ({ id, projectId }) as any;
let seq = 0;
const card = (id: string, deckId: string | null, extra: object = {}) =>
  ({ id, seq: ++seq, deckId, parentCardId: null, isDoc: false, visibility: 'default', status: 'not_started', content: id, lastUpdatedAt: seq, ...extra }) as any;

const decks = new Map([['d1', deck('d1', 'p1')], ['d2', deck('d2', 'p1')], ['x', deck('x', 'p2')]]);

describe('hero and subtask candidates', () => {
  // a ← b ← c (b is a's child, c is b's child); e is in another project; f is a doc.
  const a = card('a', 'd1');
  const b = card('b', 'd1', { parentCardId: 'a' });
  const c = card('c', 'd2', { parentCardId: 'b' });
  const e = card('e', 'x');
  const f = card('f', 'd1', { isDoc: true });
  const g = card('g', 'd2', { visibility: 'archived' });
  const all = [a, b, c, e, f, g];

  it('children are the tasks pointing at the hero', () => {
    expect(childrenOf(all, 'a').map((x) => x.id)).toEqual(['b']);
    expect(childrenOf(all, 'c')).toEqual([]);
  });
  it('a hero can be any live task task of the same project that is not the task or below it', () => {
    expect(heroCandidates(all, decks, b).map((x) => x.id)).toEqual([]); // a is its hero already, c is below it
    expect(heroCandidates(all, decks, a).map((x) => x.id)).toEqual([]); // b and c are below a
    expect(heroCandidates(all, decks, c).map((x) => x.id).sort()).toEqual(['a']);
  });
  it('a subtask can be any live task task of the same project that is not the task, its ancestors or a child already', () => {
    expect(subCandidates(all, decks, c).map((x) => x.id)).toEqual([]);
    expect(subCandidates(all, decks, a).map((x) => x.id)).toEqual(['c']);
    expect(subCandidates(all, decks, card('h', 'd1')).map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });
  it('a deckless task has no candidates', () => {
    expect(subCandidates(all, decks, card('z', null))).toEqual([]);
    expect(heroCandidates(all, decks, card('z', null))).toEqual([]);
  });
  it('says how many subtasks', () => {
    expect(subCountLabel(1)).toBe('1 subtask');
    expect(subCountLabel(3)).toBe('3 subtasks');
  });
});

describe('dependencies', () => {
  const deps = [{ lockedCardId: 'gate', lockingCardId: 'key' }, { lockedCardId: 'gate', lockingCardId: 'map' }, { lockedCardId: 'door', lockingCardId: 'gate' }];
  it('splits a task\'s deps into locking (in) and locked (out)', () => {
    expect(lockersOf(deps, 'gate').sort()).toEqual(['key', 'map']);
    expect(lockedByCard(deps, 'gate')).toEqual(['door']);
  });
  it('counts only unfinished lockers', () => {
    const cards = new Map([['key', card('key', 'd1', { status: 'done' })], ['map', card('map', 'd1')]]);
    expect(unfinishedLockers(deps, cards, 'gate').map((c) => c.id)).toEqual(['map']);
  });
  it('offers live tasks of the same project that would not close a loop, in either direction', () => {
    // chest → key → gate → door → hall  (a → b: a locks b)
    const chain = [
      { lockingCardId: 'chest', lockedCardId: 'key' }, { lockingCardId: 'key', lockedCardId: 'gate' },
      { lockingCardId: 'gate', lockedCardId: 'door' }, { lockingCardId: 'door', lockedCardId: 'hall' },
    ];
    const gate = card('gate', 'd1');
    const cards = [gate, ...['chest', 'key', 'door', 'hall', 'free'].map((id) => card(id, 'd1')),
      card('far', 'x'), card('old', 'd1', { visibility: 'archived' })];
    // Gate already waits for key; door and hall wait for gate, so they can't lock it.
    expect(depCandidates(cards, decks, gate, chain, 'locking').map((c) => c.id).sort()).toEqual(['chest', 'free']);
    // Gate already locks door; key and chest lock gate, so gate can't lock them.
    expect(depCandidates(cards, decks, gate, chain, 'locked').map((c) => c.id).sort()).toEqual(['free', 'hall']);
  });
  it('stops on a loop already in the data', () => {
    const loop = [{ lockingCardId: 'a', lockedCardId: 'b' }, { lockingCardId: 'b', lockedCardId: 'a' }];
    const x = card('x', 'd1');
    expect(depCandidates([x, card('a', 'd1'), card('b', 'd1')], decks, x, loop, 'locking').map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});

describe('dependency writes send live tasks only', () => {
  it('drops ids of missing or deleted tasks', () => {
    const cards = new Map([['a', { visibility: 'default' }], ['b', { visibility: 'deleted' }], ['c', { visibility: 'archived' }]]) as any;
    expect(liveCardIds(cards, ['a', 'b', 'c', 'gone'])).toEqual(['a', 'c']);
  });
});

describe('attachments', () => {
  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(5 * 1024 * 1024 + 300000)).toBe('5.3 MB');
  });
});

describe('history labels for relations', () => {
  const cards = new Map([['k', { id: 'k', content: 'Key' }], ['h', { id: 'h', content: 'Level 1\nmore' }]]) as any;
  const n = { users: new Map(), decks: new Map(), cards };
  it('names tasks by title', () => {
    expect(describeChange({ kind: 'deps', from: [], to: ['k'] }, n)).toEqual({ label: 'Dependencies changed', detail: '+Key' });
    expect(describeChange({ kind: 'parent', from: null, to: 'h' }, n)).toEqual({ label: 'Main task set', detail: 'Level 1' });
    expect(describeChange({ kind: 'parent', from: 'h', to: null }, n)).toEqual({ label: 'Main task removed', detail: 'Level 1' });
    expect(describeChange({ kind: 'children', from: ['k'], to: ['k', 'zz'] }, n)).toEqual({ label: 'Subtasks changed', detail: '+a task' });
    expect(describeChange({ kind: 'file', from: null, to: 'flag.png' }, n)).toEqual({ label: 'Attachment added', detail: 'flag.png' });
    expect(describeChange({ kind: 'file', from: 'flag.png', to: null }, n)).toEqual({ label: 'Attachment removed', detail: 'flag.png' });
  });
});

describe('pending whole-array writes', () => {
  it('compares lists as sets', () => {
    expect(sameSet(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameSet(['a', 'a'], ['a', 'b'])).toBe(false);
  });
  it('lets the draft go once the store echoes it in its own order, or moves on', () => {
    // Appended draft, sorted echo.
    expect(shouldRelease(['a', 'z', 'm'].sort(), ['a', 'z', 'm'], null)).toBe(true);
    // Still waiting: the store hasn't caught up and hasn't moved since the last write finished.
    expect(shouldRelease(['a'], ['a', 'b'], ['a'])).toBe(false);
    expect(shouldRelease(['a'], ['b', 'a'], ['a'])).toBe(false);
    // The store moved on (someone else wrote).
    expect(shouldRelease(['c'], ['a', 'b'], ['a'])).toBe(true);
    // Reordered echo of the settled value is not "moved on".
    expect(shouldRelease(['b', 'a'], ['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });
});

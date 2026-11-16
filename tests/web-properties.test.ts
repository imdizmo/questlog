import { describe, it, expect } from 'vitest';
import { deckStats, formatDay, localToday, priorityGroups, priorityName } from '../web/src/cards';
import { describeChange } from '../web/src/components/HistoryTab';
import { DEFAULT_SETTINGS } from '../shared/types';

const card = (p: 'a' | 'b' | 'c' | null, effort: number | null, done = false, isDoc = false) => ({ priority: p, effort, isDoc, done });
const names = { users: new Map(), decks: new Map(), priorityLabels: { a: 'Urgent', b: 'Normal', c: 'Someday' } };

describe('list stats', () => {
  it('sums effort with the fallback and counts done/total per priority, docs left out', () => {
    const cards = [card('a', 5), card('a', null, true), card(null, 2, true), card('c', 3, false, true)];
    const s = deckStats(cards, (c) => c.done, { fallbackEffort: 1 });
    expect(s.effortTotal).toBe(8);
    expect(s.effortDone).toBe(3);
    expect(s.byPriority).toEqual([
      { priority: 'a', done: 1, total: 2 },
      { priority: 'b', done: 0, total: 0 },
      { priority: 'c', done: 0, total: 0 },
      { priority: null, done: 1, total: 1 },
    ]);
  });
  it('a fresh task with no effort counts as the fallback (observed 1 / 7 style)', () => {
    expect(deckStats([card(null, null)], () => false, { fallbackEffort: 1 }).effortTotal).toBe(1);
  });
  it('groups tasks High → Medium → Low → none, skipping empty groups and keeping order', () => {
    const g = priorityGroups([{ priority: null, n: 1 }, { priority: 'c', n: 2 }, { priority: 'a', n: 3 }, { priority: null, n: 4 }] as any[]);
    expect(g.map((x) => [x.priority, x.cards.map((c: any) => c.n)])).toEqual([['a', [3]], ['c', [2]], [null, [1, 4]]]);
    expect(priorityName(null, DEFAULT_SETTINGS)).toBe('No priority');
    expect(priorityName('a', DEFAULT_SETTINGS)).toBe('High');
  });
});

describe('defaults', () => {
  it('ships with due dates switched off (the e2e workspace may turn them on)', () => {
    expect(DEFAULT_SETTINGS.dueDateEnabled).toBe(false);
  });
});

describe('dates', () => {
  it('formats local days', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatDay('2026-11-15', new Date(2026, 10, 14))).not.toContain('2026');
    expect(formatDay('2027-01-02', new Date(2026, 10, 14))).toContain('2027');
  });
});

describe('history wording for properties', () => {
  it('uses the workspace priority labels', () => {
    expect(describeChange({ kind: 'priority', from: null, to: 'a' }, names)).toEqual({ label: 'Priority set', detail: 'none → Urgent' });
    expect(describeChange({ kind: 'priority', from: 'c', to: null }, names)).toEqual({ label: 'Priority removed', detail: 'Someday → none' });
  });
  it('describes effort, due date and tag changes', () => {
    expect(describeChange({ kind: 'effort', from: null, to: 0 }, names)).toEqual({ label: 'Effort set', detail: 'none → 0' });
    expect(describeChange({ kind: 'effort', from: 5, to: null }, names).label).toBe('Effort removed');
    expect(describeChange({ kind: 'dueDate', from: null, to: '2026-12-01' }, names)).toEqual({ label: 'Due date set', detail: 'none → 2026-12-01' });
    expect(describeChange({ kind: 'dueDate', from: '2026-12-01', to: null }, names).label).toBe('Due date removed');
    expect(describeChange({ kind: 'tags', from: ['bug', 'debt'], to: ['bug', 'design'] }, names)).toEqual({ label: 'Tags changed', detail: '+#design −#debt' });
  });
});

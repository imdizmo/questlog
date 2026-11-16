import { describe, it, expect } from 'vitest';
import { cardHref, deckGroups, deleteDeckNote, handSlots, openByCard, wordCount } from '../web/src/cards';
import { STATUS_LABEL } from '../shared/cards';

describe('task helpers', () => {
  it('builds task URLs in and outside a list', () => {
    const c = { seq: 5, content: 'Fog shader\nmore' };
    expect(cardHref(c, { seq: 3, title: 'Proto Type' })).toBe('/decks/3-proto-type/card/115-fog-shader');
    expect(STATUS_LABEL.assigned).toBe('Assigned');
    expect(STATUS_LABEL.unassigned).toBe('Unassigned');
    expect(cardHref(c)).toBe('/card/115-fog-shader');
  });
  it('counts words', () => {
    expect(wordCount('Fog shader')).toBe(2);
    expect(wordCount('  \n ')).toBe(0);
  });
  it('ranks hand slots per person and keeps the best', () => {
    const m = handSlots([
      { userId: 'a', cardId: 'x', sortIndex: 5 },
      { userId: 'a', cardId: 'y', sortIndex: 2 },
      { userId: 'b', cardId: 'x', sortIndex: 1 },
    ]);
    expect(m.get('y')).toBe(1);
    expect(m.get('x')).toBe(1);
  });
  it('puts docs after tasks, each by sort index', () => {
    const c = (seq: number, sortIndex: number, isDoc: boolean) => ({ seq, sortIndex, isDoc });
    const g = deckGroups([c(1, 3, false), c(2, 1, true), c(3, 2, false)]);
    expect(g.tasks.map((x) => x.seq)).toEqual([3, 1]);
    expect(g.docs.map((x) => x.seq)).toEqual([2]);
  });
  it('collects open thread contexts', () => {
    const open = openByCard([
      { id: 'r1', cardId: 'c', context: 'block', isClosed: false } as any,
      { id: 'r2', cardId: 'c', context: 'review', isClosed: true } as any,
    ]);
    expect([...open.get('c')!]).toEqual(['block']);
  });
});

describe('deleteDeckNote', () => {
  it('names the real restore path and counts tasks', () => {
    expect(deleteDeckNote(0)).toBe('');
    expect(deleteDeckNote(1)).toBe('Its 1 task will be deleted. Its creator or an admin can restore it from the task link.');
    expect(deleteDeckNote(3)).toBe('Its 3 tasks will be deleted. Their creators or an admin can restore them from the task link.');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { clearDrafts, draftCount, dropDraft, getDraft, hasDraft, keepDraft, pruneDrafts } from '../web/src/drafts';
import { Store } from '../web/src/store';

describe('editor drafts', () => {
  beforeEach(() => clearDrafts());

  it('are kept per person and card, and dropped on save or cancel', () => {
    keepDraft('u1', 'c1', 'my text', 3);
    expect(getDraft('u1', 'c1')).toEqual({ text: 'my text', base: 3 });
    expect(hasDraft('u2', 'c1')).toBe(false); // another person on this tab never sees it
    expect(getDraft(null, 'c1')).toBeUndefined();
    keepDraft(null, 'c2', 'nobody', 1); // signed out: nothing is kept
    expect(draftCount()).toBe(1);
    dropDraft('u2', 'c1');
    expect(hasDraft('u1', 'c1')).toBe(true);
    dropDraft('u1', 'c1');
    expect(draftCount()).toBe(0);
  });

  it('keep at most 20, the least recently touched going first', () => {
    for (let i = 0; i < 25; i++) keepDraft('u1', `c${i}`, `t${i}`, 1);
    expect(draftCount()).toBe(20);
    expect(hasDraft('u1', 'c0')).toBe(false);
    expect(hasDraft('u1', 'c24')).toBe(true);
  });

  it('clearDrafts forgets everything', () => {
    keepDraft('u1', 'c1', 'a', 1);
    keepDraft('u2', 'c2', 'b', 1);
    clearDrafts();
    expect(draftCount()).toBe(0);
  });

  it('every session end (store.reset: logout, expired session, disabled user) clears them', () => {
    const s = new Store();
    for (const status of ['unauthenticated', 'disabled'] as const) {
      keepDraft('u1', 'c1', 'unsaved', 1);
      s.reset(status);
      expect(hasDraft('u1', 'c1')).toBe(false);
      expect(draftCount()).toBe(0);
    }
  });

  it('drafts of cards that are gone are dropped', () => {
    keepDraft('u1', 'c1', 'a', 1);
    keepDraft('u2', 'c2', 'b', 1);
    pruneDrafts((id) => id === 'c2');
    expect(hasDraft('u1', 'c1')).toBe(false);
    expect(hasDraft('u2', 'c2')).toBe(true);
  });

  it('the store drops them when a card is deleted or leaves it, but not while it is still loading', () => {
    const s = new Store();
    const set = (cards: [string, object][], status = 'ready') => (s as any).set({ ...s.get(), status, cards: new Map(cards) });
    keepDraft('u1', 'c1', 'a', 1);
    keepDraft('u1', 'c2', 'b', 1);
    keepDraft('u1', 'c3', 'c', 1);
    set([], 'loading'); // no snapshot yet: nothing is judged
    expect(draftCount()).toBe(3);
    set([['c1', { id: 'c1', visibility: 'default' }], ['c2', { id: 'c2', visibility: 'deleted' }]]);
    expect(hasDraft('u1', 'c1')).toBe(true);
    expect(hasDraft('u1', 'c2')).toBe(false); // deleted
    expect(hasDraft('u1', 'c3')).toBe(false); // no longer in the store
  });
});

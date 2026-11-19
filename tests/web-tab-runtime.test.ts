import { describe, it, expect } from 'vitest';
import { forServer } from '../web/src/tabRuntime';

// Two windows: each keeps its own tabs (sessionStorage); the server copy, which a new window starts from, is the window
// that changed last plus the pins of the other windows it never closed or unpinned.
const tab = (u: string, pinned = false, home = false) => ({ hist: [u], at: 0, pinned, home });
const mine = { v: 1 as const, active: 1, tabs: [tab('/home', true, true), tab('/decks'), tab('/wiki', true)] };

describe('the server copy of the tabs', () => {
  it('keeps the other windows\' pins this window does not have', () => {
    const out = forServer(mine, ['/wiki', '/milestones'], new Set());
    expect(out.tabs.map((x) => `${x.hist[0]}${x.pinned ? '*' : ''}`)).toEqual(['/home*', '/decks', '/wiki*', '/milestones*']);
  });
  it('not the ones this window closed or unpinned', () => {
    expect(forServer(mine, ['/milestones'], new Set(['/milestones'])).tabs).toHaveLength(3);
  });
  it('stays within the cap', () => {
    const many = { ...mine, tabs: Array.from({ length: 11 }, (_, i) => tab(`/t${i}`)) };
    expect(forServer(many, ['/a', '/b', '/c'], new Set()).tabs).toHaveLength(12);
  });
  it('is this window\'s own copy when there is nothing to add', () => {
    expect(forServer(mine, [], new Set())).toBe(mine);
  });
});

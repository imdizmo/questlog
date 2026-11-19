import { describe, it, expect } from 'vitest';
import { agoText, recentRows } from '../web/src/homeRecent';
import { HOME_DEFAULT, readHomePrefs } from '../web/src/homePrefs';
import type { Card, Deck, Project } from '../shared/types';

// Home's "Recently worked on" (web/src/homeRecent.ts) and the person's Home choices (web/src/homePrefs.ts).
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 19, 20, 0);

describe('time words', () => {
  it('agoText words', () => {
    expect(agoText(NOW - 20_000, NOW)).toBe('just now');
    expect(agoText(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(agoText(NOW - 25 * 60_000, NOW)).toBe('25 minutes ago');
    expect(agoText(NOW - H, NOW)).toBe('1 hour ago');
    expect(agoText(NOW - 5 * H, NOW)).toBe('5 hours ago');
    expect(agoText(NOW - 30 * H, NOW)).toBe('yesterday');
    expect(agoText(NOW - 3 * 24 * H, NOW)).toBe('3 days ago');
    expect(agoText(Date.UTC(2026, 10, 2, 12), NOW)).toBe('2 Nov');
    expect(agoText(NOW + 5000, NOW)).toBe('just now'); // a clock a little ahead
  });
});

const project = { id: 'fb', seq: 1, name: 'The Fog-Bound', spaces: [], isArchived: false } as unknown as Project;
const decks = new Map<string, Deck>([
  ['site', { id: 'site', seq: 4, projectId: 'fb', title: 'Site updates', deckType: 'task' } as unknown as Deck],
  ['lore', { id: 'lore', seq: 5, projectId: 'fb', title: 'Lore', deckType: 'doc' } as unknown as Deck],
]);
const card = (id: string, seq: number, deckId: string, content: string, extra: Partial<Card> = {}): Card =>
  ({ id, seq, deckId, content, isDoc: false, visibility: 'default', status: 'not_started', entryKey: null, ...extra }) as unknown as Card;
const state = (cards: Card[]) => ({ projects: new Map([['fb', project]]), decks, cards: new Map(cards.map((c) => [c.id, c])) });

describe('recently worked on', () => {
  it('recentRows maps tasks and pages newest first', () => {
    const s = state([
      card('a', 47, 'site', 'New screenshot for groundwork\n', { status: 'done' }),
      card('b', 12, 'lore', 'Ásdís\n', { isDoc: true, entryKey: 'asdis' }),
    ]);
    const rows = recentRows(s, [{ cardId: 'a', at: NOW - H }, { cardId: 'b', at: NOW - 2 * H }, { cardId: 'a', at: NOW - 3 * H }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a', title: 'New screenshot for groundwork', sub: 'FB-48 · Site updates', done: true, doc: false, at: NOW - H });
    expect(rows[0].href).toMatch(/^\/decks\/4-site-updates\/card\//);
    expect(rows[1]).toMatchObject({ id: 'b', title: 'Ásdís', sub: 'Page · The Fog-Bound', doc: true, href: '/wiki/1/asdis' });
  });

  it('recentRows skips cards not in the store and deleted ones', () => {
    const s = state([card('a', 1, 'site', 'Gone\n', { visibility: 'deleted' }), card('c', 2, 'site', 'Kept\n')]);
    const rows = recentRows(s, [{ cardId: 'a', at: 3 }, { cardId: 'zz', at: 2 }, { cardId: 'c', at: 1 }]);
    expect(rows.map((r) => r.title)).toEqual(['Kept']);
  });

  it('keeps at most max rows', () => {
    const cards = Array.from({ length: 20 }, (_, i) => card(`c${i}`, i, 'site', `T${i}\n`));
    expect(recentRows(state(cards), cards.map((c, i) => ({ cardId: c.id, at: 100 - i })), 8)).toHaveLength(8);
  });
});

describe('the person\'s Home choices', () => {
  it('defaults: the first picture, Web, pills, quests hidden, recent open, the pane 560 wide', () => {
    expect(readHomePrefs(undefined)).toEqual(HOME_DEFAULT);
    expect(HOME_DEFAULT).toEqual({ pic: 'ember', layout: 'web', cards: [], show: { area: true, list: true, quest: false }, recent: true, pane: 560 });
  });

  it('homePrefs keeps good fields of a partly bad value', () => {
    expect(readHomePrefs({ pic: 'nope', layout: 'tree', cards: ['quest', 'bogus', 'list'], show: { area: false, list: 'x' }, recent: false, pane: 'wide' }))
      .toEqual({ pic: 'ember', layout: 'tree', cards: ['quest', 'list'], show: { area: false, list: true, quest: false }, recent: false, pane: 560 });
    expect(readHomePrefs({ pane: 712.4 }).pane).toBe(712);
    expect(readHomePrefs({ pane: -5 }).pane).toBe(560);
    expect(readHomePrefs('garbage')).toEqual(HOME_DEFAULT);
    expect(readHomePrefs({ pic: 'night' }).pic).toBe('night');
  });
});

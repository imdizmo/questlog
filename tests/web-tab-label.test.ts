import { describe, it, expect } from 'vitest';
import { parse } from '../web/src/router';
import { tabLabel, type LabelState } from '../web/src/tabLabel';
import { cardCode } from '../shared/cards';

// What a tab says: the page's own name (a list's title, a task's title, an entry's title) with an icon.
const s = {
  projects: new Map([['p', { id: 'p', seq: 4, name: 'The Fog-Bound' }]]),
  decks: new Map([['d', { id: 'd', seq: 3, title: 'Creatures', projectId: 'p' }]]),
  cards: new Map([
    ['c', { id: 'c', seq: 40, content: 'Drowned Man\nbody', deckId: 'd', isDoc: false, visibility: 'default' }],
    ['e', { id: 'e', seq: 41, content: 'Ásdís\n', deckId: 'd', isDoc: true, entryKey: 'asdis', visibility: 'default' }],
  ]),
  milestones: new Map([['m', { id: 'm', accountSeq: 2, name: 'Playtest 3' }]]),
  entryTypes: new Map([['t', { id: 't', projectId: 'p', key: 'creature', name: 'Creature' }]]),
} as unknown as LabelState;

describe('the shell routes', () => {
  it('parses Home, Assets and the New tab page', () => {
    expect(parse('/home')).toEqual({ name: 'home' });
    expect(parse('/assets')).toEqual({ name: 'assets' });
    expect(parse('/assets/4')).toEqual({ name: 'assetsProject', projectSeq: 4 });
    expect(parse('/new')).toEqual({ name: 'newTab' });
    expect(parse('/assets/x')).toEqual({ name: 'notFound', path: '/assets/x' });
  });
});

describe('tab labels', () => {
  const cases: [string, string, string][] = [
    ['/home', 'Home', 'home'],
    ['/', 'My tasks', 'user'],
    ['/inbox', 'Inbox', 'inbox'],
    ['/decks', 'Overview', 'grid'],
    ['/decks?search=x', 'Overview', 'grid'],
    ['/milestones', 'Milestones', 'flag'],
    ['/milestones/2', 'Playtest 3', 'flag'],
    ['/decks/activity', 'Activity', 'pulse'],
    ['/decks/3-creatures', 'Creatures', 'list'],
    ['/decks/3-creatures/activity', 'Creatures', 'pulse'],
    [`/decks/3-creatures/card/${cardCode(40)}-drowned-man`, 'Drowned Man', 'task'],
    [`/card/${cardCode(40)}`, 'Drowned Man', 'task'],
    ['/wiki', 'Wiki', 'book'],
    ['/wiki/4', 'The Fog-Bound wiki', 'book'],
    ['/wiki/4/asdis', 'Ásdís', 'doc'],
    ['/wiki/4/kind/creature', 'Creature', 'book'],
    ['/assets', 'Assets', 'asset'],
    ['/assets/4', 'Assets', 'asset'],
    ['/new', 'New tab', 'plus'],
    ['/decks/99-gone', 'List', 'list'],
    ['/nowhere', 'Page not found', 'file'],
  ];
  for (const [url, label, icon] of cases) {
    it(url, () => expect(tabLabel(s, url)).toEqual({ label, icon }));
  }
});

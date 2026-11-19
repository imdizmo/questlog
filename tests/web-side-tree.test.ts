import { describe, it, expect } from 'vitest';
import { ENTRIES_PER_TYPE, FOLDS_KEPT, SEARCH_ROWS, setFold, sideRows, type TreeState } from '../web/src/sideTree';
import type { Card, Deck, EntryType, Project } from '../shared/types';

// The sidebar's project trees (web/src/sideTree.ts): projects → areas → lists, then the wiki with its entries by type.
const project = (id: string, seq: number, name: string, spaces: [number, string | null][]): Project =>
  ({ id, seq, name, visibility: 'private', isArchived: false, spaces: spaces.map(([sid, n]) => ({ id: sid, name: n, icon: null, defaultDeckType: 'task' })), tags: [], cover: null, createdAt: 0 }) as unknown as Project;
const deck = (id: string, seq: number, projectId: string, spaceId: number, title: string, deckType = 'task'): Deck =>
  ({ id, seq, projectId, spaceId, title, deckType, sortIndex: seq }) as unknown as Deck;
let cardSeq = 100;
const entry = (deckId: string, title: string, typeId: string | null, key: string): Card =>
  ({ id: `c${++cardSeq}`, seq: cardSeq, deckId, content: `${title}\n`, isDoc: true, entryTypeId: typeId, entryKey: key, visibility: 'default' }) as unknown as Card;
const type = (id: string, projectId: string, key: string, name: string, sortIndex: number): EntryType =>
  ({ id, projectId, key, name, sortIndex, icon: null, color: null, parentTypeId: null, familyId: null, picture: null, fields: [], sections: [], templates: [] }) as EntryType;

function state(extraEntries: Card[] = []): TreeState {
  const projects = new Map([
    ['fb', project('fb', 1, 'The Fog-Bound', [[1, 'World'], [2, 'Combat and systems']])],
    ['js', project('js', 2, 'Jatify site', [[1, null]])],
  ]);
  const decks = new Map([
    ['strand', deck('strand', 1, 'fb', 1, 'The Strand')],
    ['forest', deck('forest', 2, 'fb', 1, 'Forest level')],
    ['creatures', deck('creatures', 3, 'fb', 2, 'Creatures')],
    ['lore', deck('lore', 4, 'fb', 1, 'Lore', 'doc')],
    ['site', deck('site', 5, 'js', 1, 'Site updates')],
  ]);
  const entryTypes = new Map([['char', type('char', 'fb', 'character', 'Character', 0)], ['place', type('place', 'fb', 'place', 'Place', 1)]]);
  const list = [entry('lore', 'Ásdís', 'char', 'asdis'), entry('lore', 'The beach', 'place', 'the_beach'), entry('lore', 'Notes', null, 'notes'), ...extraEntries];
  return { projects, decks, entryTypes, cards: new Map(list.map((c) => [c.id, c])) };
}
const stats = new Map([['creatures', { total: 8, done: 2 }]]);
const labels = (rows: { label: string; level: number }[]) => rows.map((r) => `${r.level}:${r.label}`);

describe('the project trees', () => {
  it('lists projects, areas only where there are several, lists with their open count, then the wiki (folded)', () => {
    const rows = sideRows(state(), stats, '', {});
    expect(labels(rows)).toEqual([
      '1:The Fog-Bound', '2:World', '3:The Strand', '3:Forest level', '3:Lore', '2:Combat and systems', '3:Creatures', '2:Wiki',
      '1:Jatify site', '2:Site updates',
    ]);
    const creatures = rows.find((r) => r.label === 'Creatures')!;
    expect(creatures).toMatchObject({ kind: 'list', count: 6, done: 2, total: 8, href: '/decks/3-creatures' });
    expect(rows.find((r) => r.label === 'Wiki')).toMatchObject({ kind: 'wiki', href: '/wiki/1', open: false, count: 3 });
  });

  it('folding a project or an area hides what is under it', () => {
    expect(labels(sideRows(state(), stats, '', { fb: false }))).toEqual(['1:The Fog-Bound', '1:Jatify site', '2:Site updates']);
    expect(labels(sideRows(state(), stats, '', { 'fb/a1': false })).slice(0, 4)).toEqual(['1:The Fog-Bound', '2:World', '2:Combat and systems', '3:Creatures']);
  });

  it('an unfolded wiki shows entries grouped by type, untyped pages last', () => {
    const rows = sideRows(state(), stats, '', { 'fb/wiki': true, 'fb/wiki/char': true, 'fb/wiki/place': true, 'fb/wiki/pages': true });
    const i = rows.findIndex((r) => r.label === 'Wiki');
    expect(labels(rows.slice(i, i + 7))).toEqual(['2:Wiki', '3:Character', '4:Ásdís', '3:Place', '4:The beach', '3:Pages', '4:Notes']);
    expect(rows.find((r) => r.label === 'Character')).toMatchObject({ kind: 'type', href: '/wiki/1/kind/character', count: 1 });
    expect(rows.find((r) => r.label === 'Ásdís')).toMatchObject({ kind: 'entry', href: '/wiki/1/asdis' });
  });

  it('typing keeps what matches and its parents, unfolded, with the match marked', () => {
    const rows = sideRows(state(), stats, 'crea', { fb: false });
    expect(labels(rows)).toEqual(['1:The Fog-Bound', '2:Combat and systems', '3:Creatures']);
    expect(rows[2].hit).toEqual([0, 4]);
  });

  it('a matching project keeps everything under it', () => {
    expect(labels(sideRows(state(), stats, 'jatify', {}))).toEqual(['1:Jatify site', '2:Site updates']);
  });

  it('finds wiki entries, ignoring accents and case', () => {
    expect(labels(sideRows(state(), stats, 'asdis', {}))).toEqual(['1:The Fog-Bound', '2:Wiki', '3:Character', '4:Ásdís']);
  });

  it('nothing found is an empty list', () => {
    expect(sideRows(state(), stats, 'zzz', {})).toEqual([]);
  });

  it('caps entries per type and says how many more', () => {
    const many = Array.from({ length: ENTRIES_PER_TYPE + 7 }, (_, i) => entry('lore', `Wreck ${String(i).padStart(3, '0')}`, 'char', `wreck_${i}`));
    const rows = sideRows(state(many), stats, 'wreck', {});
    expect(rows.filter((r) => r.kind === 'entry')).toHaveLength(ENTRIES_PER_TYPE);
    expect(rows.at(-1)).toMatchObject({ kind: 'more', label: '7 more', href: '/wiki/1/kind/character' });
  });
});

describe('a big workspace', () => {
  it('searching shows at most SEARCH_ROWS rows, then one row saying there is more', () => {
    const st = state();
    for (let i = 0; i < 40; i++) {
      st.projects.set(`p${i}`, project(`p${i}`, 10 + i, `Crowd ${i}`, [[1, null]]));
      for (let j = 0; j < 12; j++) st.decks.set(`d${i}-${j}`, deck(`d${i}-${j}`, 100 + i * 20 + j, `p${i}`, 1, `Wreck list ${j}`));
    }
    const rows = sideRows(st, stats, 'wreck', {});
    expect(rows).toHaveLength(SEARCH_ROWS + 1);
    expect(rows.at(-1)).toMatchObject({ kind: 'more', href: '' });
    expect(rows.at(-1)!.label).toMatch(/^\d+\+ more: press Enter to search everything$/);
    // Without a search nothing is cut (the folds keep it short).
    expect(sideRows(st, stats, '', {}).some((r) => r.id === 'search-more')).toBe(false);
  });

  it('a fold clicked during a search wins over the search, and is not a saved fold', () => {
    const rows = sideRows(state(), stats, 'crea', {}, { fb: false });
    expect(labels(rows)).toEqual(['1:The Fog-Bound']);
  });
});

describe('fold choices', () => {
  it('keeps at most FOLDS_KEPT, the newest', () => {
    let f: Record<string, boolean> = {};
    for (let i = 0; i < FOLDS_KEPT + 20; i++) f = setFold(f, `p${i}`, i % 2 === 0);
    expect(Object.keys(f)).toHaveLength(FOLDS_KEPT);
    expect(f[`p${FOLDS_KEPT + 19}`]).toBe(false);
    expect(f.p0).toBeUndefined();
  });
});

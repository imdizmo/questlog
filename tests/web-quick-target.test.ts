import { describe, it, expect } from 'vitest';
import { quickTarget, taskList, whereText, type QuickState } from '../web/src/quickTarget';
import { parse } from '../web/src/router';
import { cardCode } from '../shared/cards';

// The sidebar's quick actions put a new thing where the person is: the open list, area or project, else the project or
// area row clicked last, else the first project they can add to. The small box says where (whereText).
const sp = (id: number, name: string | null) => ({ id, name, icon: null, defaultDeckType: 'task' });
const s = {
  me: { id: 'u' },
  accountRoles: new Map([['u', 'member']]),
  projectAccess: new Map(),
  projects: new Map([
    ['old', { id: 'old', seq: 1, name: 'Archived one', isArchived: true, spaces: [sp(1, null)] }],
    ['fb', { id: 'fb', seq: 2, name: 'The Fog-Bound', isArchived: false, spaces: [sp(1, 'World'), sp(2, 'Combat and systems')] }],
    ['js', { id: 'js', seq: 3, name: 'Jatify site', isArchived: false, spaces: [sp(1, null)] }],
  ]),
  decks: new Map([
    ['lore', { id: 'lore', seq: 1, projectId: 'fb', spaceId: 1, title: 'Lore', deckType: 'doc', sortIndex: 0 }],
    ['strand', { id: 'strand', seq: 2, projectId: 'fb', spaceId: 1, title: 'The Strand', deckType: 'task', sortIndex: 1 }],
    ['creatures', { id: 'creatures', seq: 3, projectId: 'fb', spaceId: 2, title: 'Creatures', deckType: 'task', sortIndex: 2 }],
    ['site', { id: 'site', seq: 4, projectId: 'js', spaceId: 1, title: 'Site updates', deckType: 'task', sortIndex: 0 }],
  ]),
  cards: new Map([['c', { id: 'c', seq: 7, deckId: 'creatures', content: 'Drowned Man', visibility: 'default' }]]),
} as unknown as QuickState;

describe('where quick actions put things', () => {
  it('a list page: that list, its area and project', () => {
    const t = quickTarget(s, parse('/decks/3-creatures'), null);
    expect(t.project?.id).toBe('fb');
    expect(t.area?.id).toBe(2);
    expect(t.deck?.id).toBe('creatures');
    expect(whereText('task', s, t)).toBe('Creatures (The Fog-Bound)');
    expect(whereText('list', s, t)).toBe('The Fog-Bound, area Combat and systems');
    expect(whereText('entry', s, t)).toBe('The Fog-Bound wiki');
    expect(whereText('milestone', s, t)).toBe('The Fog-Bound');
  });

  it('a task page: its list', () => {
    expect(quickTarget(s, parse(`/card/${cardCode(7)}`), null).deck?.id).toBe('creatures');
  });

  it('a wiki page: its project', () => {
    const t = quickTarget(s, parse('/wiki/3'), null);
    expect(t.project?.id).toBe('js');
    expect(whereText('list', s, t)).toBe('Jatify site'); // one area: not named
    expect(whereText('task', s, t)).toBe('Site updates (Jatify site)');
  });

  it('elsewhere: the project or area row clicked last', () => {
    const t = quickTarget(s, parse('/inbox'), { projectId: 'fb', areaId: 1 });
    expect(t.area?.id).toBe(1);
    expect(t.deck).toBeNull();
    // A new task goes to the area's first task list, never a lore list.
    expect(taskList(s, t)?.id).toBe('strand');
    expect(whereText('task', s, t)).toBe('The Strand (The Fog-Bound)');
  });

  it('else the first project the person can add to', () => {
    expect(quickTarget(s, parse('/inbox'), null).project?.id).toBe('fb');
    expect(quickTarget(s, parse('/inbox'), { projectId: 'gone' }).project?.id).toBe('fb');
  });

  it('no project: nowhere', () => {
    const none = { ...s, projects: new Map() } as unknown as QuickState;
    const t = quickTarget(none, parse('/inbox'), null);
    expect(t.project).toBeNull();
    expect(whereText('list', none, t)).toBeNull();
  });
});

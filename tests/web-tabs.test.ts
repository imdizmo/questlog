import { describe, it, expect } from 'vitest';
import {
  canGo, closeTab, current, cycle, freshTabs, goBack, goForward, HIST_MAX, HIST_SAVED, HOME_URL, nth, openTab, restoreTabs, saveTabs, switchTab,
  TAB_CAP, togglePin, visit, type Tabs,
} from '../web/src/tabs';

// The tabs beside the workspace switcher (web/src/tabs.ts): each tab one page with its own back and forward, the Home tab
// pinned first, at most TAB_CAP open.
const ids = () => { let n = 0; return () => `t${++n}`; };
const active = (t: Tabs) => t.list.find((x) => x.id === t.active)!;
const urls = (t: Tabs) => t.list.map(current);

describe('starting', () => {
  it('opens Home pinned first, then the page asked for', () => {
    const t = freshTabs('/decks', ids());
    expect(urls(t)).toEqual([HOME_URL, '/decks']);
    expect(t.list[0]).toMatchObject({ pinned: true, home: true });
    expect(current(active(t))).toBe('/decks');
  });
  it('is just Home when Home is asked for', () => {
    const t = freshTabs(HOME_URL, ids());
    expect(urls(t)).toEqual([HOME_URL]);
    expect(t.active).toBe(t.list[0].id);
  });
});

describe('visit (a link or navigate() in the active tab)', () => {
  it('pushes onto the active tab, and back and forward walk it', () => {
    const id = ids();
    let t = freshTabs('/decks', id);
    t = visit(t, '/inbox', false, id).tabs;
    t = visit(t, '/milestones', false, id).tabs;
    expect(urls(t)).toEqual([HOME_URL, '/milestones']);
    t = goBack(t);
    expect(current(active(t))).toBe('/inbox');
    t = goBack(t);
    t = goBack(t); // at the start: nothing happens
    expect(current(active(t))).toBe('/decks');
    t = goForward(t);
    expect(current(active(t))).toBe('/inbox');
    t = visit(t, '/wiki', false, id).tabs; // a new page drops the forward part
    t = goForward(t);
    expect(active(t).hist).toEqual(['/decks', '/inbox', '/wiki']);
  });
  it('replace changes the page without a history step', () => {
    const id = ids();
    let t = freshTabs('/decks', id);
    t = visit(t, '/decks?x=1', true, id).tabs;
    expect(active(t).hist).toEqual(['/decks?x=1']);
  });
  it('keeps the newest HIST_MAX pages', () => {
    const id = ids();
    let t = freshTabs('/decks', id);
    for (let i = 0; i < HIST_MAX + 5; i++) t = visit(t, `/card/${i}`, false, id).tabs;
    expect(active(t).hist).toHaveLength(HIST_MAX);
    expect(current(active(t))).toBe(`/card/${HIST_MAX + 4}`);
  });
  it('from Home opens the page in a tab of its own', () => {
    const id = ids();
    let t = freshTabs(HOME_URL, id);
    t = visit(t, '/inbox', false, id).tabs;
    expect(urls(t)).toEqual([HOME_URL, '/inbox']);
    expect(current(active(t))).toBe('/inbox');
    expect(t.list[0].hist).toEqual([HOME_URL]);
  });
  it('from Home switches to a tab that already shows the page', () => {
    const id = ids();
    let t = freshTabs('/inbox', id);
    t = switchTab(t, t.list[0].id);
    t = visit(t, '/inbox', false, id).tabs;
    expect(t.list).toHaveLength(2);
    expect(t.active).toBe(t.list[1].id);
  });
  it('navigate on Home with only a new query stays home', () => {
    const id = ids();
    let t = freshTabs(HOME_URL, id);
    t = visit(t, `${HOME_URL}?menu=workspace`, false, id).tabs;
    expect(t.list).toHaveLength(1);
    expect(t.list[0].hist).toEqual([HOME_URL, `${HOME_URL}?menu=workspace`]);
  });
});

describe('opening, closing, pinning', () => {
  it('opens in the background or in front', () => {
    const id = ids();
    let t = freshTabs('/decks', id);
    t = openTab(t, '/inbox', false, id).tabs;
    expect(current(active(t))).toBe('/decks');
    t = openTab(t, '/wiki', true, id).tabs;
    expect(current(active(t))).toBe('/wiki');
    expect(urls(t)).toEqual([HOME_URL, '/decks', '/inbox', '/wiki']);
  });
  it(`past ${TAB_CAP} the oldest unpinned tab closes and is reported`, () => {
    const id = ids();
    let t = freshTabs('/a0', id);
    t = togglePin(t, t.list[1].id); // /a0 pinned: it stays
    for (let i = 1; i < TAB_CAP - 1; i++) t = openTab(t, `/a${i}`, false, id).tabs;
    expect(t.list).toHaveLength(TAB_CAP);
    const step = openTab(t, '/new-one', false, id);
    expect(step.closed).toBe('/a1');
    expect(step.tabs.list).toHaveLength(TAB_CAP);
    expect(urls(step.tabs)).toContain('/a0');
    expect(urls(step.tabs)).toContain('/new-one');
    expect(urls(step.tabs)[0]).toBe(HOME_URL);
  });
  it('closing the active tab moves to its right neighbour, else the left one; Home cannot close', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    t = openTab(t, '/b', false, id).tabs;
    t = openTab(t, '/c', false, id).tabs;
    t = switchTab(t, t.list[2].id); // /b
    t = closeTab(t, t.active);
    expect(current(active(t))).toBe('/c');
    t = closeTab(t, t.active);
    expect(current(active(t))).toBe('/a');
    t = closeTab(t, t.active);
    expect(urls(t)).toEqual([HOME_URL]);
    expect(closeTab(t, t.list[0].id)).toBe(t);
  });
  it('closing a tab in the background keeps the active one', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    t = openTab(t, '/b', false, id).tabs;
    t = closeTab(t, t.list[2].id);
    expect(current(active(t))).toBe('/a');
  });
  it('double pin toggles; Home stays pinned', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    const tab = t.list[1].id;
    t = togglePin(t, tab);
    expect(t.list[1].pinned).toBe(true);
    t = togglePin(t, tab);
    expect(t.list[1].pinned).toBe(false);
    expect(togglePin(t, t.list[0].id).list[0].pinned).toBe(true);
  });
  it('Alt+n picks the nth tab (9: the last), Ctrl+Tab cycles', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    t = openTab(t, '/b', false, id).tabs;
    t = openTab(t, '/c', false, id).tabs;
    expect(current(active(nth(t, 1)))).toBe(HOME_URL);
    expect(current(active(nth(t, 3)))).toBe('/b');
    expect(current(active(nth(t, 9)))).toBe('/c');
    expect(nth(t, 7)).toBe(t); // no seventh tab
    expect(current(active(cycle(t, 1)))).toBe('/b');
    expect(current(active(cycle(nth(t, 9), 1)))).toBe(HOME_URL);
    expect(current(active(cycle(nth(t, 1), -1)))).toBe('/c');
  });
});

describe('saving and coming back after a restart', () => {
  it('keeps the newest HIST_SAVED pages per tab and drops long addresses', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    for (let i = 0; i < 12; i++) t = visit(t, `/p/${i}`, false, id).tabs;
    t = visit(t, `/long/${'x'.repeat(600)}`, false, id).tabs;
    const saved = saveTabs(t) as { tabs: { hist: string[]; at: number }[]; active: number };
    expect(saved.tabs[1].hist).toHaveLength(HIST_SAVED);
    expect(saved.tabs[1].hist.every((u) => u.length <= 512)).toBe(true);
    expect(saved.tabs[1].hist[saved.tabs[1].at]).toBe('/p/11');
    expect(saved.active).toBe(1);
  });
  it('comes back as it was when the address is the active tab\'s page', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    t = openTab(t, '/b', true, id).tabs;
    t = togglePin(t, t.active);
    const back = restoreTabs(saveTabs(t), '/b', ids()).tabs;
    expect(urls(back)).toEqual([HOME_URL, '/a', '/b']);
    expect(current(active(back))).toBe('/b');
    expect(back.list[2].pinned).toBe(true);
  });
  it('switches to a tab that already shows the address', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    t = openTab(t, '/b', true, id).tabs;
    const back = restoreTabs(saveTabs(t), '/a', ids()).tabs;
    expect(back.list).toHaveLength(3);
    expect(current(active(back))).toBe('/a');
  });
  it('restoreTabs … loads the address into the active tab', () => {
    const id = ids();
    const t = freshTabs('/a', id);
    const back = restoreTabs(saveTabs(t), '/c', ids()).tabs;
    expect(urls(back)).toEqual([HOME_URL, '/c']);
    expect(active(back).hist).toEqual(['/a', '/c']);
  });
  it('a new address while Home was active opens a tab', () => {
    const t = freshTabs(HOME_URL, ids());
    const back = restoreTabs(saveTabs(t), '/c', ids()).tabs;
    expect(urls(back)).toEqual([HOME_URL, '/c']);
  });
  it('restoreTabs drops malformed and off-site entries', () => {
    const saved = {
      v: 1, active: 9,
      tabs: [
        { hist: ['//evil.example/x'], at: 0, pinned: false },
        { hist: ['http://evil.example/'], at: 0, pinned: false },
        { hist: ['/ok', 42, 'javascript:alert(1)'], at: 7, pinned: 'yes' },
        'junk',
        ...Array.from({ length: 30 }, (_, i) => ({ hist: [`/m${i}`], at: 0, pinned: false })),
      ],
    };
    const back = restoreTabs(saved, '/ok', ids()).tabs;
    expect(back.list.length).toBeLessThanOrEqual(TAB_CAP);
    expect(urls(back)[0]).toBe(HOME_URL);
    expect(urls(back)).toContain('/ok');
    expect(back.list.flatMap((x) => x.hist).every((u) => u.startsWith('/') && !u.startsWith('//'))).toBe(true);
    expect(current(active(back))).toBe('/ok');
    expect(restoreTabs('nonsense', '/a', ids()).tabs.list.map(current)).toEqual([HOME_URL, '/a']);
  });
});

describe('review fixes', () => {
  it('Back on a tab\'s first page goes to the tab it was opened from', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    const from = t.active;
    t = openTab(t, '/b', true, id).tabs;
    expect(canGo(t, -1)).toBe(true);
    t = goBack(t);
    expect(t.active).toBe(from);
    // Without an opener (or once it is closed) there is nowhere to go.
    expect(canGo(freshTabs('/x', id), -1)).toBe(false);
    let u = openTab(freshTabs('/a', id), '/b', true, id).tabs;
    u = closeTab(u, u.list[1].id);
    expect(canGo(u, -1)).toBe(false);
    expect(goBack(u)).toBe(u);
  });

  it('with every other tab pinned, opening behind closes the one showing and the new tab takes its place', () => {
    const id = ids();
    let t = freshTabs('/p0', id);
    t = togglePin(t, t.active);
    for (let i = 1; i < TAB_CAP - 2; i++) { t = openTab(t, `/p${i}`, true, id).tabs; t = togglePin(t, t.active); }
    t = openTab(t, '/showing', true, id).tabs;
    expect(t.list).toHaveLength(TAB_CAP);
    const step = openTab(t, '/behind', false, id);
    expect(step.closed).toBe('/showing');
    expect(current(active(step.tabs))).toBe('/behind');
    // All pinned: the oldest pinned one goes, Home stays, still TAB_CAP.
    const all = togglePin(step.tabs, step.tabs.active);
    const more = openTab(all, '/more', false, id);
    expect(more.closed).toBe('/p0');
    expect(more.tabs.list).toHaveLength(TAB_CAP);
    expect(current(more.tabs.list[0])).toBe(HOME_URL);
  });

  it('saved tabs fit the size given, dropping the oldest pages first', () => {
    const id = ids();
    let t = freshTabs('/a', id);
    for (let i = 0; i < TAB_CAP - 2; i++) {
      t = openTab(t, `/t${i}/${'x'.repeat(400)}`, true, id).tabs;
      for (let j = 0; j < HIST_SAVED; j++) t = visit(t, `/t${i}/${j}/${'y'.repeat(400)}`, false, id).tabs;
    }
    const big = JSON.stringify(saveTabs(t, 1e9)).length;
    const saved = saveTabs(t, 8000) as { tabs: { hist: string[]; at: number }[] };
    expect(big).toBeGreaterThan(8000);
    expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(8000);
    // Each tab still has the page it shows.
    for (const x of saved.tabs) expect(x.hist[x.at]).toBeDefined();
    expect(saved.tabs.at(-1)!.hist.at(-1)).toMatch(/\/t9\/7\//);
  });

  it('restore keeps the tab that was active when another shows the same page', () => {
    const id = ids();
    let t = freshTabs('/same', id);
    t = openTab(t, '/same', true, id).tabs;
    const back = restoreTabs(saveTabs(t), '/same', ids()).tabs;
    expect(back.list.findIndex((x) => x.id === back.active)).toBe(2);
  });
});

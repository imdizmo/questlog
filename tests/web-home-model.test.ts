import { describe, it, expect } from 'vitest';
import { buildHomeModel, cardBlurb, viewOf, MAX_AREAS, MAX_LISTS, MAX_NODES, MAX_PROJECTS, MAX_QUESTS, MAX_QUESTS_PER_LIST, type HomeState } from '../web/src/homeModel';
import type { Card, CardDep, Deck, Project } from '../shared/types';
import { CARD_KINDS, layoutKey, pickCards, treeLayout, webLayout } from '../web/src/homeLayout';

// Home's canvas (web/src/homeModel.ts): projects → areas → lists → quests, with real counts, capped so a workspace of
// thousands of tasks draws only what fits, and the "this locks that" links Questlog already has.
const project = (id: string, seq: number, name: string, spaces: [number, string | null][]): Project =>
  ({ id, seq, name, visibility: 'full', isArchived: false, spaces: spaces.map(([sid, n]) => ({ id: sid, name: n, icon: null, defaultDeckType: 'task' })), tags: [], cover: null, createdAt: 0 }) as unknown as Project;
const deck = (id: string, seq: number, projectId: string, spaceId: number, title: string, deckType = 'task'): Deck =>
  ({ id, seq, projectId, spaceId, title, deckType, sortIndex: seq }) as unknown as Deck;
let seq = 0;
const task = (deckId: string, title: string, extra: Partial<Card> = {}): Card =>
  ({ id: `c${++seq}`, seq, deckId, content: `${title}\n`, isDoc: false, visibility: 'default', status: 'not_started', assigneeId: null, sortIndex: seq,
    priority: null, effort: null, tags: [], masterTags: [], snoozedAt: null, ...extra }) as unknown as Card;

function state(cards: Card[], deps: CardDep[] = []): HomeState {
  return {
    projects: new Map([
      ['fb', project('fb', 1, 'The Fog-Bound', [[1, 'World'], [2, 'Combat and systems']])],
      ['js', project('js', 2, 'Jatify site', [[1, null]])],
    ]),
    decks: new Map([
      ['strand', deck('strand', 1, 'fb', 1, 'The Strand')],
      ['creatures', deck('creatures', 2, 'fb', 2, 'Creatures')],
      ['lore', deck('lore', 3, 'fb', 1, 'Lore', 'doc')],
      ['site', deck('site', 4, 'js', 1, 'Site updates')],
    ]),
    cards: new Map(cards.map((c) => [c.id, c])),
    cardDeps: new Map(deps.map((d) => [`${d.lockedCardId}:${d.lockingCardId}`, d])),
    resolvables: new Map(),
    account: null,
  };
}
const ids = (m: ReturnType<typeof buildHomeModel>, kind: string) => m.nodes.filter((n) => n.kind === kind).map((n) => n.label);

describe('the Home model', () => {
  it('builds projects, areas only when several, lists with real counts', () => {
    const cards = [task('creatures', 'Drowned Man', { status: 'started' }), task('creatures', 'Sea Giant', { status: 'done' }), task('site', 'Add questlog')];
    const m = buildHomeModel(state(cards), { quests: false });
    expect(ids(m, 'proj')).toEqual(['The Fog-Bound', 'Jatify site']);
    expect(ids(m, 'area')).toEqual(['World', 'Combat and systems']); // the site has one area: its list hangs off the project
    expect(ids(m, 'list')).toEqual(['The Strand', 'Creatures', 'Site updates']); // no lore list
    const creatures = m.nodes.find((n) => n.label === 'Creatures')!;
    expect([creatures.open, creatures.done, creatures.total]).toEqual([1, 1, 2]);
    expect(creatures.href).toBe('/decks/2-creatures');
    const site = m.nodes.find((n) => n.label === 'Site updates')!;
    expect(site.parent).toBe(m.nodes.find((n) => n.label === 'Jatify site')!.id);
    expect(m.edges.filter((e) => e.kind === 'has')).toHaveLength(m.nodes.length - 2);
    expect(m.totals).toEqual({ projects: 2, lists: 3, quests: 3 });
  });

  it('quests off: no quest nodes', () => {
    const m = buildHomeModel(state([task('creatures', 'Drowned Man')]), { quests: false });
    expect(ids(m, 'quest')).toEqual([]);
  });

  it('quests carry what their card shows', () => {
    const m = buildHomeModel(state([task('creatures', 'Drowned Man\nPlaceholder body: the Ghoul. #art', { status: 'started', effort: 5, priority: 'a' })]), { quests: true });
    const q = m.nodes.find((n) => n.kind === 'quest')!;
    expect(q).toMatchObject({ label: 'Drowned Man', status: 'started', effort: 5, priority: 'a', text: 'Placeholder body: the Ghoul.', listLabel: 'Creatures' });
    expect(q.href).toMatch(/^\/decks\/2-creatures\/card\//);
  });

  it('homeModel caps quests per list and in all', () => {
    const many = Array.from({ length: 30 }, (_, i) => task('strand', `Task ${i}`, { status: i < 3 ? 'done' : 'not_started' }));
    const m = buildHomeModel(state(many), { quests: true });
    const qs = m.nodes.filter((n) => n.kind === 'quest');
    expect(qs).toHaveLength(MAX_QUESTS_PER_LIST);
    expect(qs.every((q) => q.status !== 'done')).toBe(true); // open ones first
    const more = m.nodes.find((n) => n.kind === 'more')!;
    expect(more).toMatchObject({ hidden: 18, href: '/decks/1-the-strand' });
    expect(m.totals.quests).toBe(30);

    // 40 lists of 30 tasks: never more than MAX_QUESTS drawn
    const s = state([]);
    for (let i = 0; i < 40; i++) {
      s.decks.set(`d${i}`, deck(`d${i}`, 100 + i, 'fb', 1, `List ${i}`));
      for (let j = 0; j < 30; j++) { const c = task(`d${i}`, `T${i}.${j}`); s.cards.set(c.id, c); }
    }
    const big = buildHomeModel(s, { quests: true });
    expect(big.nodes.filter((n) => n.kind === 'quest').length).toBeLessThanOrEqual(MAX_QUESTS);
    expect(big.totals.quests).toBe(1200);
  });

  it('locks between drawn quests are lock edges', () => {
    const a = task('creatures', 'Damage kinds'), b = task('creatures', 'Taming');
    const m = buildHomeModel(state([a, b], [{ lockedCardId: b.id, lockingCardId: a.id }]), { quests: true });
    expect(m.edges.filter((e) => e.kind === 'lock')).toEqual([{ a: `q${a.id}`, b: `q${b.id}`, kind: 'lock' }]);
  });

  it('locks between hidden quests become list locks, deduped, none inside a list', () => {
    const a = task('strand', 'Water'), b = task('creatures', 'Crab'), c = task('creatures', 'Seal'), d = task('strand', 'Foam');
    const deps = [{ lockedCardId: b.id, lockingCardId: a.id }, { lockedCardId: c.id, lockingCardId: a.id }, { lockedCardId: d.id, lockingCardId: a.id }];
    const m = buildHomeModel(state([a, b, c, d], deps), { quests: false });
    const strand = m.nodes.find((n) => n.label === 'The Strand')!.id, creatures = m.nodes.find((n) => n.label === 'Creatures')!.id;
    expect(m.edges.filter((e) => e.kind === 'lock')).toEqual([{ a: strand, b: creatures, kind: 'lock', n: 2 }]);
  });

  it('a lock to a quest past the cap shows between the lists, not as a dangling line', () => {
    const many = Array.from({ length: 20 }, (_, i) => task('strand', `Task ${i}`));
    const other = task('creatures', 'Crab');
    const m = buildHomeModel(state([...many, other], [{ lockedCardId: other.id, lockingCardId: many[19].id }]), { quests: true });
    const at = new Set(m.nodes.map((n) => n.id));
    for (const e of m.edges) expect(at.has(e.a) && at.has(e.b)).toBe(true);
    expect(m.edges.filter((e) => e.kind === 'lock')).toHaveLength(1);
  });

  it('cardBlurb drops the title, marks and tags', () => {
    expect(cardBlurb('Title\n\n**Waiting** on a [verdict](http://x) in game.\n- ford edges\n\n#art #code')).toBe('Waiting on a verdict in game. ford edges');
    expect(cardBlurb('Only a title')).toBe('');
    expect(cardBlurb(`T\n${'word '.repeat(100)}`).length).toBeLessThanOrEqual(220);
  });

  it('hiding areas or lists lifts what is under them to the next shown parent; their locks go', () => {
    const a = task('strand', 'Water'), b = task('creatures', 'Crab');
    const m = buildHomeModel(state([a, b], [{ lockedCardId: b.id, lockingCardId: a.id }]), { quests: false });
    const noAreas = viewOf(m, { area: false, list: true });
    expect(noAreas.nodes.some((n) => n.kind === 'area')).toBe(false);
    const strand = noAreas.nodes.find((n) => n.label === 'The Strand')!;
    expect(strand.parent).toBe('pfb');
    expect(noAreas.edges).toContainEqual({ a: 'pfb', b: strand.id, kind: 'has' });
    expect(noAreas.edges.filter((e) => e.kind === 'lock')).toHaveLength(1);
    const noLists = viewOf(m, { area: true, list: false });
    expect(noLists.nodes.some((n) => n.kind === 'list')).toBe(false);
    expect(noLists.edges.filter((e) => e.kind === 'lock')).toHaveLength(0);
    const at = new Set(noLists.nodes.map((n) => n.id));
    for (const e of noLists.edges) expect(at.has(e.a) && at.has(e.b)).toBe(true);
    expect(viewOf(m, { area: true, list: true })).toEqual({ nodes: m.nodes, edges: m.edges });
  });

  it('projects are packed by their own size, not on a fixed wide grid', () => {
    const s = state([]);
    for (let i = 3; i <= 6; i++) s.projects.set(`x${i}`, project(`x${i}`, i, `Small ${i}`, [[1, null]]));
    for (let i = 3; i <= 6; i++) s.decks.set(`sd${i}`, deck(`sd${i}`, 50 + i, `x${i}`, 1, 'One list'));
    const m = buildHomeModel(s, { quests: false });
    const xs = m.nodes.map((n) => n.x), ys = m.nodes.map((n) => n.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    // six projects, four of them one list each: about as wide as a page, not three 900 px columns of empty room
    expect(w).toBeLessThan(1900);
    expect(w / h).toBeGreaterThan(1);
    expect(w / h).toBeLessThan(3.5);
  });

  it('caps projects, areas and lists in all; what is left out is a "+N more" pill', () => {
    // 40 projects × 4 areas × 15 lists × 4 tasks: a big studio's workspace
    const s = state([]);
    s.projects.clear(); s.decks.clear();
    for (let p = 0; p < 40; p++) {
      s.projects.set(`bp${p}`, project(`bp${p}`, 100 + p, `Project ${p}`, [[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four']]));
      for (let a = 1; a <= 4; a++) for (let l = 0; l < 15; l++) {
        const id = `bd${p}.${a}.${l}`;
        s.decks.set(id, deck(id, 1000 + p * 100 + a * 20 + l, `bp${p}`, a, `List ${l}`));
        for (let t = 0; t < 4; t++) { const c = task(id, `T${t}`); s.cards.set(c.id, c); }
      }
    }
    const t0 = performance.now();
    const m = buildHomeModel(s, { quests: true });
    const ms = performance.now() - t0;
    const count = (k: string) => m.nodes.filter((n) => n.kind === k).length;
    expect(count('proj')).toBeLessThanOrEqual(MAX_PROJECTS);
    expect(count('area')).toBeLessThanOrEqual(MAX_AREAS);
    expect(count('list')).toBeLessThanOrEqual(MAX_LISTS);
    expect(count('quest')).toBeLessThanOrEqual(MAX_QUESTS);
    expect(m.nodes.length).toBeLessThanOrEqual(MAX_NODES);
    expect(m.nodes.find((n) => n.kind === 'more' && n.parent === null)).toMatchObject({ label: `${40 - MAX_PROJECTS} more projects`, href: '/decks' });
    expect(m.totals).toEqual({ projects: 40, lists: 2400, quests: 9600 });
    for (const e of m.edges) expect(m.nodes.some((n) => n.id === e.a) && m.nodes.some((n) => n.id === e.b)).toBe(true);
    expect(ms).toBeLessThan(200);

    // the review's case: "All" as cards on this workspace stays bounded and quick (it was 2.3 s uncapped)
    const all = pickCards(m.nodes, [...CARD_KINDS]);
    expect(all.size).toBeLessThanOrEqual(4 * 60);
    let t1 = performance.now();
    webLayout(m.nodes, (n) => all.has(n.id));
    expect(performance.now() - t1).toBeLessThan(250);
    t1 = performance.now();
    treeLayout(m.nodes, (n) => all.has(n.id));
    expect(performance.now() - t1).toBeLessThan(100);

    // a teammate finishing a task and typing below its title: the model is rebuilt, the layout key is the same
    const key = layoutKey(m.nodes, all, false);
    const someone = [...s.cards.values()][5];
    s.cards = new Map(s.cards);
    s.cards.set(someone.id, { ...someone, content: `${someone.content}more words`, effort: 3 });
    expect(layoutKey(buildHomeModel(s, { quests: true }).nodes, all, false)).toBe(key);
  });
  it('over the project cap, the most recently active or newest projects are drawn, never a new one left out', () => {
    const s = state([]);
    s.projects.clear();
    for (let i = 1; i <= MAX_PROJECTS + 6; i++) s.projects.set(`p${i}`, { ...project(`p${i}`, i, `Project ${i}`, [[1, null]]), createdAt: 1000 + i } as Project);
    s.decks.clear();
    s.decks.set('d1', deck('d1', 1, 'p1', 1, 'Old but busy'));
    s.cards = new Map([['t1', task('d1', 'Edited just now', { lastUpdatedAt: 999999 })]]);
    const shown = ids(buildHomeModel(s, { quests: false }), 'proj');
    expect(shown).toContain('Project 1'); // the oldest project, but worked on just now
    expect(shown).toContain(`Project ${MAX_PROJECTS + 6}`); // the newest project, still empty
    expect(shown).not.toContain('Project 2'); // old and quiet: behind "+N more"
    expect(shown.length).toBe(MAX_PROJECTS);
  });
});

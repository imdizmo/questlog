import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { buildHomeModel, MAX_QUESTS_PER_LIST, type HomeState } from '../web/src/homeModel';
import { CARD_H, CARD_W, nudge, pillSize, webLayout } from '../web/src/homeLayout';
import {
  askHome, drawnBoard, goneWork, hashCacheSize, HASH_CACHE_MAX, MAX_WORK_NODES, placeWork, readWork, syncWork, trackFresh, workAlive, workHash, workKey,
  workRects, workRef,
} from '../web/src/board/homeWork';
import { homeCardAllowed } from '../web/src/board/boards';
import { boardUndo, boardMaps, LOCAL, type BoardApi } from '../web/src/board/useBoard';
import type { BoardNode } from '../shared/board';
import type { Card, Deck, Project } from '../shared/types';
import type { State } from '../web/src/store';

// The work on the shared Home board (web/src/board/homeWork.ts): placed by the Web layout on first use, a new one near
// its parent, one the store says is gone leaves; what this person can't see is left alone, and the doc holds no ids.
const BID = 'home-board-1';
const K = (ref: string) => workHash(BID, ref);
const project = (id: string, seq: number, name: string, spaces: [number, string | null][], extra: Partial<Project> = {}): Project =>
  ({ id, seq, name, visibility: 'full', isArchived: false, spaces: spaces.map(([sid, n]) => ({ id: sid, name: n, icon: null, defaultDeckType: 'task' })), tags: [], cover: null, createdAt: 0, ...extra }) as unknown as Project;
const deck = (id: string, seq: number, projectId: string, spaceId: number, title: string): Deck =>
  ({ id, seq, projectId, spaceId, title, deckType: 'task', sortIndex: seq }) as unknown as Deck;
const task = (id: string, deckId: string, title: string, extra: Partial<Card> = {}): Card =>
  ({ id, seq: Number(id.replace(/\D/g, '')) || 1, deckId, content: `${title}\n`, isDoc: false, visibility: 'default', status: 'not_started', assigneeId: null, sortIndex: 0,
    priority: null, effort: null, tags: [], masterTags: [], snoozedAt: null, ...extra }) as unknown as Card;

function state(): HomeState {
  return {
    projects: new Map([
      ['fb', project('fb', 1, 'The Fog-Bound', [[1, 'World'], [2, 'Combat']])],
      ['js', project('js', 2, 'Jatify site', [[1, null]])],
    ]),
    decks: new Map([
      ['strand', deck('strand', 1, 'fb', 1, 'The Strand')],
      ['creatures', deck('creatures', 2, 'fb', 2, 'Creatures')],
      ['site', deck('site', 3, 'js', 1, 'Site updates')],
    ]),
    cards: new Map([['c1', task('c1', 'creatures', 'Drowned Man')], ['c2', task('c2', 'site', 'Add questlog')]]),
    cardDeps: new Map(),
    resolvables: new Map(),
    account: null,
  };
}
const sync = (doc: Y.Doc, s: HomeState, quests = false, fresh?: Set<string>) => syncWork(doc, BID, buildHomeModel(s, { quests }).nodes, s, fresh);
const has = (doc: Y.Doc, ref: string) => readWork(doc).some((n) => workRef(n) === K(ref));
const centreOf = (doc: Y.Doc, ref: string) => {
  const n = readWork(doc).find((x) => workRef(x) === K(ref))!;
  return { x: n.pos.x + n.pos.w / 2, y: n.pos.y + n.pos.h / 2 };
};
/** Two docs kept in step, as two editors in one room. */
const pair = () => {
  const a = new Y.Doc(), b = new Y.Doc();
  a.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'b') Y.applyUpdate(b, u, 'a'); });
  b.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'a') Y.applyUpdate(a, u, 'b'); });
  return [a, b] as const;
};

describe('the work on the Home board', () => {
  it('first use: every node where the Web layout puts it, under an opaque key, outside any frame', () => {
    const s = state(), m = buildHomeModel(s, { quests: false });
    const add = placeWork(BID, m.nodes, new Map());
    expect(add.map((n) => n.id)).toEqual(m.nodes.map((n) => workKey(BID, n.id)));
    const layout = webLayout(m.nodes, () => false).pos;
    for (const n of add) {
      const h = m.nodes.find((x) => K(x.id) === workRef(n))!;
      expect(Math.abs(n.pos.x + n.pos.w / 2 - layout.get(h.id)!.x)).toBeLessThanOrEqual(1);
      expect([n.pos.w, n.pos.h]).toEqual(pillSize(h));
      expect(n.pos.parent).toBe(null);
      expect(workRef(n)).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(workHash('other', 'pfb')).not.toBe(K('pfb'));
  });

  it('the shared doc holds no id of the work: one with a hidden project has none of its ids, nor its name', () => {
    const s = state(), doc = new Y.Doc();
    const pid = '7f0c2b1e-hidden-project', did = '9a1d4e77-hidden-list', cid = '3c5e8f21-hidden-task';
    s.projects.set(pid, project(pid, 3, 'Secret project', [[4, 'Secret area']]));
    s.decks.set(did, deck(did, 6, pid, 4, 'Secret list'));
    s.cards.set(cid, { ...task('c9', did, 'Secret quest'), id: cid } as Card);
    sync(doc, s, true);
    expect(has(doc, `q${cid}`)).toBe(true);
    const sent = Y.encodeStateAsUpdate(doc), theirs = new Y.Doc();
    Y.applyUpdate(theirs, sent);
    const text = JSON.stringify(boardMaps(theirs).nodes.toJSON()) + new TextDecoder().decode(sent);
    for (const id of [pid, did, cid, '7f0c2b1e', '9a1d4e77', '3c5e8f21', 'Secret', 'hidden']) expect(text).not.toContain(id);
    for (const n of readWork(theirs)) expect(Object.keys(n.value).every((k) => k === 'k' || k === 'p')).toBe(true);
  });

  it('a new list appears near its area, where its area was moved to', () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s);
    const world = boardMaps(doc).nodes.get(workKey(BID, 'afb:1'))!;
    const p = world.get('pos') as { x: number; y: number };
    world.set('pos', { ...p, x: p.x + 2000, y: p.y + 1000 });
    s.decks.set('beach', deck('beach', 4, 'fb', 1, 'The Beach'));
    expect(sync(doc, s)).toBe(1);
    const a = centreOf(doc, 'afb:1'), l = centreOf(doc, 'lbeach');
    expect(Math.hypot(l.x - a.x, l.y - a.y)).toBeLessThan(400);
    expect(sync(doc, s)).toBe(0);
  });

  it('a moved node keeps its place for everyone; the upkeep is not in the undo history', () => {
    const s = state(), [a, b] = pair();
    const um = boardUndo(boardMaps(a));
    sync(a, s);
    expect(um.canUndo()).toBe(false);
    const key = workKey(BID, 'lsite');
    b.transact(() => { const y = boardMaps(b).nodes.get(key)!; y.set('pos', { ...(y.get('pos') as object), x: 900, y: 700 }); }, LOCAL);
    expect((boardMaps(a).nodes.get(key)!.get('pos') as { x: number }).x).toBe(900);
    expect(sync(a, s)).toBe(0);
    s.decks.set('blog', deck('blog', 5, 'js', 1, 'Blog'));
    sync(a, s);
    sync(b, s);
    expect(readWork(a).filter((n) => workRef(n) === K('lblog'))).toHaveLength(1);
    expect(readWork(b).length).toBe(readWork(a).length);
  });

  it('leaves: archived project, removed area, deleted list, archived, deleted or done task; done ones are never put on', () => {
    const s = state(), doc = new Y.Doc();
    s.cards.set('c3', task('c3', 'strand', 'Already done', { status: 'done' }));
    sync(doc, s, true);
    expect(has(doc, 'qc1')).toBe(true);
    expect(has(doc, 'qc3')).toBe(false);
    s.cards.set('c1', { ...s.cards.get('c1')!, status: 'done' } as Card);
    s.decks.delete('site');
    s.cards.delete('c2');
    sync(doc, s, true);
    for (const ref of ['qc1', 'lsite', 'qc2']) expect(has(doc, ref), ref).toBe(false);
    s.projects.set('fb', { ...s.projects.get('fb')!, spaces: s.projects.get('fb')!.spaces.filter((x) => x.id !== 2) } as Project);
    s.decks.delete('creatures');
    sync(doc, s, true);
    expect(has(doc, 'afb:2')).toBe(false);
    s.projects.set('js', { ...s.projects.get('js')!, isArchived: true } as Project);
    sync(doc, s, true);
    expect(has(doc, 'pjs')).toBe(false);
    expect(has(doc, 'pfb')).toBe(true);
  });

  it("what this person can't see is neither drawn nor removed", () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s, true);
    const before = readWork(doc).length;
    const other: HomeState = { ...s, projects: new Map([['js', s.projects.get('js')!]]), decks: new Map([['site', s.decks.get('site')!]]), cards: new Map([['c2', s.cards.get('c2')!]]) };
    expect(goneWork(readWork(doc), workAlive(BID, other))).toEqual([]);
    syncWork(doc, BID, buildHomeModel(other, { quests: true }).nodes, other);
    expect(readWork(doc).length).toBe(before);
    const view = new Map(buildHomeModel(other, { quests: true }).nodes.map((n) => [K(n.id), n]));
    const drawn = workRects(readWork(doc), view, new Set());
    expect(drawn.size).toBe(view.size);
    expect([...drawn.keys()].every((id) => view.has(id.slice(2)))).toBe(true);
  });

  it('two editors who see different projects settle: "+N more" pills and capped quests are not removed and re-added', () => {
    // A sees a big shared list (its quests past the cap give a "+N more" pill) and a private project; B only the shared one.
    const s = state();
    for (let i = 0; i < MAX_QUESTS_PER_LIST + 5; i++) s.cards.set(`k${i}`, task(`k${i}`, 'site', `Quest ${i}`));
    const pid = 'priv', priv: HomeState = { ...s, projects: new Map(s.projects), decks: new Map(s.decks), cards: new Map(s.cards) };
    // The private project comes first and uses up Home's budgets: its lists push the shared list out of A's Home, which
    // draws a "+N more lists" pill instead, and its quests leave none for the rest. B draws the shared list and its quests.
    priv.projects.set(pid, project(pid, 0, 'Private', Array.from({ length: 9 }, (_, i) => [i + 1, `Area ${i}`] as [number, string])));
    for (let l = 0; l < 216; l++) {
      priv.decks.set(`pl${l}`, deck(`pl${l}`, 100 + l, pid, 1 + (l % 9), `Private list ${l}`));
      if (l < 36) for (let q = 0; q < MAX_QUESTS_PER_LIST; q++) priv.cards.set(`pq${l}x${q}`, task(`pq${l}x${q}`, `pl${l}`, `P ${l}.${q}`));
    }
    const ids = (st: HomeState) => new Set(buildHomeModel(st, { quests: true }).nodes.map((n) => n.id));
    const onlyA = ids(priv), onlyB = ids({ ...s, projects: new Map([['js', s.projects.get('js')!]]) });
    expect(onlyA.has('mpjs') && !onlyB.has('mpjs')).toBe(true); // the two Homes really differ
    expect(onlyB.has('lsite') && !onlyA.has('lsite')).toBe(true);
    const onlyShared: HomeState = { ...s, projects: new Map([['js', s.projects.get('js')!]]), decks: new Map([['site', s.decks.get('site')!]]),
      cards: new Map([...s.cards].filter(([, c]) => c.deckId === 'site')) };
    const [a, b] = pair();
    let changes = 0;
    for (let round = 0; round < 6; round++) {
      const ca = syncWork(a, BID, buildHomeModel(priv, { quests: true }).nodes, priv);
      const cb = syncWork(b, BID, buildHomeModel(onlyShared, { quests: true }).nodes, onlyShared);
      if (round >= 2) changes += ca + cb;
    }
    expect(changes).toBe(0);
    expect(has(a, 'msite')).toBe(true); // the list's "+N more" pill stays
    const bytes = Y.encodeStateAsUpdate(a).byteLength;
    for (let round = 0; round < 20; round++) {
      syncWork(a, BID, buildHomeModel(priv, { quests: true }).nodes, priv);
      syncWork(b, BID, buildHomeModel(onlyShared, { quests: true }).nodes, onlyShared);
    }
    expect(Y.encodeStateAsUpdate(a).byteLength).toBe(bytes);
  });

  it('a list moved to another project keeps its place and gets that project\'s key, in place', () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s);
    const key = workKey(BID, 'lsite');
    const y = boardMaps(doc).nodes.get(key)!;
    y.set('pos', { ...(y.get('pos') as object), x: 1234, y: 567 });
    s.decks.set('site', { ...s.decks.get('site')!, projectId: 'fb', spaceId: 1 } as Deck);
    expect(sync(doc, s)).toBeGreaterThan(0);
    const n = readWork(doc).find((x) => x.id === key)!;
    expect(n.pos).toMatchObject({ x: 1234, y: 567 });
    expect(n.value.p).toBe(K('pfb'));
  });

  it('a node another editor added a moment ago is not removed, even if this store does not have its thing yet', () => {
    const s = state(), [a, b] = pair();
    sync(a, s);
    let t = 1000;
    const tracker = trackFresh(a, () => t);
    // B knows a list A's store does not have yet
    const ahead: HomeState = { ...s, decks: new Map(s.decks).set('new', deck('new', 7, 'js', 1, 'New list')) };
    syncWork(b, BID, buildHomeModel(ahead, { quests: false }).nodes, ahead);
    const id = workKey(BID, 'lnew');
    expect(boardMaps(a).nodes.has(id)).toBe(true);
    expect(tracker.fresh().has(id)).toBe(true);
    sync(a, s, false, tracker.fresh());
    expect(boardMaps(a).nodes.has(id)).toBe(true);
    t += 10_000; // later, and A's store still does not have it: gone
    sync(a, s, false, tracker.fresh());
    expect(boardMaps(a).nodes.has(id)).toBe(false);
    tracker.stop();
  });

  it('the lines that touched a removed node go in the same transaction', () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s);
    const note = new Y.Map<unknown>();
    note.set('type', 'text'); note.set('value', { content: 'x' }); note.set('pos', { x: 0, y: 0, w: 100, h: 40, parent: null });
    boardMaps(doc).nodes.set('n1', note);
    const line = new Y.Map<unknown>();
    line.set('value', { source: { nodeId: 'n1', side: 'right' }, target: { nodeId: workKey(BID, 'lsite'), side: 'left' } });
    boardMaps(doc).edges.set('e1', line);
    let transactions = 0;
    doc.on('afterTransaction', () => { transactions++; });
    s.decks.delete('site');
    s.cards.delete('c2');
    sync(doc, s);
    expect(transactions).toBe(1);
    expect(boardMaps(doc).edges.has('e1')).toBe(false);
    expect(boardMaps(doc).nodes.has('n1')).toBe(true);
  });

  it('stays bounded over many rounds of new and finished quests, and never passes MAX_WORK_NODES', () => {
    const s = state(), doc = new Y.Doc();
    let n = 0;
    const sizes: number[] = [];
    for (let round = 0; round < 60; round++) {
      for (const c of [...s.cards.values()]) if (c.status !== 'done') s.cards.set(c.id, { ...c, status: 'done' } as Card);
      for (let i = 0; i < 10; i++) { n++; s.cards.set(`r${n}`, task(`r${n}`, n % 2 ? 'strand' : 'site', `Round quest ${n}`)); }
      sync(doc, s, true);
      sizes.push(readWork(doc).length);
    }
    expect(Math.max(...sizes.slice(5))).toBe(Math.min(...sizes.slice(5))); // flat: the finished ones leave
    expect(sizes.at(-1)!).toBeLessThan(30);
    // a board that is over the cap (many people adding at once) comes back under it
    const big = new Y.Doc();
    big.transact(() => {
      for (let i = 0; i < MAX_WORK_NODES + 50; i++) {
        const y = new Y.Map<unknown>();
        y.set('type', 'work'); y.set('value', { k: K(`qx${i}`), p: K('pjs') }); y.set('pos', { x: i, y: 0, w: 10, h: 10, parent: null });
        boardMaps(big).nodes.set(`w:${K(`qx${i}`)}`, y);
      }
    });
    // they are tasks of a project this person sees but not in their store: gone; the work of their own Home goes on
    sync(big, s, true);
    expect(readWork(big).length).toBeLessThanOrEqual(MAX_WORK_NODES);
    expect(has(big, 'pjs')).toBe(true);
  });

  it('only tasks of a project every member sees go on Home as cards', () => {
    const s = state() as unknown as State;
    (s.projects as Map<string, Project>).set('lim', project('lim', 5, 'Limited', [[1, null]], { visibility: 'limited' } as Partial<Project>));
    (s.decks as Map<string, Deck>).set('ld', deck('ld', 8, 'lim', 1, 'L'));
    (s.cards as Map<string, Card>).set('lc', task('lc', 'ld', 'Private task'));
    (s.cards as Map<string, Card>).set('free', { ...task('free', 'site', 'No list'), deckId: null } as unknown as Card);
    expect(homeCardAllowed(s, 'c2')).toBe(true);
    expect(homeCardAllowed(s, 'lc')).toBe(false);
    expect(homeCardAllowed(s, 'free')).toBe(false);
    expect(homeCardAllowed(s, 'missing')).toBe(false);
  });

  it('the Home board is asked for again when the person or their role changes', async () => {
    let calls = 0;
    const fetch = async () => ({ id: `b${++calls}`, canEdit: calls === 1 });
    const a = await askHome('u1:member', fetch);
    expect(await askHome('u1:member', fetch)).toBe(a);
    expect(calls).toBe(1);
    const b = await askHome('u1:observer', fetch);
    expect(calls).toBe(2);
    expect(b.canEdit).toBe(false);
  });

  it('drawn: work nodes never sit in a frame, a move writes no parent; an unchanged node keeps its object', () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s);
    const nodes = readWork(doc).map((n) => ({ ...n, pos: { ...n.pos, parent: 'frame1' } }));
    const written: Array<{ id: string; pos: BoardNode['pos'] }> = [];
    const api = { nodes, setPos: (c: typeof written) => { written.push(...c); } } as unknown as BoardApi;
    const rects = new Map(nodes.map((n) => [n.id, { x: n.pos.x, y: n.pos.y, w: n.pos.w, h: n.pos.h }]));
    const d1 = drawnBoard(api, rects);
    expect(d1.nodes.every((n) => n.pos.parent === null)).toBe(true);
    d1.setPos([{ id: nodes[0].id, pos: { ...d1.nodes[0].pos, x: d1.nodes[0].pos.x + 40, parent: 'frame1' } }]);
    expect(written[0].pos.parent).toBe(null);
    expect(written[0].pos.x).toBe(nodes[0].pos.x + 40);
    // the same stored nodes and rects: the same drawn objects (their views don't re-render)
    const d2 = drawnBoard(api, new Map(rects));
    expect(d2.nodes.every((n, i) => n === d1.nodes[i])).toBe(true);
  });

  it('the key cache keeps the most recently used keys and stays bounded', () => {
    const first = K('lru-first');
    for (let i = 0; i < HASH_CACHE_MAX + 10; i++) { workHash(BID, `fill${i}`); if (i % 1000 === 0) K('lru-first'); }
    expect(hashCacheSize()).toBeLessThanOrEqual(HASH_CACHE_MAX);
    expect(K('lru-first')).toBe(first);
  });

  it("cards: drawn at card size on the node's place; pills under a card step aside, on screen only", () => {
    const s = state(), doc = new Y.Doc();
    const m = buildHomeModel(s, { quests: false });
    sync(doc, s);
    const proj = centreOf(doc, 'pjs');
    const y = boardMaps(doc).nodes.get(workKey(BID, 'lsite'))!;
    const p = y.get('pos') as { w: number; h: number };
    y.set('pos', { ...p, x: proj.x - p.w / 2 + 10, y: proj.y - p.h / 2 + 5 });
    const stored = JSON.stringify(readWork(doc).map((n) => n.pos));
    const r = workRects(readWork(doc), new Map(m.nodes.map((n) => [K(n.id), n])), new Set(['pjs']));
    const card = r.get(workKey(BID, 'pjs'))!, list = r.get(workKey(BID, 'lsite'))!;
    expect([card.w, card.h]).toEqual([CARD_W, CARD_H]);
    expect(card.x + card.w / 2).toBeCloseTo(proj.x);
    const overlap = card.x < list.x + list.w && list.x < card.x + card.w && card.y < list.y + list.h && list.y < card.y + card.h;
    expect(overlap).toBe(false);
    expect(JSON.stringify(readWork(doc).map((n) => n.pos))).toBe(stored);
  });

  it('a `w:` entry without a key (malformed) is dropped by the upkeep', () => {
    const s = state(), doc = new Y.Doc();
    sync(doc, s);
    const bad = new Y.Map<unknown>();
    bad.set('type', 'work'); bad.set('value', { note: 'no key' }); bad.set('pos', { x: 0, y: 0, w: 10, h: 10, parent: null });
    boardMaps(doc).nodes.set('w:stray', bad);
    expect(sync(doc, s)).toBe(1);
    expect(boardMaps(doc).nodes.has('w:stray')).toBe(false);
  });

  it('nudge: overlapping cards spread; pills that only touch pills stay', () => {
    const out = nudge([
      { id: 'c1', card: true, x: 0, y: 0, w: 200, h: 200 },
      { id: 'c2', card: true, x: 50, y: 0, w: 200, h: 200 },
      { id: 'p1', card: false, x: 600, y: 0, w: 100, h: 30 },
      { id: 'p2', card: false, x: 610, y: 5, w: 100, h: 30 },
    ]);
    const a = out.get('c1')!, b = out.get('c2')!;
    expect(Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 200).toBe(true);
    expect(out.get('p1')).toMatchObject({ x: 600, y: 0 });
    expect(out.get('p2')).toMatchObject({ x: 610, y: 5 });
  });
});

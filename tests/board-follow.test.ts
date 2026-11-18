import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { layoutFrames, reconcile, type BoardPatch, type FrameInput } from '../web/src/board/projectFrames';
import { boardMaps, boardUndo, LOCAL, readBoard, SYNC, unparentOrphans, writePatch } from '../web/src/board/useBoard';
import { goneTasks, OTHER_PROJECT, refuseProject } from '../web/src/board/boards';
import { followOnce, Holds, mayAffect, watchRemoteDrops, withoutMoves } from '../web/src/board/follow';
import { ASK_ADMIN, deletable, depChoice, edgeStepCalls, FRAME_DELETE, meaningOf, saveLink, unlinkCall } from '../web/src/board/links';
import { dropIntent, HOLD_MS, listDrop, listMoveToSend, markListMove, moveBackSync, OFFLINE_DROP, parentChanges, planMove, readListMove, saveDrop } from '../web/src/board/drop';
import { refOf } from '../web/src/board/projectTree';
import type { State } from '../web/src/store';
import type { Card, CardDep, Deck, Project, Space } from '../shared/types';

const spaces = [{ id: 1, name: 'World' }, { id: 2, name: 'Combat' }] as unknown as Space[];
const project = { id: 'p1', name: 'Game', spaces } as unknown as Project;
const deck = (id: string, spaceId: number, projectId = 'p1') => ({ id, spaceId, projectId, title: `List ${id}`, sortIndex: Number(id.slice(1)), seq: Number(id.slice(1)) }) as unknown as Deck;
const card = (id: string, deckId: string, extra: Partial<Card> = {}) =>
  ({ id, deckId, seq: Number(id.slice(1)), sortIndex: Number(id.slice(1)), parentCardId: null, visibility: 'default', isDoc: false, status: 'not_started', assigneeId: null, ...extra }) as unknown as Card;
const decks = [deck('d1', 1), deck('d2', 2)];
const cards = [card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd2')];
const deps: CardDep[] = [];
const input = (over: Partial<FrameInput> = {}): FrameInput => ({
  project, spaces, decks, cards, deps, gone: new Set(), areaName: (id) => spaces.find((s) => s.id === id)!.name ?? '', nodes: [], edges: [], ...over,
});
const empty: BoardPatch = { add: [], addEdges: [], move: [], remove: [], removeEdges: [], update: [] };
const fromDoc = (doc: Y.Doc, over: Partial<FrameInput> = {}) => { const b = readBoard(doc); return input({ nodes: b.nodes, edges: b.edges, ...over }); };
const cardsOf = (doc: Y.Doc, task: string) => readBoard(doc).nodes.filter((n) => refOf(n) === `card:${task}`);

/** A board laid out once by the user (LOCAL, one undo step), as "Add project" leaves it. */
function laidOut() {
  const doc = new Y.Doc();
  const maps = boardMaps(doc);
  const um = boardUndo(maps);
  writePatch(doc, maps, layoutFrames(input(), { x: 0, y: 0 }), LOCAL, 'p1');
  return { doc, maps, um };
}

describe('reconcile writes (SYNC)', () => {
  it('reconcile is not undoable', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const um = boardUndo(maps);
    writePatch(doc, maps, reconcile(fromDoc(doc)), SYNC);
    expect(cardsOf(doc, 'c1')).toHaveLength(1);
    expect(um.canUndo()).toBe(false);
    um.undo();
    expect(cardsOf(doc, 'c1')).toHaveLength(1);
    um.destroy();
  });

  it("undo after reconcile undoes only the user's step: a task reconcile added or removed stays so", () => {
    const { doc, maps, um } = laidOut();
    // The user moves the header (LOCAL), then the project changes: c4 is new, c2 is done (SYNC).
    const header = readBoard(doc).nodes.find((n) => refOf(n) === 'project:p1')!;
    doc.transact(() => maps.nodes.get(header.id)!.set('pos', { ...header.pos, x: header.pos.x + 40 }), LOCAL);
    const more = [card('c1', 'd1'), card('c3', 'd2'), card('c4', 'd1')];
    writePatch(doc, maps, reconcile(fromDoc(doc, { cards: more, gone: new Set(['c2']) })), SYNC);
    expect(cardsOf(doc, 'c4')).toHaveLength(1);
    expect(cardsOf(doc, 'c2')).toHaveLength(0);
    expect(um.undoStack).toHaveLength(2);
    um.undo();
    expect(readBoard(doc).nodes.find((n) => n.id === header.id)!.pos.x).toBe(header.pos.x);
    expect(cardsOf(doc, 'c4')).toHaveLength(1);
    expect(cardsOf(doc, 'c2')).toHaveLength(0);
    expect(reconcile(fromDoc(doc, { cards: more, gone: new Set(['c2']) }))).toEqual(empty);
    um.destroy();
  });
});

describe('orphaned parents', () => {
  it('undoing "Add project" after reconcile filled its frames leaves loose cards, not dangling parents', () => {
    const { doc, maps, um } = laidOut();
    writePatch(doc, maps, reconcile(fromDoc(doc, { cards: [...cards, card('c4', 'd1')] })), SYNC);
    const added = cardsOf(doc, 'c4')[0];
    expect(added.pos.parent).not.toBeNull();
    um.undo(); // the layout and the board's project go; the card reconcile added does not
    const raw = maps.nodes.get(added.id)!.get('pos') as { parent: string | null };
    expect(maps.nodes.has(raw.parent!)).toBe(false);
    expect(unparentOrphans(doc, maps)).toBe(1);
    expect(cardsOf(doc, 'c4')[0].pos).toEqual({ ...added.pos, parent: null });
    expect(um.canUndo()).toBe(false); // the fix is not an undo step
    expect(unparentOrphans(doc, maps)).toBe(0);
    um.destroy();
  });

  it('on any board: a node inside a frame that another client deleted becomes loose', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const node = (id: string, type: string, parent: string | null) => {
      const m = new Y.Map<unknown>(); m.set('type', type); m.set('value', { label: 'x' }); m.set('pos', { x: 40, y: 40, w: 200, h: 80, parent }); maps.nodes.set(id, m);
    };
    doc.transact(() => { node('f', 'container', null); node('t', 'text', 'f'); node('u', 'text', 'gone'); });
    expect(unparentOrphans(doc, maps)).toBe(1);
    expect(readBoard(doc).nodes.find((n) => n.id === 't')!.pos.parent).toBe('f');
    expect(readBoard(doc).nodes.find((n) => n.id === 'u')!.pos).toEqual({ x: 40, y: 40, w: 200, h: 80, parent: null });
  });
});

describe('two clients following at once', () => {
  it('both add the same new list and task; after syncing and one more pass each, they agree on one of each', () => {
    const a = new Y.Doc(), b = new Y.Doc();
    writePatch(a, boardMaps(a), layoutFrames(input(), { x: 0, y: 0 }), LOCAL, 'p1');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const sync = () => { Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))); Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))); };
    const moreDecks = [...decks, deck('d3', 1)];
    const more = [...cards, card('c4', 'd1'), card('c5', 'd3')];
    const pass = (doc: Y.Doc) => writePatch(doc, boardMaps(doc), reconcile(fromDoc(doc, { decks: moreDecks, cards: more })), SYNC);
    pass(a); pass(b);
    sync();
    expect(cardsOf(a, 'c4')).toHaveLength(2);
    pass(a); pass(b);
    sync();
    for (const doc of [a, b]) {
      expect(cardsOf(doc, 'c4')).toHaveLength(1);
      expect(cardsOf(doc, 'c5')).toHaveLength(1);
      expect(readBoard(doc).nodes.filter((n) => refOf(n) === 'deck:d3')).toHaveLength(1);
      expect(reconcile(fromDoc(doc, { decks: moreDecks, cards: more }))).toEqual(empty);
    }
    const snap = (doc: Y.Doc) => JSON.stringify([...boardMaps(doc).nodes.entries()].map(([k, m]) => [k, m.toJSON()]).sort());
    expect(snap(a)).toBe(snap(b));
  });

  it('both draw the same new "waits for" and subtask lines; after syncing they keep the same one of each, then write nothing', () => {
    const a = new Y.Doc(), b = new Y.Doc();
    writePatch(a, boardMaps(a), layoutFrames(input(), { x: 0, y: 0 }), LOCAL, 'p1');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const sync = () => { Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))); Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))); };
    // Now c1 waits for c3 (another list) and c2 is c1's subtask.
    const more = { deps: [{ lockedCardId: 'c1', lockingCardId: 'c3' }], cards: [card('c1', 'd1'), card('c2', 'd1', { parentCardId: 'c1' }), card('c3', 'd2')] };
    const pass = (doc: Y.Doc) => { const p = reconcile(fromDoc(doc, more)); writePatch(doc, boardMaps(doc), p, SYNC); return p; };
    const lines = (doc: Y.Doc, label: string) => readBoard(doc).edges.filter((e) => e.label === label);
    pass(a); pass(b);
    sync();
    expect(lines(a, 'waits for')).toHaveLength(2);
    expect(lines(a, 'subtask')).toHaveLength(2);
    // Each client lists the two lines in its own order; both keep the one with the smallest id.
    pass(a); pass(b);
    sync();
    for (const doc of [a, b]) {
      expect(lines(doc, 'waits for')).toHaveLength(1);
      expect(lines(doc, 'subtask')).toHaveLength(1);
      expect(lines(doc, 'waits for')[0].value.kind).toBe('dep');
      expect(lines(doc, 'subtask')[0].value.kind).toBe('sub');
    }
    expect(lines(a, 'waits for')[0].id).toBe(lines(b, 'waits for')[0].id);
    // Settled: another pass on either client writes nothing, and the two stay the same.
    for (let i = 0; i < 3; i++) {
      expect(pass(a)).toEqual(empty);
      expect(pass(b)).toEqual(empty);
      sync();
    }
    const edgeSnap = (doc: Y.Doc) => JSON.stringify([...boardMaps(doc).edges.entries()].map(([k, m]) => [k, m.toJSON()]).sort());
    expect(edgeSnap(a)).toBe(edgeSnap(b));
  });
});

const HOST = 'h1';
const hostCard = card(HOST, 'd1', { isDoc: true });
const state = (over: Partial<State> = {}): State => ({
  status: 'ready',
  live: true,
  projects: new Map([['p1', project], ['p2', { id: 'p2', name: 'Other', spaces } as unknown as Project]]),
  decks: new Map([...decks, deck('x1', 1, 'p2')].map((d) => [d.id, d])),
  cards: new Map([...cards, hostCard].map((c) => [c.id, c])),
  cardDeps: new Map(),
  resolvables: new Map(),
  ...over,
}) as unknown as State;

describe('goneTasks', () => {
  it("only what the store knows about this project's tasks: done, archived, or no longer in the project since last time", () => {
    const s = state({
      cards: new Map([
        card('c1', 'd1'), card('c2', 'd1', { status: 'done' }), card('c3', 'd2', { visibility: 'archived' }),
        card('c4', 'x1'), // moved to another project since last time
        card('c6', 'd1', { isDoc: true }), card('c7', 'x1'), // lore; another project's task
      ].map((c) => [c.id, c])),
    });
    // c5 was deleted since last time (gone from the store); c8 was never seen here: not gone.
    const { gone, now } = goneTasks(s, 'p1', new Set(['c1', 'c4', 'c5']));
    expect([...gone].sort()).toEqual(['c2', 'c3', 'c4', 'c5']);
    expect([...now].sort()).toEqual(['c1', 'c2', 'c3']);
    expect([...goneTasks(s, 'p1', new Set()).gone].sort()).toEqual(['c2', 'c3']);
  });
});

describe('followOnce', () => {
  it('plans nothing before the store has the project; then follows it, and a deleted task leaves on the next pass', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    doc.transact(() => maps.meta.set('projectId', 'p1'), LOCAL);
    expect(followOnce(doc, state({ status: 'loading' }), HOST, null)).toBeNull();
    expect(followOnce(doc, state({ projects: new Map() }), HOST, null)).toBeNull();
    expect(maps.nodes.size).toBe(0);
    const known = followOnce(doc, state(), HOST, null)!;
    expect(cardsOf(doc, 'c2')).toHaveLength(1);
    // c2 deleted: the store drops it; the board knew it, so its card leaves.
    followOnce(doc, state({ cards: new Map([card('c1', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) }), HOST, known);
    expect(cardsOf(doc, 'c2')).toHaveLength(0);
    expect(cardsOf(doc, 'c1')).toHaveLength(1);
  });

  it('a card the caller holds is not moved to its new list', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    writePatch(doc, maps, layoutFrames(input(), { x: 0, y: 0 }), LOCAL, 'p1');
    const c1 = cardsOf(doc, 'c1')[0];
    const moved = state({ cards: new Map([card('c1', 'd2'), card('c2', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    followOnce(doc, moved, HOST, null, new Set([c1.id]));
    expect(cardsOf(doc, 'c1')[0].pos).toEqual(c1.pos);
    followOnce(doc, moved, HOST, null);
    expect(cardsOf(doc, 'c1')[0].pos.parent).toBe(readBoard(doc).nodes.find((n) => refOf(n) === 'deck:d2')!.id);
  });

  it('a board without a project only gets its parents fixed', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const m = new Y.Map<unknown>(); m.set('type', 'text'); m.set('value', {}); m.set('pos', { x: 0, y: 0, w: 40, h: 40, parent: 'nope' });
    maps.nodes.set('t', m);
    expect(followOnce(doc, state(), HOST, null)).toBeNull();
    expect(readBoard(doc).nodes).toEqual([{ id: 't', type: 'text', value: {}, pos: { x: 0, y: 0, w: 40, h: 40, parent: null } }]);
  });
});

describe('fix round 1: what a pass may write', () => {
  const snap = (doc: Y.Doc) => JSON.stringify([[...boardMaps(doc).nodes.entries()].map(([k, m]) => [k, m.toJSON()]).sort(), [...boardMaps(doc).edges.keys()].sort()]);

  it("a board whose projectId is not its host task's project is not followed: nothing is written", () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    doc.transact(() => maps.meta.set('projectId', 'p2'), LOCAL); // p2 is visible to this user, the host is in p1
    const before = snap(doc);
    expect(followOnce(doc, state(), HOST, null)).toBeNull();
    expect(snap(doc)).toBe(before);
    // The host itself moved to another project: the board's own project no longer matches either.
    doc.transact(() => maps.meta.set('projectId', 'p1'), LOCAL);
    const elsewhere = state({ cards: new Map([...cards, card(HOST, 'x1', { isDoc: true })].map((c) => [c.id, c])) });
    expect(followOnce(doc, elsewhere, HOST, null)).toBeNull();
    expect(maps.nodes.size).toBe(0);
    expect(followOnce(doc, state(), HOST, null)).not.toBeNull();
    expect(maps.nodes.size).toBeGreaterThan(0);
  });

  it('"Add project" / "Arrange as frames" accept only the host\'s project', () => {
    expect(refuseProject(state(), HOST, 'p1')).toBeNull();
    expect(refuseProject(state(), HOST, 'p2')).toBe(OTHER_PROJECT);
    expect(refuseProject(state(), 'unknown-host', 'p1')).toBe(OTHER_PROJECT);
    expect(OTHER_PROJECT).toBe('A board can only show the project it belongs to.');
  });

  it('no pass while the store is not live (socket down, reload in flight); the next one runs once it is', () => {
    const { doc } = laidOut();
    const known = followOnce(doc, state(), HOST, null)!;
    const before = snap(doc);
    // A stale store, before the reload after a reconnect: c2 looks deleted, c4 is not there yet.
    const stale = state({ live: false, cards: new Map([card('c1', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    expect(followOnce(doc, stale, HOST, known)).toBe(known);
    expect(snap(doc)).toBe(before);
    expect(followOnce(doc, state({ cards: new Map([...cards, card('c4', 'd1'), hostCard].map((c) => [c.id, c])) }), HOST, known)).not.toBe(known);
    expect(cardsOf(doc, 'c2')).toHaveLength(1);
    expect(cardsOf(doc, 'c4')).toHaveLength(1);
  });

  it("a card in one of this project's list frames whose task the store does not have is gone; a loose one stays", () => {
    const { doc, maps } = laidOut();
    const b = readBoard(doc);
    const list = b.nodes.find((n) => refOf(n) === 'deck:d1')!;
    const put = (id: string, task: string, parent: string | null, x: number) => {
      const m = new Y.Map<unknown>(); m.set('type', 'card'); m.set('value', { id: task, mode: 'mini' }); m.set('pos', { x, y: list.pos.y + 40, w: 200, h: 80, parent }); maps.nodes.set(id, m);
    };
    // Deleted while the board was closed: one card still in its list frame, one the user had dragged out (loose).
    doc.transact(() => { put('in', 'c90', list.id, list.pos.x + 20); put('out', 'c91', null, -2000); }, SYNC);
    followOnce(doc, state(), HOST, null);
    expect(cardsOf(doc, 'c90')).toHaveLength(0);
    expect(cardsOf(doc, 'c91')).toHaveLength(1);
    expect(cardsOf(doc, 'c1')).toHaveLength(1);
  });

  it('typing in a note or a user frame label does not start a pass; anything else does', () => {
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const node = (id: string, type: string, value: object) => {
      const m = new Y.Map<unknown>(); m.set('type', type); m.set('value', value); m.set('pos', { x: 0, y: 0, w: 40, h: 40, parent: null }); maps.nodes.set(id, m);
    };
    doc.transact(() => { node('note', 'text', { content: 'a' }); node('frame', 'container', { label: 'mine' }); node('list', 'container', { label: 'L', ref: 'deck:d1' }); node('c', 'card', { id: 'c1', mode: 'mini' }); }, LOCAL);
    const seen: boolean[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => seen.push(mayAffect(doc, tr)));
    const write = (fn: () => void, origin: unknown = LOCAL) => doc.transact(fn, origin);
    write(() => maps.nodes.get('note')!.set('value', { content: 'ab' }));
    write(() => { maps.nodes.get('note')!.set('value', { content: 'abc' }); maps.nodes.get('frame')!.set('value', { label: 'mine!' }); });
    write(() => maps.nodes.get('list')!.set('value', { label: 'L2', ref: 'deck:d1' }));
    write(() => maps.nodes.get('c')!.set('value', { id: 'c1', mode: 'full' }));
    write(() => maps.nodes.get('note')!.set('pos', { x: 40, y: 0, w: 40, h: 40, parent: null }));
    write(() => maps.nodes.delete('note'));
    write(() => maps.nodes.get('frame')!.set('value', { label: 'x' }), SYNC);
    expect(seen).toEqual([false, false, true, true, true, true, false]);
  });
});

describe('drops change the project', () => {
  const board = () => {
    const { doc, maps } = laidOut();
    const nodes = readBoard(doc).nodes;
    const byRef = (r: string) => nodes.find((n) => refOf(n) === r)!;
    return { doc, maps, nodes, byRef };
  };
  // Another project's list frame, as a user could have put one on the board.
  const otherList = { id: 'ox', type: 'container', value: { label: 'Other', ref: 'deck:x1' }, pos: { x: 0, y: 2000, w: 480, h: 140, parent: null } } as const;
  const snap = (doc: Y.Doc) => JSON.stringify([...boardMaps(doc).nodes.entries()].map(([k, m]) => [k, m.toJSON()]).sort());

  it('dropIntent: a task into another list of this project moves it; its own list, another project or another host does not', () => {
    const { byRef } = board();
    const c1 = byRef('card:c1'), d1 = byRef('deck:d1'), d2 = byRef('deck:d2');
    const s = state();
    expect(dropIntent(c1, d1, s, 'p1', HOST)).toBeNull();
    expect(dropIntent(c1, d2, s, 'p1', HOST)).toEqual({ kind: 'move-task', cardId: 'c1', deckId: 'd2' });
    expect(dropIntent(c1, otherList as never, s, 'p1', HOST)).toBeNull();
    expect(dropIntent(c1, null, s, 'p1', HOST)).toBeNull(); // outside every frame: a position only
    expect(dropIntent(c1, byRef('area:p1:2'), s, 'p1', HOST)).toBeNull(); // an area frame is not a list
    // A board whose project is not its host's project, or an unknown host: nothing.
    expect(dropIntent(c1, d2, s, 'p2', HOST)).toBeNull();
    expect(dropIntent(c1, d2, s, 'p1', 'unknown-host')).toBeNull();
    expect(dropIntent(c1, d2, s, null, HOST)).toBeNull();
    // A task of another project dropped into this project's list: nothing.
    const foreign = state({ cards: new Map([card('c1', 'x1'), hostCard].map((c) => [c.id, c])) });
    expect(dropIntent(c1, d2, foreign, 'p1', HOST)).toBeNull();
  });

  it('dropIntent: a list frame into another area of this project moves the list; its own area does not', () => {
    const { byRef } = board();
    const d1 = byRef('deck:d1');
    expect(dropIntent(d1, byRef('area:p1:2'), state(), 'p1', HOST)).toEqual({ kind: 'move-list', deckId: 'd1', spaceId: 2 });
    expect(dropIntent(d1, byRef('area:p1:1'), state(), 'p1', HOST)).toBeNull();
    const elsewhere = { ...byRef('area:p1:2'), value: { label: 'x', ref: 'area:p2:2' } };
    expect(dropIntent(d1, elsewhere, state(), 'p1', HOST)).toBeNull();
    expect(dropIntent(d1, byRef('area:p1:2'), state(), 'p2', HOST)).toBeNull();
  });

  it('drag within own list writes nothing to the project', async () => {
    const { byRef } = board();
    const c1 = byRef('card:c1'), d1 = byRef('deck:d1');
    const dispatch = vi.fn(() => Promise.resolve({}));
    const revert = vi.fn();
    const holds = new Holds();
    const moved = { ...c1, pos: { ...c1.pos, x: c1.pos.x + 20 } };
    expect(await saveDrop(moved, d1, state(), 'p1', HOST, { holds, dispatch, revert })).toBeNull();
    expect(await saveDrop(moved, null, state(), 'p1', HOST, { holds, dispatch, revert })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(holds.size).toBe(0);
  });

  it('a drop into another list is saved with the card held; held until the store has it; refused, it goes back', async () => {
    const { byRef } = board();
    const c1 = byRef('card:c1'), d2 = byRef('deck:d2');
    const holds = new Holds();
    let finish!: () => void;
    const dispatch = vi.fn(() => new Promise<unknown>((r) => { finish = () => r({}); }));
    const revert = vi.fn();
    const saving = saveDrop(c1, d2, state(), 'p1', HOST, { holds, dispatch, revert, now: () => 1000 });
    expect(dispatch).toHaveBeenCalledWith('cards', 'update', { id: 'c1', deckId: 'd2', parentCardId: null });
    expect(holds.current(state(), 1e12)).toEqual(new Set([c1.id])); // pending: held however long it takes
    finish();
    expect(await saving).toEqual({ kind: 'move-task', cardId: 'c1', deckId: 'd2' });
    expect(holds.current(state(), 1000)).toEqual(new Set([c1.id])); // the store does not have it yet
    const moved = state({ cards: new Map([card('c1', 'd2'), card('c2', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    expect(holds.current(moved, 1000).size).toBe(0);

    const refusing = vi.fn(() => Promise.reject(new Error('no')));
    expect(await saveDrop(c1, d2, state(), 'p1', HOST, { holds, dispatch: refusing, revert })).toBeNull();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(holds.size).toBe(0);
    // A list frame into another area: the list moves.
    const lists = vi.fn(() => Promise.resolve({}));
    await saveDrop(byRef('deck:d1'), byRef('area:p1:2'), state(), 'p1', HOST, { holds, dispatch: lists, revert });
    expect(lists).toHaveBeenCalledWith('decks', 'update', { id: 'd1', spaceId: 2 });
  });

  it("another client's drop is not pulled back before this client's store has it, and nothing moves after", () => {
    const { doc: a, maps } = laidOut();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
    let t = 1000;
    const holds = new Holds();
    const stop = watchRemoteDrops(b, holds, () => t);
    const send = () => Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
    // A drops c1 into d2's frame (its own write), past d2's card.
    const nodes = readBoard(a).nodes;
    const c1 = nodes.find((n) => refOf(n) === 'card:c1')!, d2 = nodes.find((n) => refOf(n) === 'deck:d2')!;
    const dropped = { ...c1.pos, x: d2.pos.x + d2.pos.w - c1.pos.w - 20, y: d2.pos.y + 40, parent: d2.id };
    a.transact(() => maps.nodes.get(c1.id)!.set('pos', dropped), LOCAL);
    send();
    expect(holds.size).toBe(1);
    // B's store still has c1 in d1: its pass leaves the card where A dropped it.
    const stale = state();
    followOnce(b, stale, HOST, null, holds.current(stale, t));
    expect(cardsOf(b, 'c1')[0].pos).toEqual(dropped);
    // B's store catches up: the hold goes, and nothing moves.
    const fresh = state({ cards: new Map([card('c1', 'd2'), card('c2', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    const before = snap(b);
    followOnce(b, fresh, HOST, null, holds.current(fresh, t));
    expect(holds.size).toBe(0);
    expect(cardsOf(b, 'c1')[0].pos).toEqual(dropped);
    expect(snap(b)).toBe(before);
    stop();
  });

  it("a remote drop the store never confirms is held for HOLD_MS only; this client's own moves are never held", () => {
    const { doc: a, maps } = laidOut();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    let t = 1000;
    const holds = new Holds();
    const stop = watchRemoteDrops(b, holds, () => t);
    const nodes = readBoard(a).nodes;
    const d1 = nodes.find((n) => refOf(n) === 'deck:d1')!, area2 = nodes.find((n) => refOf(n) === 'area:p1:2')!;
    // B's own drop (LOCAL) is not a remote one.
    const bm = boardMaps(b).nodes;
    b.transact(() => bm.get(d1.id)!.set('pos', { ...d1.pos, parent: area2.id }), LOCAL);
    expect(holds.size).toBe(0);
    b.transact(() => bm.get(d1.id)!.set('pos', d1.pos), LOCAL);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))); // A has seen them: its drop comes after
    // A drops the list d1 (with its cards, as a drag moves them) into area 2, below its list; B's store never hears of it.
    const dx = area2.pos.x - d1.pos.x + 20, dy = 200;
    a.transact(() => {
      maps.nodes.get(d1.id)!.set('pos', { ...d1.pos, x: d1.pos.x + dx, y: d1.pos.y + dy, parent: area2.id });
      for (const n of nodes) if (n.pos.parent === d1.id) maps.nodes.get(n.id)!.set('pos', { ...n.pos, x: n.pos.x + dx, y: n.pos.y + dy });
    }, LOCAL);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
    expect(holds.size).toBe(1);
    const cardPos = cardsOf(b, 'c1')[0].pos;
    followOnce(b, state(), HOST, null, holds.current(state(), t));
    expect(readBoard(b).nodes.find((n) => n.id === d1.id)!.pos.parent).toBe(area2.id);
    expect(cardsOf(b, 'c1')[0].pos).toEqual(cardPos); // the list's cards stay with it
    expect(holds.next()).toBe(1000 + HOLD_MS);
    t += HOLD_MS;
    followOnce(b, state(), HOST, null, holds.current(state(), t));
    expect(readBoard(b).nodes.find((n) => n.id === d1.id)!.pos.parent).toBe(nodes.find((n) => refOf(n) === 'area:p1:1')!.id);
    stop();
  });
});

describe('fix round 1: lists, a second drag, undo', () => {
  const centre = (n: { pos: { x: number; y: number; w: number; h: number } }) => ({ x: n.pos.x + n.pos.w / 2, y: n.pos.y + n.pos.h / 2 });

  it('a 5-task list dropped onto a populated area (over its list) moves the list; within its area onto another list it stays', () => {
    const five = [1, 2, 3, 4, 5].map((i) => card(`c${10 + i}`, 'd1'));
    const moreDecks = [...decks, deck('d3', 1)];
    const doc = new Y.Doc();
    writePatch(doc, boardMaps(doc), layoutFrames(input({ cards: [...five, card('c3', 'd2')], decks: moreDecks }), { x: 0, y: 0 }), LOCAL, 'p1');
    const nodes = readBoard(doc).nodes;
    const byRef = (r: string) => nodes.find((n) => refOf(n) === r)!;
    const s = state({ decks: new Map([...moreDecks, deck('x1', 1, 'p2')].map((d) => [d.id, d])), cards: new Map([...five, card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    const d1 = byRef('deck:d1'), d2 = byRef('deck:d2'), d3 = byRef('deck:d3'), area2 = byRef('area:p1:2');
    expect(d1.pos.w).toBeGreaterThan(area2.pos.w); // it could never fit inside the area whole
    // Dropped with the pointer over the other area's list: the list moves to that area; nothing is nested.
    const over = { x: d2.pos.x, y: d2.pos.y, w: d1.pos.w, h: d1.pos.h };
    expect(listDrop(d1, over, centre(d2), nodes, s, 'p1', HOST)).toEqual({ kind: 'move-list', deckId: 'd1', spaceId: 2, areaId: area2.id });
    // Keyboard (no pointer): the frame's new centre decides.
    const kb = { x: centre(d2).x - d1.pos.w / 2, y: centre(d2).y - d1.pos.h / 2, w: d1.pos.w, h: d1.pos.h };
    expect(listDrop(d1, kb, centre({ pos: kb }), nodes, s, 'p1', HOST)).toMatchObject({ kind: 'move-list', spaceId: 2 });
    // Within its own area, onto another list frame that encloses it: nothing happens (never a list in a list).
    const into = { x: d1.pos.x, y: d1.pos.y, w: d3.pos.w, h: d3.pos.h };
    expect(listDrop(d3, into, centre({ pos: into }), nodes, s, 'p1', HOST)).toEqual({ kind: 'stay' });
    // Within its own area, elsewhere: a position only.
    expect(listDrop(d3, { ...d3.pos, x: d3.pos.x + 20 }, centre(d3), nodes, s, 'p1', HOST)).toEqual({ kind: 'place' });
    // Not a board following its project: a position only. A store not live: the list stays (and the user is told).
    expect(listDrop(d1, over, centre(d2), nodes, s, 'p2', HOST)).toEqual({ kind: 'place' });
    expect(listDrop(d1, over, centre(d2), nodes, state({ ...s, live: false }), 'p1', HOST)).toEqual({ kind: 'offline' });
  });

  it('dropIntent wants a ready, live store', () => {
    const { doc } = laidOut();
    const nodes = readBoard(doc).nodes;
    const c1 = nodes.find((n) => refOf(n) === 'card:c1')!, d2 = nodes.find((n) => refOf(n) === 'deck:d2')!;
    expect(dropIntent(c1, d2, state(), 'p1', HOST)).not.toBeNull();
    expect(dropIntent(c1, d2, state({ live: false }), 'p1', HOST)).toBeNull();
    expect(dropIntent(c1, d2, state({ status: 'loading' }), 'p1', HOST)).toBeNull();
  });

  it('a second drag while the first save is pending: the first one refused later does not put the card back', async () => {
    const moreDecks = [...decks, deck('d3', 1)];
    const s = state({ decks: new Map([...moreDecks, deck('x1', 1, 'p2')].map((d) => [d.id, d])) });
    const { doc } = laidOut();
    const nodes = readBoard(doc).nodes;
    const c1 = nodes.find((n) => refOf(n) === 'card:c1')!, d2 = nodes.find((n) => refOf(n) === 'deck:d2')!;
    const d3 = { id: 'f3', type: 'container', value: { label: 'L3', ref: 'deck:d3' }, pos: { x: 0, y: 900, w: 480, h: 140, parent: null } } as never;
    const holds = new Holds();
    let refuse!: () => void;
    const revert = vi.fn();
    const first = saveDrop(c1, d2, s, 'p1', HOST, { holds, revert, dispatch: () => new Promise((_, no) => { refuse = () => no(new Error('no')); }) });
    let finish!: () => void;
    const second = saveDrop(c1, d3, s, 'p1', HOST, { holds, revert, dispatch: () => new Promise((ok) => { finish = () => ok({}); }) });
    refuse();
    expect(await first).toBeNull();
    expect(revert).not.toHaveBeenCalled(); // the card stays at C
    expect(holds.current(s, 1000)).toEqual(new Set([c1.id])); // still held for the second save
    finish();
    expect(await second).toEqual({ kind: 'move-task', cardId: 'c1', deckId: 'd3' });
    expect(holds.current(s, 1000)).toEqual(new Set([c1.id])); // until the store has d3
    expect(holds.current(state({ ...s, cards: new Map([card('c1', 'd3'), hostCard].map((c) => [c.id, c])) }), 1000).size).toBe(0);
  });

  it('undoing a drop goes through the drop path: the task moves back to its list', async () => {
    const { doc, maps, um } = laidOut();
    const nodes = readBoard(doc).nodes;
    const c1 = nodes.find((n) => refOf(n) === 'card:c1')!, d1 = nodes.find((n) => refOf(n) === 'deck:d1')!, d2 = nodes.find((n) => refOf(n) === 'deck:d2')!;
    doc.transact(() => maps.nodes.get(c1.id)!.set('pos', { ...c1.pos, x: d2.pos.x + 20, y: d2.pos.y + 40, parent: d2.id }), LOCAL);
    const moved = state({ cards: new Map([card('c1', 'd2'), card('c2', 'd1'), card('c3', 'd2'), hostCard].map((c) => [c.id, c])) });
    const before = readBoard(doc).nodes;
    um.undo();
    const changes = parentChanges(before, readBoard(doc).nodes);
    expect(changes.map((c) => [c.node.id, c.parent?.id, c.was.pos.parent])).toEqual([[c1.id, d1.id, d2.id]]);
    const dispatch = vi.fn(() => Promise.resolve({}));
    const holds = new Holds();
    expect(await saveDrop(changes[0].node, changes[0].parent, moved, 'p1', HOST, { holds, dispatch, revert: () => {} })).toEqual({ kind: 'move-task', cardId: 'c1', deckId: 'd1' });
    expect(dispatch).toHaveBeenCalledWith('cards', 'update', { id: 'c1', deckId: 'd1', parentCardId: null });
    um.destroy();
  });
});

describe('fix round 2: refused drops and undo, group drops, list move undo', () => {
  it('a refused drop goes back outside the undo history: undoing the drop sends nothing, earlier steps stay', async () => {
    const { doc, maps, um } = laidOut();
    const header = readBoard(doc).nodes.find((n) => refOf(n) === 'project:p1')!;
    doc.transact(() => maps.nodes.get(header.id)!.set('pos', { ...header.pos, x: header.pos.x + 40 }), LOCAL);
    const nodes = readBoard(doc).nodes;
    const c1 = nodes.find((n) => refOf(n) === 'card:c1')!, d2 = nodes.find((n) => refOf(n) === 'deck:d2')!;
    const dropped = { ...c1.pos, x: d2.pos.x + 20, y: d2.pos.y + 40, parent: d2.id };
    doc.transact(() => maps.nodes.get(c1.id)!.set('pos', dropped), LOCAL);
    const holds = new Holds();
    const seen: unknown[] = [];
    const watched = new Holds();
    const stop = watchRemoteDrops(doc, watched);
    const refusing = vi.fn((...a: unknown[]) => { seen.push(a); return Promise.reject(new Error('no')); });
    expect(await saveDrop({ ...c1, pos: dropped }, d2, state(), 'p1', HOST, { holds, dispatch: refusing, revert: () => moveBackSync(doc, c1.id, c1.pos) })).toBeNull();
    expect(cardsOf(doc, 'c1')[0].pos).toEqual(c1.pos);
    expect(watched.size).toBe(0); // the put-back is not taken for another client's drop
    expect(um.undoStack).toHaveLength(3); // layout, header, the drop: the put-back is no step
    // The drop's step changes nothing any more (Yjs skips such a step): one undo takes back the user's step before it.
    const before = readBoard(doc).nodes;
    um.undo();
    expect(parentChanges(before, readBoard(doc).nodes)).toEqual([]); // nothing to send
    expect(cardsOf(doc, 'c1')[0].pos).toEqual(c1.pos);
    expect(readBoard(doc).nodes.find((n) => n.id === header.id)!.pos.x).toBe(header.pos.x);
    expect(um.undoStack).toHaveLength(1); // the layout is still there to undo
    expect(um.canRedo()).toBe(true);
    expect(refusing).toHaveBeenCalledTimes(1);
    stop();
    um.destroy();
  });

  it('two picked cards dropped into another list frame both move their tasks', async () => {
    const many = [20, 21, 22, 23, 24, 25, 26].map((i) => card(`c${i}`, 'd2'));
    const all = [card('c1', 'd1'), card('c2', 'd1'), ...many];
    const doc = new Y.Doc();
    writePatch(doc, boardMaps(doc), layoutFrames(input({ cards: all }), { x: 0, y: 0 }), LOCAL, 'p1');
    const nodes = readBoard(doc).nodes;
    const at = (r: string) => nodes.find((n) => refOf(n) === r)!;
    const c1 = at('card:c1'), c2 = at('card:c2'), c26 = at('card:c26'), d2 = at('deck:d2');
    const s = state({ cards: new Map([...all, hostCard].map((c) => [c.id, c])) });
    // Into the free slots of d2's second row, keeping their spacing.
    const dx = c26.pos.x + (c2.pos.x - c1.pos.x) - c1.pos.x, dy = c26.pos.y - c1.pos.y;
    const plan = planMove(nodes, [c1.id, c2.id], c1.id, dx, dy, null, s, 'p1', HOST);
    expect(plan.changes.map((c) => [c.id, c.pos.parent])).toEqual([[c1.id, d2.id], [c2.id, d2.id]]);
    expect(plan.drops.map((d) => [d.node.id, d.parent?.id])).toEqual([[c1.id, d2.id], [c2.id, d2.id]]);
    const dispatch = vi.fn(() => Promise.resolve({}));
    const holds = new Holds();
    const done = await Promise.all(plan.drops.map((d) => saveDrop(d.node, d.parent, s, 'p1', HOST, { holds, dispatch, revert: () => {} })));
    expect(done).toEqual([{ kind: 'move-task', cardId: 'c1', deckId: 'd2' }, { kind: 'move-task', cardId: 'c2', deckId: 'd2' }]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(holds.current(s, 0)).toEqual(new Set([c1.id, c2.id]));
    // A single card nudged inside its own list: a position only.
    expect(planMove(nodes, [c1.id], c1.id, 0, 20, null, s, 'p1', HOST).drops).toEqual([]);
  });

  it('a list moved by a drop is one undo step: undo sends it back to its area, redo there again', () => {
    const { doc, um } = laidOut();
    const steps = um.undoStack.length;
    markListMove(doc, { deckId: 'd1', from: 1, to: 2 });
    expect(um.undoStack).toHaveLength(steps + 1);
    let before = readListMove(doc);
    um.undo();
    expect(listMoveToSend(before, readListMove(doc), false)).toEqual({ deckId: 'd1', spaceId: 1 });
    before = readListMove(doc);
    um.redo();
    expect(listMoveToSend(before, readListMove(doc), true)).toEqual({ deckId: 'd1', spaceId: 2 });
    // A step that is not a list move sends no list anywhere.
    expect(listMoveToSend(readListMove(doc), readListMove(doc), false)).toBeNull();
    um.destroy();
  });
});

describe('final review fixes', () => {
  const board = () => {
    const { doc, maps, um } = laidOut();
    const nodes = readBoard(doc).nodes;
    const byRef = (r: string) => nodes.find((n) => refOf(n) === r)!;
    return { doc, maps, um, nodes, byRef };
  };
  const line = (id: string, s: string, t: string, label?: string, kind?: 'dep' | 'sub') =>
    ({ id, value: { source: { nodeId: s, side: 'top' as const }, target: { nodeId: t, side: 'top' as const }, ...(kind ? { kind } : {}) }, ...(label ? { label } : {}) });
  const addLine = (doc: Y.Doc, e: ReturnType<typeof line>) => writePatch(doc, boardMaps(doc), { ...empty, addEdges: [e] }, LOCAL);

  it('a line the user only labelled "waits for" survives reconcile; one reconcile or the dialog marked goes when the project drops it', () => {
    const { doc, byRef } = board();
    const c1 = byRef('card:c1').id, c2 = byRef('card:c2').id, c3 = byRef('card:c3').id;
    addLine(doc, line('user', c1, c2, 'waits for')); // typed by the user: no dependency in the project
    addLine(doc, line('marked', c1, c3, 'waits for', 'dep')); // drawn for a dependency since removed
    writePatch(doc, boardMaps(doc), reconcile(fromDoc(doc)), SYNC);
    const ids = readBoard(doc).edges.map((e) => e.id);
    expect(ids).toContain('user');
    expect(ids).not.toContain('marked');
    expect(reconcile(fromDoc(doc))).toEqual(empty);
  });

  it('an older labelled line between two tasks with that dependency counts: kept once, and gets its kind', () => {
    const { doc, byRef } = board();
    const c1 = byRef('card:c1').id, c3 = byRef('card:c3').id;
    addLine(doc, line('old', c1, c3, 'waits for')); // from before kinds
    const withDep = { deps: [{ lockedCardId: 'c1', lockingCardId: 'c3' }] };
    const p = reconcile(fromDoc(doc, withDep));
    expect(p.addEdges).toEqual([]); // not drawn twice
    expect(p.updateEdges).toEqual([{ id: 'old', value: expect.objectContaining({ kind: 'dep' }) }]);
    writePatch(doc, boardMaps(doc), p, SYNC);
    expect(readBoard(doc).edges.find((e) => e.id === 'old')!.value.kind).toBe('dep');
    expect(reconcile(fromDoc(doc, withDep))).toEqual(empty);
  });

  it('dependencies off: an admin is offered to turn them on, which saves the setting and then the dependency; others see why not', async () => {
    const off = (role: string) => state({ account: { settings: { dependenciesEnabled: false } }, me: { id: 'u1' }, accountRoles: new Map([['u1', role]]) } as never);
    expect(depChoice(off('admin'), true)).toBe('turn-on');
    expect(depChoice(off('owner'), true)).toBe('turn-on');
    expect(depChoice(off('member'), true)).toBe('ask-admin');
    expect(ASK_ADMIN).toBe('An admin can turn on dependencies in Settings.');
    expect(depChoice(off('admin'), false)).toBe('hidden');
    expect(depChoice(state({ account: { settings: { dependenciesEnabled: true } }, accountRoles: new Map() } as never), true)).toBe('on');
    const calls: unknown[][] = [];
    const dispatch = vi.fn(async (...args: unknown[]) => { calls.push(args); return {}; });
    await saveLink('dep', 'c1', 'c3', off('admin'), dispatch, true);
    expect(calls).toEqual([
      ['accounts', 'update', { settings: { dependenciesEnabled: true } }],
      ['cards', 'update', { id: 'c1', inDeps: ['c3'] }],
    ]);
    // Refused setting: no dependency is sent.
    const refusing = vi.fn(async (ns: string) => { if (ns === 'accounts') throw new Error('forbidden'); return {}; });
    await expect(saveLink('dep', 'c1', 'c3', off('member'), refusing, true)).rejects.toThrow();
    expect(refusing).toHaveBeenCalledTimes(1);
  });

  it("a project board's frames and header can't be deleted; anything else can", () => {
    const { nodes, byRef } = board();
    const note = { id: 'n', type: 'text', value: { content: 'note' }, pos: { x: 0, y: 900, w: 80, h: 40, parent: null } } as const;
    const all = [...nodes, note];
    const ids = [byRef('deck:d1').id, byRef('area:p1:1').id, byRef('project:p1').id, byRef('card:c1').id, 'n'];
    expect(deletable(all, ids, true)).toEqual({ ok: [byRef('card:c1').id, 'n'], refused: true });
    expect(deletable(all, [byRef('card:c1').id], true)).toEqual({ ok: [byRef('card:c1').id], refused: false });
    expect(deletable(all, ids, false)).toEqual({ ok: ids, refused: false }); // any other board: they are only frames
    expect(FRAME_DELETE).toBe('Project frames follow the project; delete the list or area from the project instead.');
  });

  it('undoing the delete of a "waits for" or subtask line sends it again; redoing the delete takes it away again', () => {
    const deps = [{ lockedCardId: 'c1', lockingCardId: 'c3' }];
    const withSub = [card('c1', 'd1'), card('c2', 'd1', { parentCardId: 'c1' }), card('c3', 'd2')];
    const doc = new Y.Doc();
    const maps = boardMaps(doc);
    const um = boardUndo(maps);
    writePatch(doc, maps, layoutFrames(input({ deps, cards: withSub }), { x: 0, y: 0 }), LOCAL, 'p1');
    const dep = readBoard(doc).edges.find((e) => e.label === 'waits for')!, sub = readBoard(doc).edges.find((e) => e.label === 'subtask')!;
    const has = state({ cardDeps: new Map([['k', deps[0]]]), cards: new Map([...withSub, hostCard].map((c) => [c.id, c])) });
    expect(meaningOf(dep, readBoard(doc).nodes, has)).toEqual({ kind: 'dep', a: 'c1', b: 'c3' });
    expect(unlinkCall(meaningOf(dep, readBoard(doc).nodes, has)!, has)).toEqual({ ns: 'cards', action: 'update', payload: { id: 'c1', inDeps: [] } });
    // The user deletes both lines (and with them the dependency and the parent): the store no longer has them.
    for (const e of [dep, sub]) doc.transact(() => maps.edges.delete(e.id), LOCAL);
    const gone = state({ cards: new Map([...cards, hostCard].map((c) => [c.id, c])) });
    const step = (fn: () => void) => { const before = readBoard(doc); fn(); return edgeStepCalls(before, readBoard(doc), gone); };
    expect(step(() => um.undo())).toEqual([{ edgeId: sub.id, restored: true, kind: 'sub', a: 'c1', b: 'c2', call: { ns: 'cards', action: 'update', payload: { id: 'c2', parentCardId: 'c1' } } }]);
    expect(step(() => um.undo())).toEqual([{ edgeId: dep.id, restored: true, kind: 'dep', a: 'c1', b: 'c3', call: { ns: 'cards', action: 'update', payload: { id: 'c1', inDeps: ['c3'] } } }]);
    // Redo with the project as the undo left it (dependency back): the delete takes it away again.
    const before = readBoard(doc);
    um.redo();
    expect(edgeStepCalls(before, readBoard(doc), has)).toEqual([{ edgeId: dep.id, restored: false, kind: 'dep', a: 'c1', b: 'c3', call: { ns: 'cards', action: 'update', payload: { id: 'c1', inDeps: [] } } }]);
    // A step that adds or removes the cards themselves (undoing the layout) sends nothing.
    um.redo(); um.undo(); um.undo();
    const all = readBoard(doc);
    um.undo();
    expect(edgeStepCalls(all, readBoard(doc), has)).toEqual([]);
    um.destroy();
  });

  it('a held line (an undone delete being sent again) is not removed by the board meanwhile', () => {
    const p = { ...empty, removeEdges: ['e1', 'e2'], move: [{ id: 'n', pos: { x: 0, y: 0, w: 1, h: 1, parent: null } }] };
    expect(withoutMoves(p, new Set(['e1'])).removeEdges).toEqual(['e2']);
  });

  it('not connected: a drop into another list goes back with a message and sends nothing; a list over another area stays', async () => {
    const { byRef, nodes } = board();
    const c1 = byRef('card:c1'), d2 = byRef('deck:d2');
    const dispatch = vi.fn(() => Promise.resolve({}));
    const revert = vi.fn(), offline = vi.fn();
    const holds = new Holds();
    const down = state({ live: false });
    expect(await saveDrop(c1, d2, down, 'p1', HOST, { holds, dispatch, revert, offline })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(OFFLINE_DROP).toBe('Not connected right now: the task stays where it is in the project.');
    // A drop inside its own list is a position only, connected or not.
    expect(await saveDrop(c1, byRef('deck:d1'), down, 'p1', HOST, { holds, dispatch, revert, offline })).toBeNull();
    expect(revert).toHaveBeenCalledTimes(1);
    // A list frame let go over the other area: not written, not moved.
    const area2 = byRef('area:p1:2').pos, d1 = byRef('deck:d1');
    const at = { x: area2.x + 10, y: area2.y + area2.h - 10 };
    expect(listDrop(d1, d1.pos, at, nodes, down, 'p1', HOST)).toEqual({ kind: 'offline' });
    const plan = planMove(nodes, [d1.id], d1.id, at.x - d1.pos.x, at.y - d1.pos.y, at, down, 'p1', HOST);
    expect(plan).toMatchObject({ offline: true, lists: [], changes: [] });
  });
});

import { describe, it, expect } from 'vitest';
import { planProjectTree, refOf, SUBTASK, WAITS_FOR } from '../web/src/board/projectTree';
import type { Card, Deck, Project } from '../shared/types';

const project = { id: 'p1', name: 'Game', spaces: [{ id: 1, name: 'World' }, { id: 2, name: 'Combat' }, { id: 3, name: 'Empty' }] } as unknown as Project;
const deck = (id: string, spaceId: number, sortIndex: number) => ({ id, spaceId, sortIndex, title: `List ${id}` }) as unknown as Deck;
const card = (id: string, deckId: string, extra: Partial<Card> = {}) => ({ id, deckId, seq: Number(id.slice(1)), sortIndex: Number(id.slice(1)), parentCardId: null, ...extra }) as unknown as Card;
const decks = [deck('d1', 1, 0), deck('d2', 2, 0)];
const cards = [card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd1', { parentCardId: 'c1' }), card('c4', 'd2')];
const base = { project, decks, deps: [{ lockedCardId: 'c4', lockingCardId: 'c2' }], areaName: (id: number) => project.spaces.find((s) => s.id === id)!.name ?? '' };

describe('planProjectTree', () => {
  const first = planProjectTree({ ...base, cards, nodes: [], edges: [] });
  it('lays out project, areas with lists, lists and open tasks', () => {
    expect(first.nodes.map(refOf).sort()).toEqual(['area:p1:1', 'area:p1:2', 'card:c1', 'card:c2', 'card:c3', 'card:c4', 'deck:d1', 'deck:d2', 'project:p1']);
    const id = (ref: string) => first.nodes.find((n) => refOf(n) === ref)!.id;
    const has = (a: string, b: string, label?: string) => first.edges.some((e) => e.value.source.nodeId === id(a) && e.value.target.nodeId === id(b) && e.label === label);
    expect(has('project:p1', 'area:p1:1')).toBe(true);
    expect(has('area:p1:2', 'deck:d2')).toBe(true);
    expect(has('deck:d1', 'card:c1')).toBe(true);
    expect(has('card:c1', 'card:c3', SUBTASK)).toBe(true);   // a subtask hangs off its parent,
    expect(has('deck:d1', 'card:c3')).toBe(false);           // not off the list
    expect(has('card:c4', 'card:c2', WAITS_FOR)).toBe(true);
    expect(first.edges).toHaveLength(9);
    // no two nodes overlap
    const hit = first.nodes.some((a, i) => first.nodes.some((b, j) => i < j && a.pos.x < b.pos.x + b.pos.w && b.pos.x < a.pos.x + a.pos.w && a.pos.y < b.pos.y + b.pos.h && b.pos.y < a.pos.y + a.pos.h));
    expect(hit).toBe(false);
  });
  it('run again: nothing new; after a new task: one node and one line, the rest untouched', () => {
    expect(planProjectTree({ ...base, cards, nodes: first.nodes, edges: first.edges })).toEqual({ nodes: [], edges: [] });
    const more = planProjectTree({ ...base, cards: [...cards, card('c5', 'd2')], nodes: first.nodes, edges: first.edges });
    expect(more.nodes.map(refOf)).toEqual(['card:c5']);
    expect(more.edges).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { CARD_H, CARD_W, fitView, layoutKey, MAX_CARDS_PER_KIND, pickCards, pillSize, treeLayout, webLayout, type Box } from '../web/src/homeLayout';
import type { HomeNode, NodeKind } from '../web/src/homeModel';
import { readHomePrefs } from '../web/src/homePrefs';

// Home's layouts (web/src/homeLayout.ts): the Web view keeps each node at its spot when free, else the nearest free
// spot (cards never overlap anything); Tree View is project → areas → lists → quests, quest cards three across.
const node = (id: string, kind: NodeKind, x: number, y: number, parent: string | null = null, label = id): HomeNode =>
  ({ id, kind, label, href: '', parent, x, y, projectId: 'p' });
const GAP = 12;
function overlaps(pos: Map<string, Box>): string[] {
  const all = [...pos.entries()];
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const [ia, a] = all[i], [ib, b] = all[j];
    if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) out.push(`${ia}/${ib}`);
  }
  return out;
}
/** A web like the model's: projects, areas around them, lists around those, quests around those, many of them crowded. */
function bigWeb(n: number): HomeNode[] {
  const out: HomeNode[] = [];
  let k = 0;
  while (out.length < n) {
    const px = (k % 4) * 900, py = Math.floor(k / 4) * 700, pid = `p${k++}`;
    out.push(node(pid, 'proj', px, py, null, `Project ${k}`));
    for (let a = 0; a < 4 && out.length < n; a++) {
      const ax = px + 190 * Math.cos(a * 1.57), ay = py + 190 * Math.sin(a * 1.57), aid = `${pid}a${a}`;
      out.push(node(aid, 'area', ax, ay, pid, `Area ${a}`));
      for (let l = 0; l < 4 && out.length < n; l++) {
        const lx = ax + 150 * Math.cos(a * 1.57 + l * .4), ly = ay + 150 * Math.sin(a * 1.57 + l * .4), lid = `${aid}l${l}`;
        out.push(node(lid, 'list', lx, ly, aid, `A list called ${l}`));
        for (let q = 0; q < 8 && out.length < n; q++) out.push(node(`${lid}q${q}`, 'quest', lx + 80 * Math.cos(q), ly + 80 * Math.sin(q), lid, `Quest number ${q} of the list`));
      }
    }
  }
  return out;
}

describe('the Web layout', () => {
  it('web layout: a free seed is kept', () => {
    const { pos } = webLayout([node('a', 'proj', 0, 0), node('b', 'list', 500, 300)], () => false);
    expect(pos.get('a')).toMatchObject({ x: 0, y: 0 });
    expect(pos.get('b')).toMatchObject({ x: 500, y: 300 });
  });

  it('a crowded pill moves to a spot near its seed', () => {
    const { pos } = webLayout([node('a', 'proj', 0, 0), node('b', 'list', 5, 5)], () => false);
    const b = pos.get('b')!;
    expect(overlaps(pos)).toEqual([]);
    expect(Math.hypot(b.x - 5, b.y - 5)).toBeLessThan(120);
  });

  it('web layout: no two boxes overlap, 600 nodes under 250 ms', () => {
    const nodes = bigWeb(600);
    webLayout(bigWeb(100), () => false); // warm up
    const t0 = performance.now();
    const { pos } = webLayout(nodes, () => false);
    const ms = performance.now() - t0;
    expect(pos.size).toBe(600);
    expect(overlaps(pos)).toEqual([]);
    expect(ms).toBeLessThan(250); // about 60 ms alone; the bound leaves room for a busy test run
  });

  it('web layout: cards on keep every box apart', () => {
    const nodes = bigWeb(220);
    const { pos } = webLayout(nodes, () => true);
    expect(overlaps(pos)).toEqual([]);
    expect(pos.get(nodes[0].id)).toMatchObject({ w: CARD_W, h: CARD_H });
  });

  it('cards come first: a card keeps its seed, the pill on it moves away', () => {
    const { pos } = webLayout([node('q', 'quest', 0, 0), node('l', 'list', 0, 0)], (n) => n.kind === 'list');
    expect(pos.get('l')).toMatchObject({ x: 0, y: 0 });
    expect(overlaps(pos)).toEqual([]);
  });
});

describe('nodes moved by hand (Web view)', () => {
  it('a moved node stays exactly where it was put; one it lands on makes room', () => {
    const { pos } = webLayout([node('a', 'proj', 0, 0), node('b', 'list', 500, 300)], () => false, { b: [3, 2] });
    expect(pos.get('b')).toMatchObject({ x: 3, y: 2 });
    expect(pos.get('a')).not.toMatchObject({ x: 0, y: 0 });
    expect(overlaps(pos)).toEqual([]);
  });

  it('the per-person spots of before the shared Home board are ignored', () => {
    expect(readHomePrefs({ moved: { a: [1, 2] } })).not.toHaveProperty('moved');
  });
});

describe('Tree View', () => {
  const tree = [
    node('p', 'proj', 0, 0), node('a', 'area', 0, 0, 'p'), node('l', 'list', 0, 0, 'a'),
    ...Array.from({ length: 7 }, (_, i) => node(`q${i}`, 'quest', 0, 0, 'l', `Quest ${i}`)),
    node('l2', 'list', 0, 0, 'a'),
  ];

  it('tree: quest cards three across, parent centred', () => {
    const { pos } = treeLayout(tree, (n) => n.kind === 'quest');
    const q = (i: number) => pos.get(`q${i}`)!;
    expect(q(0).y).toBe(q(1).y);
    expect(q(0).y).toBe(q(2).y);
    expect(q(3).y).toBeGreaterThan(q(0).y);
    expect(q(3).x).toBe(q(0).x);
    expect(q(6).y).toBeGreaterThan(q(3).y); // three rows for seven
    const l = pos.get('l')!;
    expect(l.y).toBeCloseTo((q(0).y + q(6).y) / 2);
    expect(pos.get('a')!.x).toBeLessThan(l.x);
    expect(l.x).toBeLessThan(q(0).x);
    expect(overlaps(pos)).toEqual([]);
  });

  it('tree: pills, no overlap', () => {
    const { pos, bounds } = treeLayout(tree, () => false);
    expect(overlaps(pos)).toEqual([]);
    expect(bounds.w).toBeGreaterThan(0);
    // a project without areas: its lists sit in the list column
    const flat = treeLayout([node('p', 'proj', 0, 0), node('l', 'list', 0, 0, 'p')], () => false);
    expect(flat.pos.get('l')!.x).toBeGreaterThan(flat.pos.get('p')!.x);
  });

  it('pills are sized by their words', () => {
    const [w1] = pillSize(node('a', 'list', 0, 0, null, 'Short'));
    const [w2] = pillSize(node('b', 'list', 0, 0, null, 'A much longer list name here'));
    expect(w2).toBeGreaterThan(w1);
    expect(pillSize(node('c', 'list', 0, 0, null, 'x'.repeat(200)))[0]).toBeLessThanOrEqual(300);
  });
});

describe('fitting the view', () => {
  it('fitView clamps and centres', () => {
    const small = fitView({ x: 100, y: 100, w: 200, h: 100 }, { w: 1200, h: 800, left: 400, top: 30 }, false);
    expect(small.scale).toBe(1);
    // the centre of the content lands in the middle of the free space
    expect(100 * small.scale + small.x).toBeCloseTo(400 + (1200 - 400 - 80) / 2);
    const huge = fitView({ x: 0, y: 0, w: 20000, h: 20000 }, { w: 1200, h: 800, left: 70, top: 30 }, false);
    expect(huge.scale).toBe(0.7);
    // too big in the Web view: it starts beside the welcome column, the anchor (the first project) centred up and down
    const anchored = fitView({ x: 0, y: 0, w: 20000, h: 20000 }, { w: 1200, h: 800, left: 70, top: 30 }, false, { y: -2000 });
    expect(-10000 * anchored.scale + anchored.x).toBeCloseTo(70);
    expect(-2000 * anchored.scale + anchored.y).toBeCloseTo(30 + (800 - 30 - 50) / 2);
    // never past the content's own edge
    const edge = fitView({ x: 0, y: 0, w: 4000, h: 4000 }, { w: 1200, h: 800, left: 70, top: 30 }, false, { y: -1990 });
    expect(-2000 * edge.scale + edge.y).toBeCloseTo(30);
    const tree = fitView({ x: 0, y: 0, w: 20000, h: 20000 }, { w: 1200, h: 800, left: 70, top: 30 }, true);
    expect(tree.scale).toBe(0.7);
    // too big to fit: its top-left corner shows first
    expect(-10000 * tree.scale + tree.x).toBeCloseTo(70);
    expect(-10000 * tree.scale + tree.y).toBeCloseTo(30);
  });
});

describe('keeping it cheap', () => {
  it('"All" stays bounded: the first cards of each kind are cards, the rest stay pills', () => {
    const nodes = [node('p', 'proj', 0, 0), ...Array.from({ length: 300 }, (_, i) => node(`q${i}`, 'quest', 0, 0, 'p')), node('m', 'more', 0, 0, 'p')];
    const cards = pickCards(nodes, ['proj', 'quest']);
    expect(cards.has('p')).toBe(true);
    expect(cards.has('q0')).toBe(true);
    expect(cards.has(`q${MAX_CARDS_PER_KIND - 1}`)).toBe(true);
    expect(cards.has(`q${MAX_CARDS_PER_KIND}`)).toBe(false);
    expect(cards.has('m')).toBe(false); // "+N more" is always a pill
    expect(pickCards(nodes, []).size).toBe(0);
  });

  it('a live change that moves nothing keeps the layout key, so the layout does not run again', () => {
    const base = [node('p', 'proj', 0, 0), node('l', 'list', 10, 10, 'p', 'Creatures'), node('q', 'quest', 20, 20, 'l', 'Taming')];
    const cards = new Set<string>();
    const key = layoutKey(base, cards, false);
    // a teammate types in a task, finishes it, changes its words below the title: same nodes, same places
    const edited = base.map((n) => (n.id === 'q' ? { ...n, status: 'done' as const, text: 'New words', effort: 5 } : n.id === 'l' ? { ...n, done: 1 } : n));
    expect(layoutKey(edited, cards, false)).toBe(key);
    // something that moves things does change it: a new quest, a renamed list, a card, the other view
    expect(layoutKey([...base, node('q2', 'quest', 30, 30, 'l')], cards, false)).not.toBe(key);
    expect(layoutKey(base.map((n) => (n.id === 'l' ? { ...n, label: 'A much longer list name' } : n)), cards, false)).not.toBe(key);
    expect(layoutKey(base, new Set(['q']), false)).not.toBe(key);
    expect(layoutKey(base, cards, true)).not.toBe(key);
  });
});

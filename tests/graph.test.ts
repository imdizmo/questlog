import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_GRAPH_MAX, campaignGraph, clusterByType, clusterId, defaultIterations, ENTRY_GRAPH_MAX, labelRank, layout, neighbours, nodeToward,
  type GraphData, type GraphEdgeIn,
} from '../shared/graph';

const node = (id: string, typeId: string | null = 'place', label = id) => ({ id, label, typeId });
const link = (from: string, to: string, key = 'located_in', label = 'located in'): GraphEdgeIn => ({ from, to, kind: 'link', key, label });

function world(): GraphData {
  return {
    nodes: [node('emberfall', 'place', 'Emberfall'), node('keep', 'place', 'Ashen Keep'), node('mira', 'npc', 'Mira'), node('sword', 'item', 'Fire Sword'), node('roads', null, 'Old Roads'), node('far', 'place', 'Cinder Vale')],
    edges: [
      link('keep', 'emberfall'),
      link('keep', 'emberfall'), // the same link twice: once
      { from: 'emberfall', to: 'keep', kind: 'mention', label: 'mentions' },
      { from: 'mira', to: 'emberfall', kind: 'field', key: 'home', label: 'Character: Home' },
      { from: 'sword', to: 'mira', kind: 'link', key: 'owns', label: 'owned by' },
      { from: 'roads', to: 'sword', kind: 'mention', label: 'mentions' },
      { from: 'roads', to: 'roads', kind: 'mention', label: 'mentions' }, // self: dropped
      { from: 'roads', to: 'ghost', kind: 'mention', label: 'mentions' }, // unknown node: dropped
    ],
  };
}

/** A campaign of `n` entries over `types` types: a ring, plus a few chords so it isn't a plain circle. */
function big(n: number, types = 6): GraphData {
  const nodes = Array.from({ length: n }, (_, i) => node(`e${String(i).padStart(5, '0')}`, `t${i % types}`, `Entry ${i}`));
  const edges: GraphEdgeIn[] = [];
  for (let i = 0; i < n; i++) {
    edges.push(link(nodes[i].id, nodes[(i + 1) % n].id));
    if (i % 3 === 0) edges.push({ from: nodes[i].id, to: nodes[(i * 7 + 11) % n].id, kind: 'mention', label: 'mentions' });
    if (i % 5 === 0) edges.push({ from: nodes[i].id, to: nodes[0].id, kind: 'field', key: 'f', label: 'T: field' });
  }
  return { nodes, edges };
}

describe('neighbours', () => {
  it('one step: the entry and what touches it, relations deduplicated by kind and key', () => {
    const g = neighbours('emberfall', world(), 1);
    expect(g.centerId).toBe('emberfall');
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['emberfall', 'keep', 'mira']);
    expect(g.nodes.find((n) => n.id === 'emberfall')!.depth).toBe(0);
    const keepEdge = g.edges.find((e) => e.source === 'emberfall' && e.target === 'keep')!;
    expect(keepEdge.relations).toEqual([{ kind: 'link', key: 'located_in', label: 'located in' }, { kind: 'mention', label: 'mentions' }]);
    expect(keepEdge.weight).toBe(2);
    expect(g.edges.map((e) => e.relations[0].kind).sort()).toEqual(['field', 'link']);
    expect(g.dropped).toBe(0);
  });

  it('a new connection outside the shown nodes changes a degree but not the shown ids and edges (the layout key)', () => {
    const a = world();
    const b: GraphData = { nodes: [...a.nodes, node('extra')], edges: [...a.edges, link('emberfall', 'extra')] };
    const ga = neighbours('keep', a, 1), gb = neighbours('keep', b, 1);
    expect(gb.nodes.find((n) => n.id === 'emberfall')!.degree).toBe(ga.nodes.find((n) => n.id === 'emberfall')!.degree + 1);
    expect(gb.nodes.map((n) => n.id)).toEqual(ga.nodes.map((n) => n.id));
    expect(gb.edges).toEqual(ga.edges);
  });

  it('two steps reach the neighbours of neighbours; self and unknown edges never show', () => {
    const g = neighbours('emberfall', world(), 2);
    expect(g.nodes.map((n) => [n.id, n.depth]).sort()).toEqual([['emberfall', 0], ['keep', 1], ['mira', 1], ['sword', 2]]);
    expect(neighbours('roads', world(), 1).edges).toHaveLength(1);
    expect(neighbours('nobody', world(), 1).nodes).toEqual([]);
    expect(neighbours('far', world(), 2)).toMatchObject({ nodes: [{ id: 'far', degree: 0 }], edges: [] });
  });

  it('caps at 60 nodes, keeping the strongest first-step neighbours and only second-step ones still attached', () => {
    const nodes = [node('hub'), ...Array.from({ length: 80 }, (_, i) => node(`n${i}`)), node('rich'), node('leaf')];
    const edges: GraphEdgeIn[] = nodes.slice(1, 81).map((n) => link('hub', n.id));
    // n5 and n7 have extra neighbours, so they are stronger and kept.
    for (let i = 0; i < 4; i++) edges.push(link('n5', `n${20 + i}`), link('n7', `n${40 + i}`));
    edges.push(link('hub', 'rich'), link('rich', 'leaf'));
    const data = { nodes, edges };
    const g = neighbours('hub', data, 2);
    expect(g.nodes).toHaveLength(ENTRY_GRAPH_MAX);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('hub') && ids.has('n5') && ids.has('n7') && ids.has('rich')).toBe(true);
    expect(g.dropped).toBe(83 - ENTRY_GRAPH_MAX);
    // Every kept second-step node hangs on a kept first-step node.
    for (const n of g.nodes.filter((x) => x.depth === 2)) expect(g.edges.some((e) => (e.source === n.id || e.target === n.id))).toBe(true);
    expect(g.nodes.every((n) => n.depth <= 1)).toBe(true); // 81 first-step neighbours already fill the 60
  });

  it('is the same for the same data, whatever order it came in', () => {
    const a = world();
    const b: GraphData = { nodes: [...a.nodes].reverse(), edges: [...a.edges].reverse() };
    const ga = neighbours('emberfall', a, 2), gb = neighbours('emberfall', b, 2);
    expect(gb.edges.map((e) => e.id)).toEqual(ga.edges.map((e) => e.id));
    expect([...layout(gb).pos].sort()).toEqual([...layout(ga).pos].sort());
  });
});

describe('campaign graph and clusters', () => {
  it('filters by type and caps at 2 000 strongest', () => {
    const g = campaignGraph(world(), (t) => t !== 'item');
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['emberfall', 'far', 'keep', 'mira', 'roads']);
    expect(g.edges.every((e) => e.source !== 'sword' && e.target !== 'sword')).toBe(true);
    const huge = campaignGraph(big(2500));
    expect(huge.nodes).toHaveLength(CAMPAIGN_GRAPH_MAX);
    expect(huge.dropped).toBe(500);
    expect(huge.nodes.some((n) => n.id === 'e00000')).toBe(true); // the best-connected one is kept
  });

  it('clusters by type above 50 nodes; a cluster expands on request; edges add up', () => {
    const g = campaignGraph(big(120, 4));
    expect(clusterByType(campaignGraph(big(50, 4)), new Set(), (t, c) => `${t} (${c})`).nodes).toHaveLength(50);
    const c = clusterByType(g, new Set(), (t, n) => `${t} (${n})`);
    expect(c.nodes.map((n) => n.id).sort()).toEqual([clusterId('t0'), clusterId('t1'), clusterId('t2'), clusterId('t3')]);
    expect(c.nodes.find((n) => n.id === clusterId('t0'))).toMatchObject({ label: 't0 (30)', cluster: { typeId: 't0', count: 30 } });
    expect(c.edges.reduce((s, e) => s + e.weight, 0)).toBeGreaterThan(c.edges.length);
    expect(c.edges.every((e) => e.source !== e.target)).toBe(true);
    const open = clusterByType(g, new Set(['t1']), (t, n) => `${t} (${n})`);
    expect(open.nodes).toHaveLength(3 + 30);
    expect(open.nodes.filter((n) => n.typeId === 't1').every((n) => !n.cluster)).toBe(true);
  });
});

describe('layout', () => {
  it('pins the centre, keeps nodes apart, and gives the same positions every time', () => {
    const g = neighbours('emberfall', world(), 2);
    const a = layout(g), b = layout(g);
    expect(a.pos.get('emberfall')).toEqual({ x: 0, y: 0 });
    expect([...a.pos]).toEqual([...b.pos]);
    const pts = [...a.pos.values()];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(20);
    // Another seed turns the start; still deterministic.
    expect([...layout(g, { seed: 3 }).pos]).toEqual([...layout(g, { seed: 3 }).pos]);
    expect([...layout(g, { seed: 3 }).pos]).not.toEqual([...a.pos]);
  });

  it('never runs more than 300 iterations, and big graphs get fewer by default', () => {
    expect(defaultIterations(60)).toBe(300);
    expect(defaultIterations(2000)).toBeLessThan(120);
    const g = neighbours('emberfall', world(), 2);
    expect([...layout(g, { iterations: 5000 }).pos]).toEqual([...layout(g, { iterations: 300 }).pos]);
  });

  it('linked nodes end up closer than unlinked ones', () => {
    const g = campaignGraph(big(40, 2));
    const { pos } = layout(g);
    const d = (a: string, b: string) => Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y);
    let linked = 0;
    for (const e of g.edges) linked += d(e.source, e.target);
    linked /= g.edges.length;
    let all = 0, count = 0;
    for (const a of g.nodes) for (const b of g.nodes) if (a.id < b.id) { all += d(a.id, b.id); count++; }
    expect(linked).toBeLessThan((all / count) * 0.6);
  });

  it('timing: 60 nodes and 2 000 nodes', () => {
    const median = (f: () => void, runs: number) => {
      const t: number[] = [];
      for (let i = 0; i < runs; i++) { const s = performance.now(); f(); t.push(performance.now() - s); }
      return t.sort((a, b) => a - b)[Math.floor(runs / 2)];
    };
    const ring = big(59);
    const sixty = neighbours('hub', { nodes: [node('hub'), ...ring.nodes], edges: [...ring.nodes.map((n) => link('hub', n.id)), ...ring.edges] }, 1);
    expect(sixty.nodes).toHaveLength(60);
    const g2000 = campaignGraph(big(2000));
    const t60 = median(() => layout(sixty, { iterations: 300 }), 9);
    const t2000 = median(() => layout(g2000), 3);
    const t2000full = median(() => layout(g2000, { iterations: 300 }), 1);
    console.log(`layout timing: 60 nodes × 300 it ${t60.toFixed(2)} ms; 2 000 nodes × ${defaultIterations(2000)} it ${t2000.toFixed(1)} ms; 2 000 × 300 it ${t2000full.toFixed(1)} ms`);
    expect(t60).toBeLessThan(50);
    expect(t2000).toBeLessThan(2000);
  });
});

describe('keyboard helpers', () => {
  it('labels rank the centre first, then degree; arrows prefer neighbours in that direction', () => {
    const g = neighbours('emberfall', world(), 2);
    expect(labelRank(g)[0]).toBe('emberfall');
    const pos = new Map([['emberfall', { x: 0, y: 0 }], ['keep', { x: 100, y: 0 }], ['mira', { x: -100, y: 5 }], ['sword', { x: 40, y: 0 }]]);
    // Sword is nearer to the right, but keep is a neighbour of emberfall.
    expect(nodeToward(g, pos, 'emberfall', 1, 0)).toBe('keep');
    expect(nodeToward(g, pos, 'emberfall', -1, 0)).toBe('mira');
    expect(nodeToward(g, pos, 'emberfall', 0, -1)).toBeNull();
    // From mira (neighbours: emberfall, sword): right goes to emberfall, the nearest neighbour that way.
    expect(nodeToward(g, pos, 'mira', 1, 0)).toBe('emberfall');
  });
});

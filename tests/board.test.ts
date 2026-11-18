import { describe, it, expect } from 'vitest';
import {
  COLORS, DEFAULT_SIZE, GRID, NODE_TYPES, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  adoptAfterResize, autoSides, containerAt, edgePath, filterSize, imageSize, newId, newNodeAt,
  nearestSide, nodesToDelete, parseYouTube, smartAggregate, snap, spotBeside,
  type BoardEdge, type BoardNode,
} from '../shared/board';

const node = (id: string, x: number, y: number, w: number, h: number, parent: string | null = null, type: BoardNode['type'] = 'container'): BoardNode =>
  ({ id, type, value: {}, pos: { x, y, w, h, parent } });
const edge = (id: string, a: string, b: string): BoardEdge =>
  ({ id, value: { source: { nodeId: a, side: 'right' }, target: { nodeId: b, side: 'left' } } });

describe('constants', () => {
  it('match the observed model', () => {
    expect(GRID).toBe(20);
    expect([ZOOM_STEP, ZOOM_MIN, ZOOM_MAX]).toEqual([0.1, 0.2, 3]);
    expect(COLORS).toEqual(['green', 'blue', 'pink', 'orange', 'purple', 'grey']);
    expect(NODE_TYPES).toEqual(['text', 'card', 'container', 'filter', 'image', 'video']);
    expect(DEFAULT_SIZE.text).toEqual({ w: 160, h: 40 });
    expect(DEFAULT_SIZE.card).toEqual({ w: 120, h: 160 });
    expect(DEFAULT_SIZE.container).toEqual({ w: 200, h: 100 });
    expect(DEFAULT_SIZE.video).toEqual({ w: 320, h: 180 });
  });
});

describe('sizes', () => {
  it('image keeps natural size up to 400 on the long side', () => {
    expect(imageSize(300, 200)).toEqual({ w: 300, h: 200 });
    expect(imageSize(800, 400)).toEqual({ w: 400, h: 200 });
    expect(imageSize(300, 1200)).toEqual({ w: 100, h: 400 });
    expect(imageSize(0, 0)).toEqual(DEFAULT_SIZE.image);
  });
  it('filter is 100x100, table mode 160x200', () => {
    expect(filterSize('horBar')).toEqual({ w: 100, h: 100 });
    expect(filterSize(undefined)).toEqual({ w: 100, h: 100 });
    expect(filterSize('table')).toEqual({ w: 160, h: 200 });
  });
});

describe('snap', () => {
  it('rounds to the 20 grid', () => {
    expect(snap(-210)).toBe(-200);
    expect(snap(209)).toBe(200);
    expect(snap(210)).toBe(220);
    expect(Object.is(snap(-5), 0)).toBe(true);
  });
});

describe('newNodeAt', () => {
  it('centres a text node on the click, then snaps', () => {
    const n = newNodeAt('text', { x: 0, y: 0 }, { content: 'hi' });
    expect(n.pos).toEqual({ x: -80, y: -20, w: 160, h: 40, parent: null });
    expect(n.type).toBe('text');
    expect(n.value).toEqual({ content: 'hi' });
    expect(n.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
  it('snaps an off-grid click', () => {
    expect(newNodeAt('container', { x: 105, y: 53 }, {}).pos).toMatchObject({ x: 0, y: 0, w: 200, h: 100 });
  });
  it('sizes image, filter and video from their value', () => {
    expect(newNodeAt('image', { x: 0, y: 0 }, { url: 'u', width: 800, height: 400 }).pos).toMatchObject({ w: 400, h: 200 });
    expect(newNodeAt('filter', { x: 0, y: 0 }, { mode: 'table' }).pos).toMatchObject({ w: 160, h: 200 });
    expect(newNodeAt('video', { x: 0, y: 0 }, { videoId: 'aqz-KE-bpKQ' }).pos).toMatchObject({ w: 320, h: 180 });
  });
});

describe('containerAt', () => {
  const outer = node('outer', 0, 0, 1000, 1000);
  const inner = node('inner', 100, 100, 300, 300, 'outer');
  const nodes = [outer, inner];
  it('picks the inner of two nested containers', () => {
    expect(containerAt(nodes, { x: 150, y: 150, w: 40, h: 40 })).toBe('inner');
  });
  it('falls back to the outer one when the rect pokes out of the inner', () => {
    expect(containerAt(nodes, { x: 350, y: 350, w: 100, h: 100 })).toBe('outer');
  });
  it('returns null outside every container, or when only partly inside', () => {
    expect(containerAt(nodes, { x: 2000, y: 0, w: 40, h: 40 })).toBeNull();
    expect(containerAt(nodes, { x: 980, y: 0, w: 40, h: 40 })).toBeNull();
  });
  it('ignores non-containers', () => {
    expect(containerAt([node('t', 0, 0, 500, 500, null, 'text')], { x: 10, y: 10, w: 20, h: 20 })).toBeNull();
  });
  it('excludes the node itself and its descendants', () => {
    expect(containerAt(nodes, { x: 150, y: 150, w: 40, h: 40 }, 'inner')).toBe('outer');
    expect(containerAt(nodes, { x: 150, y: 150, w: 40, h: 40 }, 'outer')).toBeNull();
  });
});

describe('adoptAfterResize', () => {
  it('includes a node exactly on the edge', () => {
    const c = node('c', 0, 0, 200, 200);
    const flush = node('a', 0, 0, 200, 200, null, 'text');
    expect(adoptAfterResize([c, flush], 'c')).toEqual(['a']);
  });
  it('skips partly-outside nodes, the container itself, and its ancestors', () => {
    const outer = node('outer', -100, -100, 600, 600);
    const c = node('c', 0, 0, 200, 200, 'outer');
    const out = node('out', 150, 150, 100, 100, null, 'text');
    const inside = node('in', 20, 20, 40, 40, null, 'text');
    expect(adoptAfterResize([outer, c, out, inside], 'c')).toEqual(['in']);
  });
  it('leaves nodes inside a nested container to that container', () => {
    const c = node('c', 0, 0, 400, 400);
    const inner = node('inner', 20, 20, 200, 200);
    const grand = node('grand', 40, 40, 20, 20, 'inner', 'text');
    const direct = node('direct', 300, 300, 20, 20, null, 'text');
    expect(adoptAfterResize([c, inner, grand, direct], 'c')).toEqual(['inner', 'direct']);
  });
  it('returns [] for an unknown container', () => {
    expect(adoptAfterResize([], 'nope')).toEqual([]);
  });
});

describe('nearestSide', () => {
  const r = { x: 0, y: 0, w: 200, h: 100 };
  it('picks the side facing the point', () => {
    expect(nearestSide(r, { x: 300, y: 50 })).toBe('right');
    expect(nearestSide(r, { x: -90, y: 50 })).toBe('left');
    expect(nearestSide(r, { x: 100, y: -80 })).toBe('top');
    expect(nearestSide(r, { x: 100, y: 190 })).toBe('bottom');
  });
  it('breaks ties top, right, bottom, left', () => {
    const sq = { x: 0, y: 0, w: 100, h: 100 };
    expect(nearestSide(sq, { x: 50, y: 50 })).toBe('top');
    expect(nearestSide(sq, { x: 100, y: 0 })).toBe('top');
    expect(nearestSide(sq, { x: 100, y: 100 })).toBe('right');
    expect(nearestSide(sq, { x: 0, y: 100 })).toBe('bottom');
  });
});

describe('edgePath', () => {
  it('draws a cubic with control points 0.4 x distance outward from each side', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 300, y: 0, w: 100, h: 100 };
    // anchors (100,50) and (300,50): distance 200 -> controls at +/-80 along the outward normal
    expect(edgePath({ rect: a, side: 'right' }, { rect: b, side: 'left' })).toBe('M 100 50 C 180 50, 220 50, 300 50');
  });
  it('handles vertical sides', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 0, y: 300, w: 100, h: 100 };
    expect(edgePath({ rect: a, side: 'bottom' }, { rect: b, side: 'top' })).toBe('M 50 100 C 50 180, 50 220, 50 300');
  });
});

describe('nodesToDelete', () => {
  it('removes edges both ways and unparents children', () => {
    const nodes = [node('c', 0, 0, 500, 500), node('k', 10, 10, 20, 20, 'c', 'text'), node('o', 900, 0, 20, 20, null, 'text')];
    const edges = [edge('e1', 'c', 'o'), edge('e2', 'o', 'c'), edge('e3', 'k', 'o')];
    expect(nodesToDelete(nodes, edges, 'c')).toEqual({ nodes: ['c'], edges: ['e1', 'e2'], unparent: ['k'] });
  });
});

describe('parseYouTube', () => {
  it('accepts the supported shapes', () => {
    expect(parseYouTube('aqz-KE-bpKQ')).toBe('aqz-KE-bpKQ');
    expect(parseYouTube('https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=3')).toBe('aqz-KE-bpKQ');
    expect(parseYouTube('https://youtu.be/aqz-KE-bpKQ?t=3')).toBe('aqz-KE-bpKQ');
    expect(parseYouTube('https://www.youtube.com/shorts/aqz-KE-bpKQ')).toBe('aqz-KE-bpKQ');
    expect(parseYouTube('  https://youtube.com/watch?v=aqz-KE-bpKQ ')).toBe('aqz-KE-bpKQ');
  });
  it('rejects everything else', () => {
    for (const bad of ['javascript:alert(1)', '', 'short', 'aqz-KE-bpKQx', 'https://evil.com/watch?v=aqz-KE-bpKQ',
      'https://youtube.com.evil.com/watch?v=aqz-KE-bpKQ', 'https://www.youtube.com/watch?v=bad', 'https://youtu.be/', 'ftp://youtu.be/aqz-KE-bpKQ'])
      expect(parseYouTube(bad), bad).toBeNull();
  });
});

describe('newId', () => {
  it('is 12 url-safe characters and varies', () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
});

describe('smartAggregate', () => {
  const cards = [
    { id: 1, status: 'done', effort: 3 }, { id: 2, status: 'done', effort: null },
    { id: 3, status: 'started', effort: 5 }, { id: 4, status: 'unassigned', effort: 2 },
  ];
  const agg = smartAggregate(cards, c => c.status === 'done', c => c.effort);
  it('pct counts done tasks over all', () => {
    expect(agg).toMatchObject({ total: 4, done: 2, pct: 50 });
  });
  it('groups by status with summed effort', () => {
    expect(agg.byStatus).toEqual({ done: { count: 2, effort: 3 }, started: { count: 1, effort: 5 }, unassigned: { count: 1, effort: 2 } });
  });
  it('groups by statusOf when given, and tolerates odd keys', () => {
    const derived = smartAggregate(cards, c => c.status === 'done', c => c.effort, c => (c.id === 1 ? 'hero' : c.id === 2 ? '__proto__' : 'other'));
    expect(Object.keys(derived.byStatus).sort()).toEqual(['__proto__', 'hero', 'other']);
    expect(derived.byStatus.hero).toEqual({ count: 1, effort: 3 });
    expect(derived.byStatus.other).toEqual({ count: 2, effort: 7 });
    expect(({} as any).count).toBeUndefined();
  });
  it('is 0% for no tasks', () => {
    const e = smartAggregate([] as { status: string }[], () => true, () => 1);
    expect([e.total, e.done, e.pct, Object.keys(e.byStatus)]).toEqual([0, 0, 0, []]);
  });
});

describe('spotBeside', () => {
  const anchor = { x: 100, y: 100, w: 100, h: 100 };
  it('goes one grid step to the right, level with the anchor', () => {
    expect(spotBeside([node('a', 100, 100, 100, 100)], anchor, { w: 120, h: 160 })).toEqual({ x: 220, y: 100 });
  });
  it('steps down past nodes already there, and never overlaps one', () => {
    const nodes = [node('a', 100, 100, 100, 100), node('b', 220, 100, 120, 160)];
    const at = spotBeside(nodes, anchor, { w: 120, h: 160 });
    expect(at).toEqual({ x: 220, y: 280 });
  });
});

describe('autoSides', () => {
  const r = (x: number, y: number, w = 120, h = 160) => ({ x, y, w, h });
  it('stacked (overlapping in x): the upper one\'s bottom to the lower one\'s top, either way round', () => {
    expect(autoSides(r(0, 0), r(40, 300))).toEqual({ from: 'bottom', to: 'top' });
    expect(autoSides(r(40, 300), r(0, 0))).toEqual({ from: 'top', to: 'bottom' });
    // Only just overlapping in x still counts as stacked; even overlapping rects pick by their centres.
    expect(autoSides(r(0, 0), r(119, 500))).toEqual({ from: 'bottom', to: 'top' });
    expect(autoSides(r(0, 0), r(0, 10))).toEqual({ from: 'bottom', to: 'top' });
  });
  it('side by side: the facing sides', () => {
    expect(autoSides(r(0, 0), r(300, 0))).toEqual({ from: 'right', to: 'left' });
    expect(autoSides(r(300, 0), r(0, 0))).toEqual({ from: 'left', to: 'right' });
    // Far below but not overlapping in x is still side by side.
    expect(autoSides(r(0, 0), r(120, 900))).toEqual({ from: 'right', to: 'left' });
    expect(autoSides(r(500, 900), r(0, 0))).toEqual({ from: 'left', to: 'right' });
  });
});

// The wiki graph: an entry's neighbourhood, the whole campaign, clusters by type, and a small deterministic force layout.
// Pure: no store, no DOM, no randomness. Same data in → same nodes, edges and positions out.

export type EdgeKind = 'link' | 'field' | 'mention';
/** One relation between two entries as the wiki knows it: a typed link (its kind key and label), an entry field, a mention. */
export interface Relation { kind: EdgeKind; key?: string; label: string }
export interface GraphNodeIn { id: string; label: string; typeId: string | null }
export interface GraphEdgeIn extends Relation { from: string; to: string }
/** A campaign's entries and the relations between them (direction kept in `from`/`to`, but the graph is undirected). */
export interface GraphData { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }

export interface GraphNode extends GraphNodeIn {
  /** Distinct neighbours in the whole data (a cluster: entries inside it). */
  degree: number;
  /** Steps from the centre entry (0 = the centre); 0 for every node of a campaign graph. */
  depth: number;
  /** A cluster stands for `count` entries of one type. */
  cluster?: { typeId: string | null; count: number };
}
export interface GraphEdge {
  id: string; source: string; target: string;
  /** Distinct relations between the two, deduplicated (same kind and key once). */
  relations: Relation[];
  /** Number of relations (a cluster edge: all of its members' relations). */
  weight: number;
}
export interface Graph {
  nodes: GraphNode[]; edges: GraphEdge[];
  centerId: string | null;
  /** Nodes left out by the cap. */
  dropped: number;
}

export const ENTRY_GRAPH_MAX = 60;
export const CAMPAIGN_GRAPH_MAX = 2000;
export const CLUSTER_ABOVE = 50;
export const MAX_ITERATIONS = 300;

// ---- Adjacency, built once per GraphData object ----

interface Adjacency {
  byId: Map<string, GraphNodeIn>;
  /** id → neighbour id → relations (deduplicated). */
  next: Map<string, Map<string, Relation[]>>;
}
const adjCache = new WeakMap<GraphData, Adjacency>();

const relKey = (r: Relation) => `${r.kind}\0${r.key ?? ''}\0${r.label}`;
const pairId = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function adjacency(data: GraphData): Adjacency {
  const hit = adjCache.get(data);
  if (hit) return hit;
  const byId = new Map<string, GraphNodeIn>();
  for (const n of data.nodes) byId.set(n.id, n);
  const next = new Map<string, Map<string, Relation[]>>();
  const seen = new Set<string>();
  const add = (a: string, b: string, r: Relation) => {
    let m = next.get(a);
    if (!m) next.set(a, (m = new Map()));
    const l = m.get(b);
    if (l) l.push(r); else m.set(b, [r]);
  };
  for (const e of data.edges) {
    if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) continue;
    const r: Relation = e.key === undefined ? { kind: e.kind, label: e.label } : { kind: e.kind, key: e.key, label: e.label };
    const k = `${pairId(e.from, e.to)}\0${relKey(r)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    add(e.from, e.to, r);
    add(e.to, e.from, r);
  }
  const out = { byId, next };
  adjCache.set(data, out);
  return out;
}

const degreeOf = (adj: Adjacency, id: string) => adj.next.get(id)?.size ?? 0;

/** Edges among `ids` (each pair once, source < target), in a stable order. */
function induced(adj: Adjacency, ids: Set<string>): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const a of [...ids].sort(byStr)) {
    const m = adj.next.get(a);
    if (!m) continue;
    for (const [b, relations] of m) {
      if (b <= a || !ids.has(b)) continue;
      out.push({ id: pairId(a, b), source: a, target: b, relations, weight: relations.length });
    }
  }
  return out.sort((x, y) => byStr(x.id, y.id));
}

/** Strongest first: more neighbours, then by label, then by id (stable). */
const stronger = (adj: Adjacency) => (a: string, b: string) =>
  degreeOf(adj, b) - degreeOf(adj, a) || byStr(adj.byId.get(a)!.label, adj.byId.get(b)!.label) || byStr(a, b);

/**
 * An entry and its neighbours one or two steps away, with every relation among them. Over `max` nodes (60), the
 * centre stays, then first-step neighbours strongest first (most neighbours), then second-step ones that still hang
 * on a kept first-step node.
 */
export function neighbours(entryId: string, data: GraphData, depth: 1 | 2 = 1, max = ENTRY_GRAPH_MAX): Graph {
  const adj = adjacency(data);
  if (!adj.byId.has(entryId)) return { nodes: [], edges: [], centerId: null, dropped: 0 };
  const cmp = stronger(adj);
  const first = [...(adj.next.get(entryId)?.keys() ?? [])].sort(cmp);
  const keep = new Set<string>([entryId]);
  const depthOf = new Map<string, number>([[entryId, 0]]);
  let total = 1 + first.length;
  for (const id of first) { if (keep.size >= max) break; keep.add(id); depthOf.set(id, 1); }
  if (depth === 2) {
    const firstSet = new Set(first);
    const second = new Set<string>();
    for (const id of first) for (const b of adj.next.get(id)?.keys() ?? []) if (b !== entryId && !firstSet.has(b)) second.add(b);
    total += second.size;
    // Only those still attached to a kept first-step node (dropping a neighbour drops what hangs only on it).
    const attached = [...second].filter((b) => [...adj.next.get(b)!.keys()].some((a) => depthOf.get(a) === 1)).sort(cmp);
    for (const id of attached) { if (keep.size >= max) break; keep.add(id); depthOf.set(id, 2); }
  }
  const nodes = [...keep].map((id) => ({ ...adj.byId.get(id)!, degree: degreeOf(adj, id), depth: depthOf.get(id)! }));
  return { nodes, edges: induced(adj, keep), centerId: entryId, dropped: total - keep.size };
}

/** Every entry whose type `keepType` accepts (all by default), strongest first past `max` (2 000). */
export function campaignGraph(data: GraphData, keepType: (typeId: string | null) => boolean = () => true, max = CAMPAIGN_GRAPH_MAX): Graph {
  const adj = adjacency(data);
  const ids = data.nodes.filter((n) => keepType(n.typeId)).map((n) => n.id);
  const kept = ids.length > max ? ids.sort(stronger(adj)).slice(0, max) : ids;
  const keep = new Set(kept);
  const nodes = data.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, degree: degreeOf(adj, n.id), depth: 0 }));
  return { nodes, edges: induced(adj, keep), centerId: null, dropped: ids.length - keep.size };
}

export const clusterId = (typeId: string | null) => `type:${typeId ?? ''}`;
export const isClusterId = (id: string) => id.startsWith('type:');

/**
 * Above `above` nodes (50), each type with two or more entries becomes one cluster node, unless it is in `expanded`.
 * Edges to and between clusters add up their members' relations; edges inside a cluster go. `label` names a cluster.
 */
export function clusterByType(g: Graph, expanded: ReadonlySet<string | null>, label: (typeId: string | null, count: number) => string, above = CLUSTER_ABOVE): Graph {
  if (g.nodes.length <= above) return g;
  const members = new Map<string | null, GraphNode[]>();
  for (const n of g.nodes) { const l = members.get(n.typeId); if (l) l.push(n); else members.set(n.typeId, [n]); }
  const home = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const [typeId, list] of members) {
    if (list.length < 2 || expanded.has(typeId)) { nodes.push(...list); continue; }
    const id = clusterId(typeId);
    for (const n of list) home.set(n.id, id);
    nodes.push({ id, label: label(typeId, list.length), typeId, degree: list.length, depth: 0, cluster: { typeId, count: list.length } });
  }
  if (!home.size) return g;
  const edges = new Map<string, GraphEdge>();
  for (const e of g.edges) {
    const a = home.get(e.source) ?? e.source, b = home.get(e.target) ?? e.target;
    if (a === b) continue;
    const [source, target] = a < b ? [a, b] : [b, a];
    const id = pairId(source, target);
    const hit = edges.get(id);
    if (!hit) { edges.set(id, { id, source, target, relations: e.relations, weight: e.weight }); continue; }
    hit.weight += e.weight;
    if (hit.relations.length < 8) {
      const have = new Set(hit.relations.map(relKey));
      hit.relations = [...hit.relations, ...e.relations.filter((r) => !have.has(relKey(r)))].slice(0, 8);
    }
  }
  return { nodes, edges: [...edges.values()].sort((x, y) => byStr(x.id, y.id)), centerId: g.centerId, dropped: g.dropped };
}

// ---- Layout ----

export interface Point { x: number; y: number }
export interface Layout { pos: Map<string, Point>; bounds: { minX: number; minY: number; maxX: number; maxY: number } }
export interface LayoutOptions {
  /** Steps of the simulation, at most 300. */
  iterations?: number;
  /** Turns the starting spiral; the same seed always gives the same picture. */
  seed?: number;
  /** Rest length of an edge. */
  spacing?: number;
  /** Extra room a node needs (its radius), by id. */
  radius?: (n: GraphNode) => number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad
/** Under this many nodes, every pair repels exactly; above, a Barnes-Hut quadtree approximates far groups. */
const EXACT_BELOW = 200;
const THETA2 = 1.0; // θ = 1

/** Iterations a graph of `n` nodes gets by default: 300 for small ones, fewer as it grows (never under 60). */
export const defaultIterations = (n: number) => (n <= 150 ? MAX_ITERATIONS : Math.max(60, Math.round(MAX_ITERATIONS * Math.sqrt(150 / n))));

/**
 * A force layout: nodes start on a golden-angle spiral in stable order (centre first, then by depth and id), then
 * repel each other, edges pull like springs, a weak pull keeps the whole near the middle, and the step size cools
 * linearly to zero. The centre node stays at (0, 0). Fixed iterations, no randomness: same graph → same positions.
 */
export function layout(g: Graph, opts: LayoutOptions = {}): Layout {
  const n = g.nodes.length;
  const iterations = Math.max(0, Math.min(MAX_ITERATIONS, Math.floor(opts.iterations ?? defaultIterations(n))));
  const k = opts.spacing ?? 60;
  const seed = opts.seed ?? 0;
  const order = g.nodes.map((node, i) => i).sort((a, b) => {
    const x = g.nodes[a], y = g.nodes[b];
    return Number(y.id === g.centerId) - Number(x.id === g.centerId) || x.depth - y.depth || byStr(x.id, y.id);
  });
  const xs = new Float64Array(n), ys = new Float64Array(n), dx = new Float64Array(n), dy = new Float64Array(n), rad = new Float64Array(n);
  const index = new Map<string, number>();
  const pinned = new Uint8Array(n);
  const offset = seed * GOLDEN;
  order.forEach((i, rank) => {
    const node = g.nodes[i];
    index.set(node.id, i);
    rad[i] = opts.radius ? opts.radius(node) : 0;
    if (node.id === g.centerId) { pinned[i] = 1; return; }
    const r = k * 0.6 * Math.sqrt(rank + (g.centerId ? 0 : 0.5));
    const a = rank * GOLDEN + offset;
    xs[i] = r * Math.cos(a); ys[i] = r * Math.sin(a);
  });
  const src = new Int32Array(g.edges.length), dst = new Int32Array(g.edges.length), wt = new Float64Array(g.edges.length);
  g.edges.forEach((e, j) => { src[j] = index.get(e.source) ?? -1; dst[j] = index.get(e.target) ?? -1; wt[j] = 1 + Math.log(Math.max(1, e.weight)) * 0.3; });

  const k2 = k * k;
  const t0 = k * 1.2;
  const tree = n >= EXACT_BELOW ? new QuadTree(n) : null;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    // Repulsion: k² / d, with each node's radius added to the distance it wants.
    if (tree) tree.repel(xs, ys, rad, dx, dy, k2);
    else {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let ex = xs[i] - xs[j], ey = ys[i] - ys[j];
        let d2 = ex * ex + ey * ey;
        if (d2 < 1e-6) { ex = ((i - j) % 3) * 0.1 + 0.05; ey = 0.1; d2 = ex * ex + ey * ey; }
        const room = 1 + (rad[i] + rad[j]) / k;
        const f = (k2 * room * room) / d2;
        dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
      }
    }
    // Springs: pull toward the rest length (longer for big nodes).
    for (let j = 0; j < src.length; j++) {
      const a = src[j], b = dst[j];
      if (a < 0 || b < 0) continue;
      const ex = xs[b] - xs[a], ey = ys[b] - ys[a];
      const d = Math.sqrt(ex * ex + ey * ey) || 1e-3;
      const rest = k + rad[a] + rad[b];
      const f = ((d - rest) / d) * 0.5 * wt[j] * k * 0.06;
      dx[a] += ex * f; dy[a] += ey * f; dx[b] -= ex * f; dy[b] -= ey * f;
    }
    const t = t0 * (1 - it / iterations);
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      // Centring: a weak pull that grows with distance, so loose parts don't drift away.
      dx[i] -= xs[i] * 0.04; dy[i] -= ys[i] * 0.04;
      const m = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (m > t) { dx[i] *= t / m; dy[i] *= t / m; }
      xs[i] += dx[i]; ys[i] += dy[i];
    }
  }
  const pos = new Map<string, Point>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = Math.round(xs[i] * 100) / 100, y = Math.round(ys[i] * 100) / 100;
    pos.set(g.nodes[i].id, { x, y });
    minX = Math.min(minX, x - rad[i]); minY = Math.min(minY, y - rad[i]); maxX = Math.max(maxX, x + rad[i]); maxY = Math.max(maxY, y + rad[i]);
  }
  if (!n) minX = minY = maxX = maxY = 0;
  return { pos, bounds: { minX, minY, maxX, maxY } };
}

/** A Barnes-Hut quadtree in flat arrays, rebuilt every step (allocated once per layout). */
class QuadTree {
  private cap: number;
  private cx: Float64Array; private cy: Float64Array; private size: Float64Array;
  private mass: Float64Array; private mx: Float64Array; private my: Float64Array; private mr: Float64Array;
  private child: Int32Array; private body: Int32Array;
  private used = 0;
  private stack: Int32Array;

  constructor(n: number) {
    this.cap = n * 4 + 8;
    this.cx = new Float64Array(this.cap); this.cy = new Float64Array(this.cap); this.size = new Float64Array(this.cap);
    this.mass = new Float64Array(this.cap); this.mx = new Float64Array(this.cap); this.my = new Float64Array(this.cap); this.mr = new Float64Array(this.cap);
    this.child = new Int32Array(this.cap * 4); this.body = new Int32Array(this.cap);
    this.stack = new Int32Array(this.cap);
  }

  private node(cx: number, cy: number, size: number): number {
    if (this.used >= this.cap) this.grow();
    const q = this.used++;
    this.cx[q] = cx; this.cy[q] = cy; this.size[q] = size;
    this.mass[q] = 0; this.mx[q] = 0; this.my[q] = 0; this.mr[q] = 0;
    this.child.fill(-1, q * 4, q * 4 + 4); this.body[q] = -1;
    return q;
  }

  private grow() {
    const cap = this.cap * 2;
    const f = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    this.cx = f(this.cx); this.cy = f(this.cy); this.size = f(this.size); this.mass = f(this.mass); this.mx = f(this.mx); this.my = f(this.my); this.mr = f(this.mr);
    const child = new Int32Array(cap * 4); child.set(this.child); this.child = child;
    const body = new Int32Array(cap); body.set(this.body); this.body = body;
    this.stack = new Int32Array(cap);
    this.cap = cap;
  }

  private quad(q: number, x: number, y: number): number {
    return (x >= this.cx[q] ? 1 : 0) + (y >= this.cy[q] ? 2 : 0);
  }

  private insert(root: number, i: number, xs: Float64Array, ys: Float64Array, depth = 0) {
    let q = root;
    for (let d = depth; ; d++) {
      const slot = this.quad(q, xs[i], ys[i]);
      const c = this.child[q * 4 + slot];
      if (c === -1) {
        const h = this.size[q] / 2;
        const leaf = this.node(this.cx[q] + (slot & 1 ? h / 2 : -h / 2), this.cy[q] + (slot & 2 ? h / 2 : -h / 2), h);
        this.body[leaf] = i;
        this.child[q * 4 + slot] = leaf;
        return;
      }
      const b = this.body[c];
      if (b >= 0) {
        // A leaf: split it (stop splitting at a tiny size; then the two share the leaf as a group).
        if (this.size[c] < 1e-3 || d > 40) { this.body[c] = -2; this.extra(c, i); this.extra(c, b); return; }
        this.body[c] = -1;
        this.insert(c, b, xs, ys, d + 1);
      } else if (b === -2) { this.extra(c, i); return; }
      q = c;
    }
  }

  /** Overflow bodies of a tiny leaf live in a list. */
  private extras = new Map<number, number[]>();
  private extra(q: number, i: number) { const l = this.extras.get(q); if (l) { if (!l.includes(i)) l.push(i); } else this.extras.set(q, [i]); }

  private sum(q: number, xs: Float64Array, ys: Float64Array, rad: Float64Array) {
    const b = this.body[q];
    if (b >= 0) { this.mass[q] = 1; this.mx[q] = xs[b]; this.my[q] = ys[b]; this.mr[q] = rad[b]; return; }
    if (b === -2) {
      const l = this.extras.get(q)!;
      let x = 0, y = 0, r = 0;
      for (const i of l) { x += xs[i]; y += ys[i]; r = Math.max(r, rad[i]); }
      this.mass[q] = l.length; this.mx[q] = x / l.length; this.my[q] = y / l.length; this.mr[q] = r;
      return;
    }
    let m = 0, x = 0, y = 0, r = 0;
    for (let s = 0; s < 4; s++) {
      const c = this.child[q * 4 + s];
      if (c === -1) continue;
      this.sum(c, xs, ys, rad);
      m += this.mass[c]; x += this.mx[c] * this.mass[c]; y += this.my[c] * this.mass[c]; r = Math.max(r, this.mr[c]);
    }
    this.mass[q] = m; this.mx[q] = m ? x / m : 0; this.my[q] = m ? y / m : 0; this.mr[q] = r;
  }

  repel(xs: Float64Array, ys: Float64Array, rad: Float64Array, dx: Float64Array, dy: Float64Array, k2: number) {
    const n = xs.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]); }
    this.used = 0; this.extras.clear();
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.01 + 1;
    const root = this.node((minX + maxX) / 2, (minY + maxY) / 2, size);
    for (let i = 0; i < n; i++) this.insert(root, i, xs, ys);
    this.sum(root, xs, ys, rad);
    const k = Math.sqrt(k2);
    for (let i = 0; i < n; i++) {
      let top = 0;
      this.stack[top++] = root;
      while (top) {
        const q = this.stack[--top];
        const b = this.body[q];
        if (b === i) continue;
        let ex = xs[i] - this.mx[q], ey = ys[i] - this.my[q];
        let d2 = ex * ex + ey * ey;
        const s = this.size[q];
        if (b >= 0 || b === -2 || (s * s) / Math.max(d2, 1e-9) < THETA2) {
          let m = this.mass[q];
          if (b === -2 && this.extras.get(q)!.includes(i)) m -= 1;
          if (m <= 0) continue;
          if (d2 < 1e-6) { ex = ((i % 3) - 1) * 0.1 + 0.05; ey = 0.1; d2 = ex * ex + ey * ey; }
          const room = 1 + (rad[i] + this.mr[q]) / k;
          const f = (k2 * room * room * m) / d2;
          dx[i] += ex * f; dy[i] += ey * f;
          continue;
        }
        for (let c = 0; c < 4; c++) { const ch = this.child[q * 4 + c]; if (ch !== -1) this.stack[top++] = ch; }
      }
    }
  }
}

/** Nodes by rank for labels: the centre first, then most neighbours, then by label. */
export function labelRank(g: Graph): string[] {
  return [...g.nodes].sort((a, b) => Number(b.id === g.centerId) - Number(a.id === g.centerId) || b.degree - a.degree || byStr(a.label, b.label) || byStr(a.id, b.id)).map((n) => n.id);
}

/**
 * The node an arrow key moves to from `fromId`: among its neighbours, the one most in direction (`dirX`, `dirY`);
 * when none lies that way, the nearest node in that direction; null when there is none.
 */
export function nodeToward(g: Graph, pos: Map<string, Point>, fromId: string, dirX: number, dirY: number): string | null {
  const from = pos.get(fromId);
  if (!from) return null;
  const adj = new Set<string>();
  for (const e of g.edges) { if (e.source === fromId) adj.add(e.target); else if (e.target === fromId) adj.add(e.source); }
  const pick = (only: Set<string> | null): string | null => {
    let best: string | null = null, bestScore = Infinity;
    for (const n of g.nodes) {
      if (n.id === fromId || (only && !only.has(n.id))) continue;
      const p = pos.get(n.id);
      if (!p) continue;
      const ex = p.x - from.x, ey = p.y - from.y;
      const d = Math.sqrt(ex * ex + ey * ey) || 1e-6;
      const cos = (ex * dirX + ey * dirY) / d;
      if (cos < 0.38) continue; // within about 67° of the arrow
      const score = d * (2 - cos);
      if (score < bestScore || (score === bestScore && best !== null && byStr(n.id, best) < 0)) { best = n.id; bestScore = score; }
    }
    return best;
  };
  return pick(adj) ?? pick(null);
}

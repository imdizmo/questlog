// Vision board model: plain types and pure helpers. No DOM, no Yjs; the web layer maps these onto Y.Map writes.

export const NODE_TYPES = ['text', 'card', 'container', 'filter', 'image', 'video'] as const;
export type NodeType = typeof NODE_TYPES[number];
export type Side = 'left' | 'right' | 'top' | 'bottom';

export const GRID = 20;
export const COLORS = ['green', 'blue', 'pink', 'orange', 'purple', 'grey'] as const; // no colour = undefined
export type BoardColor = typeof COLORS[number];
export const ZOOM_STEP = 0.1;
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 3;

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
export interface NodePos extends Rect { parent: string | null }

export interface BoardNode {
  id: string;
  type: NodeType;
  value: Record<string, unknown>;
  pos: NodePos;
  color?: BoardColor;
}
export interface EdgeEnd { nodeId: string; side: Side }
/**
 * What a line between two task cards stands for in the project: 'dep' a "waits for" (source waits for target), 'sub' a
 * subtask (source is the parent). Set only by the board's own upkeep and by the "What does this line mean?" choice, so
 * a line the user merely labels "waits for" stays the user's line.
 */
export type EdgeKind = 'dep' | 'sub';
export const isEdgeKind = (v: unknown): v is EdgeKind => v === 'dep' || v === 'sub';
export interface BoardEdge {
  id: string;
  value: { source: EdgeEnd; target: EdgeEnd; kind?: EdgeKind };
  label?: string;
  color?: BoardColor;
}

/** Fixed default sizes. image is only a fallback for an image of unknown size; see imageSize. */
export const DEFAULT_SIZE: Record<NodeType, Size> = {
  text: { w: 160, h: 40 },
  card: { w: 120, h: 160 },
  container: { w: 200, h: 100 },
  filter: { w: 100, h: 100 },
  image: { w: 200, h: 200 },
  video: { w: 320, h: 180 },
};

const IMAGE_MAX = 400;

/** Natural size, scaled down so the long side is at most 400. Unknown size falls back to the default. */
export function imageSize(w: number, h: number): Size {
  if (!(w > 0) || !(h > 0)) return { ...DEFAULT_SIZE.image };
  const k = Math.min(1, IMAGE_MAX / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function filterSize(mode: string | undefined): Size {
  return mode === 'table' ? { w: 160, h: 200 } : { ...DEFAULT_SIZE.filter };
}

/** How a Smart Node shows its query. Only horBar and table are observed; the other names are guesses. */
export const SMART_MODES = ['horBar', 'verBar', 'donut', 'table', 'number'] as const;
export type SmartMode = typeof SMART_MODES[number];
export const SMART_MODE_LABEL: Record<SmartMode, string> = {
  horBar: 'Horizontal bar', verBar: 'Vertical bar', donut: 'Donut', table: 'Table', number: 'Number',
};
export const SMART_COLUMNS = ['priority', 'effort', 'owner', 'run', 'milestone', 'checklist', 'deck', 'tags'] as const;
export type SmartColumn = typeof SMART_COLUMNS[number];
export const SMART_COLUMN_LABEL: Record<SmartColumn, string> = {
  priority: 'Priority', effort: 'Effort', owner: 'Owner', run: 'Sprint', milestone: 'Milestone', checklist: 'Checklist', deck: 'List', tags: 'Tags',
};
/** Deck order props a table can sort by (those that need no notification or time data). */
export const SMART_ORDER_PROPS = [
  'priority', 'effort', 'status', 'sprint', 'milestone', 'projectTags', 'assignee', 'creator', 'lastUpdatedAt', 'createdAt', 'title', 'dueDate',
] as const;
export type SmartOrder = typeof SMART_ORDER_PROPS[number];
export const SMART_LABEL_MAX = 200;

const isIn = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);

/** A Smart Node's value is trusted by nobody: anyone who may edit the board can write anything into the doc. */
export function validSmartValue(v: Record<string, unknown>): boolean {
  if (!(v.queryId === null || typeof v.queryId === 'string')) return false;
  if (!isIn(SMART_MODES, v.mode)) return false;
  if (v.label !== undefined && !(typeof v.label === 'string' && v.label.length <= SMART_LABEL_MAX)) return false;
  if (v.columns !== undefined && !(Array.isArray(v.columns) && v.columns.length <= SMART_COLUMNS.length
    && v.columns.every((c) => isIn(SMART_COLUMNS, c)) && new Set(v.columns).size === v.columns.length)) return false;
  if (v.order !== undefined && v.order !== null && !isIn(SMART_ORDER_PROPS, v.order)) return false;
  if (v.hideArchived !== undefined && typeof v.hideArchived !== 'boolean') return false;
  if (v.segments !== undefined && typeof v.segments !== 'boolean') return false;
  return true;
}

/**
 * Where a new node of `size` goes beside `anchor`: the first free grid spot to its right, scanning down,
 * then the next column over. Never overlaps an existing node.
 */
export function spotBeside(nodes: BoardNode[], anchor: Rect, size: Size): Point {
  const free = (p: Point) => nodes.every((n) =>
    p.x + size.w <= n.pos.x || n.pos.x + n.pos.w <= p.x || p.y + size.h <= n.pos.y || n.pos.y + n.pos.h <= p.y);
  const x0 = snap(anchor.x + anchor.w) + GRID;
  const step = snap(Math.max(size.h, GRID)) + GRID;
  for (let col = 0; col < 20; col++) {
    for (let row = 0; row < 20; row++) {
      const p = { x: x0 + col * (snap(size.w) + GRID), y: snap(anchor.y) + row * step };
      if (free(p)) return p;
    }
  }
  return { x: x0, y: snap(anchor.y) };
}

export function snap(n: number): number {
  return Math.round(n / GRID) * GRID + 0; // + 0 turns -0 into 0
}

function sizeFor(type: NodeType, value: Record<string, unknown>): Size {
  if (type === 'image') return imageSize(Number(value.width), Number(value.height));
  if (type === 'filter') return filterSize(typeof value.mode === 'string' ? value.mode : undefined);
  return { ...DEFAULT_SIZE[type] };
}

/** A node centred on the click point, position snapped to the grid. */
export function newNodeAt(type: NodeType, click: Point, value: Record<string, unknown>): BoardNode {
  const { w, h } = sizeFor(type, value);
  return { id: newId(), type, value, pos: { x: snap(click.x - w / 2), y: snap(click.y - h / 2), w, h, parent: null } };
}

const encloses = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

function descendantsOf(nodes: BoardNode[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const p = queue.pop()!;
    for (const n of nodes) if (n.pos.parent === p && !out.has(n.id)) { out.add(n.id); queue.push(n.id); }
  }
  return out;
}

/** The smallest container fully enclosing rect (edges count as inside). selfId excludes that node and its descendants. */
export function containerAt(nodes: BoardNode[], rect: Rect, selfId?: string): string | null {
  const skip = selfId ? descendantsOf(nodes, selfId).add(selfId) : new Set<string>();
  let best: BoardNode | null = null;
  for (const n of nodes) {
    if (n.type !== 'container' || skip.has(n.id) || !encloses(n.pos, rect)) continue;
    if (!best || n.pos.w * n.pos.h < best.pos.w * best.pos.h) best = n;
  }
  return best ? best.id : null;
}

/**
 * Ids of nodes now fully inside the container (edges count), for the caller to parent to it.
 * Never the container itself or its ancestors, and nothing that sits inside another container
 * that is itself inside this one (that node belongs to the inner container, so nesting is kept).
 */
export function adoptAfterResize(nodes: BoardNode[], containerId: string): string[] {
  const c = nodes.find(n => n.id === containerId);
  if (!c) return [];
  const ancestors = new Set<string>();
  for (let p = c.pos.parent; p && !ancestors.has(p); p = nodes.find(n => n.id === p)?.pos.parent ?? null) ancestors.add(p);
  const inside = nodes.filter(n => n.id !== containerId && !ancestors.has(n.id) && encloses(c.pos, n.pos));
  const inners = inside.filter(n => n.type === 'container');
  return inside.filter(n => !inners.some(i => i.id !== n.id && encloses(i.pos, n.pos))).map(n => n.id);
}

const anchor = (r: Rect, side: Side): Point =>
  side === 'left' ? { x: r.x, y: r.y + r.h / 2 }
  : side === 'right' ? { x: r.x + r.w, y: r.y + r.h / 2 }
  : side === 'top' ? { x: r.x + r.w / 2, y: r.y }
  : { x: r.x + r.w / 2, y: r.y + r.h };

const OUT: Record<Side, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

/** The side whose midpoint is closest to the point. Ties go top, right, bottom, left. */
export function nearestSide(rect: Rect, point: Point): Side {
  let best: Side = 'top';
  let bestD = Infinity;
  for (const s of ['top', 'right', 'bottom', 'left'] as const) {
    const a = anchor(rect, s);
    const d = Math.hypot(a.x - point.x, a.y - point.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

/**
 * The sides a project board draws a "waits for" or subtask line between, worked out from where the two nodes are now
 * (nothing stored): stacked (overlapping in x), the upper one's bottom to the lower one's top; otherwise the facing
 * sides, right to left when the target is to the right, left to right when it is to the left.
 */
export function autoSides(a: Rect, b: Rect): { from: Side; to: Side } {
  if (a.x < b.x + b.w && b.x < a.x + a.w) {
    return a.y + a.h / 2 <= b.y + b.h / 2 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
  }
  return a.x + a.w / 2 <= b.x + b.w / 2 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
}

const num = (n: number) => String(Math.round(n * 100) / 100 + 0);

/** SVG cubic path between two side midpoints; each control point sits 0.4 x the anchor distance outward from its side. */
export function edgePath(src: { rect: Rect; side: Side }, dst: { rect: Rect; side: Side }): string {
  const a = anchor(src.rect, src.side);
  const b = anchor(dst.rect, dst.side);
  const k = 0.4 * Math.hypot(b.x - a.x, b.y - a.y);
  const c1 = { x: a.x + OUT[src.side].x * k, y: a.y + OUT[src.side].y * k };
  const c2 = { x: b.x + OUT[dst.side].x * k, y: b.y + OUT[dst.side].y * k };
  return `M ${num(a.x)} ${num(a.y)} C ${num(c1.x)} ${num(c1.y)}, ${num(c2.x)} ${num(c2.y)}, ${num(b.x)} ${num(b.y)}`;
}

/** What deleting a node removes: the node, every edge touching it, and the parent link of its children (they stay put). */
export function nodesToDelete(nodes: BoardNode[], edges: BoardEdge[], id: string): { nodes: string[]; edges: string[]; unparent: string[] } {
  return {
    nodes: [id],
    edges: edges.filter(e => e.value.source.nodeId === id || e.value.target.nodeId === id).map(e => e.id),
    unparent: nodes.filter(n => n.pos.parent === id).map(n => n.id),
  };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const FILE_URL = /^\/api\/files\/[A-Za-z0-9_-]+$/;

/** An image node's url: exactly /api/files/<id>, nothing else (no dot segments, schemes or hosts). */
export const isFileUrl = (v: unknown): v is string => typeof v === 'string' && FILE_URL.test(v);
/** A video node's id: exactly 11 characters of [A-Za-z0-9_-]. */
export const isVideoId = (v: unknown): v is string => typeof v === 'string' && YT_ID.test(v);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/** The 11-character video id from a bare id or a youtube.com watch / shorts or youtu.be URL; null for anything else. */
export function parseYouTube(input: string): string | null {
  const s = input.trim();
  if (YT_ID.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !YT_HOSTS.has(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const id = u.hostname === 'youtu.be' ? (parts.length === 1 ? parts[0] : null)
    : u.pathname === '/watch' ? u.searchParams.get('v')
    : parts.length === 2 && parts[0] === 'shorts' ? parts[1] : null;
  return id && YT_ID.test(id) ? id : null;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'; // 64 chars, so a masked byte is unbiased

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 63];
  return out;
}

export interface SmartAggregate { total: number; done: number; pct: number; byStatus: Record<string, { count: number; effort: number }> }

/**
 * Smart Node figures: done share (rounded %) over all cards, and count + summed effort per status.
 * statusOf picks the grouping key (pass the derived status, e.g. hero / unassigned); default is the stored c.status.
 */
export function smartAggregate<C>(
  cards: C[], isDone: (c: C) => boolean, effortOf: (c: C) => number | null | undefined,
  statusOf: (c: C) => string = c => (c as { status: string }).status,
): SmartAggregate {
  const byStatus: SmartAggregate['byStatus'] = Object.create(null);
  let done = 0;
  for (const c of cards) {
    if (isDone(c)) done++;
    const s = (byStatus[statusOf(c)] ??= { count: 0, effort: 0 });
    s.count++;
    s.effort += effortOf(c) ?? 0;
  }
  return { total: cards.length, done, pct: cards.length ? Math.round((done / cards.length) * 100) : 0, byStatus };
}

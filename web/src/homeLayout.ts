/**
 * Where Home's nodes go (tests/web-home-layout.test.ts). Pure geometry in world pixels: each box is its centre and size.
 *
 * - Web: every node would like its seed (web/src/homeModel.ts). Cards are placed first, then pills, projects before
 *   areas before lists before quests; each keeps its seed when it is free, else takes the nearest free spot on rings
 *   around it. "Free" is asked of a grid of what is already placed, so the cost stays near linear in the nodes.
 * - Tree View: columns project | area | list | quest, a parent centred on its children; quest cards of one list sit in
 *   a grid up to three across, so a long list does not make the tree tall.
 * - fitView: scale and offset that fit the whole into the page beside the welcome column (never smaller than 0.7:
 *   drag to see the rest).
 */
import type { HomeNode, NodeKind } from './homeModel';

export type CardKind = 'proj' | 'area' | 'list' | 'quest';
export const CARD_KINDS: CardKind[] = ['proj', 'area', 'list', 'quest'];
/** A scene card, as on the vision board: picture, title, text, tags. */
export const CARD_W = 236;
export const CARD_H = 232;
export interface Box { x: number; y: number; w: number; h: number }
export interface Layout { pos: Map<string, Box>; bounds: Box }

/** "All" (or any kind) as cards: at most this many cards of a kind, in the model's order; the rest stay pills. */
export const MAX_CARDS_PER_KIND = 60;

/** The nodes drawn as cards: the first MAX_CARDS_PER_KIND of each kind asked for ("+N more" is always a pill). */
export function pickCards(nodes: HomeNode[], kinds: CardKind[], max = MAX_CARDS_PER_KIND): Set<string> {
  const out = new Set<string>();
  if (!kinds.length) return out;
  const seen: Record<string, number> = {};
  for (const n of nodes) {
    if (n.kind === 'more' || !kinds.includes(n.kind)) continue;
    if ((seen[n.kind] = (seen[n.kind] ?? 0) + 1) <= max) out.add(n.id);
  }
  return out;
}

/**
 * What the layout depends on: which nodes, under which parent, where they would like to be, their size, which are
 * cards, and the view. A live change that moves nothing (a task finished, words changed, a count gone up within its
 * digits) gives the same key, so the page keeps its layout and its fit instead of running them again.
 */
export function layoutKey(nodes: HomeNode[], cards: Set<string>, tree: boolean): string {
  const parts: string[] = [tree ? 'tree' : 'web'];
  for (const n of nodes) {
    const [w, h] = cards.has(n.id) ? [CARD_W, CARD_H] : pillSize(n);
    parts.push(`${n.id}<${n.parent ?? ''}@${Math.round(n.x)},${Math.round(n.y)}#${Math.round(w)}x${h}${cards.has(n.id) ? 'c' : ''}`);
  }
  return parts.join('|');
}

const GAP = 12;
const CELL = 120;
const ORDER: Record<NodeKind, number> = { proj: 0, area: 1, list: 2, quest: 3, more: 4 };

/**
 * A pill's size from its words: an estimate a little over the drawn width, so pills never touch, rounded up to a
 * 24 px step so typing in a title moves nothing until it really needs more room.
 */
export function pillSize(n: HomeNode): [number, number] {
  const len = n.label.length;
  const step = (w: number) => Math.min(300, Math.ceil(w / 24) * 24);
  switch (n.kind) {
    case 'proj': return [step(48 + len * 8), 32];
    case 'area': return [step(34 + len * 8), 26];
    case 'list': return [step(56 + len * 7.2 + String(n.open ?? 0).length * 7.5), 28];
    case 'quest': return [step(36 + Math.min(len, 34) * 6.9), 26];
    default: return [step(30 + len * 6.6), 24];
  }
}

const sizeOf = (n: HomeNode, isCard: (n: HomeNode) => boolean): [number, number] =>
  isCard(n) && n.kind !== 'more' ? [CARD_W, CARD_H] : pillSize(n);

function boundsOf(pos: Map<string, Box>): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pos.values()) {
    x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2);
    y0 = Math.min(y0, b.y - b.h / 2); y1 = Math.max(y1, b.y + b.h / 2);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/** The placed boxes by grid cell; each box is in every cell it covers. */
class Grid {
  private cells = new Map<number, Box[]>();
  private key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
  private span(b: Box, pad: number) {
    return [Math.floor((b.x - b.w / 2 - pad) / CELL), Math.floor((b.x + b.w / 2 + pad) / CELL), Math.floor((b.y - b.h / 2 - pad) / CELL), Math.floor((b.y + b.h / 2 + pad) / CELL)];
  }
  add(b: Box): void {
    const [x0, x1, y0, y1] = this.span(b, 0);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = this.key(cx, cy);
      const list = this.cells.get(k);
      if (list) list.push(b); else this.cells.set(k, [b]);
    }
  }
  free(x: number, y: number, w: number, h: number): boolean {
    const x0 = Math.floor((x - w / 2 - GAP) / CELL), x1 = Math.floor((x + w / 2 + GAP) / CELL);
    const y0 = Math.floor((y - h / 2 - GAP) / CELL), y1 = Math.floor((y + h / 2 + GAP) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const list = this.cells.get(this.key(cx, cy));
      if (!list) continue;
      for (const q of list) if (Math.abs(q.x - x) < (q.w + w) / 2 + GAP && Math.abs(q.y - y) < (q.h + h) / 2 + GAP) return false;
    }
    return true;
  }
}

/** Most spots tried for one node before it is left where it is (only on absurd input). */
const MAX_TRIES = 30000;

/** `pinned`: nodes the person moved by hand; they stay exactly there and the rest make room around them. */
export function webLayout(nodes: HomeNode[], isCard: (n: HomeNode) => boolean, pinned: Record<string, [number, number]> = {}): Layout {
  const order = nodes.map((n, i) => ({ n, i, card: isCard(n) && n.kind !== 'more', pin: Object.hasOwn(pinned, n.id) }));
  order.sort((a, b) => Number(b.pin) - Number(a.pin) || Number(b.card) - Number(a.card) || ORDER[a.n.kind] - ORDER[b.n.kind] || a.i - b.i);
  const grid = new Grid();
  const pos = new Map<string, Box>();
  for (const { n, pin } of order) {
    const [w, h] = sizeOf(n, isCard);
    let x = n.x, y = n.y;
    if (pin) [x, y] = pinned[n.id];
    else if (!grid.free(x, y, w, h)) [x, y] = spotNear(grid, n.x, n.y, w, h);
    const b = { x, y, w, h };
    grid.add(b);
    pos.set(n.id, b);
  }
  return { pos, bounds: boundsOf(pos) };
}

/**
 * The nearest free spot around (x, y): rings half a box high apart near it, wider apart further out (a pill pushed past
 * a card does not need to try every few pixels); on a ring, spots a third of the box wide apart (pills are wide and low).
 */
function spotNear(grid: Grid, x: number, y: number, w: number, h: number): [number, number] {
  const base = Math.max(8, h / 2), arc = Math.max(base, w / 3);
  let tries = 0;
  for (let r = base; tries < MAX_TRIES; r += Math.max(base, r / 6)) {
    const points = Math.max(12, Math.ceil((2 * Math.PI * r) / Math.max(arc, r / 6)));
    for (let k = 0; k < points; k++, tries++) {
      const a = (k / points) * 2 * Math.PI;
      const tx = x + r * Math.cos(a), ty = y + r * Math.sin(a) * 0.7;
      if (grid.free(tx, ty, w, h)) return [tx, ty];
    }
  }
  return [x, y];
}

/**
 * Cards on the shared Home board, for the person who turned them on: each card is drawn centred on its node's place;
 * a card that would cover an earlier one takes the nearest free spot, and a pill under a card moves to the nearest free
 * spot around it. On screen only: the board keeps the places. Pills that only touch pills stay where people put them.
 */
export function nudge(items: Array<Box & { id: string; card: boolean }>): Map<string, Box> {
  const out = new Map<string, Box>();
  const cards = new Grid(), all = new Grid();
  for (const t of items) {
    if (!t.card) continue;
    const [x, y] = cards.free(t.x, t.y, t.w, t.h) ? [t.x, t.y] : spotNear(cards, t.x, t.y, t.w, t.h);
    const b = { x, y, w: t.w, h: t.h };
    cards.add(b); all.add(b); out.set(t.id, b);
  }
  const under: typeof items = [];
  for (const t of items) {
    if (t.card) continue;
    if (cards.free(t.x, t.y, t.w, t.h)) { const b = { x: t.x, y: t.y, w: t.w, h: t.h }; all.add(b); out.set(t.id, b); } else under.push(t);
  }
  for (const t of under) {
    const [x, y] = spotNear(all, t.x, t.y, t.w, t.h);
    const b = { x, y, w: t.w, h: t.h };
    all.add(b); out.set(t.id, b);
  }
  return out;
}

const COL: Record<NodeKind, number> = { proj: 0, area: 1, list: 2, quest: 3, more: 3 };
const COL_GAP = 70;
const ACROSS = 3;

export function treeLayout(nodes: HomeNode[], isCard: (n: HomeNode) => boolean): Layout {
  const kids = new Map<string, HomeNode[]>();
  for (const n of nodes) if (n.parent) {
    const list = kids.get(n.parent);
    if (list) list.push(n); else kids.set(n.parent, [n]);
  }
  const size = (n: HomeNode) => sizeOf(n, isCard);
  const colW = [0, 0, 0, 0];
  for (const n of nodes) colW[COL[n.kind]] = Math.max(colW[COL[n.kind]], size(n)[0]);
  const questCards = nodes.some((n) => n.kind === 'quest' && isCard(n));
  if (questCards) {
    let most = 1;
    for (const n of nodes) if (n.kind === 'list') most = Math.max(most, Math.min(ACROSS, (kids.get(n.id) ?? []).length));
    colW[3] = Math.max(colW[3], most * (CARD_W + 14) - 14);
  }
  // A project whose lists hang straight off it puts them in the list column; an empty column takes no room.
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < 4; c++) { colX[c] = x; x += colW[c] + (colW[c] ? COL_GAP : 0); }

  const pos = new Map<string, Box>();
  let y = 0;
  const at = (n: HomeNode, cy: number) => {
    const [w, h] = size(n);
    pos.set(n.id, { x: colX[COL[n.kind]] + w / 2, y: cy, w, h });
  };
  const place = (n: HomeNode): number => {
    const ch = kids.get(n.id) ?? [];
    if (n.kind === 'list' && ch.length && questCards) {
      const across = Math.min(ACROSS, ch.length), top = y, cellW = CARD_W + 14, cellH = CARD_H + 14;
      ch.forEach((k, i) => {
        const [w, h] = size(k);
        pos.set(k.id, { x: colX[3] + (i % across) * cellW + (k.kind === 'more' ? w / 2 : CARD_W / 2), y: top + Math.floor(i / across) * cellH + (k.kind === 'more' ? h / 2 : CARD_H / 2), w, h });
      });
      const rows = Math.ceil(ch.length / across);
      const lastMore = ch[ch.length - 1].kind === 'more' && ch.length % across === 1;
      const span = rows * cellH - 14 - (lastMore ? CARD_H - size(ch[ch.length - 1])[1] : 0);
      y += span + 22;
      const cy = top + span / 2;
      at(n, cy);
      return cy;
    }
    if (!ch.length) {
      const h = size(n)[1];
      const cy = y + h / 2;
      y += h + (isCard(n) && n.kind !== 'more' ? 14 : 8);
      at(n, cy);
      return cy;
    }
    const top = y;
    const ys = ch.map(place);
    // A parent taller than its children (a card over two pills) starts at their top and pushes what follows down.
    const h = size(n)[1];
    const cy = Math.max((ys[0] + ys[ys.length - 1]) / 2, top + h / 2);
    y = Math.max(y, cy + h / 2 + 14);
    at(n, cy);
    return cy;
  };
  for (const n of nodes) if (n.kind === 'proj') { place(n); y += 46; }
  return { pos, bounds: boundsOf(pos) };
}

/**
 * Screen = world × scale + (x, y). The whole fits beside `left` and below `top` when it can, never smaller than 0.7
 * (below that the words cannot be read; drag to see the rest). Too big, it starts at its left edge (beside the
 * welcome column) and its top, except that the Web view centres `anchor` (the first project) up and down, never past
 * the content's edges.
 */
export function fitView(bounds: Box, view: { w: number; h: number; left: number; top: number }, tree: boolean, anchor?: { y: number }): { scale: number; x: number; y: number } {
  const aw = Math.max(1, view.w - view.left - 80), ah = Math.max(1, view.h - view.top - 50);
  const floor = 0.7;
  const scale = Math.max(floor, Math.min(1, aw / (bounds.w || 1), ah / (bounds.h || 1)));
  const place = (start: number, avail: number, lo: number, size: number, at: number | undefined) => {
    const s = size * scale;
    if (s <= avail) return start + (avail - s) / 2 - lo * scale;
    if (tree || at === undefined) return start - lo * scale;
    // the anchor in the middle, clamped so neither edge of the content leaves its side of the space
    const want = start + avail / 2 - at * scale;
    return Math.min(start - lo * scale, Math.max(start + avail - (lo + size) * scale, want));
  };
  return {
    scale,
    // across, the content always starts beside the welcome column; only up and down does it centre on the anchor
    x: place(view.left, aw, bounds.x - bounds.w / 2, bounds.w, undefined),
    y: place(view.top, ah, bounds.y - bounds.h / 2, bounds.h, anchor?.y),
  };
}

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import { isClusterId, labelRank, nodeToward, type Graph, type GraphNode, type Layout, type Point } from '../../../../shared/graph';

export interface View { k: number; tx: number; ty: number }
const ZOOM_MIN = 0.1, ZOOM_MAX = 4, FIT_MAX = 1.4, PAD = 28;
/** Room kept between a focused node and the edge of the box when the view follows the keyboard. */
const MARGIN = 40;
const PAN_STEP = 60;

/** Node radius by how connected it is (a cluster by how many entries it holds). */
export const nodeRadius = (n: GraphNode, centerId: string | null): number => radiusFor(n, n.degree, centerId);
/** The same rule for any degree (the layout uses the degree within the shown graph). */
export const radiusFor = (n: GraphNode, degree: number, centerId: string | null): number =>
  n.cluster ? Math.min(34, 12 + 3 * Math.sqrt(n.cluster.count)) : Math.min(16, 5 + 1.6 * Math.sqrt(degree)) + (n.id === centerId ? 3 : 0);

/** The size of an element, kept current. */
function useSize<T extends Element>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height })); };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function fitView(l: Layout, w: number, h: number): View {
  const { minX, minY, maxX, maxY } = l.bounds;
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const k = Math.max(ZOOM_MIN, Math.min(FIT_MAX, (w - PAD * 2) / bw, (h - PAD * 2) / bh));
  return { k, tx: w / 2 - k * (minX + maxX) / 2, ty: h / 2 - k * (minY + maxY) / 2 };
}

/** The view moved just enough that a node at `p` of radius `r` sits inside the box (with a margin). */
function keepInside(v: View, p: Point, r: number, w: number, h: number): View {
  const sx = v.tx + v.k * p.x, sy = v.ty + v.k * p.y;
  const m = Math.min(Math.max(MARGIN, r * v.k + 12), w / 2, h / 2);
  let tx = v.tx, ty = v.ty;
  if (sx < m) tx += m - sx; else if (sx > w - m) tx -= sx - (w - m);
  if (sy < m) ty += m - sy; else if (sy > h - m) ty -= sy - (h - m);
  return tx === v.tx && ty === v.ty ? v : { ...v, tx, ty };
}

const viewTransform = (v: View) => `translate(${v.tx},${v.ty}) scale(${v.k})`;
const short = (s: string) => (s.length > 28 ? `${s.slice(0, 27)}…` : s);

export interface GraphCanvasProps {
  graph: Graph;
  layout: Layout;
  /** Accessible name of the whole picture. */
  label: string;
  /** Stable (memoised) per graph: the node layer only redraws when it changes. */
  colorOf: (n: GraphNode) => string;
  /** What a screen reader hears for a node (its name, type, connections). Stable, like colorOf. */
  describe: (n: GraphNode) => string;
  /** How many top-ranked nodes always show their name (the rest on hover, focus or selection, or when zoomed in). */
  labels: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Enter or double-click on a node (a cluster: click too). */
  onOpen: (id: string) => void;
  /** Esc with nothing selected: the owner puts focus back outside the graph. */
  onEscape: () => void;
  /** Pan and zoom (wheel, drag, + / - / 0, Shift+arrows). Without it the picture always fits. */
  zoomable?: boolean;
  /** Changes when the owner wants the picture fitted again (e.g. a filter changed). */
  fitKey?: string;
  /** Rendered over the picture next to the selected node. */
  preview?: (id: string, at: { left: number; top: number; w: number; h: number }) => ReactNode;
  /** Exposes zoom controls to the owner's buttons. */
  controls?: (c: { zoom: (f: number) => void; fit: () => void }) => void;
}

interface Handlers {
  enter: (id: string) => void; leave: (id: string) => void; focus: (id: string) => void; blur: (id: string) => void;
  click: (id: string) => void; dblclick: (id: string) => void; key: (e: KeyboardEvent<SVGGElement>, id: string) => void;
}

/** Edges: redrawn only when the graph or layout changes. Widths stay the same on screen at any zoom. */
const EdgeLayer = memo(function EdgeLayer({ graph, layout }: { graph: Graph; layout: Layout }) {
  const maxWeight = graph.edges.reduce((m, e) => Math.max(m, e.weight), 1);
  const at = (id: string) => layout.pos.get(id) ?? { x: 0, y: 0 };
  return (
    <g className="ge-all" aria-hidden>
      {graph.edges.map((e) => {
        const a = at(e.source), b = at(e.target);
        return (
          <line key={e.id} className={`ge${e.relations.every((r) => r.kind === 'mention') ? ' mention' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            strokeWidth={1 + 1.6 * Math.log(e.weight) / Math.log(maxWeight + 1)} vectorEffect="non-scaling-stroke">
            <title>{e.relations.map((r) => r.label).join(', ')}</title>
          </line>
        );
      })}
    </g>
  );
});

/** Nodes: redrawn when the graph, layout, labels shown, selection or tab stop change; never on hover or pan. */
const NodeLayer = memo(function NodeLayer({ graph, layout, rank, labelled, selectedId, tabStop, colorOf, describe, on }: {
  graph: Graph; layout: Layout; rank: string[]; labelled: ReadonlySet<string>; selectedId: string | null; tabStop: string | null;
  colorOf: (n: GraphNode) => string; describe: (n: GraphNode) => string; on: Handlers;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <g className="gn-all">
      {rank.map((id) => {
        const n = byId.get(id)!;
        const { x, y } = layout.pos.get(id) ?? { x: 0, y: 0 };
        const r = nodeRadius(n, graph.centerId);
        return (
          <g key={id} data-node={id} transform={`translate(${x},${y})`} tabIndex={id === tabStop ? 0 : -1} role="button"
            aria-label={describe(n)} aria-pressed={n.cluster ? undefined : id === selectedId}
            className={`gn${id === graph.centerId ? ' center' : ''}${id === selectedId ? ' selected' : ''}${n.cluster ? ' cluster' : ''}`}
            onMouseEnter={() => on.enter(id)} onMouseLeave={() => on.leave(id)} onFocus={() => on.focus(id)} onBlur={() => on.blur(id)}
            onClick={(e) => { e.stopPropagation(); on.click(id); }} onDoubleClick={(e) => { e.stopPropagation(); on.dblclick(id); }}
            onKeyDown={(e) => on.key(e, id)}>
            <circle r={r + 5} className="gn-ring" />
            <circle r={r} className="gn-dot" style={{ fill: colorOf(n) }} />
            {n.cluster && <text className="gn-count" dy="0.35em" style={{ fontSize: Math.min(14, r * 0.8) }}>{n.cluster.count}</text>}
            {labelled.has(id) && <text className="gn-label" y={r + 3}>{short(n.label)}</text>}
          </g>
        );
      })}
    </g>
  );
});

/**
 * The graph as hand-written SVG: straight edges, round nodes sized by connections and coloured by type, labels for the
 * top-ranked nodes. Hover or focus lights a node's edges (an overlay of just that node and its neighbours; the big
 * layers stay as they are). Keyboard: one tab stop (the selected node, else the centre, else the best-connected);
 * arrows move to the neighbour that way (the view follows), Home to the first, Space selects, Enter opens, Esc clears
 * the selection then leaves; when zoomable, + / - zoom on the focused node, 0 fits, Shift+arrows pan.
 */
export function GraphCanvas(p: GraphCanvasProps) {
  const { graph, layout, selectedId } = p;
  const [wrap, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const inner = useRef<SVGGElement>(null);
  const over = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean; frame: number } | null>(null);
  /** The frame that moves focus to a node once React has given it tabIndex 0. */
  const focusFrame = useRef(0);
  // Nothing scheduled outlives the canvas (a panel closing mid-drag, an entry left while focus was moving).
  useEffect(() => () => {
    if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    cancelAnimationFrame(focusFrame.current);
  }, []);

  const rank = useMemo(() => labelRank(graph), [graph]);
  const rankOf = useMemo(() => new Map(rank.map((id, i) => [id, i])), [rank]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { const s = m.get(a); if (s) s.add(b); else m.set(a, new Set([b])); };
    for (const e of graph.edges) { add(e.source, e.target); add(e.target, e.source); }
    return m;
  }, [graph]);
  const fitted0 = useMemo(() => (size.w && size.h ? fitView(layout, size.w, size.h) : null), [layout, size.w, size.h]);

  // Fit when the picture opens, when the size changes (always, unless zoomable and already placed), or on fitKey.
  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!fitted0) return;
    const key = `${p.fitKey ?? ''}`;
    if (p.zoomable && view && fitted.current === key) return;
    fitted.current = key;
    setView(fitted0);
  }, [fitted0, p.fitKey, p.zoomable]);

  const zoomAt = useCallback((f: number, cx?: number, cy?: number) => {
    setView((v) => {
      if (!v) return v;
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * f));
      const r = k / v.k;
      const x = cx ?? size.w / 2, y = cy ?? size.h / 2;
      return { k, tx: x - (x - v.tx) * r, ty: y - (y - v.ty) * r };
    });
  }, [size.w, size.h]);
  /** Keyboard zoom: the focused node goes to the middle, else the middle stays put. */
  const zoomOn = useCallback((f: number, id: string | null) => {
    const pt = id ? layout.pos.get(id) : undefined;
    setView((v) => {
      if (!v) return v;
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * f));
      if (pt) return { k, tx: size.w / 2 - k * pt.x, ty: size.h / 2 - k * pt.y };
      const r = k / v.k, x = size.w / 2, y = size.h / 2;
      return { k, tx: x - (x - v.tx) * r, ty: y - (y - v.ty) * r };
    });
  }, [layout, size.w, size.h]);
  const fit = useCallback(() => { if (fitted0) setView(fitted0); }, [fitted0]);
  useEffect(() => { p.controls?.({ zoom: (f) => zoomAt(f), fit }); }, [zoomAt, fit]);

  // Wheel zooms around the pointer; it has to be a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = svg.current;
    if (!el || !p.zoomable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [p.zoomable, zoomAt, !!view]);

  // Dragging moves the picture through the DOM (one write per frame) and is committed to state when it ends.
  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !view || (e.target as Element).closest('.gn')) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false, frame: 0 };
    if (p.zoomable) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } }
  };
  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || !p.zoomable || !view) return;
    d.dx = e.clientX - d.x; d.dy = e.clientY - d.y;
    if (Math.abs(d.dx) + Math.abs(d.dy) > 3) d.moved = true;
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      inner.current?.setAttribute('transform', viewTransform({ ...view, tx: view.tx + d.dx, ty: view.ty + d.dy }));
      if (over.current) over.current.style.transform = `translate(${d.dx}px, ${d.dy}px)`;
    });
  };
  const endDrag = (clear: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    if (over.current) over.current.style.transform = '';
    if (d.moved && p.zoomable) setView((v) => (v ? { ...v, tx: v.tx + d.dx, ty: v.ty + d.dy } : v));
    else if (clear) p.onSelect(null);
  };

  const tabStop = [focusId, selectedId, graph.centerId, rank[0]].find((id): id is string => !!id && byId.has(id)) ?? null;
  const focusNode = (id: string) => {
    setFocusId(id);
    const pt = layout.pos.get(id);
    const n = byId.get(id);
    if (p.zoomable && pt && n) setView((v) => (v ? keepInside(v, pt, nodeRadius(n, graph.centerId) + 5, size.w, size.h) : v));
    // After React gives it tabIndex 0.
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => { focusFrame.current = 0; svg.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); });
  };

  // Handlers read the latest props through a ref, so the memoised node layer keeps one stable set.
  const latest = useRef({ p, graph, layout, rank, selectedId, focusNode });
  latest.current = { p, graph, layout, rank, selectedId, focusNode };
  const on = useMemo<Handlers>(() => ({
    enter: (id) => setHover(id),
    leave: (id) => setHover((h) => (h === id ? null : h)),
    focus: (id) => setFocusId(id),
    blur: (id) => setFocusId((f) => (f === id ? null : f)),
    click: (id) => { const l = latest.current; if (isClusterId(id)) l.p.onOpen(id); else l.p.onSelect(id); },
    dblclick: (id) => { if (!isClusterId(id)) latest.current.p.onOpen(id); },
    key: (e, id) => {
      const l = latest.current;
      const dir: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (dir[e.key]) {
        if (e.shiftKey && l.p.zoomable) return; // Shift+arrows pan (the canvas handles them)
        e.preventDefault();
        const to = nodeToward(l.graph, l.layout.pos, id, ...dir[e.key]);
        if (to) l.focusNode(to);
      } else if (e.key === 'Home') { e.preventDefault(); if (l.rank[0]) l.focusNode(l.rank[0]); }
      else if (e.key === 'Enter') { e.preventDefault(); l.p.onOpen(id); }
      else if (e.key === ' ') { e.preventDefault(); if (isClusterId(id)) l.p.onOpen(id); else l.p.onSelect(l.selectedId === id ? null : id); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (l.selectedId) l.p.onSelect(null);
        else { setFocusId(null); l.p.onEscape(); }
      }
    },
  }), []);

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!p.zoomable || e.ctrlKey || e.metaKey || e.altKey) return;
    const pan: Record<string, [number, number]> = { ArrowRight: [-1, 0], ArrowLeft: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (e.shiftKey && pan[e.key]) {
      e.preventDefault();
      const [x, y] = pan[e.key];
      setView((v) => (v ? { ...v, tx: v.tx + x * PAN_STEP, ty: v.ty + y * PAN_STEP } : v));
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomOn(1.25, focusId); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOn(0.8, focusId); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
  };

  // Names shown: the top of the ranking, more as one zooms in (in steps, so wheel zooming rarely redraws the nodes).
  const zoomRatio = view && fitted0 ? view.k / fitted0.k : 1;
  const budget = p.labels * 2 ** Math.max(0, Math.floor(Math.log2(Math.max(1, zoomRatio * zoomRatio))));
  const labelled = useMemo(() => {
    const s = new Set<string>(rank.slice(0, budget));
    if (selectedId) s.add(selectedId);
    return s;
  }, [rank, budget, selectedId]);

  const lit = hover ?? focusId;
  const litSet = lit ? adj.get(lit) : undefined;
  const at = (id: string) => layout.pos.get(id) ?? { x: 0, y: 0 };
  const sel = selectedId && view && byId.has(selectedId) ? at(selectedId) : null;
  const k = view?.k ?? 1;

  return (
    <div className="graph-canvas" ref={wrap}>
      {view && (
        <svg ref={svg} className={`graph-svg${p.zoomable ? ' zoomable' : ''}${lit ? ' lit' : ''}`} width={size.w} height={size.h} role="group" aria-label={p.label}
          style={{ ['--gk' as string]: Math.sqrt(Math.max(k, 0.35)) }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag(false)} onKeyDown={onKeyDown}>
          <g ref={inner} transform={viewTransform(view)}>
            <EdgeLayer graph={graph} layout={layout} />
            <NodeLayer graph={graph} layout={layout} rank={rank} labelled={labelled} selectedId={selectedId} tabStop={tabStop}
              colorOf={p.colorOf} describe={p.describe} on={on} />
            {lit && byId.has(lit) && (
              <g className="g-over" aria-hidden>
                {graph.edges.filter((e) => e.source === lit || e.target === lit).map((e) => {
                  const a = at(e.source), b = at(e.target);
                  return <line key={e.id} className="ge on" x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
                })}
                {[lit, ...(litSet ?? [])].map((id) => {
                  const n = byId.get(id)!;
                  const { x, y } = at(id);
                  const r = nodeRadius(n, graph.centerId);
                  return (
                    <g key={id} transform={`translate(${x},${y})`} className={`gn-copy${id === lit ? ' lit' : ''}${id === graph.centerId ? ' center' : ''}${n.cluster ? ' cluster' : ''}`}>
                      <circle r={r} className="gn-dot" style={{ fill: p.colorOf(n) }} />
                      {n.cluster && <text className="gn-count" dy="0.35em" style={{ fontSize: Math.min(14, r * 0.8) }}>{n.cluster.count}</text>}
                      {(id === lit || (rankOf.get(id) ?? Infinity) < budget * 4) && <text className="gn-label" y={r + 3}>{short(n.label)}</text>}
                    </g>
                  );
                })}
              </g>
            )}
          </g>
        </svg>
      )}
      {sel && view && p.preview && <div ref={over} className="graph-over">{p.preview(selectedId!, { left: view.tx + view.k * sel.x, top: view.ty + view.k * sel.y, w: size.w, h: size.h })}</div>}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { COLORS, isFileUrl, isVideoId, NODE_TYPES, nodesToDelete, validSmartValue, type BoardColor, type BoardEdge, type BoardNode, type NodePos } from '../../../shared/board';

/** Origin of this client's own writes; the undo manager tracks only these, so undo never reverts someone else's change. */
export const LOCAL = Symbol('local');
/** Undo steps kept per session; older ones are dropped so a board left open for hours keeps memory flat. */
export const UNDO_LIMIT = 200;

export interface BoardApi {
  nodes: BoardNode[];
  edges: BoardEdge[];
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  addNode: (node: BoardNode) => void;
  /** Many nodes and edges in one transaction (one undo step). */
  addMany: (nodes: BoardNode[], edges: BoardEdge[]) => void;
  /** Sets each node's whole pos in one transaction. */
  setPos: (changes: Array<{ id: string; pos: NodePos }>) => void;
  /** With pos, the value and the size change in one transaction (one undo step). */
  setValue: (id: string, value: Record<string, unknown>, pos?: NodePos) => void;
  setColor: (id: string, color: BoardColor | undefined) => void;
  /** Removes the node, every edge touching it, and the parent link of its children (nodesToDelete). */
  deleteNode: (id: string) => void;
  addEdge: (edge: BoardEdge) => void;
  /** An empty label removes it. */
  setEdgeLabel: (id: string, label: string) => void;
  setEdgeColor: (id: string, color: BoardColor | undefined) => void;
  deleteEdge: (id: string) => void;
}

const SIDE_VALUES: readonly string[] = ['left', 'right', 'top', 'bottom'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7;
const isColor = (v: unknown): v is BoardColor => (COLORS as readonly unknown[]).includes(v);

/**
 * Drops the oldest undo steps beyond `limit`. The undo manager marks what each step deleted as kept (so undo can
 * restore it); a dropped step can never be undone, so its deleted content is released and garbage-collected.
 */
export function trimUndo(um: Y.UndoManager, limit: number): void {
  if (um.undoStack.length <= limit) return;
  const gone = um.undoStack.splice(0, um.undoStack.length - limit);
  const doc = um.doc;
  doc.transact((tr) => {
    for (const step of gone) Y.iterateDeletedStructs(tr, step.deletions, (s) => { if (s instanceof Y.Item) s.keep = false; });
  });
  if (doc.gc) for (const step of gone) Y.tryGc(step.deletions, doc.store, doc.gcFilter);
}

function validPos(v: unknown): v is NodePos {
  return isObject(v) && finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) && v.w > 0 && v.h > 0
    && (v.parent === null || typeof v.parent === 'string');
}

function validEnd(v: unknown): v is BoardEdge['value']['source'] {
  return isObject(v) && typeof v.nodeId === 'string' && typeof v.side === 'string' && SIDE_VALUES.includes(v.side);
}

/**
 * One node from its Y.Map, or null when the entry is malformed. Anyone who may edit the board can write
 * anything into the doc, so nothing is trusted: a bad entry is skipped, never rendered.
 */
export const readNode = (id: string, m: Y.Map<unknown>): BoardNode | null => {
  const type = m.get('type');
  const pos = m.get('pos');
  const value = m.get('value');
  const color = m.get('color');
  if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) return null;
  if (!validPos(pos) || !isObject(value)) return null;
  if (color !== undefined && !isColor(color)) return null;
  if (type === 'image' && !isFileUrl(value.url)) return null;
  if (type === 'video' && !isVideoId(value.videoId)) return null;
  if (type === 'filter' && !validSmartValue(value)) return null;
  return { id, type: type as BoardNode['type'], value, pos, ...(color ? { color } : {}) };
};

/** One connector from its Y.Map, or null when malformed (see readNode). */
export const readEdge = (id: string, m: Y.Map<unknown>): BoardEdge | null => {
  const value = m.get('value');
  const label = m.get('label');
  const color = m.get('color');
  if (!isObject(value) || !validEnd(value.source) || !validEnd(value.target)) return null;
  if (label !== undefined && typeof label !== 'string') return null;
  if (color !== undefined && !isColor(color)) return null;
  return { id, value: { source: value.source, target: value.target }, ...(label ? { label } : {}), ...(color ? { color } : {}) };
};

/**
 * Mirrors one top-level map into a list. Only entries that changed get a new object, so memoised node views
 * skip the rest.
 */
function mirror<T>(map: Y.Map<Y.Map<unknown>>, read: (id: string, m: Y.Map<unknown>) => T | null, onChange: (list: T[]) => void) {
  const cache = new Map<string, T>();
  const refresh = (id: string) => {
    const m = map.get(id);
    const v = m instanceof Y.Map ? read(id, m) : null;
    if (v) cache.set(id, v); else cache.delete(id);
  };
  for (const id of map.keys()) refresh(id);
  onChange([...cache.values()]);
  const observer = (events: Array<Y.YEvent<any>>) => {
    const dirty = new Set<string>();
    for (const ev of events) {
      if (ev.target === map) for (const key of ev.changes.keys.keys()) dirty.add(key);
      else {
        // A key inside one entry: the entry's id is the first step of the path from the top-level map.
        const id = ev.path[0];
        if (typeof id === 'string') dirty.add(id);
      }
    }
    for (const id of dirty) refresh(id);
    onChange([...cache.values()]);
  };
  map.observeDeep(observer);
  return () => map.unobserveDeep(observer);
}

/** Reads the board's two maps into React state and writes back in LOCAL transactions, with per-client undo. */
export function useBoard(doc: Y.Doc | null): BoardApi {
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [edges, setEdges] = useState<BoardEdge[]>([]);
  const [stack, setStack] = useState({ undo: false, redo: false });

  const maps = useMemo(() => doc && {
    nodes: doc.getMap<Y.Map<unknown>>('nodes'),
    edges: doc.getMap<Y.Map<unknown>>('edges'),
  }, [doc]);

  // Made in an effect (not a memo) so StrictMode's mount, unmount, mount gets a live manager, not a destroyed one.
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);

  useEffect(() => {
    if (!maps) { setNodes([]); setEdges([]); return; }
    const offNodes = mirror(maps.nodes, readNode, setNodes);
    const offEdges = mirror(maps.edges, readEdge, setEdges);
    // captureTimeout 0: every transaction is its own undo step (a drop, a delete, a colour).
    const um = new Y.UndoManager([maps.nodes, maps.edges], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    const sync = () => setStack({ undo: um.canUndo(), redo: um.canRedo() });
    um.on('stack-item-added', () => { trimUndo(um, UNDO_LIMIT); sync(); });
    um.on('stack-item-popped', sync);
    um.on('stack-cleared', sync);
    setUndoManager(um);
    sync();
    return () => { offNodes(); offEdges(); um.destroy(); setUndoManager(null); setStack({ undo: false, redo: false }); };
  }, [maps]);

  return useMemo((): BoardApi => {
    const write = (fn: (m: NonNullable<typeof maps>) => void) => { if (doc && maps) doc.transact(() => fn(maps), LOCAL); };
    return {
      nodes,
      edges,
      canUndo: stack.undo,
      canRedo: stack.redo,
      undo: () => { undoManager?.undo(); },
      redo: () => { undoManager?.redo(); },
      addNode: (n) => write(({ nodes: m }) => {
        const y = new Y.Map<unknown>();
        y.set('type', n.type);
        y.set('value', n.value);
        y.set('pos', n.pos);
        if (n.color) y.set('color', n.color);
        m.set(n.id, y);
      }),
      addMany: (ns, es) => write(({ nodes: m, edges: e }) => {
        for (const n of ns) { const y = new Y.Map<unknown>(); y.set('type', n.type); y.set('value', n.value); y.set('pos', n.pos); m.set(n.id, y); }
        for (const x of es) { const y = new Y.Map<unknown>(); y.set('value', x.value); if (x.label) y.set('label', x.label); e.set(x.id, y); }
      }),
      setPos: (changes) => write(({ nodes: m }) => { for (const c of changes) m.get(c.id)?.set('pos', c.pos); }),
      setValue: (id, value, pos) => write(({ nodes: m }) => { const y = m.get(id); y?.set('value', value); if (pos) y?.set('pos', pos); }),
      setColor: (id, color) => write(({ nodes: m }) => {
        const y = m.get(id);
        if (!y) return;
        if (color) y.set('color', color); else y.delete('color');
      }),
      deleteNode: (id) => write(({ nodes: m, edges: e }) => {
        const all = <T,>(map: Y.Map<Y.Map<unknown>>, read: (id: string, y: Y.Map<unknown>) => T | null) =>
          [...map.entries()].map(([k, y]) => read(k, y)).filter((x): x is T => x !== null);
        const plan = nodesToDelete(all(m, readNode), all(e, readEdge), id);
        for (const childId of plan.unparent) {
          const child = m.get(childId);
          const pos = child?.get('pos') as NodePos | undefined;
          if (child && pos) child.set('pos', { ...pos, parent: null });
        }
        for (const edgeId of plan.edges) e.delete(edgeId);
        for (const nodeId of plan.nodes) m.delete(nodeId);
      }),
      addEdge: (edge) => write(({ edges: m }) => {
        const y = new Y.Map<unknown>();
        y.set('value', edge.value);
        if (edge.label) y.set('label', edge.label);
        if (edge.color) y.set('color', edge.color);
        m.set(edge.id, y);
      }),
      setEdgeLabel: (id, label) => write(({ edges: m }) => {
        const y = m.get(id);
        if (!y) return;
        if (label) y.set('label', label); else y.delete('label');
      }),
      setEdgeColor: (id, color) => write(({ edges: m }) => {
        const y = m.get(id);
        if (!y) return;
        if (color) y.set('color', color); else y.delete('color');
      }),
      deleteEdge: (id) => write(({ edges: m }) => { m.delete(id); }),
    };
  }, [doc, maps, nodes, edges, stack, undoManager]);
}

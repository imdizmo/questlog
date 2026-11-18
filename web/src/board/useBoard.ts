import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { COLORS, isEdgeKind, isFileUrl, isVideoId, NODE_TYPES, nodesToDelete, validSmartValue, type BoardColor, type BoardEdge, type BoardNode, type EdgeKind, type NodePos } from '../../../shared/board';
import type { BoardPatch } from './projectFrames';

/** Origin of this client's own writes; the undo manager tracks only these, so undo never reverts someone else's change. */
export const LOCAL = Symbol('local');
/**
 * Origin of the board's own upkeep (following the project, fixing parents of deleted frames): not in the undo history,
 * so undo never brings back a task that left the project, nor removes one the board added for it.
 */
export const SYNC = Symbol('sync');
/** Undo steps kept per session; older ones are dropped so a board left open for hours keeps memory flat. */
export const UNDO_LIMIT = 200;

export interface BoardApi {
  nodes: BoardNode[];
  edges: BoardEdge[];
  /** The project a project board shows (`meta.projectId`), or null for any other board. */
  projectId: string | null;
  setProjectId: (id: string) => void;
  /**
   * A planned change in one transaction with `origin` (LOCAL: one undo step). With `projectId`, the board's project is
   * set in the same transaction, so one undo reverts both.
   */
  applyPatch: (patch: BoardPatch, origin?: unknown, projectId?: string) => void;
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
  /** An empty label removes it. With `kind`, the line also stands for that in the project (same transaction). */
  setEdgeLabel: (id: string, label: string, kind?: EdgeKind) => void;
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

/** The board's three maps: nodes, edges, and meta (board-wide settings such as `projectId`). */
export interface BoardMaps {
  nodes: Y.Map<Y.Map<unknown>>;
  edges: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<unknown>;
}

export const boardMaps = (doc: Y.Doc): BoardMaps => ({
  nodes: doc.getMap<Y.Map<unknown>>('nodes'),
  edges: doc.getMap<Y.Map<unknown>>('edges'),
  meta: doc.getMap<unknown>('meta'),
});

/** `meta.projectId` when it is a non-empty string (anyone who may edit can write anything there). */
export const readProjectId = (meta: Y.Map<unknown>): string | null => {
  const v = meta.get('projectId');
  return typeof v === 'string' && v ? v : null;
};

/**
 * The undo manager of one client: tracks only LOCAL writes; meta is in scope, so a step that sets the board's project
 * (a layout or "Arrange as frames") is undone as a whole.
 */
export function boardUndo(maps: BoardMaps): Y.UndoManager {
  // captureTimeout 0: every transaction is its own undo step (a drop, a delete, a colour).
  return new Y.UndoManager([maps.nodes, maps.edges, maps.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
}

const yNode = (n: BoardNode) => {
  const y = new Y.Map<unknown>();
  y.set('type', n.type);
  y.set('value', n.value);
  y.set('pos', n.pos);
  if (n.color) y.set('color', n.color);
  return y;
};
const yEdge = (e: BoardEdge) => {
  const y = new Y.Map<unknown>();
  y.set('value', e.value);
  if (e.label) y.set('label', e.label);
  if (e.color) y.set('color', e.color);
  return y;
};

/** Writes a planned patch (and optionally the board's project) in one transaction with `origin`. */
export function writePatch(doc: Y.Doc, maps: BoardMaps, patch: BoardPatch, origin: unknown, projectId?: string): void {
  doc.transact(() => {
    for (const id of patch.removeEdges) maps.edges.delete(id);
    for (const id of patch.remove) maps.nodes.delete(id);
    for (const n of patch.add) maps.nodes.set(n.id, yNode(n));
    for (const m of patch.move) maps.nodes.get(m.id)?.set('pos', m.pos);
    for (const u of patch.update) maps.nodes.get(u.id)?.set('value', u.value);
    for (const e of patch.addEdges) maps.edges.set(e.id, yEdge(e));
    for (const u of patch.updateEdges ?? []) maps.edges.get(u.id)?.set('value', u.value);
    if (projectId) maps.meta.set('projectId', projectId);
  }, origin);
}

/**
 * Nodes whose parent no longer exists (an undo removed the frame that reconcile had filled) become loose: `parent`
 * null, positions as they are. One SYNC transaction; returns how many changed.
 */
export function unparentOrphans(doc: Y.Doc, maps: BoardMaps): number {
  const orphans: Array<[Y.Map<unknown>, NodePos]> = [];
  maps.nodes.forEach((m) => {
    const pos = m instanceof Y.Map ? m.get('pos') : undefined;
    if (isObject(pos) && typeof pos.parent === 'string' && !maps.nodes.has(pos.parent)) orphans.push([m, pos as unknown as NodePos]);
  });
  if (orphans.length) doc.transact(() => { for (const [m, pos] of orphans) m.set('pos', { ...pos, parent: null }); }, SYNC);
  return orphans.length;
}

/** The board as it is in the document now (React may not have drawn the latest nodes yet). */
export function readBoard(doc: Y.Doc): { nodes: BoardNode[]; edges: BoardEdge[]; projectId: string | null } {
  const maps = boardMaps(doc);
  const nodes: BoardNode[] = [], edges: BoardEdge[] = [];
  maps.nodes.forEach((m, id) => { const n = m instanceof Y.Map ? readNode(id, m) : null; if (n) nodes.push(n); });
  maps.edges.forEach((m, id) => { const e = m instanceof Y.Map ? readEdge(id, m) : null; if (e) edges.push(e); });
  return { nodes, edges, projectId: readProjectId(maps.meta) };
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
  const kind = isEdgeKind(value.kind) ? { kind: value.kind } : {};
  return { id, value: { source: value.source, target: value.target, ...kind }, ...(label ? { label } : {}), ...(color ? { color } : {}) };
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
  const [projectId, setProject] = useState<string | null>(null);
  const [stack, setStack] = useState({ undo: false, redo: false });

  const maps = useMemo(() => doc && boardMaps(doc), [doc]);

  // Made in an effect (not a memo) so StrictMode's mount, unmount, mount gets a live manager, not a destroyed one.
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);

  useEffect(() => {
    if (!maps) { setNodes([]); setEdges([]); setProject(null); return; }
    const offNodes = mirror(maps.nodes, readNode, setNodes);
    const offEdges = mirror(maps.edges, readEdge, setEdges);
    const onMeta = () => setProject(readProjectId(maps.meta));
    onMeta();
    maps.meta.observe(onMeta);
    const um = boardUndo(maps);
    const sync = () => setStack({ undo: um.canUndo(), redo: um.canRedo() });
    um.on('stack-item-added', () => { trimUndo(um, UNDO_LIMIT); sync(); });
    um.on('stack-item-popped', sync);
    um.on('stack-cleared', sync);
    setUndoManager(um);
    sync();
    return () => { offNodes(); offEdges(); maps.meta.unobserve(onMeta); um.destroy(); setUndoManager(null); setStack({ undo: false, redo: false }); };
  }, [maps]);

  return useMemo((): BoardApi => {
    const write = (fn: (m: NonNullable<typeof maps>) => void) => { if (doc && maps) doc.transact(() => fn(maps), LOCAL); };
    return {
      nodes,
      edges,
      projectId,
      setProjectId: (id) => write(({ meta }) => { meta.set('projectId', id); }),
      applyPatch: (patch, origin = LOCAL, project) => { if (doc && maps) writePatch(doc, maps, patch, origin, project); },
      canUndo: stack.undo,
      canRedo: stack.redo,
      undo: () => { undoManager?.undo(); },
      redo: () => { undoManager?.redo(); },
      addNode: (n) => write(({ nodes: m }) => { m.set(n.id, yNode(n)); }),
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
      setEdgeLabel: (id, label, kind) => write(({ edges: m }) => {
        const y = m.get(id);
        if (!y) return;
        if (label) y.set('label', label); else y.delete('label');
        const v = y.get('value');
        if (kind && isObject(v)) y.set('value', { ...v, kind });
      }),
      setEdgeColor: (id, color) => write(({ edges: m }) => {
        const y = m.get(id);
        if (!y) return;
        if (color) y.set('color', color); else y.delete('color');
      }),
      deleteEdge: (id) => write(({ edges: m }) => { m.delete(id); }),
    };
  }, [doc, maps, nodes, edges, projectId, stack, undoManager]);
}

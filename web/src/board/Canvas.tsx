import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import type * as Y from 'yjs';
import {
  adoptAfterResize, containerAt, DEFAULT_SIZE, filterSize, GRID, nearestSide, newId, newNodeAt, snap, spotBeside, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  type BoardNode, type EdgeEnd, type NodePos, type NodeType, type Point, type Rect, type Side,
} from '../../../shared/board';
import { cardCode, derivedStatus, titleOf } from '../../../shared/cards';
import { planProjectTree, planStoryboard, refOf, SCENE, SUBTASK, WAITS_FOR } from './projectTree';
import { isStoryline, makeFrame } from '../components/wiki/Builder';
import { lockersOf } from '../relations';
import { openByCard } from '../cards';
import { spaceLabel } from '../spaces';
import { showToast } from '../toast';
import { dispatch } from '../api';
import { Dialog } from '../components/Dialog';
import { projectVisible } from '../store';
import type { Card } from '../../../shared/types';
import { encodeChips } from '../../../shared/search';
import { navigate, setQuery, useLocation } from '../router';
import { settingsOf, store, useStore } from '../store';
import { CardView } from '../views/Card';
import { Icon, type IconName } from '../components/icons';
import { CardNodeDialog } from './CardNodeDialog';
import { ImageDialog, VideoDialog } from './MediaDialogs';
import { readNode, useBoard } from './useBoard';
import { NodeView, handlesFor, initialValue, TYPE_LABEL, type Handle } from './nodes';
import { NodeToolbar } from './NodeToolbar';
import { SmartFilterPanel } from './SmartFilterPanel';
import { smartToStored, smartValue, type SmartValue } from './SmartNode';
import { Edges, edgeGeometry, type ConnectPreview } from './Edges';
import type { Awareness } from 'y-protocols/awareness';
import { PresenceLayer, useLocalPresence } from './Presence';

/** Board units → screen: screen = s * (board + (x, y)). Pan and zoom live here only, never in the doc. */
interface View { x: number; y: number; s: number }

const TOOLS: Array<{ type: NodeType; icon: IconName }> = [
  { type: 'text', icon: 'text' }, { type: 'image', icon: 'asset' }, { type: 'video', icon: 'play' },
  { type: 'card', icon: 'card' }, { type: 'filter', icon: 'smart' }, { type: 'container', icon: 'frame' },
];

/** Pixels the pointer must travel before a press becomes a drag (below that it is a click). */
const DRAG_SLOP = 3;
const FOCUS_FILL = 0.6;
/** Arrow keys move by one grid step, Shift+arrow by this many. */
const BIG_STEP = 5;
/** Arrow keys on the empty canvas pan by this many pixels. */
const PAN_STEP = 40;

const clampZoom = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(s * 10) / 10));

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

const ARROWS: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };

type Gesture =
  | { kind: 'pan'; start: Point; view: View; moved: boolean; onEmpty: boolean }
  | { kind: 'move'; start: Point; id: string; ids: string[]; moved: boolean }
  | { kind: 'resize'; start: Point; id: string; handle: Handle; rect: Rect; moved: boolean }
  | { kind: 'connect'; start: Point; from: EdgeEnd; moved: boolean }
  | { kind: 'marquee'; start: Point; from: Point; moved: boolean };

function descendants(nodes: BoardNode[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  for (let i = -1; i < out.length; i++) {
    const p = i < 0 ? id : out[i];
    for (const n of nodes) if (n.pos.parent === p && !seen.has(n.id)) { seen.add(n.id); out.push(n.id); }
  }
  return out;
}

function resized(r: Rect, h: Handle, dx: number, dy: number): Rect {
  let { x, y, w, h: ht } = r;
  if (h.includes('e')) w = Math.max(GRID, r.w + dx);
  if (h.includes('w')) { w = Math.max(GRID, r.w - dx); x = r.x + r.w - w; }
  if (h.includes('s')) ht = Math.max(GRID, r.h + dy);
  if (h.includes('n')) { ht = Math.max(GRID, r.h - dy); y = r.y + r.h - ht; }
  return { x, y, w, h: ht };
}

/** Snaps each edge to the grid, keeping at least one grid unit. */
function snapRect(r: Rect): Rect {
  const x = snap(r.x), y = snap(r.y);
  return { x, y, w: Math.max(GRID, snap(r.x + r.w) - x), h: Math.max(GRID, snap(r.y + r.h) - y) };
}

const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** The vision board: tool rail, pannable and zoomable node layer, selection toolbar, undo. */
export function Canvas({ doc, canEdit, host, awareness = null }: { doc: Y.Doc | null; canEdit: boolean; host: Card; awareness?: Awareness | null }) {
  const board = useBoard(doc);
  const meId = useStore((x) => x.me?.id);
  const settings = useStore(settingsOf);
  const { nodes, edges } = board;
  const sectionRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  const [tool, setTool] = useState<NodeType | null>(null);
  const [selected, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const lastEdgeDown = useRef<{ id: string; at: number } | null>(null);
  /** Drawn heights of the frames that outgrew their stored size (local, never written to the board). */
  const [grown, setGrown] = useState<Map<string, number>>(new Map());
  const onGrow = useCallback((id: string, h: number) => setGrown((m) => (m.get(id) === h ? m : new Map(m).set(id, h))), []);
  /** Nodes picked together with the selection box (two or more; a single one is the ordinary selection). */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  /** The selection box being drawn, in board units. */
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** The right-click menu: where it shows (pixels in the canvas) and where its node goes (board units). */
  const [menu, setMenu] = useState<{ left: number; top: number; at: Point } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: EdgeEnd; to: Point } | null>(null);
  const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null);
  const [resize, setResize] = useState<{ id: string; rect: Rect } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** A card, image or video node waits for its dialog: nothing is written until the dialog completes. */
  const [dialog, setDialog] = useState<{ type: 'card' | 'image' | 'video'; at: Point; fromKeyboard: boolean } | null>(null);
  /** The card shown in the side panel over the board (a node id, so the panel follows the node's card). */
  const [openNode, setOpenNode] = useState<string | null>(null);
  /** The Smart Node whose filter panel is open; it shares the side with the card panel, so only one shows. */
  const [setupNode, setSetupNode] = useState<string | null>(null);
  /** The project picker for "Project tree", and the question a line between two tasks raises. */
  const [treeAsk, setTreeAsk] = useState(false);
  const [linkAsk, setLinkAsk] = useState<{ edgeId: string; a: string; b: string } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /** Where focus goes after the next render: a node id, or 'canvas' for the viewport. */
  const pendingFocus = useRef<string | null>(null);
  /** Set while we move focus to a node on purpose without selecting it (Esc from the toolbar). */
  const quietFocus = useRef(false);

  // Latest values for handlers registered once (keyboard, wheel).
  const live = useRef({ board, view, tool, selected, selectedEdge, canEdit, multi });
  useLayoutEffect(() => { live.current = { board, view, tool, selected, selectedEdge, canEdit, multi }; });

  /** One selection at a time: a node or a connector. */
  const setSelected = useCallback((id: string | null) => { setSelectedNode(id); if (id) setSelectedEdge(null); }, []);
  const selectEdge = useCallback((id: string | null) => { setSelectedEdge(id); if (id) setSelectedNode(null); }, []);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selNode = selected ? byId.get(selected) : undefined;
  const { setCursor } = useLocalPresence(awareness, meId, useMemo(() => (selNode ? [selNode.id] : []), [selNode]));
  const peerRects = useMemo(() => new Map(nodes.map((n) => [n.id, n.pos])), [nodes]);
  const selEdge = selectedEdge ? edges.find((e) => e.id === selectedEdge) : undefined;
  // Containers first (largest at the back), so the nodes they hold stay on top and clickable.
  const ordered = useMemo(() => {
    const area = (n: BoardNode) => (n.type === 'container' ? n.pos.w * n.pos.h : -1);
    return [...nodes].sort((a, b) => area(b) - area(a));
  }, [nodes]);

  useEffect(() => { if (!canEdit) { setTool(null); setEditing(null); setEditingEdge(null); setConnecting(null); } }, [canEdit]);
  useEffect(() => { if (selected && !selNode) { setSelected(null); setEditing(null); } }, [selected, selNode, setSelected]);
  useEffect(() => { if (selectedEdge && !selEdge) { setSelectedEdge(null); setEditingEdge(null); } }, [selectedEdge, selEdge]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const el = target === 'canvas' ? viewportRef.current : viewportRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target)}"], [data-edge-id="${CSS.escape(target)}"]`);
    el?.focus({ preventScroll: true });
    quietFocus.current = false;
  });

  const viewportCentre = (): Point => {
    const el = viewportRef.current!;
    const v = live.current.view;
    return { x: el.clientWidth / 2 / v.s - v.x, y: el.clientHeight / 2 / v.s - v.y };
  };

  const toBoard = useCallback((clientX: number, clientY: number, v: View = live.current.view): Point => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / v.s - v.x, y: (clientY - r.top) / v.s - v.y };
  }, []);

  /** Zoom to s keeping the board point under `at` (viewport px; default the centre) in place. */
  const zoomTo = useCallback((s: number, at?: Point) => {
    setView((v) => {
      const el = viewportRef.current;
      const p = at ?? { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 };
      const next = clampZoom(s);
      const bx = p.x / v.s - v.x, by = p.y / v.s - v.y;
      return { s: next, x: p.x / next - bx, y: p.y / next - by };
    });
  }, []);

  /** Frames a rect (a node, or both ends of a connector) at about 60 % of the view. */
  const focusRect = useCallback((r: Rect) => {
    const el = viewportRef.current;
    if (!el) return;
    const { clientWidth: vw, clientHeight: vh } = el;
    const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.floor(Math.min((FOCUS_FILL * vw) / r.w, (FOCUS_FILL * vh) / r.h) * 10) / 10));
    setView({ s, x: vw / (2 * s) - (r.x + r.w / 2), y: vh / (2 * s) - (r.y + r.h / 2) });
  }, []);

  const remove = useCallback((id: string) => {
    live.current.board.deleteNode(id);
    setSelected(null);
    setEditing(null);
    pendingFocus.current = 'canvas';
  }, []);

  const removeEdge = useCallback((id: string) => {
    // Removing a line that means something takes the meaning with it: the dependency, or the parent.
    const e = live.current.board.edges.find((x) => x.id === id);
    const end = (nodeId: string) => { const n = live.current.board.nodes.find((x) => x.id === nodeId); const r = n ? refOf(n) ?? '' : ''; return r.startsWith('card:') ? r.slice(5) : null; };
    const src = e ? end(e.value.source.nodeId) : null, dst = e ? end(e.value.target.nodeId) : null;
    if (e && src && dst && live.current.canEdit) {
      const s = store.get();
      if (e.label === WAITS_FOR) void dispatch('cards', 'update', { id: src, inDeps: lockersOf(s.cardDeps.values(), src).filter((x) => x !== dst) }).catch(() => {});
      else if (e.label === SUBTASK && s.cards.get(dst)?.parentCardId === src) void dispatch('cards', 'update', { id: dst, parentCardId: null }).catch(() => {});
    }
    live.current.board.deleteEdge(id);
    setSelectedEdge(null);
    setEditingEdge(null);
    pendingFocus.current = 'canvas';
  }, []);

  /** One write: a new connector, selected and focused. Pass sides to fix them, else each end faces the other node. */
  const connect = (from: EdgeEnd, to: EdgeEnd) => {
    const id = newId();
    live.current.board.addEdge({ id, value: { source: from, target: to } });
    selectEdge(id);
    pendingFocus.current = id;
    // A line that joins project things means something: task to task asks what, task to list moves the task.
    const a = byId.get(from.nodeId), b = byId.get(to.nodeId);
    if (!a || !b) return;
    const ra = refOf(a) ?? '', rb = refOf(b) ?? '';
    // Two tasks: ask what the line means. Wiki entries (a storyline's frames) are not tasks: their line is only a line.
    const isTask = (r: string) => r.startsWith('card:') && store.get().cards.get(r.slice(5))?.isDoc === false;
    if (isTask(ra) && isTask(rb)) setLinkAsk({ edgeId: id, a: ra.slice(5), b: rb.slice(5) });
    else if (ra.startsWith('card:') && rb.startsWith('deck:')) moveToList(a, b, id);
    else if (ra.startsWith('deck:') && rb.startsWith('card:')) moveToList(b, a, id);
    else if (ra.startsWith('deck:') && rb.startsWith('area:')) moveToArea(a, b, id);
    else if (ra.startsWith('area:') && rb.startsWith('deck:')) moveToArea(b, a, id);
  };
  /** The list goes to the area it was just joined to (same project only); its line to the old area goes away. */
  const moveToArea = (list: BoardNode, area: BoardNode, keep: string) => {
    const s = store.get(), deck = s.decks.get((refOf(list) ?? '').slice(5)), [, projectId, spaceId] = (refOf(area) ?? '').split(':');
    if (!deck || deck.projectId !== projectId || deck.spaceId === Number(spaceId)) return;
    void dispatch('decks', 'update', { id: deck.id, spaceId: Number(spaceId) }).then(() => {
      for (const e of live.current.board.edges) {
        if (e.id === keep) continue;
        const other = e.value.source.nodeId === list.id ? e.value.target.nodeId : e.value.target.nodeId === list.id ? e.value.source.nodeId : null;
        const o = other ? live.current.board.nodes.find((n) => n.id === other) : undefined;
        if (o && (refOf(o) ?? '').startsWith('area:')) live.current.board.deleteEdge(e.id);
      }
      showToast(`${deck.title} moved to ${String(area.value.content ?? 'the area')}`, 'info', 3000);
    }).catch(() => { live.current.board.deleteEdge(keep); });
  };
  /** The task goes to the list it was just joined to; its line to the old list goes away. */
  const moveToList = (task: BoardNode, list: BoardNode, keep: string) => {
    const s = store.get(), card = s.cards.get(String(task.value.id)), deckId = (refOf(list) ?? '').slice(5), deck = s.decks.get(deckId);
    if (!card || !deck || card.deckId === deckId) return;
    void dispatch('cards', 'update', { id: card.id, deckId, parentCardId: null }).then(() => {
      for (const e of live.current.board.edges) {
        if (e.id === keep) continue;
        const other = e.value.source.nodeId === task.id ? e.value.target.nodeId : e.value.target.nodeId === task.id ? e.value.source.nodeId : null;
        const o = other ? live.current.board.nodes.find((n) => n.id === other) : undefined;
        if (o && (refOf(o) ?? '').startsWith('deck:')) live.current.board.deleteEdge(e.id);
      }
      showToast(`${titleOf(card.content)} moved to ${deck.title}`, 'info', 3000);
    }).catch(() => { live.current.board.deleteEdge(keep); });
  };
  /** Adds the project as a tree, or only what is new since the last time. One undo step. */
  const addProjectTree = (projectId: string) => {
    const s = store.get(), project = s.projects.get(projectId);
    if (!project || !live.current.canEdit) return;
    const open = openByCard(s.resolvables.values());
    const decks = [...s.decks.values()].filter((d) => d.projectId === projectId).sort((x, y) => x.sortIndex - y.sortIndex || x.seq - y.seq);
    const inDeck = new Set(decks.map((d) => d.id));
    const cards = [...s.cards.values()].filter((c) => c.deckId && inDeck.has(c.deckId) && c.visibility === 'default' && !c.isDoc
      && derivedStatus(c, open.get(c.id) ?? new Set()) !== 'done');
    const plan = planProjectTree({
      project, decks, cards, deps: [...s.cardDeps.values()], nodes: live.current.board.nodes, edges: live.current.board.edges,
      areaName: (id) => { const sp = project.spaces.find((x) => x.id === id); return sp ? spaceLabel(sp) : ''; },
    });
    live.current.board.addMany(plan.nodes, plan.edges);
    const tasks = plan.nodes.filter((n) => n.type === 'card').length;
    showToast(plan.nodes.length || plan.edges.length ? `Added ${tasks} ${tasks === 1 ? 'task' : 'tasks'} and ${plan.edges.length} ${plan.edges.length === 1 ? 'line' : 'lines'}` : 'Nothing new: the tree is up to date', 'info', 4000);
    setTreeAsk(false);
  };
  // A board opened as `?tree=<project>` (a new project board) lays that project out once.
  const treeParam = useLocation().query.get('tree');
  useEffect(() => {
    if (!treeParam || !doc || !canEdit) return;
    setQuery('tree', null);
    addProjectTree(treeParam);
  }, [treeParam, doc, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  // A storyline's board opened as `?story=1` gets a picture card for every frame that is not on it yet.
  const storyParam = useLocation().query.get('story');
  useEffect(() => {
    if (!storyParam || !doc || !canEdit) return;
    setQuery('story', null);
    // Only once the board's own content is here: planned against an empty board, every frame would be added again.
    void doc.whenSynced.then(() => {
      const s = store.get();
      const frames = [...s.entryLinks.values()].filter((l) => l.fromCardId === host.id && l.kindKey === 'frames' && s.cards.has(l.toCardId)).sort((a, b) => a.sortIndex - b.sortIndex);
      // Read from the document itself: React has not drawn the just-arrived nodes yet.
      const onBoard: BoardNode[] = [];
      doc.getMap<Y.Map<unknown>>('nodes').forEach((m, id) => { const n = readNode(id, m); if (n) onBoard.push(n); });
      const plan = planStoryboard(frames.map((l) => l.toCardId), onBoard);
      if (plan.nodes.length && live.current.canEdit) live.current.board.addMany(plan.nodes, plan.edges);
    });
  }, [storyParam, doc, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  /** What the line between two tasks means; "only a line" leaves the project alone. */
  const meanLink = (kind: 'dep' | 'sub') => {
    if (!linkAsk) return;
    const { a, b, edgeId } = linkAsk;
    setLinkAsk(null);
    const s = store.get();
    const patch = kind === 'dep' ? { inDeps: [...new Set([...lockersOf(s.cardDeps.values(), a), b])] } : { parentCardId: b };
    void dispatch('cards', 'update', { id: a, ...patch })
      .then(() => {
        if (kind === 'dep') { live.current.board.setEdgeLabel(edgeId, WAITS_FOR); return; }
        // A subtask line always runs parent → child, as the tree draws it: redraw the one just made the other way round.
        const e = live.current.board.edges.find((x) => x.id === edgeId);
        if (!e) return;
        live.current.board.deleteEdge(edgeId);
        live.current.board.addEdge({ id: newId(), value: { source: e.value.target, target: e.value.source }, label: SUBTASK });
      })
      .catch(() => { /* the toast says why; the line stays as a plain line */ });
  };

  /** One write: the node moves by (dx, dy) board units, snapped; parent recomputed; a container's descendants follow. */
  const moveNode = (id: string, dx: number, dy: number) => {
    const self = byId.get(id);
    if (!self || !live.current.canEdit) return;
    const x = snap(self.pos.x + dx), y = snap(self.pos.y + dy);
    const ddx = x - self.pos.x, ddy = y - self.pos.y;
    const rect = { x, y, w: self.pos.w, h: self.pos.h };
    const changes: Array<{ id: string; pos: NodePos }> = [{ id, pos: { ...rect, parent: containerAt(nodes, rect, id) } }];
    for (const cid of descendants(nodes, id)) {
      const c = byId.get(cid);
      if (c) changes.push({ id: cid, pos: { ...c.pos, x: c.pos.x + ddx, y: c.pos.y + ddy } });
    }
    board.setPos(changes);
  };

  /** One write: the node gets the snapped rect; a container adopts what it now encloses. */
  const resizeNode = (id: string, r: Rect) => {
    const self = byId.get(id);
    if (!self || !live.current.canEdit) return;
    const pos: NodePos = { ...snapRect(r), parent: self.pos.parent };
    const changes = [{ id, pos }];
    if (self.type === 'container') {
      const after = nodes.map((n) => (n.id === id ? { ...n, pos } : n));
      for (const cid of adoptAfterResize(after, id)) {
        const c = byId.get(cid);
        if (c && c.pos.parent !== id) changes.push({ id: cid, pos: { ...c.pos, parent: id } });
      }
    }
    board.setPos(changes);
  };

  /** One write: the node, selected and focused (a text node opens its editor instead). */
  const addPlaced = (type: NodeType, at: Point, value: Record<string, unknown>) => {
    if (!live.current.canEdit) return;
    const placed = newNodeAt(type, at, value);
    if (value.mode === 'scene') Object.assign(placed.pos, SCENE);
    placed.pos.parent = containerAt(nodes, placed.pos);
    board.addNode(placed);
    setTool(null);
    setSelected(placed.id);
    if (type === 'text') setEditing(placed.id);
    else { setEditing(null); pendingFocus.current = placed.id; }
  };

  const place = (type: NodeType, at: Point, fromKeyboard = false) => {
    if (type === 'card' || type === 'image' || type === 'video') {
      setTool(null);
      setDialog({ type, at, fromKeyboard });
    } else addPlaced(type, at, initialValue(type));
  };

  /** A dialog ended without a node: from the keyboard the dialog gives focus back to the tool; otherwise to the canvas. */
  const cancelDialog = () => {
    if (dialog && !dialog.fromKeyboard) pendingFocus.current = 'canvas';
    setDialog(null);
  };
  const finishDialog = (value: Record<string, unknown>) => {
    if (!dialog) return;
    setDialog(null);
    addPlaced(dialog.type, dialog.at, value);
  };

  const openCard = (nodeId: string) => {
    const n = byId.get(nodeId);
    const c = n?.type === 'card' ? store.get().cards.get(String(n.value.id)) : undefined;
    if (c && c.visibility !== 'deleted') { setSetupNode(null); setOpenNode(nodeId); }
  };
  const setupFilter = useCallback((nodeId: string) => {
    if (!live.current.canEdit) return;
    setOpenNode(null);
    setSetupNode(nodeId);
  }, []);
  const filterNode = setupNode ? byId.get(setupNode) : undefined;
  const closeSetup = () => { if (setupNode) pendingFocus.current = setupNode; setSetupNode(null); };
  useEffect(() => { if (setupNode && (!filterNode || filterNode.type !== 'filter' || !canEdit)) setSetupNode(null); }, [setupNode, filterNode, canEdit]);

  /** One write: the Smart Node's new display; its size follows the mode (Table is taller) in the same undo step. */
  const changeSmart = (node: BoardNode, patch: Partial<SmartValue>) => {
    if (!live.current.canEdit) return;
    const next = { ...smartValue(node.value), ...patch };
    const size = filterSize(next.mode);
    const resize = patch.mode && patch.mode !== smartValue(node.value).mode ? { ...node.pos, w: size.w, h: size.h } : undefined;
    board.setValue(node.id, smartToStored(next), resize);
  };
  /** One write: a card node beside the Smart Node, on the first free grid spot. */
  const addCardBeside = (anchor: BoardNode, cardId: string) => {
    if (!live.current.canEdit) return;
    const size = DEFAULT_SIZE.card;
    const at = spotBeside(nodes, anchor.pos, size);
    board.addNode({ id: newId(), type: 'card', value: { id: cardId, mode: 'mini' }, pos: { ...at, ...size, parent: containerAt(nodes, { ...at, ...size }) } });
  };
  const openAsSearch = (node: BoardNode) => {
    const q = smartValue(node.value).queryId ? store.get().visionQueries.get(smartValue(node.value).queryId!) : undefined;
    if (q) navigate(q.query.tokens.length ? `/decks?search=${encodeChips(q.query.tokens, q.query.forceOr)}` : '/decks');
  };
  const panelCard = (() => {
    const n = openNode ? byId.get(openNode) : undefined;
    const c = n?.type === 'card' ? store.get().cards.get(String(n.value.id)) : undefined;
    return c && c.visibility !== 'deleted' ? c : undefined;
  })();
  const closePanel = () => { if (openNode) pendingFocus.current = openNode; setOpenNode(null); };
  useEffect(() => { if (openNode && !panelCard) setOpenNode(null); }, [openNode, panelCard]);
  // Opening the panel moves focus into it (its close button comes first), so the keyboard follows the view.
  useEffect(() => { if (openNode) sectionRef.current?.querySelector<HTMLElement>('.board-card-panel .panel-close')?.focus(); }, [openNode]);

  // Keyboard anywhere on the page: Esc, Delete/Backspace, Ctrl+Z, Ctrl+Shift+Z. Inputs keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || editable(e.target) || document.querySelector('dialog[open]') || (e.target as Element).closest?.('.board-card-panel')) return;
      const { board: b, tool: t, selected: sel, selectedEdge: selE, canEdit: ce } = live.current;
      const mod = e.ctrlKey || e.metaKey;
      // Editing keys act only with focus on the board (or nowhere): not from the header menus or the node toolbar.
      const tgt = e.target as Element;
      const onBoard = tgt === document.body || (!!sectionRef.current?.contains(tgt) && !tgt.closest?.('.btoolbar'));
      if (e.key === 'Escape') {
        if (t) { setTool(null); e.preventDefault(); } else if (live.current.multi.size) { setMulti(new Set()); e.preventDefault(); } else if (sel) { setSelected(null); e.preventDefault(); } else if (selE) { selectEdge(null); e.preventDefault(); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && ce && onBoard && (sel || selE || live.current.multi.size)) {
        e.preventDefault();
        if (live.current.multi.size) { for (const id of live.current.multi) remove(id); setMulti(new Set()); } else if (sel) remove(sel); else removeEdge(selE!);
      } else if (mod && !e.altKey && e.code === 'KeyZ' && ce && onBoard) {
        e.preventDefault();
        if (e.shiftKey) b.redo(); else b.undo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [remove, removeEdge, setSelected, selectEdge]);

  // Keys with focus in the canvas: arrows move (Alt: resize) the focused node or pan; Enter edits or places; +/- zoom.
  const onCanvasKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editable(e.target) || e.ctrlKey || e.metaKey) return;
    const el = e.target as HTMLElement;
    const id = el.dataset?.nodeId;
    const node = id ? byId.get(id) : undefined;
    const edgeId = el.dataset?.edgeId;
    const arrow = ARROWS[e.key];
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(view.s + ZOOM_STEP); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(view.s - ZOOM_STEP); return; }
    if (edgeId) {
      if (arrow) e.preventDefault();
      if (e.key === ' ') { e.preventDefault(); selectEdge(edgeId); }
      else if (e.key === 'Enter' && canEdit) { e.preventDefault(); selectEdge(edgeId); setEditingEdge(edgeId); }
      return;
    }
    if (arrow && node) {
      e.preventDefault();
      if (!canEdit) return;
      const step = GRID * (e.shiftKey ? BIG_STEP : 1);
      if (e.altKey) {
        if (handlesFor(node.type).length) resizeNode(node.id, { ...node.pos, w: node.pos.w + arrow.x * step, h: node.pos.h + arrow.y * step });
      } else moveNode(node.id, arrow.x * step, arrow.y * step);
      return;
    }
    if (arrow && el === viewportRef.current) {
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - (arrow.x * PAN_STEP) / v.s, y: v.y - (arrow.y * PAN_STEP) / v.s }));
      return;
    }
    if (e.key === ' ' && node) { e.preventDefault(); setSelected(node.id); return; }
    if (e.key === 'Enter') {
      if (node && canEdit && (node.type === 'text' || node.type === 'container')) { e.preventDefault(); setSelected(node.id); setEditing(node.id); }
      else if (node?.type === 'card') { e.preventDefault(); openCard(node.id); }
      else if (node?.type === 'filter' && canEdit) { e.preventDefault(); setupFilter(node.id); }
      else if (!node && tool && canEdit) { e.preventDefault(); place(tool, viewportCentre(), true); }
    }
  };

  const onNodeFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const id = el.dataset?.nodeId;
    const edgeId = el.dataset?.edgeId;
    if (edgeId) { if (!quietFocus.current && edgeId !== live.current.selectedEdge) selectEdge(edgeId); return; }
    if (!id) return;
    // Tab can scroll the clipped viewport to reach a node; undo that and pan to the node instead.
    const vp = viewportRef.current!;
    if (vp.scrollLeft || vp.scrollTop) { vp.scrollLeft = 0; vp.scrollTop = 0; }
    const sec = sectionRef.current!;
    if (sec.scrollLeft || sec.scrollTop) { sec.scrollLeft = 0; sec.scrollTop = 0; }
    const n = byId.get(id);
    if (n) {
      const v = live.current.view;
      const left = v.s * (n.pos.x + v.x), top = v.s * (n.pos.y + v.y);
      if (left < 0 || top < 0 || left + v.s * n.pos.w > vp.clientWidth || top + v.s * n.pos.h > vp.clientHeight) {
        setView({ ...v, x: vp.clientWidth / (2 * v.s) - (n.pos.x + n.pos.w / 2), y: vp.clientHeight / (2 * v.s) - (n.pos.y + n.pos.h / 2) });
      }
    }
    if (!quietFocus.current && id !== live.current.selected) setSelected(id);
  };

  // The wheel zooms about the pointer; Shift+wheel pans (for a trackpad). Registered by hand: React's wheel listener is passive.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!e.shiftKey) {
        if (e.timeStamp - last < 60 || e.deltaY === 0) return; // one 10 % step per notch, not per trackpad tick
        last = e.timeStamp;
        const r = el.getBoundingClientRect();
        const v = live.current.view;
        zoomTo(v.s + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX / v.s, y: v.y - e.deltaY / v.s }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo, doc]);

  useEffect(() => {
    const section = sectionRef.current;
    const onChange = () => setFullscreen(document.fullscreenElement === section);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (section && document.fullscreenElement === section) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void sectionRef.current?.requestFullscreen().catch(() => {});
  };

  const chooseTool = (type: NodeType, e: ReactMouseEvent) => {
    // Activated from the keyboard (no pointer, detail 0): place at the centre of the view right away.
    if (e.detail === 0 && doc) place(type, viewportCentre(), true);
    else setTool((x) => (x === type ? null : type));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    setMenu(null);
    // The middle button moves the view from anywhere on the board.
    if (e.button === 1) {
      e.preventDefault();
      gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, view, moved: false, onEmpty: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const target = e.target as Element;
    if (!(tool && canEdit) && target.closest('a[href], [data-node-action]')) return; // a link or button in a node: pointer capture would swallow its click
    if (tool && canEdit) {
      e.preventDefault(); // keeps focus off the viewport so the new text node's input stays focused
      (document.activeElement as HTMLElement | null)?.blur?.();
      place(tool, toBoard(e.clientX, e.clientY));
      return;
    }
    const conn = target.closest<HTMLElement>('[data-connect-side]');
    if (conn && canEdit) {
      e.preventDefault(); // a handle is a drag source, not a focus target
      gesture.current = { kind: 'connect', start, from: { nodeId: conn.dataset.connectNode!, side: conn.dataset.connectSide as Side }, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const edgeEl = target.closest<HTMLElement>('[data-edge-id]');
    if (edgeEl) {
      e.preventDefault();
      setEditing(null);
      selectEdge(edgeEl.dataset.edgeId!);
      // The second press of a double-click opens the label. Timed here: pointer events carry no click count, and the
      // pointer capture below keeps a dblclick event from reaching the line.
      const last = lastEdgeDown.current;
      lastEdgeDown.current = { id: edgeEl.dataset.edgeId!, at: e.timeStamp };
      if (canEdit && last && last.id === edgeEl.dataset.edgeId && e.timeStamp - last.at < 450) { setEditingEdge(last.id); return; }
      edgeEl.focus({ preventScroll: true });
      gesture.current = { kind: 'pan', start, view, moved: false, onEmpty: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]');
    const nodeEl = handle ? null : target.closest<HTMLElement>('[data-node-id]');
    const id = handle ? handle.closest<HTMLElement>('[data-sel-id]')?.dataset.selId : nodeEl?.dataset.nodeId;
    const node = id ? byId.get(id) : undefined;
    if (node && id !== editing) setEditing(null);
    if (nodeEl && id !== editing) {
      // Pointer capture would send the focus to the viewport; the node takes it (and with it the keyboard).
      e.preventDefault();
      nodeEl.focus({ preventScroll: true });
    }
    if (node && handle && canEdit) {
      gesture.current = { kind: 'resize', start, id: node.id, handle: handle.dataset.handle as Handle, rect: node.pos, moved: false };
    } else if (node && canEdit) {
      // A node of the picked group drags the whole group; any other node becomes the selection.
      const group = multi.has(node.id) ? [...multi] : [node.id];
      if (!multi.has(node.id)) { setMulti(new Set()); setSelected(node.id); }
      gesture.current = { kind: 'move', start, id: node.id, ids: [...new Set(group.flatMap((id) => [id, ...descendants(nodes, id)]))], moved: false };
    } else if (node) {
      setSelected(node.id);
      gesture.current = { kind: 'pan', start, view, moved: false, onEmpty: false }; // a viewer: a click opens it, a drag does nothing more
    } else {
      // Empty board: a click clears the selection, a drag draws the selection box.
      gesture.current = { kind: 'marquee', start, from: toBoard(e.clientX, e.clientY), moved: false };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    setCursor(toBoard(e.clientX, e.clientY));
    const g = gesture.current;
    if (!g) return;
    const px = e.clientX - g.start.x, py = e.clientY - g.start.y;
    if (!g.moved && Math.hypot(px, py) < DRAG_SLOP) return;
    g.moved = true;
    if (g.kind === 'pan') { if (e.buttons & 4) setView({ ...g.view, x: g.view.x + px / g.view.s, y: g.view.y + py / g.view.s }); }
    else if (g.kind === 'marquee') { const to = toBoard(e.clientX, e.clientY); setMarquee({ x: Math.min(g.from.x, to.x), y: Math.min(g.from.y, to.y), w: Math.abs(to.x - g.from.x), h: Math.abs(to.y - g.from.y) }); }
    else if (g.kind === 'connect') setConnecting({ from: g.from, to: toBoard(e.clientX, e.clientY) });
    else if (g.kind === 'move') setDrag({ ids: new Set(g.ids), dx: px / view.s, dy: py / view.s });
    else setResize({ id: g.id, rect: resized(g.rect, g.handle, px / view.s, py / view.s) });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setDrag(null);
    setResize(null);
    setConnecting(null);
    setMarquee(null);
    if (!g) return;
    if (g.kind === 'marquee') {
      setEditing(null); selectEdge(null);
      if (!g.moved) { setSelected(null); setMulti(new Set()); return; }
      const to = toBoard(e.clientX, e.clientY);
      const box = { x: Math.min(g.from.x, to.x), y: Math.min(g.from.y, to.y), w: Math.abs(to.x - g.from.x), h: Math.abs(to.y - g.from.y) };
      const hit = nodes.filter((n) => n.pos.x < box.x + box.w && n.pos.x + n.pos.w > box.x && n.pos.y < box.y + box.h && n.pos.y + n.pos.h > box.y).map((n) => n.id);
      if (hit.length === 1) { setMulti(new Set()); setSelected(hit[0]); } else { setSelected(null); setMulti(new Set(hit)); }
      return;
    }
    if (g.kind === 'pan') {
      if (!g.moved && g.onEmpty) { setSelected(null); setEditing(null); selectEdge(null); }
      else if (!g.moved) {
        const id = (e.target as Element).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        if (id) openCard(id);
      }
      return;
    }
    if (g.kind === 'connect') {
      if (g.moved && live.current.canEdit) {
        // The node under the pointer (the drop is captured by the viewport, so ask the page what is there).
        const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest('[data-node-id]'))?.closest<HTMLElement>('[data-node-id]');
        const target = hit && hit.dataset.nodeId !== g.from.nodeId ? byId.get(hit.dataset.nodeId!) : undefined;
        if (target) connect(g.from, { nodeId: target.id, side: nearestSide(target.pos, toBoard(e.clientX, e.clientY)) });
      }
      return;
    }
    if (!g.moved) { if (g.kind === 'resize') setSelected(g.id); else if (g.kind === 'move') openCard(g.id); return; }
    // moveNode / resizeNode re-check canEdit: rights can be lost in the middle of a drag.
    const px = (e.clientX - g.start.x) / view.s, py = (e.clientY - g.start.y) / view.s;
    if (g.kind === 'move' && multi.size > 1 && multi.has(g.id)) {
      // ponytail: a group keeps its containers as they were; dropping a group into a container does not adopt it.
      if (!live.current.canEdit) return;
      const self = byId.get(g.id)!;
      const ddx = snap(self.pos.x + px) - self.pos.x, ddy = snap(self.pos.y + py) - self.pos.y;
      board.setPos(g.ids.flatMap((id) => { const n = byId.get(id); return n ? [{ id, pos: { ...n.pos, x: n.pos.x + ddx, y: n.pos.y + ddy } }] : []; }));
    } else if (g.kind === 'move') moveNode(g.id, px, py);
    else resizeNode(g.id, resized(g.rect, g.handle, px, py));
  };

  const onPointerCancel = () => { gesture.current = null; setDrag(null); setResize(null); setConnecting(null); setMarquee(null); };
  /** Right-click: a menu of what can be added, placed where the pointer is. */
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!canEdit) return;
    const r = sectionRef.current!.getBoundingClientRect();
    setMenu({ left: e.clientX - r.left, top: e.clientY - r.top, at: toBoard(e.clientX, e.clientY) });
  };

  const onPointerOver = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    setHover(t.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? t.closest<HTMLElement>('[data-conn]')?.dataset.conn ?? null);
  };

  const previewOf = (n: BoardNode): Rect | undefined => {
    if (resize?.id === n.id) return resize.rect;
    if (drag?.ids.has(n.id)) return { x: n.pos.x + drag.dx, y: n.pos.y + drag.dy, w: n.pos.w, h: n.pos.h };
    return undefined;
  };

  // A tree label keeps its link to the project (`ref`) when its text is edited.
  const commit = useCallback((id: string, value: Record<string, unknown>) => {
    const ref = live.current.board.nodes.find((n) => n.id === id)?.value.ref;
    live.current.board.setValue(id, typeof ref === 'string' ? { ...value, ref } : value);
  }, []);
  const endEdit = useCallback((id: string, refocus: boolean) => { setEditing(null); if (refocus) pendingFocus.current = id; }, []);

  /** Where a node is drawn: its preview while dragged, and for a frame that grew, its real height. */
  const rectOf = (n: BoardNode): Rect => { const r = previewOf(n) ?? n.pos, h = grown.get(n.id); return h && h > r.h ? { ...r, h } : r; };
  const edgeGeo = selEdge && edgeGeometry(selEdge, byId, rectOf);
  const showEdgeToolbar = edgeGeo && selEdge && editingEdge !== selEdge.id && !drag && !resize && !connecting;
  // Connect handles: on the hovered node, else the selected one; not while it is being edited, moved or resized.
  const handleNode = canEdit && !drag && !resize && editing === null ? byId.get(hover ?? '') ?? selNode : undefined;
  const handleRect = handleNode && rectOf(handleNode);
  const connectPreview: ConnectPreview | null = (() => {
    const from = connecting && byId.get(connecting.from.nodeId);
    return connecting && from ? { from: connecting.from, fromRect: rectOf(from), to: connecting.to } : null;
  })();

  // Connectors sit above the containers (largest first in `ordered`) and below every other node.
  const leaves = ordered.findIndex((n) => n.type !== 'container');
  const edgeLayer = (
    <>
      <Edges edges={edges} byId={byId} rectOf={rectOf} selected={selectedEdge} editing={editingEdge} preview={connectPreview}
        onCommitLabel={(id, label) => board.setEdgeLabel(id, label)}
        onEndEdit={(id, refocus) => { setEditingEdge(null); if (refocus) pendingFocus.current = id; }} />
      {showEdgeToolbar && (
        <div className="btoolbar-anchor" style={{ transform: `translate(${edgeGeo.mid.x}px, ${edgeGeo.mid.y}px) scale(${1 / view.s})` }}>
          <NodeToolbar key={selEdge.id} edge={selEdge} canEdit={canEdit}
            onEdit={() => setEditingEdge(selEdge.id)}
            onColor={(c) => board.setEdgeColor(selEdge.id, c)}
            onFocus={() => {
              const [a, b] = [rectOf(edgeGeo.from), rectOf(edgeGeo.to)];
              const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
              focusRect({ x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y });
            }}
            onDelete={() => removeEdge(selEdge.id)}
            onClose={() => { quietFocus.current = true; pendingFocus.current = selEdge.id; selectEdge(null); }} />
        </div>
      )}
    </>
  );

  const selRect = selNode && rectOf(selNode);
  const pct = Math.round(view.s * 100);
  const showToolbar = selNode && selRect && editing !== selNode.id && !drag && !resize;

  return (
    <section ref={sectionRef} className={`board-canvas${tool ? ' is-placing' : ''}`} aria-label="Board">
      {!doc ? <p className="board-loading muted">Connecting…</p> : (
        <>
          <div ref={viewportRef} className="board-viewport" data-testid="board-viewport" tabIndex={0}
            aria-label={tool ? `Board canvas: press Enter to place a ${TYPE_LABEL[tool]} node` : 'Board canvas'}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
            onContextMenu={onContextMenu} onAuxClick={(e) => e.preventDefault()}
            onPointerOver={onPointerOver} onPointerLeave={() => { setHover(null); setCursor(null); }}
            onKeyDown={onCanvasKey} onFocus={onNodeFocus}>
            <div className="board-layer" style={{ transform: `scale(${view.s}) translate(${view.x}px, ${view.y}px)`, ['--canvas-scale' as string]: view.s }}>
              {marquee && <div className="bmarquee" style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.w, height: marquee.h }} />}
              {ordered.map((n, i) => (
                <Fragment key={n.id}>
                  {i === leaves && edgeLayer}
                  <NodeView node={n} preview={previewOf(n)} selected={n.id === selected || multi.has(n.id)} editing={n.id === editing} onGrow={onGrow}
                    onCommit={commit} onEndEdit={endEdit} onSetup={canEdit ? setupFilter : undefined} />
                  {/* Right after its node in the DOM, so Tab goes from the node to its actions. Counter-scaled to stay readable. */}
                  {showToolbar && n.id === selNode.id && (
                    <div className="btoolbar-anchor"
                      style={{ transform: `translate(${selRect.x + selRect.w / 2}px, ${selRect.y}px) scale(${1 / view.s})` }}>
                      <NodeToolbar key={selNode.id} node={selNode} canEdit={canEdit}
                        targets={ordered.filter((o) => o.id !== selNode.id)}
                        onConnect={(targetId) => {
                          const to = byId.get(targetId);
                          if (!to) return;
                          const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
                          connect({ nodeId: selNode.id, side: nearestSide(selNode.pos, centre(to.pos)) },
                            { nodeId: to.id, side: nearestSide(to.pos, centre(selNode.pos)) });
                        }}
                        onEdit={() => setEditing(selNode.id)}
                        onOpen={() => openCard(selNode.id)}
                        smart={selNode.type === 'filter' ? {
                          display: {
                            value: smartValue(selNode.value),
                            features: { milestones: settings.milestonesEnabled, sprints: settings.sprintsEnabled, dueDate: settings.dueDateEnabled },
                            onChange: (patch) => changeSmart(selNode, patch),
                          },
                          onSetup: () => setupFilter(selNode.id),
                          onOpenSearch: smartValue(selNode.value).queryId ? () => openAsSearch(selNode) : undefined,
                        } : undefined}
                        onColor={(c) => board.setColor(selNode.id, c)}
                        onFocus={() => focusRect(selNode.pos)}
                        onDelete={() => remove(selNode.id)}
                        onClose={() => { quietFocus.current = true; pendingFocus.current = selNode.id; setSelected(null); }} />
                    </div>
                  )}
                </Fragment>
              ))}
              {leaves < 0 && edgeLayer}
              <PresenceLayer awareness={awareness} rects={peerRects} scale={view.s} />
              {/* Resize hit areas sit above every node, so a container's children never cover its corners. */}
              {canEdit && selNode && selRect && editing !== selNode.id && handlesFor(selNode.type).length > 0 && (
                <div className="bsel" style={{ transform: `translate(${selRect.x}px, ${selRect.y}px)`, width: selRect.w, height: selRect.h }} data-sel-id={selNode.id}>
                  {handlesFor(selNode.type).map((h) => <span key={h} className={`bh bh-${h}`} data-handle={h} />)}
                </div>
              )}
              {canEdit && handleNode && handleRect && (
                <div className="bconns" data-conn={handleNode.id} style={{ transform: `translate(${handleRect.x}px, ${handleRect.y}px)` }}>
                  {SIDES.map((side) => (
                    <button key={side} type="button" className="bconn" tabIndex={-1} aria-label={`Connect from ${side}`}
                      data-connect-side={side} data-connect-node={handleNode.id}
                      style={{
                        left: side === 'left' ? 0 : side === 'right' ? handleRect.w : handleRect.w / 2,
                        top: side === 'top' ? 0 : side === 'bottom' ? handleRect.h : handleRect.h / 2,
                        transform: `translate(-50%, -50%) scale(${1 / view.s})`,
                      }} />
                  ))}
                </div>
              )}
            </div>
          </div>
          {menu && canEdit && (
            <div className="menu board-menu" role="menu" aria-label="Add to the board" style={{ left: menu.left, top: menu.top }}>
              {TOOLS.map((t) => (
                <button key={t.type} type="button" role="menuitem" className="menu-item" onClick={() => { const at = menu.at; setMenu(null); place(t.type, at); }}>
                  <Icon name={t.icon} size={15} /> Add {TYPE_LABEL[t.type].toLowerCase()}
                </button>
              ))}
            </div>
          )}
          {canEdit && (
            <div className="board-rail" role="group" aria-label="Node tools">
              {TOOLS.map((t) => (
                <button key={t.type} type="button" className={`icon-btn${tool === t.type ? ' is-active' : ''}`}
                  aria-label={TYPE_LABEL[t.type]} title={`${TYPE_LABEL[t.type]} node`} aria-pressed={tool === t.type}
                  onClick={(e) => chooseTool(t.type, e)}>
                  <Icon name={t.icon} />
                </button>
              ))}
              <button type="button" className="icon-btn" aria-label="Project tree" title="Add a project as a tree, or update the one here" onClick={() => setTreeAsk(true)}>
                <Icon name="hero" />
              </button>
              <span className="board-rail-sep" />
              <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" aria-keyshortcuts="Control+Z"
                disabled={!board.canUndo} onClick={board.undo}><Icon name="undo" /></button>
              <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" aria-keyshortcuts="Control+Shift+Z"
                disabled={!board.canRedo} onClick={board.redo}><Icon name="redo" /></button>
            </div>
          )}
          {panelCard && (
            <aside className="card-panel board-card-panel" aria-label="Open task"
              onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && !editable(e.target)) { e.preventDefault(); closePanel(); } }}>
              <button type="button" className="icon-btn panel-close" aria-label="Close task" onClick={closePanel}><Icon name="close" /></button>
              <CardView code={cardCode(panelCard.seq)} inDeck embedded />
            </aside>
          )}
          {filterNode && filterNode.type === 'filter' && (
            <SmartFilterPanel key={filterNode.id} host={host} queryId={smartValue(filterNode.value).queryId} canEdit={canEdit}
              onSaved={(queryId, label) => {
                const cur = live.current.board.nodes.find((n) => n.id === filterNode.id); // the node may have changed while saving
                if (cur) live.current.board.setValue(cur.id, smartToStored({ ...smartValue(cur.value), queryId, label }));
              }}
              onAdd={(cardId) => addCardBeside(filterNode, cardId)}
              onClose={closeSetup} />
          )}
          {treeAsk && <ProjectTreeDialog onClose={() => setTreeAsk(false)} onPick={addProjectTree} />}
          {linkAsk && (() => {
            const s = store.get(), ta = titleOf(s.cards.get(linkAsk.a)?.content ?? ''), tb = titleOf(s.cards.get(linkAsk.b)?.content ?? '');
            return (
              <Dialog title="What does this line mean?" onClose={() => setLinkAsk(null)} actions={<>
                <button type="button" className="btn btn-ghost" onClick={() => setLinkAsk(null)}>Only a line</button>
                {settings.dependenciesEnabled && <button type="button" className="btn" onClick={() => meanLink('dep')}>It waits for it</button>}
                <button type="button" className="btn" onClick={() => meanLink('sub')}>It is its subtask</button>
              </>}>
                <p><strong>{ta}</strong> → <strong>{tb}</strong></p>
                <p className="hint">Waiting and subtasks are saved on the tasks themselves, so they show everywhere, not only on this board.</p>
              </Dialog>
            );
          })()}
          {dialog?.type === 'card' && <CardNodeDialog host={host} onClose={cancelDialog}
            makeFrame={isStoryline(store.get(), host) ? (title) => makeFrame(store.get(), host, title) : undefined}
            onChoose={(id) => {
            // On a storyline's board a picked wiki entry becomes a frame: a picture card, and a "shows" link from the storyline.
            const s = store.get(), picked = s.cards.get(id), frame = isStoryline(s, host) && !!picked?.isDoc;
            if (frame && picked && isStoryline(s, picked)) { finishDialog({ id, mode: 'scene' }); return; }
            const linked = [...s.entryLinks.values()].some((l) => l.fromCardId === host.id && l.toCardId === id && l.kindKey === 'frames');
            if (frame && !linked) void dispatch('wiki', 'addLink', { kindKey: 'frames', fromCardId: host.id, toCardId: id, props: {} }).catch(() => {});
            finishDialog({ id, mode: frame ? 'scene' : 'mini' });
          }} />}
          {dialog?.type === 'image' && <ImageDialog hostCardId={host.id} onClose={cancelDialog} onDone={(v) => finishDialog({ ...v })} />}
          {dialog?.type === 'video' && <VideoDialog onClose={cancelDialog} onDone={(videoId) => finishDialog({ videoId })} />}
          <div className="board-zoom" role="group" aria-label="Zoom">
            <button type="button" className="icon-btn" aria-label="Zoom out" aria-keyshortcuts="-" disabled={view.s <= ZOOM_MIN} onClick={() => zoomTo(view.s - ZOOM_STEP)}><Icon name="minus" /></button>
            <button type="button" className="btn btn-sm btn-ghost board-pct" aria-label={`Zoom ${pct}%, reset to 100%`} title="Reset to 100%"
              onClick={() => zoomTo(1)}>{pct}%</button>
            <button type="button" className="icon-btn" aria-label="Zoom in" aria-keyshortcuts="+" disabled={view.s >= ZOOM_MAX} onClick={() => zoomTo(view.s + ZOOM_STEP)}><Icon name="plus" /></button>
            <button type="button" className="icon-btn" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-pressed={fullscreen}
              onClick={toggleFullscreen}><Icon name="expand" /></button>
          </div>
        </>
      )}
    </section>
  );
}

/** Picks the project to lay out as a tree. */
function ProjectTreeDialog({ onClose, onPick }: { onClose: () => void; onPick: (projectId: string) => void }) {
  const projects = useStore((s) => [...s.projects.values()].filter((p) => !p.isArchived && projectVisible(s, p.id)).sort((a, b) => a.seq - b.seq));
  const [id, setId] = useState(projects[0]?.id ?? '');
  return (
    <Dialog title="Project tree" onClose={onClose} onSubmit={() => onPick(id)} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={!id}>Add to the board</button>
    </>}>
      <label className="field">
        <span>Project</span>
        <select value={id} onChange={(e) => setId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <p className="hint">Adds the project, its areas, lists and open tasks, joined by lines. Run it again later and only what is new is added; what you moved stays where you put it.</p>
    </Dialog>
  );
}

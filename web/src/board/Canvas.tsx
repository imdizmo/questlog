import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
  type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import type * as Y from 'yjs';
import {
  adoptAfterResize, containerAt, DEFAULT_SIZE, filterSize, GRID, nearestSide, newId, newNodeAt, snap, spotBeside, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  type BoardEdge, type BoardNode, type EdgeEnd, type NodePos, type NodeType, type Point, type Rect, type Side,
} from '../../../shared/board';
import { cardCode, titleOf } from '../../../shared/cards';
import { planStoryboard, refOf, SCENE, SUBTASK, WAITS_FOR } from './projectTree';
import { convertTree, layoutFrames, originBelow, treeProjects, type BoardPatch } from './projectFrames';
import { frameInput, HOME_CARD_REFUSED, homeCardAllowed, refuseProject } from './boards';
import { isStoryline, makeFrame } from '../components/wiki/Builder';
import { showToast } from '../toast';
import { dispatch } from '../api';
import { Dialog } from '../components/Dialog';
import { projectVisible } from '../store';
import type { Card } from '../../../shared/types';
import { encodeChips } from '../../../shared/search';
import { isNewTabClick, navigate, setQuery, useLocation } from '../router';
import { keysHere } from '../views/HomePane';
import { sideOf } from '../homeSplit';
import { settingsOf, store, useStore } from '../store';
import { CardView } from '../views/Card';
import { Icon, type IconName } from '../components/icons';
import { CardNodeDialog } from './CardNodeDialog';
import { ImageDialog, VideoDialog } from './MediaDialogs';
import { LOCAL, readBoard, readNode, useBoard } from './useBoard';
import { drawnBoard } from './homeWork';
import { Rail } from '../components/Rail';
import { Holds, useFollowProject } from './follow';
import { HOLD_MS, listMoveToSend, markListMove, moveBackSync, OFFLINE_DROP, OFFLINE_LIST, parentChanges, planMove, readListMove, saveDrop, type DropIntent } from './drop';
import { ASK_ADMIN, deletable, depChoice, edgeStepCalls, FRAME_DELETE, isProjectFrame, meaningOf, saveLink, unlinkCall } from './links';
import { NodeView, handlesFor, initialValue, TYPE_LABEL, type Handle } from './nodes';
import { NodeToolbar } from './NodeToolbar';
import { SmartFilterPanel } from './SmartFilterPanel';
import { smartToStored, smartValue, type SmartValue } from './SmartNode';
import { EdgeLabels, Edges, edgeGeometry, MacroLinks, type ConnectPreview } from './Edges';
import { isMacro, macroView } from './macro';
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
/** Pixels along Home's canvas edges that its toolbars may cover. */
const EDGE = 60;

const clampZoom = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(s * 10) / 10));

const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

const HINT_KEY = 'ql.hint.connect';
const readHintGone = (): boolean => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } };
const writeHintGone = () => { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* storage blocked: the hint comes back next visit */ } };

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
const deckProject = (id: string) => store.get().decks.get(id)?.projectId;

const NOT_LOADED = "The project isn't loaded yet. Try again in a moment.";

/** The project of the board's old tree, when the tree names exactly one and the board shows no other. */
function treeProject(nodes: BoardNode[], projectId: string | null): string | null {
  const named = treeProjects(nodes, deckProject);
  if (named.size !== 1) return null;
  const [pid] = named;
  return projectId && projectId !== pid ? null : pid;
}

/** "Arrange as frames" for a board made with the old tree: the plan, or null when the board has no tree of one project. */
function planArrange(nodes: BoardNode[], edges: BoardEdge[], projectId: string | null): (BoardPatch & { projectId: string }) | null {
  const pid = treeProject(nodes, projectId);
  const inp = pid ? frameInput(store.get(), pid, nodes, edges) : null;
  return inp && convertTree(inp, deckProject);
}

/**
 * Home's work on the board (web/src/board/homeWork.ts): where this person draws each work node, the lines from the
 * data, and what opening one does. Without it, work nodes are never drawn.
 */
export interface WorkLayer {
  /** Where this person draws each work node (board units); a work node left out is not drawn. */
  place: (nodes: BoardNode[]) => Map<string, Rect>;
  /** Drawn under the nodes, in board units; `rectOf` gives a node's drawn rect (following a drag), or undefined. */
  lines: (rectOf: (id: string) => Rect | undefined) => ReactNode;
  /** `newTab`: Ctrl/⌘ or a middle click. */
  open: (ref: string, newTab: boolean) => void;
  /** Screen pixels on the left that the first fit keeps clear (the welcome column). */
  clearLeft: number;
  /** Another value fits the board to the view again (Home's split pane opened or closed). */
  fit?: string;
}

export function Canvas({ doc, canEdit, host, awareness = null, onArrange, work }: {
  /** The board's host task; null for Home, which has none (no project upkeep, Smart Nodes or uploads there). */
  doc: Y.Doc | null; canEdit: boolean; host: Card | null; awareness?: Awareness | null;
  /** Hands up "Arrange as frames" while this board has an old tree to arrange (null when it has none). */
  onArrange?: (run: (() => void) | null) => void;
  work?: WorkLayer;
}) {
  const stored = useBoard(doc);
  const board = useMemo(() => drawnBoard(stored, work ? work.place(stored.nodes) : null), [stored, work]);
  const tools = useMemo(() => (host ? TOOLS : TOOLS.filter((t) => t.type !== 'filter' && t.type !== 'image')), [host]);
  const hostId = host?.id ?? '';
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
  const [hintGone, setHintGone] = useState(readHintGone);
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
  /** The project picker for "Add project", and the question a line between two tasks raises. */
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
  // A page opening beside Home (web/src/views/HomePane.tsx) leaves nothing picked on the board, for its keys to act on.
  const paneOpen = !!sideOf(useLocation().query);
  useEffect(() => { if (paneOpen) { setSelected(null); selectEdge(null); setMulti(new Set()); } }, [paneOpen, setSelected, selectEdge]);

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
  // Zoomed out on a project board: the overview. Drawn from the board as it is; zooming never writes to the document.
  const projectBoard = !!board.projectId;
  const macro = isMacro(view.s, projectBoard);
  const overview = useMemo(() => (macro ? macroView(nodes, edges) : null), [macro, nodes, edges]);
  const shown = useMemo(() => (overview ? ordered.filter((n) => !overview.hidden.has(n.id)) : ordered), [ordered, overview]);
  const isShown = (id: string | undefined) => !!id && !overview?.hidden.has(id);
  /** On a project board its frames and header follow the project: their names can't be edited, nor can they be deleted. */
  const frozen = (n: BoardNode | undefined) => projectBoard && isProjectFrame(n);
  // Entering the overview drops what it no longer draws from the selection (the node and the picked group).
  useEffect(() => {
    if (!overview) return;
    if (selected && overview.hidden.has(selected)) { setSelected(null); setEditing(null); }
    setMulti((m) => ([...m].some((id) => overview.hidden.has(id)) ? new Set([...m].filter((id) => !overview.hidden.has(id))) : m));
  }, [overview]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A frame held down in the overview: its toolbar stays hidden until it is let go. */
  const [pressed, setPressed] = useState(false);

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

  // Home opens with the board fitted beside the welcome column, never smaller than 70 % so the words stay readable: a
  // board bigger than that starts at its top left (drag or zoom to see the rest). Once, and again when `work.fit` changes
  // (the view got narrower or wider); otherwise the view is the person's.
  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!work || fitted.current === (work.fit ?? '') || !nodes.length || !el) return;
    fitted.current = work.fit ?? '';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { x0 = Math.min(x0, n.pos.x); y0 = Math.min(y0, n.pos.y); x1 = Math.max(x1, n.pos.x + n.pos.w); y1 = Math.max(y1, n.pos.y + n.pos.h); }
    const left = Math.min(work.clearLeft, el.clientWidth / 2), w = Math.max(100, el.clientWidth - left - 120), h = Math.max(100, el.clientHeight - 100);
    const s = Math.max(0.7, Math.min(1, Math.floor(Math.min(w / (x1 - x0 || 1), h / (y1 - y0 || 1)) * 10) / 10));
    const at = (start: number, avail: number, lo: number, hi: number) => ((hi - lo) * s <= avail ? (start + avail / 2) / s - (lo + hi) / 2 : start / s - lo);
    setView({ s, x: at(left + 60, w, x0, x1), y: at(50, h, y0, y1) });
  }, [work, nodes]);

  const remove = useCallback((id: string) => {
    live.current.board.deleteNode(id);
    setSelected(null);
    setEditing(null);
    pendingFocus.current = 'canvas';
  }, []);
  /** Deletes the nodes named, except, on a project board, the project's own frames and header (which say why instead). */
  const removeMany = useCallback((ids: Iterable<string>) => {
    const b = live.current.board;
    // Home's work nodes stand for the data: they leave with it, never by hand.
    const { ok, refused } = deletable(b.nodes, [...ids].filter((id) => !b.nodes.some((n) => n.id === id && n.type === 'work')), !!b.projectId);
    for (const id of ok) remove(id);
    if (refused) showToast(FRAME_DELETE, 'info', 5000);
    return ok.length > 0;
  }, [remove]);

  const removeEdge = useCallback((id: string) => {
    // Removing a line that means something takes the meaning with it: the dependency, or the parent. A line the user
    // only labelled "waits for" means nothing in the project (see standsFor), so it takes nothing with it.
    const e = live.current.board.edges.find((x) => x.id === id);
    const s = store.get();
    const m = e && live.current.canEdit ? meaningOf(e, live.current.board.nodes, s) : null;
    const call = m && unlinkCall(m, s);
    if (call) void dispatch(call.ns, call.action, call.payload).catch(() => {});
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
    // A line that joins project things means something: task to task asks what; on a board without a project, task to
    // list moves the task (and list to area the list). On a project board (frames) that is a drop, so a line is a line.
    const a = byId.get(from.nodeId), b = byId.get(to.nodeId);
    if (!a || !b) return;
    const ra = refOf(a) ?? '', rb = refOf(b) ?? '';
    // Two tasks: ask what the line means. Wiki entries (a storyline's frames) are not tasks: their line is only a line.
    const isTask = (r: string) => r.startsWith('card:') && store.get().cards.get(r.slice(5))?.isDoc === false;
    if (isTask(ra) && isTask(rb)) setLinkAsk({ edgeId: id, a: ra.slice(5), b: rb.slice(5) });
    else if (live.current.board.projectId) return;
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
      showToast(`${deck.title} moved to ${String(area.value.content ?? area.value.label ?? 'the area')}`, 'info', 3000);
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
  /**
   * Makes this board the project's board and lays the project out as frames (an old tree of it is arranged in place,
   * anything else goes below what is there), in one undo step. A board shows one project, its host task's: for another
   * one this returns (or toasts) why not, and nothing changes.
   */
  const addProject = (projectId: string): string | null => {
    const s = store.get(), project = s.projects.get(projectId);
    if (!doc || !live.current.canEdit) return null;
    if (!project) { setTreeAsk(false); showToast(NOT_LOADED, 'info', 4000); return null; }
    const { nodes: now, edges: lines, projectId: current } = readBoard(doc);
    if (current && current !== projectId) return `This board shows ${s.projects.get(current)?.name ?? 'another project'}; make a new project board for another.`;
    setTreeAsk(false);
    // Only the project of the board's host task: another one could be one the board's other editors may not see.
    const refused = refuseProject(s, hostId, projectId);
    if (refused) { showToast(refused, 'info', 5000); return null; }
    if (current === projectId) { showToast(`This board already shows ${project.name}.`, 'info', 4000); return null; }
    const named = treeProjects(now, deckProject);
    if (named.size > 1) { showToast("This board has more than one project's tree; make a new project board.", 'info', 5000); return null; }
    const inp = frameInput(s, projectId, now, lines);
    if (!inp) return null;
    const tree = named.has(projectId) ? planArrange(now, lines, null) : null;
    // Below what is there, clear of the tool rail (an empty board starts where a storyboard does).
    const below = originBelow(now);
    const patch = tree ?? layoutFrames(inp, { x: below.x + 4 * GRID, y: now.length ? below.y : 2 * GRID });
    live.current.board.applyPatch(patch, LOCAL, projectId);
    return null;
  };
  // A board opened as `?tree=<project>` (a new project board) lays that project out once, after its content is here.
  const treeParam = useLocation().query.get('tree');
  useEffect(() => {
    if (!treeParam || !doc || !canEdit) return;
    setQuery('tree', null);
    void doc.whenSynced.then(() => { addProject(treeParam); });
  }, [treeParam, doc, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  // The board follows its project by itself (SYNC writes, never undone); not while a node is being dragged or resized.
  // `holds`: nodes reconcile must not move, such as a card dropped into another list frame while the task's move is
  // being saved (saveDrop), so it is not pulled back to its old list meanwhile.
  const [holds] = useState(() => new Holds());
  useFollowProject(doc, hostId, canEdit && !!host, () => gesture.current?.kind === 'move' || gesture.current?.kind === 'resize', holds);
  // "Arrange as frames" is offered while the board holds an old tree of one project.
  const decks = useStore((x) => x.decks);
  const cardsNow = useStore((x) => x.cards);
  // Not offered when it would be refused: a tree of another project than the board's own (its host task's).
  const arrangeable = useMemo(() => {
    const pid = canEdit ? treeProject(nodes, board.projectId) : null;
    return !!pid && !refuseProject(store.get(), hostId, pid);
  }, [canEdit, nodes, board.projectId, decks, cardsNow, hostId]); // eslint-disable-line react-hooks/exhaustive-deps
  const arrange = useRef(() => {});
  arrange.current = () => {
    if (!doc || !live.current.canEdit) return;
    const now = readBoard(doc);
    const pid = treeProject(now.nodes, now.projectId);
    if (pid && !store.get().projects.has(pid)) { showToast(NOT_LOADED, 'info', 4000); return; }
    const refused = pid ? refuseProject(store.get(), hostId, pid) : null;
    if (refused) { showToast(refused, 'info', 5000); return; }
    const plan = planArrange(now.nodes, now.edges, now.projectId);
    if (!plan) return;
    const { projectId, ...patch } = plan;
    live.current.board.applyPatch(patch, LOCAL, projectId);
  };
  useEffect(() => {
    if (!onArrange) return;
    onArrange(arrangeable ? () => arrange.current() : null);
    return () => onArrange(null);
  }, [arrangeable, onArrange]);
  // A storyline's board opened as `?story=1` gets a picture card for every frame that is not on it yet.
  const storyParam = useLocation().query.get('story');
  useEffect(() => {
    if (!storyParam || !doc || !canEdit) return;
    setQuery('story', null);
    // Only once the board's own content is here: planned against an empty board, every frame would be added again.
    void doc.whenSynced.then(() => {
      const s = store.get();
      const frames = [...s.entryLinks.values()].filter((l) => l.fromCardId === hostId && l.kindKey === 'frames' && s.cards.has(l.toCardId)).sort((a, b) => a.sortIndex - b.sortIndex);
      // Read from the document itself: React has not drawn the just-arrived nodes yet.
      const onBoard: BoardNode[] = [];
      doc.getMap<Y.Map<unknown>>('nodes').forEach((m, id) => { const n = readNode(id, m); if (n) onBoard.push(n); });
      const plan = planStoryboard(frames.map((l) => l.toCardId), onBoard);
      if (plan.nodes.length && live.current.canEdit) live.current.board.addMany(plan.nodes, plan.edges);
    });
  }, [storyParam, doc, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * What the line between two tasks means; "only a line" leaves the project alone. `turnOn`: an admin's "It waits for
   * it (turns on dependencies)" switches dependencies on for the workspace first.
   */
  const meanLink = (kind: 'dep' | 'sub', turnOn = false) => {
    if (!linkAsk) return;
    const { a, b, edgeId } = linkAsk;
    setLinkAsk(null);
    void saveLink(kind, a, b, store.get(), dispatch, turnOn)
      .then(() => {
        if (kind === 'dep') { live.current.board.setEdgeLabel(edgeId, WAITS_FOR, 'dep'); return; }
        // A subtask line always runs parent → child, as the tree draws it: redraw the one just made the other way round.
        const e = live.current.board.edges.find((x) => x.id === edgeId);
        if (!e) return;
        live.current.board.deleteEdge(edgeId);
        live.current.board.addEdge({ id: newId(), value: { source: e.value.target, target: e.value.source, kind: 'sub' }, label: SUBTASK });
      })
      .catch(() => { /* the toast says why; the line stays as a plain line */ });
  };
  const waitsChoice = useStore((x) => depChoice(x, projectBoard));

  /** What a saved drop says (the dispatch toasts a refusal). */
  const toastDrop = (done: DropIntent, s = store.get(), area?: BoardNode) => {
    if (done?.kind === 'move-task') showToast(`${titleOf(s.cards.get(done.cardId)?.content ?? '')} moved to ${s.decks.get(done.deckId)?.title ?? 'the list'}`, 'info', 3000);
    else if (done) showToast(`${s.decks.get(done.deckId)?.title ?? 'The list'} moved to ${String(area?.value.label ?? 'the area')}`, 'info', 3000);
  };
  /**
   * One write: the node (or the picked group `ids`, snapped by `id`) moves by (dx, dy) board units; each gets the
   * container it now sits in, and what it holds follows. On a project board a task card dropped into another list
   * frame moves the task (refused: it goes back); a list frame let go over another area moves the list (the frame
   * stays until the board follows the store); a list frame never goes into a list. `at` is where a drag was let go
   * (the pointer, board units); a keyboard move has none and uses the node's centre.
   */
  const moveNode = (id: string, dx: number, dy: number, at?: Point, ids: string[] = [id]) => {
    if (!byId.has(id) || !live.current.canEdit) return;
    const s = store.get(), pid = live.current.board.projectId;
    const plan = planMove(nodes, ids, id, dx, dy, at ?? null, s, pid, hostId);
    if (plan.changes.length) board.setPos(plan.changes);
    if (plan.offline) showToast(OFFLINE_LIST, 'info', 4000);
    for (const d of plan.drops) {
      void saveDrop(d.node, d.parent, s, pid, hostId, {
        holds, dispatch, revert: () => { if (doc) moveBackSync(doc, d.node.id, d.start); }, offline: () => showToast(OFFLINE_DROP, 'info', 4000),
      }).then((done) => toastDrop(done, s));
    }
    for (const l of plan.lists) {
      const from = s.decks.get(l.deckId)?.spaceId;
      void dispatch('decks', 'update', { id: l.deckId, spaceId: l.spaceId }).then(() => {
        // One undo step for the list move: undo sends the list back.
        if (doc && from !== undefined) markListMove(doc, { deckId: l.deckId, from, to: l.spaceId });
        toastDrop({ kind: 'move-list', deckId: l.deckId, spaceId: l.spaceId }, s, byId.get(l.areaId));
      }, () => {});
    }
  };
  /**
   * Undo / redo. On a project board, a node whose frame the step changed goes through the drop path, so the project
   * follows (undoing a drop moves the task back too; refused, the node goes back to where it was before the step), and
   * a list move's step sends the list back (or, redone, there again).
   */
  const undoRedo = (redo: boolean) => {
    const b = live.current.board;
    const board0 = doc ? readBoard(doc) : { nodes: [], edges: [] };
    const before = board0.nodes;
    const moveBefore = doc ? readListMove(doc) : null;
    if (redo) b.redo(); else b.undo();
    if (!doc || !live.current.canEdit) return;
    const after = readBoard(doc);
    const s = store.get();
    // A "waits for" or subtask line the step brought back sends its dependency or parent again (held meanwhile, so the
    // board's upkeep does not take it away before the store has it); one the step took away takes it away again.
    for (const c of edgeStepCalls(board0, after, s)) {
      const token = c.restored ? holds.claim(c.edgeId) : 0;
      const has = (x: typeof s) => (c.kind === 'dep'
        ? [...x.cardDeps.values()].some((d) => d.lockedCardId === c.a && d.lockingCardId === c.b)
        : x.cards.get(c.b)?.parentCardId === c.a);
      void dispatch(c.call.ns, c.call.action, c.call.payload).then(
        () => { if (c.restored) holds.end(c.edgeId, token, { done: has, until: Date.now() + HOLD_MS }); },
        () => { if (c.restored) holds.end(c.edgeId, token); },
      );
    }
    if (!after.projectId) return;
    for (const { node, parent, was } of parentChanges(before, after.nodes)) {
      void saveDrop(node, parent, s, after.projectId, hostId, {
        holds, dispatch, revert: () => moveBackSync(doc, node.id, was.pos), offline: () => showToast(OFFLINE_DROP, 'info', 4000),
      }).then((done) => toastDrop(done, s, parent ?? undefined));
    }
    const list = listMoveToSend(moveBefore, readListMove(doc), redo);
    const deck = list ? s.decks.get(list.deckId) : undefined;
    if (list && deck && deck.projectId === after.projectId && deck.spaceId !== list.spaceId) {
      void dispatch('decks', 'update', { id: list.deckId, spaceId: list.spaceId }).catch(() => {});
    }
  };
  const undoRef = useRef(undoRedo);
  undoRef.current = undoRedo;

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

  const openCard = (nodeId: string, newTab = false) => {
    const n = byId.get(nodeId);
    if (n?.type === 'work') { work?.open(String(n.value.k), newTab); return; }
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
      if (e.defaultPrevented || editable(e.target) || document.querySelector('dialog[open]') || (e.target as Element).closest?.('.board-card-panel') || !keysHere(e, false)) return;
      const { tool: t, selected: sel, selectedEdge: selE, canEdit: ce } = live.current;
      const mod = e.ctrlKey || e.metaKey;
      // Editing keys act only with focus on the board (or nowhere): not from the header menus or the node toolbar.
      const tgt = e.target as Element;
      const onBoard = tgt === document.body || (!!sectionRef.current?.contains(tgt) && !tgt.closest?.('.btoolbar'));
      if (e.key === 'Escape') {
        if (t) { setTool(null); e.preventDefault(); } else if (live.current.multi.size) { setMulti(new Set()); e.preventDefault(); } else if (sel) { setSelected(null); e.preventDefault(); } else if (selE) { selectEdge(null); e.preventDefault(); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && ce && onBoard && (sel || selE || live.current.multi.size)) {
        e.preventDefault();
        if (live.current.multi.size) { if (removeMany(live.current.multi)) setMulti(new Set()); } else if (sel) removeMany([sel]); else removeEdge(selE!);
      } else if (mod && !e.altKey && e.code === 'KeyZ' && ce && onBoard) {
        e.preventDefault();
        undoRef.current(e.shiftKey);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [removeMany, removeEdge, setSelected, selectEdge]);

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
      if (node && canEdit && (node.type === 'text' || node.type === 'container')) { e.preventDefault(); setSelected(node.id); if (!frozen(node)) setEditing(node.id); }
      else if (node?.type === 'card' || node?.type === 'work') { e.preventDefault(); openCard(node.id); }
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
      // On Home the floating toolbars cover the edges and the welcome column the left: a node there counts as out of view.
      const e = work ? EDGE : 0, l = work ? Math.max(EDGE, Math.min(work.clearLeft, vp.clientWidth / 2)) : 0;
      if (left < l || top < e || left + v.s * n.pos.w > vp.clientWidth - e || top + v.s * n.pos.h > vp.clientHeight - 2 * e) {
        setView({ ...v, x: (work ? l + vp.clientWidth : vp.clientWidth) / (2 * v.s) - (n.pos.x + n.pos.w / 2), y: vp.clientHeight / (2 * v.s) - (n.pos.y + n.pos.h / 2) });
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
    // A label drawn above the cards (project boards) stands for its line.
    const labelOf = target.closest<HTMLElement>('[data-label-of]')?.dataset.labelOf;
    const edgeEl = target.closest<HTMLElement>('[data-edge-id]')
      ?? (labelOf ? viewportRef.current?.querySelector<HTMLElement>(`[data-edge-id="${CSS.escape(labelOf)}"]`) ?? null : null);
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
      if (overview && node.type === 'container') setPressed(true);
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
    setPressed(false);
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
      const hit = nodes.filter((n) => isShown(n.id)).filter((n) => n.pos.x < box.x + box.w && n.pos.x + n.pos.w > box.x && n.pos.y < box.y + box.h && n.pos.y + n.pos.h > box.y).map((n) => n.id);
      if (hit.length === 1) { setMulti(new Set()); setSelected(hit[0]); } else { setSelected(null); setMulti(new Set(hit)); }
      return;
    }
    if (g.kind === 'pan') {
      if (!g.moved && g.onEmpty) { setSelected(null); setEditing(null); selectEdge(null); }
      else if (!g.moved) {
        const id = (e.target as Element).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        if (id) openCard(id, isNewTabClick(e));
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
    if (!g.moved) { if (g.kind === 'resize') setSelected(g.id); else if (g.kind === 'move') openCard(g.id, isNewTabClick(e)); return; }
    // moveNode / resizeNode re-check canEdit: rights can be lost in the middle of a drag.
    const px = (e.clientX - g.start.x) / view.s, py = (e.clientY - g.start.y) / view.s;
    // A picked group moves as one (snapped by the node it was dragged by), each member dropped like a single node.
    if (g.kind === 'move') moveNode(g.id, px, py, toBoard(e.clientX, e.clientY), multi.size > 1 && multi.has(g.id) ? g.ids : [g.id]);
    else resizeNode(g.id, resized(g.rect, g.handle, px, py));
  };

  const onPointerCancel = () => { gesture.current = null; setPressed(false); setDrag(null); setResize(null); setConnecting(null); setMarquee(null); };
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
  const edgeGeo = selEdge && edgeGeometry(selEdge, byId, rectOf, projectBoard);
  const showEdgeToolbar = edgeGeo && selEdge && editingEdge !== selEdge.id && !drag && !resize && !connecting
    && isShown(selEdge.value.source.nodeId) && isShown(selEdge.value.target.nodeId);
  // Connect handles: on the hovered node, else the selected one; not while it is being edited, moved or resized.
  // None in the overview: per-card lines are drawn in the detail, and a frame's top handle would cover its name strip.
  // None on Home's work nodes: their lines come from the data, and on a small pill a handle would take the press.
  const handleNode = canEdit && !overview && !drag && !resize && editing === null ? [byId.get(hover ?? ''), selNode].find((n) => n && isShown(n.id) && n.type !== 'work') : undefined;
  const handleRect = handleNode && rectOf(handleNode);
  const connectPreview: ConnectPreview | null = (() => {
    const from = connecting && byId.get(connecting.from.nodeId);
    return connecting && from ? { from: connecting.from, fromRect: rectOf(from), to: connecting.to } : null;
  })();

  // Connectors sit above the containers (largest first in `ordered`) and below every other node.
  const leaves = shown.findIndex((n) => n.type !== 'container');
  const edgeLayer = (
    <>
      {work?.lines((id) => { const n = byId.get(id); return n && isShown(id) ? rectOf(n) : undefined; })}
      {overview && <MacroLinks links={overview.links} byId={byId} rectOf={rectOf} nameOf={(n) => String(n.value.label ?? '')} />}
      <Edges edges={overview?.edges ?? edges} byId={byId} rectOf={rectOf} projectBoard={projectBoard} selected={selectedEdge} editing={editingEdge} preview={connectPreview}
        labels={!projectBoard}
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
  const showHint = canEdit && projectBoard && !overview && !hintGone && edges.filter((e) => e.label === WAITS_FOR || e.label === SUBTASK).length < 2;
  const handleName = handleNode?.type === 'card' ? titleOf(store.get().cards.get(String(handleNode.value.id))?.content ?? '') : '';
  // A frame's name strip runs along its top edge, so its handles sit just outside it (a press on the strip must move the frame).
  const out = handleNode?.type === 'container' ? 10 / view.s : 0;
  const showToolbar = selNode && selRect && editing !== selNode.id && !drag && !resize && !(overview && pressed);

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
            <div className={`board-layer${overview ? ' is-macro' : ''}`} style={{ transform: `scale(${view.s}) translate(${view.x}px, ${view.y}px)`, ['--canvas-scale' as string]: view.s }}>
              {marquee && <div className="bmarquee" style={{ transform: `translate(${marquee.x}px, ${marquee.y}px)`, width: marquee.w, height: marquee.h }} />}
              {shown.map((n, i) => (
                <Fragment key={n.id}>
                  {i === leaves && edgeLayer}
                  <NodeView node={n} preview={previewOf(n)} selected={n.id === selected || multi.has(n.id)} editing={n.id === editing} onGrow={onGrow}
                    tasks={overview?.counts.get(n.id)}
                    onCommit={commit} onEndEdit={endEdit} onSetup={canEdit ? setupFilter : undefined} />
                  {/* Right after its node in the DOM, so Tab goes from the node to its actions. Counter-scaled to stay readable. */}
                  {showToolbar && n.id === selNode.id && (
                    <div className="btoolbar-anchor"
                      style={{ transform: `translate(${selRect.x + selRect.w / 2}px, ${selRect.y}px) scale(${1 / view.s})` }}>
                      <NodeToolbar key={selNode.id} node={selNode} canEdit={canEdit}
                        targets={shown.filter((o) => o.id !== selNode.id)}
                        onConnect={(targetId) => {
                          const to = byId.get(targetId);
                          if (!to) return;
                          const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
                          connect({ nodeId: selNode.id, side: nearestSide(selNode.pos, centre(to.pos)) },
                            { nodeId: to.id, side: nearestSide(to.pos, centre(selNode.pos)) });
                        }}
                        onEdit={frozen(selNode) || selNode.type === 'work' ? undefined : () => setEditing(selNode.id)}
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
                        onDelete={frozen(selNode) || selNode.type === 'work' ? undefined : () => remove(selNode.id)}
                        onClose={() => { quietFocus.current = true; pendingFocus.current = selNode.id; setSelected(null); }} />
                    </div>
                  )}
                </Fragment>
              ))}
              {leaves < 0 && edgeLayer}
              {/* On a project board the lines run under the cards, but their labels are drawn above every node. */}
              {projectBoard && <EdgeLabels edges={overview?.edges ?? edges} byId={byId} rectOf={rectOf} editing={editingEdge} selected={selectedEdge} />}
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
                    <button key={side} type="button" className="bconn" tabIndex={-1} aria-label={handleName ? `Connect from ${side} of ${handleName}` : `Connect from ${side}`}
                      data-connect-side={side} data-connect-node={handleNode.id}
                      style={{
                        left: side === 'left' ? 0 : side === 'right' ? handleRect.w : handleRect.w / 2,
                        top: side === 'top' ? 0 : side === 'bottom' ? handleRect.h : handleRect.h / 2,
                        transform: `translate(${side === 'left' ? -out : side === 'right' ? out : 0}px, ${side === 'top' ? -out : side === 'bottom' ? out : 0}px) translate(-50%, -50%) scale(${1 / view.s})`,
                      }} />
                  ))}
                </div>
              )}
            </div>
          </div>
          {showHint && (
            <div className="board-hint" role="note" title="From the keyboard: focus a task, Tab to its toolbar and choose Connect to…">
              <span>Drag from a task's handle to another task to connect them.</span>
              <button type="button" className="icon-btn" aria-label="Dismiss hint" onClick={() => { writeHintGone(); setHintGone(true); }}><Icon name="close" size={14} /></button>
            </div>
          )}
          {menu && canEdit && (
            <div className="menu board-menu" role="menu" aria-label="Add to the board" style={{ left: menu.left, top: menu.top }}>
              {tools.map((t) => (
                <button key={t.type} type="button" role="menuitem" className="menu-item" onClick={() => { const at = menu.at; setMenu(null); place(t.type, at); }}>
                  <Icon name={t.icon} size={15} /> Add {TYPE_LABEL[t.type].toLowerCase()}
                </button>
              ))}
            </div>
          )}
          {canEdit && (
            <Rail className="v l" label="Add to the board" vertical>
              <div className="vh" aria-hidden>Add</div>
              {tools.map((t) => (
                <button key={t.type} type="button" className={tool === t.type ? 'is-active' : undefined}
                  aria-label={TYPE_LABEL[t.type]} aria-pressed={tool === t.type}
                  onClick={(e) => chooseTool(t.type, e)}>
                  <Icon name={t.icon} size={16} /><span className="tip2">{TYPE_LABEL[t.type]} node</span>
                </button>
              ))}
              {host && (
                <button type="button" aria-label="Add project" onClick={() => setTreeAsk(true)}>
                  <Icon name="hero" size={16} /><span className="tip2">Lay a project out on this board as frames</span>
                </button>
              )}
              <hr />
              <button type="button" aria-label="Undo" aria-keyshortcuts="Control+Z"
                disabled={!board.canUndo} onClick={() => undoRedo(false)}><Icon name="undo" size={16} /><span className="tip2">Undo (Ctrl+Z)</span></button>
              <button type="button" aria-label="Redo" aria-keyshortcuts="Control+Shift+Z"
                disabled={!board.canRedo} onClick={() => undoRedo(true)}><Icon name="redo" size={16} /><span className="tip2">Redo (Ctrl+Shift+Z)</span></button>
            </Rail>
          )}
          {panelCard && (
            <aside className="card-panel board-card-panel" aria-label="Open task"
              onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && !editable(e.target)) { e.preventDefault(); closePanel(); } }}>
              <button type="button" className="icon-btn panel-close" aria-label="Close task" onClick={closePanel}><Icon name="close" /></button>
              <CardView code={cardCode(panelCard.seq)} inDeck embedded />
            </aside>
          )}
          {filterNode && filterNode.type === 'filter' && (
            host && <SmartFilterPanel key={filterNode.id} host={host} queryId={smartValue(filterNode.value).queryId} canEdit={canEdit}
              onSaved={(queryId, label) => {
                const cur = live.current.board.nodes.find((n) => n.id === filterNode.id); // the node may have changed while saving
                if (cur) live.current.board.setValue(cur.id, smartToStored({ ...smartValue(cur.value), queryId, label }));
              }}
              onAdd={(cardId) => addCardBeside(filterNode, cardId)}
              onClose={closeSetup} />
          )}
          {treeAsk && <AddProjectDialog onClose={() => setTreeAsk(false)} onPick={addProject} />}
          {linkAsk && (() => {
            const s = store.get(), ta = titleOf(s.cards.get(linkAsk.a)?.content ?? ''), tb = titleOf(s.cards.get(linkAsk.b)?.content ?? '');
            return (
              <Dialog title="What does this line mean?" onClose={() => setLinkAsk(null)} actions={<>
                <button type="button" className="btn btn-ghost" onClick={() => setLinkAsk(null)}>Only a line</button>
                {waitsChoice === 'on' && <button type="button" className="btn" onClick={() => meanLink('dep')}>It waits for it</button>}
                {waitsChoice === 'turn-on' && <button type="button" className="btn" onClick={() => meanLink('dep', true)}>It waits for it (turns on dependencies)</button>}
                <button type="button" className="btn" onClick={() => meanLink('sub')}>It is its subtask</button>
              </>}>
                <p><strong>{ta}</strong> → <strong>{tb}</strong></p>
                {waitsChoice === 'ask-admin' && <p className="hint">{ASK_ADMIN}</p>}
                <p className="hint">Waiting and subtasks are saved on the tasks themselves, so they show everywhere, not only on this board.</p>
              </Dialog>
            );
          })()}
          {dialog?.type === 'card' && <CardNodeDialog host={host} onClose={cancelDialog}
            makeFrame={host && isStoryline(store.get(), host) ? (title) => makeFrame(store.get(), host, title) : undefined}
            onChoose={(id) => {
            // On Home (no host) only a task of a project every member sees: the doc goes to the whole workspace.
            if (!host && !homeCardAllowed(store.get(), id)) { cancelDialog(); showToast(HOME_CARD_REFUSED, 'info', 5000); return; }
            // On a storyline's board a picked wiki entry becomes a frame: a picture card, and a "shows" link from the storyline.
            const s = store.get(), picked = s.cards.get(id), frame = !!host && isStoryline(s, host) && !!picked?.isDoc;
            if (frame && picked && isStoryline(s, picked)) { finishDialog({ id, mode: 'scene' }); return; }
            const linked = [...s.entryLinks.values()].some((l) => l.fromCardId === hostId && l.toCardId === id && l.kindKey === 'frames');
            if (frame && !linked) void dispatch('wiki', 'addLink', { kindKey: 'frames', fromCardId: hostId, toCardId: id, props: {} }).catch(() => {});
            finishDialog({ id, mode: frame ? 'scene' : 'mini' });
          }} />}
          {dialog?.type === 'image' && host && <ImageDialog hostCardId={hostId} onClose={cancelDialog} onDone={(v) => finishDialog({ ...v })} />}
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

/** Picks the project to lay out as frames; says why when the board already shows another project. */
function AddProjectDialog({ onClose, onPick }: { onClose: () => void; onPick: (projectId: string) => string | null }) {
  const projects = useStore((s) => [...s.projects.values()].filter((p) => !p.isArchived && projectVisible(s, p.id)).sort((a, b) => a.seq - b.seq));
  const [id, setId] = useState(projects[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Add project" onClose={onClose} onSubmit={() => setError(onPick(id))} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={!id}>Add to the board</button>
    </>}>
      <label className="field">
        <span>Project</span>
        <select value={id} onChange={(e) => { setId(e.target.value); setError(null); }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="hint">Lays the project out as frames: each area a frame, each list a frame inside it, with its open tasks. A board shows one project.</p>
    </Dialog>
  );
}

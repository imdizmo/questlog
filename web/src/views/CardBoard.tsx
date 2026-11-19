import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import type * as Y from 'yjs';
import type { VisionBoard } from '../../../shared/types';
import { titleOf } from '../../../shared/cards';
import { cardHref } from '../cards';
import { dispatch } from '../api';
import { Link, navigate } from '../router';
import { withBoard } from '../homeSplit';
import { settingsOf, store, useStore } from '../store';
import { PresenceStack } from '../board/Presence';
import { showToast } from '../toast';
import { StoryPlayer, StoryVarsDialog } from '../board/StoryPlayer';
import { CastPanel, attachToFrame, isStoryline } from '../components/wiki/Builder';
import { readNode } from '../board/useBoard';
import { connectBoard, type BoardConnection, type BoardStatus } from '../board/provider';
import { Canvas } from '../board/Canvas';
import {
  boardLevel, boardOfCard, boardPath, canManageBoard, createBoard, forgetBoard, mayEditHost, createProjectBoard, rememberBoard, STATE_HINT, STATE_LABEL,
} from '../board/boards';
import { Dialog } from '../components/Dialog';
import { CardPicker } from '../components/CardPicker';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/icons';
import { Menu, type MenuItem } from '../components/Menu';
import { Rail } from '../components/Rail';

/**
 * The boards on Home (web/src/views/Home.tsx): the Boards toolbar (Home, every board the person may see, a new one; a
 * card board's own actions at its end) and a card board's page (the old Vision board page): its canvas with scenes,
 * arrows and tools, Play, Variables and Cast on a storyline, the host task, its state and delete in More.
 */

const STATES = ['default', 'read_only', 'locked'] as const;

/** Connection to one board's room, closed when the board changes or the view goes away. */
export function useBoardConnection(boardId: string | null) {
  const [conn, setConn] = useState<BoardConnection | null>(null);
  /** Bumped by reconnect(): a new connection starts from a fresh doc. */
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!boardId) return;
    const c = connectBoard(boardId);
    setConn(c);
    return () => { c.destroy(); setConn(null); };
  }, [boardId, round]);
  const sub = useMemo(() => (fn: () => void) => conn?.subscribe(fn) ?? (() => {}), [conn]);
  const status = useSyncExternalStore<BoardStatus>(sub, () => conn?.status() ?? 'connecting');
  const reason = useSyncExternalStore(sub, () => conn?.reason() ?? null);
  return { conn, status, reason, reconnect: () => setRound((n) => n + 1) };
}

/** The boards the person may open from Home, in board order (none while vision boards are switched off). */
export function useBoardList(): Array<{ board: VisionBoard; title: string }> {
  const boards = useStore((s) => s.visionBoards);
  const cards = useStore((s) => s.cards);
  const enabled = useStore((s) => settingsOf(s).visionBoardEnabled);
  return useMemo(() => {
    if (!enabled) return [];
    return [...boards.values()].flatMap((board) => {
      const card = cards.get(board.cardId);
      return card && card.visibility !== 'deleted' ? [{ board, title: titleOf(card.content) || 'Untitled' }] : [];
    }).sort((a, b) => a.board.accountSeq - b.board.accountSeq);
  }, [boards, cards, enabled]);
}

/** The Boards toolbar, top centre: Home, each board, + (a new board); `children` (a card board's actions) at its end. */
export function BoardsRail({ current, children }: { current: VisionBoard | null; children?: ReactNode }) {
  const list = useBoardList();
  const enabled = useStore((s) => settingsOf(s).visionBoardEnabled);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The board on show is in view in the list.
  useEffect(() => {
    const l = listRef.current, b = l?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (l && b && (b.offsetLeft < l.scrollLeft || b.offsetLeft + b.offsetWidth > l.scrollLeft + l.clientWidth)) l.scrollLeft = b.offsetLeft - 8;
  }, [current?.id, list.length]);
  return (
    <>
      <Rail className="top" label="Boards">
        {/* Switching boards keeps the page beside Home (web/src/views/HomePane.tsx). */}
        <button type="button" aria-pressed={!current} onClick={() => navigate(withBoard(location.search, null))}><Icon name="home" size={14} />Home</button>
        {/* The boards scroll on their own, so the board's actions after them stay in view (and its menus are not clipped). */}
        <div className="rail-boards" ref={listRef}>
        {list.map(({ board, title }) => (
          <button key={board.id} type="button" aria-pressed={current?.id === board.id} title={title}
            onClick={() => navigate(withBoard(location.search, board.accountSeq))}><Icon name="frame" size={14} /><span className="rail-name">{title}</span></button>
        ))}
        </div>
        {enabled && <button type="button" aria-label="New board" title="New board" onClick={() => setAdding(true)}><Icon name="plus" size={14} /></button>}
        {children}
      </Rail>
      {adding && <NewBoardDialog onClose={() => setAdding(false)} />}
    </>
  );
}

/** "+": a board lives on a task (pick one), or a whole project laid out as frames on a new lore page. */
function NewBoardDialog({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x);
  const candidates = useMemo(
    () => [...s.cards.values()].filter((c) => c.visibility !== 'deleted' && !boardOfCard(s, c.id) && mayEditHost(s, c)),
    [s.cards, s.visionBoards, s.decks, s.projects, s.me?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const projects = useStore((x) => [...x.projects.values()].filter((p) => !p.isArchived && [...x.decks.values()].some((d) => d.projectId === p.id)).sort((a, b) => a.seq - b.seq));
  const [id, setId] = useState('');
  const pick = id || projects[0]?.id || '';
  return (
    <Dialog title="New board" onClose={onClose}
      actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>}>
      <p>A board lives on a task: pick one to pin notes, tasks, links and images on its board.</p>
      <CardPicker label="Pick task" trigger={<><Icon name="plus" size={14} /> Pick task</>} triggerClass="btn btn-primary"
        candidates={candidates} empty="No tasks you can add a board to"
        onPick={(c) => void createBoard(c).then((seq) => { onClose(); navigate(boardPath(seq)); }).catch(() => {})} />
      {projects.length > 0 && (
        <>
          <p>Or start with a whole project laid out as frames: each area a frame, each list a frame inside it, with its open tasks.</p>
          <div className="row">
            <label className="field">
              <span>Project</span>
              <select value={pick} onChange={(e) => setId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
            <button type="button" className="btn" onClick={() => void createProjectBoard(pick).then((href) => { onClose(); navigate(href); }).catch(() => {})}>Project board</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Presence and the connection, top right on every board. */
export function BoardStatusBar({ conn, status }: { conn: BoardConnection | null; status: BoardStatus }) {
  return (
    <div className="board-status">
      <PresenceStack awareness={conn?.awareness ?? null} />
      <span role="status" className={`conn conn-${status}`} aria-label={`Connection: ${status}`} title={`Connection: ${status}`}>{status}</span>
    </div>
  );
}

/** Home with a card board picked (`/home?board=<seq>`); "Board not found" when it is gone or out of sight. */
export function CardBoardView({ seq, board }: { seq: number; board: VisionBoard | undefined }) {
  const card = useStore((s) => (board ? s.cards.get(board.cardId) : undefined));
  // A board that was just made may arrive over the live socket a moment after we navigate to it.
  const [grace, setGrace] = useState(true);
  useEffect(() => { const t = setTimeout(() => setGrace(false), 2500); return () => clearTimeout(t); }, [seq]);
  const gone = !board || !card || card.visibility === 'deleted';
  useEffect(() => { if (!gone) rememberBoard(seq); }, [gone, seq]);
  if (gone) {
    return (
      <>
        <BoardsRail current={null} />
        {board === undefined && grace ? <p className="board-gone muted" aria-busy="true">Loading…</p> : (
          <div className="board-gone empty">
            <h2>Board not found</h2>
            <p>It may have been deleted, or you don't have access to its task.</p>
          </div>
        )}
      </>
    );
  }
  return <CardBoard key={board.id} board={board} />;
}

function CardBoard({ board }: { board: VisionBoard }) {
  const s = useStore((x) => x);
  const card = s.cards.get(board.cardId)!;
  const deck = card.deckId ? s.decks.get(card.deckId) : undefined;
  const title = titleOf(card.content) || 'Untitled';
  const level = boardLevel(s, board);
  const manage = canManageBoard(s, board);
  const { conn, status, reason, reconnect } = useBoardConnection(board.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(true);
  /** "Arrange as frames", while the canvas holds an old project tree. */
  const [arrange, setArrange] = useState<(() => void) | null>(null);
  const onArrange = useCallback((run: (() => void) | null) => setArrange(() => run), []);
  const story = isStoryline(s, card);
  const canEdit = level === 'edit' && !(status === 'offline' && reason);
  /** An entry dragged from the cast panel onto a frame card links the two. */
  const dropCast = (e: DragEvent<HTMLDivElement>) => {
    const entryId = e.dataTransfer.getData('text/ql-entry');
    if (!entryId || !conn) return;
    e.preventDefault();
    const nodeId = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    const m = nodeId ? conn.doc.getMap<Y.Map<unknown>>('nodes').get(nodeId) : undefined;
    const node = nodeId && m ? readNode(nodeId, m) : null;
    if (node?.type === 'card' && typeof node.value.id === 'string') attachToFrame(node.value.id, entryId);
    else showToast('Drop it on a frame.', 'info', 3000);
  };
  const href = cardHref(card, deck);

  const items: MenuItem[] = [
    { label: 'Go to task', onSelect: () => navigate(href) },
    ...(arrange ? [{ label: 'Arrange as frames', onSelect: arrange }] : []),
    ...(manage ? STATES.map((st): MenuItem => ({
      label: STATE_LABEL[st], hint: STATE_HINT[st], checked: board.state === st,
      onSelect: () => { if (board.state !== st) void dispatch('visionBoard', 'updateBoard', { id: board.id, state: st }).catch(() => {}); },
    })) : []),
    ...(manage ? [{ label: 'Delete board', danger: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  return (
    <>
      {/* The canvas stays usable apart from the toolbars: if it fails to render, Delete board is still in More. After a
          final close edits would only be local and lost on reload, so the canvas turns read-only. */}
      <div className="story-layout" onDragOver={(e) => { if (e.dataTransfer.types.includes('text/ql-entry')) e.preventDefault(); }} onDrop={dropCast}>
        {story && canEdit && castOpen && <CastPanel story={card} />}
        <ErrorBoundary what="This board" resetKey={board.id}>
          <Canvas doc={conn?.doc ?? null} canEdit={canEdit} host={card} awareness={conn?.awareness ?? null} onArrange={onArrange} />
        </ErrorBoundary>
      </div>
      <BoardsRail current={board}>
        <hr />
        <Link href={href}><Icon name="external" size={14} />Open task</Link>
        {story && conn && <button type="button" className="play" onClick={() => setPlaying(true)}><Icon name="play" size={13} />Play</button>}
        {story && conn && <button type="button" onClick={() => setVarsOpen(true)}><Icon name="tag" size={14} />Variables</button>}
        {story && canEdit && <button type="button" aria-pressed={castOpen} onClick={() => setCastOpen((o) => !o)}><Icon name="people" size={14} />Cast</button>}
        <Menu label="More" trigger={<Icon name="more" />} items={items} />
      </BoardsRail>
      <BoardStatusBar conn={conn} status={status} />
      <div className="board-notices">
        {reason && (
          <p className="notice notice-danger" role="alert">
            {reason}
            {status === 'offline' && <button type="button" className="btn btn-sm" onClick={reconnect}>Reconnect</button>}
          </p>
        )}
        {level === 'view' && <p className="notice">This board is read-only for you. {readOnlyWhy(board.state)}</p>}
      </div>
      {varsOpen && conn && <StoryVarsDialog doc={conn.doc} canEdit={canEdit} onClose={() => setVarsOpen(false)} />}
      {playing && conn && <StoryPlayer doc={conn.doc} host={card} onClose={() => setPlaying(false)} />}
      {confirmDelete && (
        <ConfirmDialog title="Delete board?" confirmLabel="Delete board" danger onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await dispatch('visionBoard', 'deleteBoard', { id: board.id });
            // Drop it locally first, like createBoard adds locally: the page must not find it before the live push arrives.
            store.apply([{ model: 'visionBoard', op: 'remove', row: board }]);
            forgetBoard(board.accountSeq);
            navigate('/home');
          }}>
          <p>The board on <strong>{title}</strong> and everything pinned on it is deleted for everyone. The task stays.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

const readOnlyWhy = (state: VisionBoard['state']) =>
  state === 'locked' ? 'It is locked.' : state === 'read_only' ? 'Only the person who made it can edit it.' : 'You can\'t edit its task.';


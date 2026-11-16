import { useEffect, useMemo, useState, useSyncExternalStore, type DragEvent } from 'react';
import type * as Y from 'yjs';
import type { VisionBoard } from '../../../shared/types';
import { titleOf } from '../../../shared/cards';
import { cardHref } from '../cards';
import { dispatch } from '../api';
import { Link, navigate } from '../router';
import { settingsOf, store, useStore } from '../store';
import { PresenceStack } from '../board/Presence';
import { showToast } from '../toast';
import { StoryPlayer, StoryVarsDialog } from '../board/StoryPlayer';
import { CastPanel, attachToFrame, isStoryline } from '../components/wiki/Builder';
import { readNode } from '../board/useBoard';
import { connectBoard, type BoardConnection, type BoardStatus } from '../board/provider';
import { Canvas } from '../board/Canvas';
import {
  boardBySeq, boardLevel, boardOfCard, boardPath, canManageBoard, createBoard, forgetBoard, lastBoardSeq, mayEditHost,
  createProjectBoard, rememberBoard, STATE_HINT, STATE_LABEL,
} from '../board/boards';
import { Dialog } from '../components/Dialog';
import { BoardPicker } from '../components/BoardPicker';
import { CardPicker } from '../components/CardPicker';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Icon } from '../components/icons';
import { Menu, type MenuItem } from '../components/Menu';

const STATES = ['default', 'read_only', 'locked'] as const;

/** /vision: the last opened board, or the empty state that makes the first one. */
export function VisionHome() {
  const boards = useStore((s) => s.visionBoards);
  const cards = useStore((s) => s.cards);
  const s = useStore((x) => x);
  const enabled = settingsOf(s).visionBoardEnabled;
  const target = useMemo(() => {
    const last = lastBoardSeq();
    const list = [...boards.values()].filter((b) => cards.has(b.cardId)).sort((a, b) => a.accountSeq - b.accountSeq);
    return (last !== null && list.find((b) => b.accountSeq === last)) || list[0];
  }, [boards, cards]);
  useEffect(() => { if (target && enabled) navigate(boardPath(target.accountSeq), { replace: true }); }, [target?.accountSeq, enabled]);

  const candidates = useMemo(
    () => [...cards.values()].filter((c) => c.visibility !== 'deleted' && !boardOfCard(s, c.id) && mayEditHost(s, c)),
    [cards, boards, s.decks, s.projects, s.me?.id],
  );
  if (target && enabled) return <main className="page" id="main" aria-busy="true" />;
  return (
    <main className="page page-narrow" id="main">
      <div className="empty">
        <h2>Vision board</h2>
        {enabled ? (
          <>
            <p>Pick a task to open its board and pin notes, tasks, links and images on it.</p>
            <CardPicker label="Pick task" trigger={<><Icon name="plus" size={14} /> Pick task</>} triggerClass="btn btn-primary"
              candidates={candidates} empty="No tasks you can add a board to"
              onPick={(c) => void createBoard(c).then((seq) => navigate(boardPath(seq))).catch(() => {})} />
            <p>Or start with a whole project laid out as a tree.</p>
            <ProjectBoardButton primary />
          </>
        ) : <p>Boards are switched off in the workspace settings.</p>}
      </div>
    </main>
  );
}

/** Connection to one board's room, closed when the board changes or the view goes away. */
function useBoardConnection(boardId: string) {
  const [conn, setConn] = useState<BoardConnection | null>(null);
  /** Bumped by reconnect(): a new connection starts from a fresh doc. */
  const [round, setRound] = useState(0);
  useEffect(() => {
    const c = connectBoard(boardId);
    setConn(c);
    return () => { c.destroy(); setConn(null); };
  }, [boardId, round]);
  const sub = useMemo(() => (fn: () => void) => conn?.subscribe(fn) ?? (() => {}), [conn]);
  const status = useSyncExternalStore(sub, () => conn?.status() ?? 'connecting');
  const reason = useSyncExternalStore(sub, () => conn?.reason() ?? null);
  return { conn, status, reason, reconnect: () => setRound((n) => n + 1) };
}

/** /vision/:seq */
export function VisionBoardView({ seq }: { seq: number }) {
  const s = useStore((x) => x);
  const board = boardBySeq(s, seq);
  // A board that was just made may arrive over the live socket a moment after we navigate to it.
  const [grace, setGrace] = useState(true);
  useEffect(() => { const t = setTimeout(() => setGrace(false), 2500); return () => clearTimeout(t); }, [seq]);
  const card = board && s.cards.get(board.cardId);
  const gone = !board || !card || card.visibility === 'deleted';
  useEffect(() => { if (!gone) rememberBoard(seq); }, [gone, seq]);
  if (gone) {
    if (board === undefined && grace) return <main className="page" id="main" aria-busy="true"><p className="muted">Loading…</p></main>;
    return (
      <main className="page page-narrow" id="main">
        <div className="empty">
          <h2>Board not found</h2>
          <p>It may have been deleted, or you don't have access to its task.</p>
          <Link href="/vision" className="btn">Boards</Link>
        </div>
      </main>
    );
  }
  return <BoardPage key={board.id} board={board} />;
}

function BoardPage({ board }: { board: VisionBoard }) {
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
    ...(manage ? STATES.map((st): MenuItem => ({
      label: STATE_LABEL[st], hint: STATE_HINT[st], checked: board.state === st,
      onSelect: () => { if (board.state !== st) void dispatch('visionBoard', 'updateBoard', { id: board.id, state: st }).catch(() => {}); },
    })) : []),
    ...(manage ? [{ label: 'Delete board', danger: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  return (
    <main className="page page-board" id="main">
      <div className="vision-head">
        <BoardPicker current={board} title={title} />
        <Link href={href} className="btn">Open task</Link>
        <ProjectBoardButton />
        {story && conn && <button type="button" className="btn btn-primary" onClick={() => setPlaying(true)}><Icon name="play" /> Play</button>}
        {story && conn && <button type="button" className="btn" onClick={() => setVarsOpen(true)}>Variables</button>}
        <Menu label="More" trigger={<Icon name="more" />} items={items} />
        <span className="grow" />
        <PresenceStack awareness={conn?.awareness ?? null} />
        <span role="status" className={`conn conn-${status}`} aria-label={`Connection: ${status}`} title={`Connection: ${status}`}>{status}</span>
      </div>
      {reason && (
        <p className="notice notice-danger" role="alert">
          {reason}
          {status === 'offline' && <button type="button" className="btn btn-sm" onClick={reconnect}>Reconnect</button>}
        </p>
      )}
      {level === 'view' && <p className="notice">This board is read-only for you. {readOnlyWhy(board.state)}</p>}
      {/* The header (with Delete board) stays usable if the canvas fails to render. After a final close edits would only
          be local and lost on reload, so the canvas turns read-only. */}
      <div className="story-layout" onDragOver={(e) => { if (e.dataTransfer.types.includes('text/ql-entry')) e.preventDefault(); }} onDrop={dropCast}>
        {story && canEdit && <CastPanel story={card} />}
        <ErrorBoundary what="This board" resetKey={board.id}>
          <Canvas doc={conn?.doc ?? null} canEdit={canEdit} host={card} awareness={conn?.awareness ?? null} />
        </ErrorBoundary>
      </div>
      {varsOpen && conn && <StoryVarsDialog doc={conn.doc} canEdit={canEdit} onClose={() => setVarsOpen(false)} />}
      {playing && conn && <StoryPlayer doc={conn.doc} host={card} onClose={() => setPlaying(false)} />}
      {confirmDelete && (
        <ConfirmDialog title="Delete board?" confirmLabel="Delete board" danger onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await dispatch('visionBoard', 'deleteBoard', { id: board.id });
            // Drop it locally first, like createBoard adds locally: /vision must not find it before the live push arrives.
            store.apply([{ model: 'visionBoard', op: 'remove', row: board }]);
            forgetBoard(board.accountSeq);
            navigate('/vision');
          }}>
          <p>The board on <strong>{title}</strong> and everything pinned on it is deleted for everyone. The task stays.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

const readOnlyWhy = (state: VisionBoard['state']) =>
  state === 'locked' ? 'It is locked.' : state === 'read_only' ? 'Only the person who made it can edit it.' : 'You can\'t edit its task.';

/** Starts a board for a whole project, laid out as its tree. */
function ProjectBoardButton({ primary }: { primary?: boolean }) {
  const projects = useStore((s) => [...s.projects.values()].filter((p) => !p.isArchived && [...s.decks.values()].some((d) => d.projectId === p.id)).sort((a, b) => a.seq - b.seq));
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const pick = id || projects[0]?.id || '';
  if (!projects.length) return null;
  return (
    <>
      <button type="button" className={primary ? 'btn btn-primary' : 'btn'} onClick={() => setOpen(true)}>Project board</button>
      {open && (
        <Dialog title="Project board" onClose={() => setOpen(false)}
          onSubmit={() => createProjectBoard(pick).then((href) => { setOpen(false); navigate(href); }).catch(() => {})}
          actions={<><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create board</button></>}>
          <label className="field">
            <span>Project</span>
            <select value={pick} onChange={(e) => setId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <p className="hint">Makes a board with the whole project as a tree: areas, lists and open tasks, joined by lines. Move anything, add notes, and draw a line from a task to a list or to another task to change the project.</p>
        </Dialog>
      )}
    </>
  );
}

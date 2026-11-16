import { taskId } from '../taskId';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { VisionBoard } from '../../../shared/types';
import { cardCode, titleOf } from '../../../shared/cards';
import { navigate } from '../router';
import { useStore } from '../store';
import { boardPath, recentBoardSeqs } from '../board/boards';
import { Icon } from './icons';

interface Row { board: VisionBoard; title: string; code: string }

/** The header's board switcher: the current board's host card title opens a searchable list of boards. */
export function BoardPicker({ current, title }: { current: VisionBoard; title: string }) {
  const boards = useStore((s) => s.visionBoards);
  const cards = useStore((s) => s.cards);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const { recent, all } = useMemo(() => {
    if (!open) return { recent: [] as Row[], all: [] as Row[] };
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    const rows: Row[] = [...boards.values()].flatMap((board) => {
      const card = cards.get(board.cardId);
      return card ? [{ board, title: titleOf(card.content) || 'Untitled', code: taskId(card) }] : [];
    }).filter((r) => !q || r.title.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      .sort((a, b) => a.board.accountSeq - b.board.accountSeq);
    const recentRows = recentBoardSeqs().flatMap((seq) => rows.filter((r) => r.board.accountSeq === seq));
    return { recent: recentRows, all: rows };
  }, [open, query, boards, cards]);
  const options = [...recent, ...all];

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => { setOpen(false); setQuery(''); button.current?.focus(); };
  const pick = (r: Row) => { close(); if (r.board.id !== current.id) navigate(boardPath(r.board.accountSeq)); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = options[active]; if (r) pick(r); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const item = (r: Row, i: number, group: string) => (
    <li key={`${group}-${r.board.id}`} role="option" aria-selected={i === active} aria-current={r.board.id === current.id ? 'true' : undefined}
      className={i === active ? 'picker-opt active' : 'picker-opt'}
      onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
      <span className="picker-opt-title">{r.title}</span>
      <span className="picker-sub">{r.code}</span>
      {r.board.id === current.id && <span className="picker-current">Current</span>}
    </li>
  );

  return (
    <div className="picker" ref={wrap}>
      <button ref={button} type="button" className="btn vision-title" title="Choose board" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <span className="picker-value">{title}</span> <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="picker-pop board-picker-pop" role="dialog" aria-label="Choose board">
          <div className="picker-search">
            <Icon name="search" size={15} />
            <input autoFocus aria-label="Search boards" placeholder="Search boards" value={query}
              onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          </div>
          <ul role="listbox" aria-label="Boards" className="picker-list">
            {recent.length > 0 && <li role="presentation" className="picker-group">Last opened</li>}
            {recent.map((r, i) => item(r, i, 'recent'))}
            <li role="presentation" className="picker-group">All boards</li>
            {all.map((r, i) => item(r, recent.length + i, 'all'))}
            {all.length === 0 && <li role="presentation" className="picker-empty">No matching boards</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

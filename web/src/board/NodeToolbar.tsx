import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { COLORS, type BoardColor, type BoardEdge, type BoardNode } from '../../../shared/board';
import { nodeName } from './nodes';
import { Icon } from '../components/icons';
import { DisplayMenu, type DisplayMenuProps } from './SmartNode';

const COLOR_LABEL: Record<BoardColor, string> = {
  green: 'Green', blue: 'Blue', pink: 'Pink', orange: 'Orange', purple: 'Purple', grey: 'Grey',
};

export interface NodeToolbarProps {
  /** Exactly one of node and edge: the toolbar serves both (an edge's Edit is "Edit label", and it has no Connect). */
  node?: BoardNode;
  edge?: BoardEdge;
  /** The other nodes a "Connect to…" can end at (nodes only). */
  targets?: BoardNode[];
  onConnect?: (targetId: string) => void;
  canEdit: boolean;
  onEdit: () => void;
  /** Card nodes: show the card in the side panel. */
  onOpen?: () => void;
  /** Smart Nodes: Display, Set up filter and Open as search. Without edit rights only Open as search is offered. */
  smart?: {
    display: Pick<DisplayMenuProps, 'value' | 'features' | 'onChange'>;
    onSetup: () => void;
    /** Absent while the node has no query. */
    onOpenSearch?: () => void;
  };
  onColor: (c: BoardColor | undefined) => void;
  onFocus: () => void;
  onDelete: () => void;
  /** Esc with no popover open: deselect, focus back on the node. */
  onClose: () => void;
}

/** Arrow keys, Home and End move focus between the buttons of one toolbar or swatch row. */
function rove(e: KeyboardEvent<HTMLElement>) {
  const scope = (e.target as HTMLElement).closest('[role="toolbar"], [role="group"]');
  if (!scope) return false;
  const items = [...scope.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
  const i = items.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return false;
  const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? items[(i + 1) % items.length]
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? items[(i - 1 + items.length) % items.length]
    : e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : null;
  if (!next) return false;
  next.focus();
  return true;
}

/** The actions above the selected node or connector. Read-only viewers get Focus only (and Open as search on a Smart Node). */
export function NodeToolbar({ node, edge, targets = [], onConnect, canEdit, onEdit, onOpen, smart, onColor, onFocus, onDelete, onClose }: NodeToolbarProps) {
  const [pop, setPop] = useState<'colors' | 'connect' | 'display' | null>(null);
  const colors = pop === 'colors';
  const connect = pop === 'connect';
  const display = pop === 'display';
  const displayBtn = useRef<HTMLButtonElement>(null);
  const displayMenu = useRef<HTMLDivElement>(null);
  const colorBtn = useRef<HTMLButtonElement>(null);
  const connectBtn = useRef<HTMLButtonElement>(null);
  const swatches = useRef<HTMLDivElement>(null);
  const targetList = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  // Keep the bar inside the canvas and clear of the tool rail (it is centred on the node, which may sit near an edge).
  useLayoutEffect(() => {
    const el = bar.current;
    const canvas = el?.closest('.board-canvas');
    if (!el || !canvas) return;
    el.style.left = '0px';
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const min = c.left + 56, max = c.right - 8;
    const shift = r.left < min ? min - r.left : r.right > max ? Math.min(0, max - r.right) : 0;
    if (shift) el.style.left = `${shift}px`; // the bar is counter-scaled, so screen px equal local px
  });
  const t = node?.type;
  const color = (node ?? edge)?.color;
  const edit = canEdit && (!!edge || t === 'text' || t === 'container' || t === 'filter');
  const open = t === 'card' && !!onOpen;

  // Opening a popover puts focus on its first useful item: the current colour, or the first target.
  useEffect(() => { if (colors) swatches.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); }, [colors]);
  useEffect(() => { if (display) displayMenu.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); }, [display]);
  useEffect(() => { if (connect) targetList.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [connect]);

  const closePop = () => { const was = pop; setPop(null); (was === 'connect' ? connectBtn : was === 'display' ? displayBtn : colorBtn).current?.focus(); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (pop) closePop(); else onClose();
    } else if (rove(e)) {
      e.preventDefault();
      e.stopPropagation(); // the canvas would otherwise move the node or pan
    } else if (e.key === '+' || e.key === '-' || e.key === '=' || e.key === 'Enter') {
      e.stopPropagation(); // buttons handle Enter themselves; zoom keys belong to the canvas, not its toolbar
    }
  };

  return (
    <div ref={bar} className="btoolbar" role="toolbar" aria-label={edge ? 'Connector actions' : 'Node actions'} onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}>
      {smart && canEdit && (
        <button ref={displayBtn} type="button" className="btn btn-sm btn-ghost" aria-expanded={display} onClick={() => setPop(display ? null : 'display')}>
          <Icon name="smart" size={14} /> Display
        </button>
      )}
      {smart && canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={smart.onSetup}><Icon name="gear" size={14} /> Set up filter</button>}
      {smart && <button type="button" className="btn btn-sm btn-ghost" disabled={!smart.onOpenSearch} onClick={smart.onOpenSearch}><Icon name="link" size={14} /> Open as search</button>}
      {edit && <button type="button" className="btn btn-sm btn-ghost" onClick={onEdit}><Icon name="edit" size={14} /> {edge || t === 'filter' ? 'Edit label' : 'Edit'}</button>}
      {open && <button type="button" className="btn btn-sm btn-ghost" onClick={onOpen}><Icon name="card" size={14} /> Open task</button>}
      {canEdit && (
        <button ref={colorBtn} type="button" className="btn btn-sm btn-ghost" aria-expanded={colors} onClick={() => setPop(colors ? null : 'colors')}>
          <span className={`bswatch${color ? ` bc-${color}` : ''}`} aria-hidden="true" /> Colour
        </button>
      )}
      {canEdit && node && onConnect && (
        <button ref={connectBtn} type="button" className="btn btn-sm btn-ghost" aria-expanded={connect} disabled={targets.length === 0}
          onClick={() => setPop(connect ? null : 'connect')}>Connect to…</button>
      )}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onFocus}><Icon name="focus" size={14} /> Focus</button>
      {canEdit && <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete}><Icon name="trash" size={14} /> Delete</button>}
      {display && smart && (
        <div ref={displayMenu} className="bcolors bsmart-menu" role="group" aria-label="Display">
          <DisplayMenu {...smart.display} />
        </div>
      )}
      {colors && (
        <div ref={swatches} className="bcolors" role="group" aria-label="Colour">
          <button type="button" className="bswatch-btn" aria-pressed={!color} onClick={() => { onColor(undefined); closePop(); }}>
            <span className="bswatch" aria-hidden="true" /> None
          </button>
          {COLORS.map((c) => (
            <button key={c} type="button" className="bswatch-btn" aria-pressed={color === c} aria-label={COLOR_LABEL[c]} title={COLOR_LABEL[c]}
              onClick={() => { onColor(c); closePop(); }}>
              <span className={`bswatch bc-${c}`} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {connect && (
        <div ref={targetList} className="bcolors bconnect-list" role="group" aria-label="Connect to">
          {targets.map((n) => (
            <button key={n.id} type="button" className="bswatch-btn" onClick={() => { onConnect?.(n.id); setPop(null); }}>{nodeName(n)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

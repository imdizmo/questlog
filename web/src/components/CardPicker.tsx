import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card } from '../../../shared/types';
import { cardCode, titleOf } from '../../../shared/cards';
import { Icon } from './icons';
import { useShownTitle } from '../translate';

const LIMIT = 50;

/**
 * Button that opens a searchable list of cards (title or $code). ↑/↓ move, Enter picks, Esc closes.
 * The caller decides which cards are offered (same project, not the card itself, …).
 */
export function CardPicker({ label, trigger, triggerClass = 'btn btn-sm', candidates, onPick, disabled, empty = 'No matching tasks', searchLabel = 'Search tasks' }: {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  triggerClass?: string;
  /** The cards offered; a function is called only while the picker is open (for lists that cost a scan). */
  candidates: Card[] | (() => Card[]);
  onPick: (card: Card) => void;
  disabled?: boolean;
  empty?: string;
  /** Placeholder and name of the search input. */
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shownTitle = useShownTitle();
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const options = useMemo(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    return (typeof candidates === 'function' ? candidates() : candidates)
      .filter((c) => !q || titleOf(c.content).toLowerCase().includes(q) || shownTitle(c).toLowerCase().includes(q) || cardCode(c.seq).toLowerCase().includes(q) || taskId(c).toLowerCase().includes(q))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, LIMIT);
  }, [open, query, candidates, shownTitle]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  const close = () => { setOpen(false); setQuery(''); button.current?.focus(); };
  const pick = (c: Card) => { close(); onPick(c); };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = options[active]; if (c) pick(c); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="picker" ref={wrap}>
      <button ref={button} type="button" className={triggerClass} disabled={disabled} aria-label={label}
        aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className="picker-pop">
          <div className="picker-search">
            <Icon name="search" size={15} />
            <input
              autoFocus role="combobox" aria-label={searchLabel} placeholder={searchLabel}
              aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            />
          </div>
          <ul id={listId} role="listbox" aria-label={label} className="picker-list">
            {options.map((c, i) => (
              <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={i === active ? 'picker-opt active' : 'picker-opt'}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                <span className="picker-opt-title">{shownTitle(c) || 'Untitled'}</span>
                <span className="picker-sub">{taskId(c)}</span>
              </li>
            ))}
            {options.length === 0 && <li role="presentation" className="picker-empty">{empty}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

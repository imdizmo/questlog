import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Deck } from '../../../shared/types';
import { canEditContent, projectVisible, useStore } from '../store';
import { spaceLabel } from '../spaces';
import { pushRecentDeck, readRecentDecks } from '../cards';
import { DeckTypeIcon, Icon } from './icons';

interface Props {
  /** Selected deck id. */
  value: string | null;
  onChange: (deckId: string) => void;
  /** Task cards can't live in doc decks, so those are hidden for them. */
  isDoc: boolean;
  disabled?: boolean;
  /** Shown when no deck is selected (default "No deck"). */
  emptyLabel?: string;
}

interface Group { key: string; label: string; decks: Deck[] }

/**
 * Button that opens a searchable deck list: recent decks first, then every deck grouped
 * "Project – Section". ↑/↓ move, Enter picks, Esc closes.
 */
export function DeckPicker({ value, onChange, isDoc, disabled, emptyLabel }: Props) {
  const s = useStore((x) => x);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = value ? s.decks.get(value) : undefined;

  const groups = useMemo<Group[]>(() => {
    if (!open) return [];
    const ok = (d: Deck) => {
      const p = s.projects.get(d.projectId);
      return !!p && !p.isArchived && projectVisible(s, p.id) && canEditContent(s, p) && (isDoc || d.deckType !== 'doc');
    };
    const q = query.trim().toLowerCase();
    const label = (d: Deck) => {
      const p = s.projects.get(d.projectId)!;
      return `${p.name} – ${spaceLabel(p.spaces.find((sp) => sp.id === d.spaceId) ?? { name: null })}`;
    };
    const match = (d: Deck) => !q || d.title.toLowerCase().includes(q) || label(d).toLowerCase().includes(q);
    const out: Group[] = [];
    const recent = readRecentDecks().map((id) => s.decks.get(id)).filter((d): d is Deck => !!d && ok(d) && match(d));
    if (recent.length) out.push({ key: 'recent', label: 'Recent lists', decks: recent });
    const projects = [...s.projects.values()].sort((a, b) => a.seq - b.seq);
    for (const p of projects) {
      for (const sp of p.spaces) {
        const decks = [...s.decks.values()]
          .filter((d) => d.projectId === p.id && d.spaceId === sp.id && ok(d) && match(d))
          .sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq);
        if (decks.length) out.push({ key: `${p.id}-${sp.id}`, label: `${p.name} – ${spaceLabel(sp)}`, decks });
      }
    }
    return out;
  }, [open, query, s, isDoc]);

  const flat = useMemo(() => groups.flatMap((g) => g.decks.map((d) => ({ g, d }))), [groups]);

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
  const pick = (d: Deck) => {
    pushRecentDeck(d.id);
    close();
    if (d.id !== value) onChange(d.id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = flat[active]; if (it) pick(it.d); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  let i = -1;
  return (
    <div className="picker" ref={wrap}>
      <button
        ref={button} type="button" className="picker-btn" disabled={disabled}
        aria-label={current ? `List: ${current.title}` : emptyLabel ?? 'List: none'} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        {current && <DeckTypeIcon type={current.deckType} size={14} />}
        <span className="picker-value">{current?.title ?? emptyLabel ?? 'No list'}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="picker-pop">
          <div className="picker-search">
            <Icon name="search" size={15} />
            <input
              autoFocus role="combobox" aria-label="Search lists" placeholder="Search lists"
              aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={flat.length ? `${listId}-${active}` : undefined}
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Lists" className="picker-list">
            {groups.map((g) => (
              <li key={g.key} role="presentation">
                <div className="picker-group" id={`${listId}-g-${g.key}`} aria-hidden>{g.label}</div>
                <ul role="group" aria-labelledby={`${listId}-g-${g.key}`}>
                  {g.decks.map((d) => {
                    i++;
                    const idx = i;
                    const isCurrent = d.id === value;
                    return (
                      <li
                        key={d.id} id={`${listId}-${idx}`} role="option" aria-selected={idx === active}
                        className={idx === active ? 'picker-opt active' : 'picker-opt'}
                        onMouseEnter={() => setActive(idx)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(d)}
                      >
                        <span className="picker-opt-title">{d.title}</span>
                        {isCurrent && <span className="picker-current">current</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {flat.length === 0 && <li role="presentation" className="picker-empty">No matching lists</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

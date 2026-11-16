import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  /** Makes the item a radio of the menu (menuitemradio) that is checked or not. */
  checked?: boolean;
  /** Smaller second line under the label. */
  hint?: string;
}

interface Props {
  /** Accessible name of the trigger button. */
  label: string;
  /** Visible trigger content (usually an icon). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  /** Trigger button class; an icon button by default. */
  triggerClass?: string;
}

/** Button that opens a list of actions. Arrow keys move, Esc closes, focus returns to the button. */
export function Menu({ label, trigger, items, align = 'right', triggerClass = 'icon-btn' }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const itemEls = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  // The list is portalled to <body> with fixed coordinates, so a panel with overflow hidden can't clip it; it is
  // kept inside the viewport and follows its button when the page scrolls or resizes.
  const place = () => {
    const el = menu.current;
    if (!button.current || !el) return;
    el.style.maxHeight = '';
    const b = button.current.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    const gap = 4, edge = 8, vw = window.innerWidth, vh = window.innerHeight;
    let left = align === 'right' ? b.right - m.width : b.left;
    left = Math.max(edge, Math.min(left, vw - m.width - edge));
    // Below the button if it fits, else above it, else pinned to the bottom edge (a taller list scrolls inside).
    let top = b.bottom + gap;
    if (top + m.height > vh - edge) top = b.top - gap - m.height >= edge ? b.top - gap - m.height : Math.max(edge, vh - edge - m.height);
    Object.assign(el.style, {
      position: 'fixed', top: `${top}px`, left: `${left}px`, right: 'auto', maxHeight: `${vh - 2 * edge}px`, overflowY: 'auto',
    });
  };
  useLayoutEffect(() => { if (open) place(); }, [open, align]);
  const focusAt = (i: number) => { const els = itemEls(); els[(i + els.length) % els.length]?.focus(); };

  useEffect(() => {
    if (!open) return;
    focusAt(0);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    let frame = 0;
    const onMove = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus(); };

  const onKey = (e: KeyboardEvent) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={button} type="button" className={triggerClass} aria-label={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
      >
        {trigger}
      </button>
      {open && createPortal(
        <div ref={menu} id={id} role="menu" aria-label={label} className={`menu menu-${align}`} onKeyDown={onKey}>
          {items.map((it) => (
            <button
              key={it.label} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={it.checked}
              tabIndex={-1} disabled={it.disabled} title={it.title}
              className={it.danger ? 'menu-item danger' : 'menu-item'}
              onClick={() => { close(); it.onSelect(); }}
            >
              {it.checked !== undefined && <span className="menu-check" aria-hidden>{it.checked ? '●' : '○'}</span>}
              <span>{it.label}{it.hint && <small className="menu-hint">{it.hint}</small>}</span>
            </button>
          ))}
        </div>,
        // An open modal <dialog> sits in the top layer, above anything in <body>: a menu inside one is portalled to it.
        wrap.current?.closest('dialog') ?? document.body,
      )}
    </div>
  );
}

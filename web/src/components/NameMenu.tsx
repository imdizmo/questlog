import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from '../router';
import { ignoreName } from '../linkIgnores';
import { copyText } from '../cards';
import { showToast } from '../toast';
import { usePanelOpener } from './wiki/panelContext';

export interface NameMenuAt {
  /** The recognised name's link in the rendered text; focus returns to it. */
  anchor: HTMLAnchorElement;
  x: number;
  y: number;
}

/**
 * The menu of a recognised name in rendered text (right-click, the context-menu key or Alt+Enter on the link): Open,
 * Open beside (in the wiki: a panel to the right), Open in new tab and Copy link (it replaces the browser's own menu),
 * and "Not a link here" for the card whose text it is (with Undo in the toast). Arrow keys move, Esc closes.
 */
export function NameMenu({ at, cardId, onClose }: { at: NameMenuAt; cardId: string | null; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const href = at.anchor.getAttribute('href') ?? '';
  const name = at.anchor.dataset.name ?? at.anchor.textContent ?? '';
  const title = at.anchor.getAttribute('title') ?? name;
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const close = (refocus: boolean) => { onClose(); if (refocus && at.anchor.isConnected) at.anchor.focus(); };
  const beside = usePanelOpener();
  /** The text block the link sits in: where focus goes once the name stops being a link. */
  const focusBlock = () => {
    const block = at.anchor.closest<HTMLElement>('.md');
    if (!block) return;
    if (!block.hasAttribute('tabindex')) {
      // Only for this focus: the text block is not a tab stop otherwise.
      block.setAttribute('tabindex', '-1');
      block.addEventListener('blur', () => block.removeAttribute('tabindex'), { once: true });
    }
    block.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const m = el.getBoundingClientRect();
    const edge = 8;
    el.style.left = `${Math.max(edge, Math.min(at.x, window.innerWidth - m.width - edge))}px`;
    el.style.top = `${at.y + m.height > window.innerHeight - edge ? Math.max(edge, at.y - m.height) : at.y}px`;
  }, [at]);

  useEffect(() => {
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    const onScroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) onClose(); };
    const onResize = () => onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [at]);

  const onKey = (e: KeyboardEvent) => {
    const els = items();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div ref={menu} role="menu" aria-label={`Link to ${title}`} className="menu name-menu" data-testid="name-menu" onKeyDown={onKey}
      onBlur={(e) => { if (!menu.current?.contains(e.relatedTarget as Node | null)) onClose(); }}>
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => { onClose(); navigate(href); }}>Open</button>
      {beside && (
        <button type="button" role="menuitem" tabIndex={-1} className="menu-item" title="In a panel to the right of this one"
          onClick={() => { onClose(); beside.openHref(href); }}>Open beside</button>
      )}
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item"
        onClick={() => { close(true); window.open(href, '_blank', 'noopener'); }}>Open in new tab</button>
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item"
        onClick={() => {
          close(true);
          void copyText(new URL(href, location.origin).href).then((ok) => showToast(ok ? 'Link copied.' : "Couldn't copy the link.", ok ? 'info' : 'error', 3000));
        }}>Copy link</button>
      {cardId && (
        <button type="button" role="menuitem" tabIndex={-1} className="menu-item" title={`Stops linking "${name}" in this text`}
          onClick={() => { focusBlock(); onClose(); ignoreName(cardId, name); }}>Not a link here</button>
      )}
    </div>,
    at.anchor.closest('dialog') ?? document.body,
  );
}

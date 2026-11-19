import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** The buttons and links of a rail, in order (not those inside a menu or a dialog it opened). */
const itemsOf = (el: HTMLElement | null): HTMLElement[] =>
  el ? [...el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')].filter((b) => !b.closest('[role="menu"], [role="dialog"]')) : [];

/**
 * A floating board toolbar, one look on every board (the redesign preview's `.rail`): Boards on top, Add on the left,
 * View and picture on the right. One tab stop: the arrow keys, Home and End move between its buttons; Tab leaves.
 */
export function Rail({ label, className, vertical, children }: { label: string; className: string; vertical?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  /** The button that holds the tab stop (the last one focused), by index. */
  const at = useRef(-1);
  // After every render (buttons come and go): exactly one button is in the tab order.
  useLayoutEffect(() => {
    const items = itemsOf(ref.current);
    if (!items.length) return;
    const focused = items.indexOf(document.activeElement as HTMLElement);
    let i = focused >= 0 ? focused : at.current;
    if (i < 0 || i >= items.length) i = Math.max(0, items.findIndex((b) => b.getAttribute('aria-pressed') === 'true'));
    items.forEach((b, k) => { b.tabIndex = k === i ? 0 : -1; });
  });
  const onFocus = () => {
    const items = itemsOf(ref.current), k = items.indexOf(document.activeElement as HTMLElement);
    if (k < 0) return;
    at.current = k;
    items.forEach((b, j) => { b.tabIndex = j === k ? 0 : -1; });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = itemsOf(ref.current), k = items.indexOf(document.activeElement as HTMLElement);
    if (k < 0) return;
    const next = vertical ? 'ArrowDown' : 'ArrowRight', prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    let to = -1;
    if (e.key === next) to = (k + 1) % items.length;
    else if (e.key === prev) to = (k - 1 + items.length) % items.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    if (to < 0) return;
    e.preventDefault();
    items[to].focus();
  };
  return (
    <div ref={ref} role="toolbar" aria-label={label} aria-orientation={vertical ? 'vertical' : 'horizontal'} className={`rail ${className}`}
      onFocus={onFocus} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

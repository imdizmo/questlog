import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Card } from '../../../shared/types';
import { renderContext, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { navigate } from '../router';
import { nameLinks, projectIdOf } from '../wiki';
import { NameMenu, type NameMenuAt } from './NameMenu';

/**
 * Card text rendered as Markdown. The HTML comes only from renderMarkdown (markdown-it with raw
 * HTML off, plus our escaped chips), so it is safe to set as innerHTML. Card links and other
 * same-site links open inside the app; ticking a checkbox calls onToggle with its line.
 * Names of the project's wiki entries become links: the project of `card` (whose own names and "Not a link here" names
 * stay text), else `projectId`. A name's menu (right-click, the context-menu key or Alt+Enter on it) has Open and, with
 * `editable`, "Not a link here" for `card`.
 */
export function MarkdownView({ content, lineOffset = 0, onToggle, testId, className, card, projectId, editable = false }: {
  content: string;
  editable?: boolean;
  card?: Card | null;
  projectId?: string | null;
  lineOffset?: number;
  onToggle?: (line: number, checked: boolean, box: HTMLInputElement) => void;
  testId?: string;
  className?: string;
}) {
  const cards = useStore((s) => s.cards);
  const users = useStore((s) => s.users);
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const checkable = !!onToggle;
  const project = (card ? projectIdOf(decks, card) : null) ?? projectId ?? null;
  const html = useMemo(() => {
    const names = nameLinks({ cards, decks, projects }, project, card);
    return renderMarkdown(content, renderContext(cards, users, { decks, projects, names }), { lineOffset, checkable });
  }, [content, cards, users, decks, projects, project, card, lineOffset, checkable]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains('md-check')) {
      const line = Number(t.dataset.line);
      if (onToggle && Number.isInteger(line)) onToggle(line, t.checked, t);
      return;
    }
    const a = t.closest('a');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute('href') ?? '';
    // Same-site paths (card references, deck links) stay in this tab.
    if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  const [menu, setMenu] = useState<NameMenuAt | null>(null);
  const nameLink = (t: EventTarget) => (t as HTMLElement).closest?.('a.entry-link') as HTMLAnchorElement | null;
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const a = nameLink(e.target);
    if (!a) return;
    e.preventDefault();
    // From the keyboard (context-menu key, Shift+F10) the event has no pointer position: open under the link.
    const r = a.getBoundingClientRect();
    setMenu(e.clientX || e.clientY ? { anchor: a, x: e.clientX, y: e.clientY } : { anchor: a, x: r.left, y: r.bottom + 4 });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const a = nameLink(e.target);
    if (!a || e.key !== 'Enter' || !e.altKey) return;
    e.preventDefault();
    const r = a.getBoundingClientRect();
    setMenu({ anchor: a, x: r.left, y: r.bottom + 4 });
  };

  return (
    <>
      <div className={`md${className ? ` ${className}` : ''}`} data-testid={testId} onClick={onClick}
        onContextMenu={onContextMenu} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />
      {menu && <NameMenu at={menu} cardId={editable && card ? card.id : null} onClose={() => setMenu(null)} />}
    </>
  );
}

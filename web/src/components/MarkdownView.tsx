import { useMemo, type MouseEvent } from 'react';
import { renderContext, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { navigate } from '../router';

/**
 * Card text rendered as Markdown. The HTML comes only from renderMarkdown (markdown-it with raw
 * HTML off, plus our escaped chips), so it is safe to set as innerHTML. Card links and other
 * same-site links open inside the app; ticking a checkbox calls onToggle with its line.
 */
export function MarkdownView({ content, lineOffset = 0, onToggle, testId, className }: {
  content: string;
  lineOffset?: number;
  onToggle?: (line: number, checked: boolean, box: HTMLInputElement) => void;
  testId?: string;
  className?: string;
}) {
  const cards = useStore((s) => s.cards);
  const users = useStore((s) => s.users);
  const checkable = !!onToggle;
  const html = useMemo(
    () => renderMarkdown(content, renderContext(cards, users), { lineOffset, checkable }),
    [content, cards, users, lineOffset, checkable],
  );

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

  return (
    <div className={`md${className ? ` ${className}` : ''}`} data-testid={testId} onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}

import { useEffect, useRef } from 'react';

export type RefKind = 'user' | 'tag' | 'card' | 'deck' | 'emoji' | 'image';

/** What a command does: insert Markdown, open a picker, or act on the editor. */
export type CommandAction =
  | { kind: 'block'; text: string; caret?: number }
  | { kind: 'inline'; text: string; select?: [number, number] }
  | { kind: 'pick'; ref: RefKind }
  | { kind: 'properties' }
  | { kind: 'focus' };

export interface Command { id: string; label: string; group: string; hint?: string; action: CommandAction }

/** The `/` commands, in menu order (groups as observed). */
export const COMMANDS: Command[] = [
  { id: 'props', group: 'Task properties', label: 'Set properties', action: { kind: 'properties' } },
  { id: 'focus', group: 'Task properties', label: 'Focus mode', action: { kind: 'focus' } },
  { id: 'mention', group: 'References', label: 'Mention user', hint: '@', action: { kind: 'pick', ref: 'user' } },
  { id: 'tag', group: 'References', label: 'Add tag', hint: '#', action: { kind: 'pick', ref: 'tag' } },
  { id: 'card', group: 'References', label: 'Reference task', hint: '$', action: { kind: 'pick', ref: 'card' } },
  { id: 'deck', group: 'References', label: 'Reference list', action: { kind: 'pick', ref: 'deck' } },
  { id: 'h1', group: 'Headings', label: 'Heading 1', hint: '#', action: { kind: 'block', text: '# ' } },
  { id: 'h2', group: 'Headings', label: 'Heading 2', hint: '##', action: { kind: 'block', text: '## ' } },
  { id: 'h3', group: 'Headings', label: 'Heading 3', hint: '###', action: { kind: 'block', text: '### ' } },
  { id: 'bullets', group: 'Lists', label: 'Bulleted list', hint: '-', action: { kind: 'block', text: '- ' } },
  { id: 'numbers', group: 'Lists', label: 'Numbered list', hint: '1.', action: { kind: 'block', text: '1. ' } },
  { id: 'checklist', group: 'Lists', label: 'Checklist', hint: '- [ ]', action: { kind: 'block', text: '- [ ] ' } },
  { id: 'emoji', group: 'Formatting', label: 'Emoji', action: { kind: 'pick', ref: 'emoji' } },
  { id: 'quote', group: 'Formatting', label: 'Quote', hint: '>', action: { kind: 'block', text: '> ' } },
  { id: 'code', group: 'Formatting', label: 'Code block', hint: '```', action: { kind: 'block', text: '```\n\n```\n', caret: 4 } },
  { id: 'divider', group: 'Formatting', label: 'Divider', hint: '---', action: { kind: 'block', text: '---\n' } },
  { id: 'image', group: 'Links', label: 'Embed attached image', action: { kind: 'pick', ref: 'image' } },
  { id: 'link', group: 'Links', label: 'External link', action: { kind: 'inline', text: '[link text](https://)', select: [1, 10] } },
];

/** Commands whose label words start with every word typed after the slash. */
export function filterCommands(query: string, available: Command[] = COMMANDS): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return available;
  return available.filter((c) => {
    const label = c.label.toLowerCase().split(/\s+/);
    return words.every((w) => label.some((l) => l.startsWith(w)));
  });
}

/**
 * The `/` menu. Focus stays in the textarea, which drives it (arrows, Enter, Esc) and points at
 * the active option with aria-activedescendant.
 */
export function SlashMenu({ id, items, active, pos, onPick, onHover }: {
  id: string;
  items: Command[];
  active: number;
  pos: { top: number; left: number };
  onPick: (c: Command) => void;
  onHover: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const groups: { name: string; items: { c: Command; i: number }[] }[] = [];
  items.forEach((c, i) => {
    const g = groups[groups.length - 1];
    if (g?.name === c.group) g.items.push({ c, i });
    else groups.push({ name: c.group, items: [{ c, i }] });
  });

  return (
    <div ref={ref} id={id} role="listbox" aria-label="Insert" className="slash-menu" style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault() /* keep the caret in the textarea */}>
      {groups.map((g) => (
        <div key={g.name} role="group" aria-labelledby={`${id}-g-${g.name.replace(/\s+/g, '-')}`}>
          <div id={`${id}-g-${g.name.replace(/\s+/g, '-')}`} className="picker-group" aria-hidden>{g.name}</div>
          {g.items.map(({ c, i }) => (
            <div key={c.id} id={`${id}-${c.id}`} role="option" aria-selected={i === active}
              className={i === active ? 'picker-opt active' : 'picker-opt'} onMouseEnter={() => onHover(i)} onClick={() => onPick(c)}>
              <span className="picker-opt-title">{c.label}</span>
              {c.hint && <kbd aria-hidden="true">{c.hint}</kbd>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

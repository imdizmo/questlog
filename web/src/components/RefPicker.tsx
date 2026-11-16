import { taskId } from '../taskId';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cardCode, titleOf } from '../../../shared/cards';
import { mentionHandle, TOKEN_BODY } from '../../../shared/content';
import { people, projectVisible, useStore, type CardFile } from '../store';
import { deckPath } from '../cards';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import type { RefKind } from './SlashMenu';

/** A small built-in emoji set (no dependency): the ones game-dev cards tend to use. */
export const EMOJI: [string, string][] = [
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['✅', 'done check'], ['❌', 'cross no'], ['⚠️', 'warning'], ['❗', 'important'],
  ['❓', 'question'], ['💡', 'idea'], ['🔥', 'fire hot'], ['🚀', 'rocket ship'], ['🐞', 'bug'], ['🛠️', 'tools fix'],
  ['🔧', 'wrench'], ['⚙️', 'gear settings'], ['🧪', 'test experiment'], ['📌', 'pin'], ['📝', 'note memo'], ['📎', 'attachment clip'],
  ['🔗', 'link'], ['📅', 'calendar date'], ['⏰', 'alarm time'], ['⏳', 'waiting'], ['🎯', 'target goal'], ['🎮', 'game controller'],
  ['🎨', 'art palette'], ['🎵', 'music'], ['🔊', 'sound audio'], ['🖼️', 'image picture'], ['🗺️', 'map level'], ['🧩', 'puzzle'],
  ['⭐', 'star'], ['❤️', 'heart love'], ['😀', 'smile happy'], ['😅', 'sweat'], ['🤔', 'thinking'], ['😢', 'sad'],
  ['🎉', 'party celebrate'], ['👀', 'eyes look'], ['🙏', 'thanks please'], ['💬', 'comment chat'], ['🔒', 'lock locked'], ['🚧', 'construction wip'],
];

interface Option { key: string; label: string; sub?: string; insert: string }

const TITLES: Record<RefKind, string> = {
  user: 'Mention user', tag: 'Add tag', card: 'Reference task', deck: 'Reference list', emoji: 'Emoji', image: 'Embed attached image',
};
const EMPTY: Record<RefKind, string> = {
  user: 'No matching people', tag: 'No matching tags', card: 'No matching tasks', deck: 'No matching lists', emoji: 'No matching emoji',
  image: 'No images attached to this task yet.',
};
const LIMIT = 50;
const TAG_RE = new RegExp(`^${TOKEN_BODY.tag}$`, 'u');
/** Square brackets would end a link label early. */
const label = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

/**
 * Searchable list for a `/` reference command. ↑/↓ move, Enter inserts the Markdown for the
 * highlighted entry, Esc closes without inserting.
 */
export function RefPicker({ kind, projectId, images, onPick, onClose }: {
  kind: RefKind;
  /** Tags come from this project; without one, from every visible project. */
  projectId: string | null;
  images: CardFile[];
  onPick: (markdown: string) => void;
  onClose: () => void;
}) {
  const s = useStore((x) => x);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
    let out: Option[] = [];
    if (kind === 'user') {
      out = people(s.users).filter((u) => !u.disabled).sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => ({ key: u.id, label: u.name, sub: `@${mentionHandle(u.name)}`, insert: `@${mentionHandle(u.name)} ` }));
    } else if (kind === 'tag') {
      const projects = projectId ? [s.projects.get(projectId)].filter((p) => !!p) : [...s.projects.values()].filter((p) => projectVisible(s, p.id));
      const names = new Map<string, string | null>();
      for (const p of projects) for (const t of p.tags) if (!names.has(t.name)) names.set(t.name, t.emoji);
      out = [...names].sort(([a], [b]) => a.localeCompare(b))
        .map(([n, emoji]) => ({ key: n, label: `${emoji ? `${emoji} ` : ''}#${n}`, insert: `#${n} ` }));
      // Any word can be a tag; offer the typed one when it isn't in the list.
      const typed = q.replace(/^#/, '');
      if (typed && TAG_RE.test(typed) && !names.has(typed)) out.push({ key: `new:${typed}`, label: `#${typed}`, sub: 'new tag', insert: `#${typed} ` });
    } else if (kind === 'card') {
      out = [...s.cards.values()].filter((c) => c.visibility === 'default').sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .map((c) => ({ key: c.id, label: titleOf(c.content), sub: taskId(c), insert: `$${cardCode(c.seq)} ` }));
    } else if (kind === 'deck') {
      out = [...s.decks.values()].filter((d) => projectVisible(s, d.projectId)).sort((a, b) => a.title.localeCompare(b.title))
        .map((d) => ({ key: d.id, label: d.title, sub: s.projects.get(d.projectId)?.name, insert: `[${label(d.title)}](${deckPath(d)}) ` }));
    } else if (kind === 'emoji') {
      out = EMOJI.map(([e, name]) => ({ key: e, label: `${e} ${name.split(' ')[0]}`, sub: name, insert: e }));
    } else {
      out = images.map((f) => ({ key: f.id, label: f.name, insert: `![${label(f.name)}](/api/files/${encodeURIComponent(f.id)}) ` }));
    }
    return out.filter((o) => o.key.startsWith('new:') || hit(o.label, o.sub)).slice(0, LIMIT);
  }, [kind, query, s, projectId, images]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o) onPick(o.insert); }
  };

  return (
    <Dialog title={TITLES[kind]} onClose={onClose}>
      <div className="ref-picker">
        <div className="picker-search">
          <Icon name="search" size={15} />
          <input
            autoFocus data-autofocus role="combobox" aria-label={`Search: ${TITLES[kind]}`} placeholder="Search"
            aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          />
        </div>
        <ul id={listId} role="listbox" aria-label={TITLES[kind]} className="picker-list">
          {options.map((o, i) => (
            <li key={o.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={i === active ? 'picker-opt active' : 'picker-opt'}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(o.insert)}>
              <span className="picker-opt-title">{o.label}</span>
              {o.sub && <span className="picker-sub">{o.sub}</span>}
            </li>
          ))}
          {options.length === 0 && <li role="presentation" className="picker-empty">{EMPTY[kind]}</li>}
        </ul>
      </div>
    </Dialog>
  );
}

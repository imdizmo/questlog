export type ShortcutScope = 'global' | 'card' | 'deck';

export interface Shortcut {
  /** Stable name that code uses to look the entry up. */
  id: string;
  /** What the person presses, as shown in the panel (also the `key` value for single letters). */
  keys: string;
  label: string;
  scope: ShortcutScope;
  /** Listed but not wired yet. */
  soon?: boolean;
}

/** The one list of keyboard shortcuts: the panel shows it, and the handlers read their keys from it. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'search', keys: '/', label: 'Focus search', scope: 'global' },
  { id: 'help', keys: '?', label: 'Show or hide this list', scope: 'global' },
  { id: 'escape', keys: 'Esc', label: 'Close the innermost open thing', scope: 'global' },
  { id: 'nav.hand', keys: 'Shift+1', label: 'My tasks', scope: 'global' },
  { id: 'nav.decks', keys: 'Shift+2', label: 'Lists', scope: 'global' },
  { id: 'nav.timeline', keys: 'Shift+3', label: 'Timeline', scope: 'global' },
  { id: 'nav.vision', keys: 'Shift+4', label: 'Boards', scope: 'global' },
  { id: 'nav.mission', keys: 'Shift+5', label: 'Mission Control', scope: 'global', soon: true },
  { id: 'nav.inbox', keys: 'i', label: 'Messages', scope: 'global' },
  { id: 'timer', keys: 'Alt+P', label: 'Start or stop my timer', scope: 'global' },
  { id: 'card.properties', keys: 'z', label: 'Properties tab', scope: 'card' },
  { id: 'card.subcards', keys: 's', label: 'Subtasks tab', scope: 'card' },
  { id: 'card.conversations', keys: 'n', label: 'Conversations tab', scope: 'card' },
  { id: 'deck.order', keys: 'o', label: 'Order panel', scope: 'deck' },
  { id: 'deck.tags', keys: 't', label: 'Tag panel', scope: 'deck' },
];

export const SCOPE_LABEL: Record<ShortcutScope, string> = { global: 'Everywhere', deck: 'In a list', card: 'On a task' };

/** The keys of one entry (throws on a misspelt id, which is a programming error). */
export function keysOf(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  return s.keys;
}

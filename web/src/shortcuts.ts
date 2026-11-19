export type ShortcutScope = 'global' | 'card' | 'deck' | 'board' | 'editor';

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
  { id: 'palette', keys: 'Ctrl+K', label: 'Find or create anything (⌘K on a Mac; works while typing too)', scope: 'global' },
  { id: 'help', keys: '?', label: 'Show or hide this list', scope: 'global' },
  { id: 'escape', keys: 'Esc', label: 'Close the innermost open thing (in the wiki: the rightmost side panel)', scope: 'global' },
  { id: 'nav.hand', keys: 'Shift+1', label: 'My tasks', scope: 'global' },
  { id: 'nav.decks', keys: 'Shift+2', label: 'Lists', scope: 'global' },
  { id: 'nav.timeline', keys: 'Shift+3', label: 'Timeline', scope: 'global' },
  { id: 'nav.vision', keys: 'Shift+4', label: 'Home', scope: 'global' },
  { id: 'nav.mission', keys: 'Shift+5', label: 'Mission Control', scope: 'global', soon: true },
  { id: 'nav.inbox', keys: 'i', label: 'Messages', scope: 'global' },
  { id: 'tabs.go', keys: 'Alt+1…9', label: 'Show tab 1 to 8; Alt+9 the last tab (not while typing; not on a Mac, where Option+digit types a character)', scope: 'global' },
  { id: 'tabs.new', keys: 'Ctrl+T', label: 'New tab (desktop app; a browser keeps this key)', scope: 'global' },
  { id: 'tabs.close', keys: 'Ctrl+W', label: 'Close the tab (desktop app; a browser keeps this key)', scope: 'global' },
  { id: 'tabs.next', keys: 'Ctrl+Tab', label: 'Next tab, with Shift the one before (desktop app; a browser keeps this key)', scope: 'global' },
  { id: 'timer', keys: 'Alt+P', label: 'Start or stop my timer', scope: 'global' },
  { id: 'card.properties', keys: 'z', label: 'Properties tab', scope: 'card' },
  { id: 'card.subcards', keys: 's', label: 'Subtasks tab', scope: 'card' },
  { id: 'card.conversations', keys: 'n', label: 'Conversations tab', scope: 'card' },
  { id: 'deck.order', keys: 'o', label: 'Order panel', scope: 'deck' },
  { id: 'deck.tags', keys: 't', label: 'Tag panel', scope: 'deck' },
  { id: 'editor.save', keys: 'Ctrl+Enter', label: 'Save the text', scope: 'editor' },
  { id: 'editor.namePopover', keys: 'Alt+Enter', label: 'On a linked name, reading or editing: its menu (Open, Open beside in the wiki, Not a link here)', scope: 'editor' },
  { id: 'board.move', keys: 'Arrow keys', label: 'Move the focused node (Shift: five steps; Alt: resize)', scope: 'board' },
  { id: 'board.moveTask', keys: 'Arrow keys', label: "On a project board, moving a task card into another list's frame also moves the task to that list", scope: 'board' },
];

export const SCOPE_LABEL: Record<ShortcutScope, string> = { global: 'Everywhere', deck: 'In a list', card: 'On a task', board: 'On a board', editor: 'In the text editor' };

/** The keys of one entry (throws on a misspelt id, which is a programming error). */
export function keysOf(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  return s.keys;
}

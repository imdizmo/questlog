import { dispatch } from './api';
import { showToast } from './toast';

/**
 * "Not a link here" for `name` in the card's text, with an Undo toast that links it again. The card's ignores come back
 * over the live socket, so every view of the text (editor and reader) follows.
 */
export function ignoreName(cardId: string, name: string): void {
  void dispatch('cards', 'addLinkIgnore', { cardId, name }).then(() => {
    showToast(`"${name}" is no longer a link in this text.`, 'info', 8000, {
      label: 'Undo',
      run: () => void dispatch('cards', 'removeLinkIgnore', { cardId, name }).catch(() => {}),
    });
  }, () => {});
}

/** Click-to-open takes ⌘ on macOS and Ctrl elsewhere (Ctrl-click is the context menu on a Mac). */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const openModifier = (e: { ctrlKey: boolean; metaKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

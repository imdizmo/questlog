import { dispatch } from './api';
import { store } from './store';

export interface ContentState { content: string; contentVersion: number }

/** One save chain per card, so content writes never race each other. Entries go once a chain is idle. */
const chains = new Map<string, { tail: Promise<unknown>; pending: number }>();
/**
 * What our own last write left on the server. The store only learns it when the socket echoes the
 * card back, which can be after the next queued write starts; this bridges that gap.
 */
const written = new Map<string, ContentState>();
const WRITTEN_MAX = 50;

function current(cardId: string, fallback?: ContentState): ContentState | null {
  const card = store.get().cards.get(cardId) ?? fallback;
  const mine = written.get(cardId);
  if (mine && (!card || card.contentVersion < mine.contentVersion)) return mine;
  if (mine) written.delete(cardId); // the store has caught up
  return card ? { content: card.content, contentVersion: card.contentVersion } : null;
}

/**
 * Queues a content write for a card. `build` runs when the write's turn comes, against the newest
 * content we know of, and returns what to send (or null to skip). Resolves true when something was
 * saved; rejects with the dispatch error (already shown as a toast). `fallback` stands in for a card
 * the store doesn't hold (one opened by link before the socket pushed it).
 */
export function queueContentSave(
  cardId: string, build: (cur: ContentState) => ContentState | null, fallback?: ContentState,
): Promise<boolean> {
  const chain = chains.get(cardId) ?? { tail: Promise.resolve(), pending: 0 };
  chains.set(cardId, chain);
  chain.pending++;
  const run = chain.tail.then(async () => {
    const cur = current(cardId, fallback);
    const next = cur && build(cur);
    if (!next) return false;
    await dispatch('cards', 'update', { id: cardId, content: next.content, contentVersion: next.contentVersion });
    written.delete(cardId);
    written.set(cardId, { content: next.content, contentVersion: next.contentVersion + 1 });
    if (written.size > WRITTEN_MAX) written.delete(written.keys().next().value!);
    return true;
  });
  chain.tail = run.catch(() => undefined).finally(() => {
    if (--chain.pending === 0 && chains.get(cardId) === chain) chains.delete(cardId);
  });
  return run;
}

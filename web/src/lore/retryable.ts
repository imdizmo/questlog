/** A failed load of the lore editor's code (offline, or a chunk renamed by a deploy), as opposed to a bug in it. */
export class LoreLoadError extends Error {
  constructor(cause: unknown) {
    super(`The lore editor couldn't load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'LoreLoadError';
  }
}

/**
 * A loader that shares one pending or successful load, but forgets a failed one, so the next
 * call tries again (an offline moment or a chunk renamed by a deploy shouldn't stick). A failure
 * rejects with a LoreLoadError wrapping the original error.
 */
export function retryable<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e instanceof LoreLoadError ? e : new LoreLoadError(e);
    }));
}

import { describe, it, expect } from 'vitest';
import { LoreLoadError, retryable } from '../web/src/lore/retryable';

describe('retryable', () => {
  it('shares a pending and a successful load', async () => {
    let calls = 0;
    const load = retryable(async () => ++calls);
    const [a, b] = await Promise.all([load(), load()]);
    expect([a, b, await load(), calls]).toEqual([1, 1, 1, 1]);
  });
  it('forgets a failed load, so the next call tries again', async () => {
    let calls = 0;
    const load = retryable(async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return 'module';
    });
    await expect(load()).rejects.toThrow('offline');
    await expect(load()).resolves.toBe('module');
    await expect(load()).resolves.toBe('module');
    expect(calls).toBe(2);
  });
});

describe('LoreLoadError', () => {
  it('tags a failed load, keeping the original error as its cause', async () => {
    const offline = new TypeError('Failed to fetch dynamically imported module');
    const load = retryable(async () => { throw offline; });
    const e = await load().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LoreLoadError);
    expect((e as LoreLoadError).cause).toBe(offline);
    expect((e as Error).message).toContain('Failed to fetch');
  });
  it('a LoreLoadError is not wrapped twice', async () => {
    const tagged = new LoreLoadError('x');
    await expect(retryable(async () => { throw tagged; })()).rejects.toBe(tagged);
  });

});

describe('the fallback note', () => {
  it('says the editor could not load for a load failure, and hit a problem for anything else', async () => {
    const { fallbackNote } = await import('../web/src/lore/LazyLoreEditor');
    expect(fallbackNote(new LoreLoadError('offline'))).toBe("The lore editor couldn't load; you're using the plain editor.");
    expect(fallbackNote(new Error('a bug'))).toBe("The lore editor hit a problem; you're using the plain editor.");
    expect(fallbackNote(undefined)).toBe("The lore editor hit a problem; you're using the plain editor.");
  });
});

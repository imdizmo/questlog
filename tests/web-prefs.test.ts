import { describe, it, expect, vi } from 'vitest';
import { createPrefs, type LocalPref, type PrefsIO } from '../web/src/prefs';
import { ApiError } from '../web/src/api';

// The page's side of the per-person preferences (web/src/prefs.ts): the server is the home of the values; the browser's
// storage only stands in while the server cannot be reached.
const isNum = (v: unknown): v is number => typeof v === 'number';

function fakeIO(server: Record<string, unknown> | 'down' = {}, serverAt = 0) {
  const puts: [string, unknown][] = [];
  let local: Record<string, LocalPref> | null = null;
  let down = server === 'down';
  const data: Record<string, unknown> = server === 'down' ? {} : { ...server };
  const at: Record<string, number> = Object.fromEntries(Object.keys(data).map((k) => [k, serverAt]));
  const io: PrefsIO = {
    get: async () => { if (down) throw new ApiError(0, 'network'); return { prefs: { ...data }, updatedAt: { ...at } }; },
    put: async (k, v) => { if (down) throw new ApiError(0, 'network'); puts.push([k, v]); if (v === null) delete data[k]; else data[k] = v; },
    readLocal: () => local,
    writeLocal: (all) => { local = all; },
  };
  return { io, puts, data, local: () => local, setDown: (d: boolean) => { down = d; } };
}

describe('per-person preferences in the page', () => {
  it('reads what the server has', async () => {
    const f = fakeIO({ n: 3 });
    const p = createPrefs(f.io);
    expect(p.ready()).toBe(false);
    await p.load();
    expect(p.ready()).toBe(true);
    expect(p.get('n', isNum, 0)).toBe(3);
    expect(p.get('missing', isNum, 7)).toBe(7);
  });

  it('a value of the wrong shape reads as the fallback', async () => {
    const p = createPrefs(fakeIO({ n: 'three' }).io);
    await p.load();
    expect(p.get('n', isNum, 0)).toBe(0);
  });

  it('falls back to the browser when the server cannot be reached', async () => {
    const f = fakeIO('down');
    f.io.writeLocal({ n: { value: 5, at: 1 } });
    const p = createPrefs(f.io);
    await p.load();
    expect(p.ready()).toBe(true);
    expect(p.get('n', isNum, 0)).toBe(5);
  });

  it('sends two quick changes as one, with the last value', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeIO();
      const p = createPrefs(f.io, 800);
      await p.load();
      p.set('n', 1);
      p.set('n', 2);
      expect(p.get('n', isNum, 0)).toBe(2); // at once in the page
      expect(f.puts).toEqual([]);
      await vi.advanceTimersByTimeAsync(800);
      expect(f.puts).toEqual([['n', 2]]);
    } finally { vi.useRealTimers(); }
  });

  it('a deliberate choice is sent at once', async () => {
    const f = fakeIO();
    const p = createPrefs(f.io, 800);
    await p.load();
    p.set('n', 6, true);
    await Promise.resolve();
    expect(f.puts).toEqual([['n', 6]]);
  });

  it('flush sends what is waiting at once', async () => {
    const f = fakeIO();
    const p = createPrefs(f.io, 800);
    await p.load();
    p.set('n', 4);
    await p.flush();
    expect(f.puts).toEqual([['n', 4]]);
  });

  it('keeps a change in the browser when the server is down, and sends it on the next load', async () => {
    const f = fakeIO();
    const p = createPrefs(f.io, 0);
    await p.load();
    f.setDown(true);
    p.set('n', 9);
    await p.flush();
    expect(f.local()).toMatchObject({ n: { value: 9 } });
    f.setDown(false);
    const again = createPrefs(f.io, 0);
    await again.load();
    expect(again.get('n', isNum, 0)).toBe(9);
    expect(f.data.n).toBe(9);
    expect(f.local()).toBeNull();
  });

  it('a value kept offline does not overwrite a newer one on the server', async () => {
    const f = fakeIO({ n: 'server' }, 2000);
    f.io.writeLocal({ n: { value: 'old offline', at: 1000 }, m: { value: 'offline only', at: 1000 } });
    const p = createPrefs(f.io, 0);
    await p.load();
    await p.flush();
    expect(p.get('n', (v): v is string => typeof v === 'string', '')).toBe('server');
    expect(f.puts).toEqual([['m', 'offline only']]);
  });

  it('sends one request at a time, in order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const io: PrefsIO = {
      get: async () => ({ prefs: {}, updatedAt: {} }),
      put: async (k, v) => { order.push(`start ${k}=${v}`); if (v === 1) await slow; order.push(`end ${k}=${v}`); },
      readLocal: () => null, writeLocal: () => {},
    };
    const p = createPrefs(io, 0);
    await p.load();
    p.set('n', 1, true);
    p.set('n', 2, true);
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['start n=1']); // the second waits for the first
    release();
    await p.flush();
    expect(order).toEqual(['start n=1', 'end n=1', 'start n=2', 'end n=2']);
  });

  it('when the page goes away, what is waiting is sent at once, keepalive', async () => {
    const sent: [string, unknown, boolean | undefined][] = [];
    const io: PrefsIO = { get: async () => ({ prefs: {}, updatedAt: {} }), put: async (k, v, ka) => { sent.push([k, v, ka]); }, readLocal: () => null, writeLocal: () => {} };
    const p = createPrefs(io, 800);
    await p.load();
    p.set('tabs', 'x');
    p.flushNow();
    expect(sent).toEqual([['tabs', 'x', true]]);
  });

  it('reset forgets everything', async () => {
    const p = createPrefs(fakeIO({ n: 1 }).io);
    await p.load();
    p.reset();
    expect(p.ready()).toBe(false);
    expect(p.get('n', isNum, 0)).toBe(0);
  });
});

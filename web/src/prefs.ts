import { useSyncExternalStore } from 'react';
import { ApiError } from './api';

/**
 * Per-person preferences (server/prefs.ts): the sidebar, its folds, the open tabs. They live on the server so they
 * follow the person to every device; the page keeps a copy, changes it at once and sends each key at most once per
 * DELAY ms. Only when the server cannot be reached do values go to this browser's storage, and the next load that
 * reaches the server sends them on and clears them there.
 */
/** What the server holds: the values, and when each was last written (ms). */
export interface ServerPrefs { prefs: Record<string, unknown>; updatedAt: Record<string, number> }
/** A value kept in the browser while the server could not be reached, with when it was set. */
export interface LocalPref { value: unknown; at: number }
export interface PrefsIO {
  get(): Promise<ServerPrefs>;
  /** `keepalive`: the page is going away (sent without waiting for the answer). */
  put(key: string, value: unknown, keepalive?: boolean): Promise<void>;
  readLocal(): Record<string, LocalPref> | null;
  writeLocal(all: Record<string, LocalPref> | null): void;
}

const DELAY = 800;
const offline = (e: unknown) => e instanceof ApiError && e.status === 0;

const isLocal = (v: unknown): v is LocalPref => !!v && typeof v === 'object' && 'value' in v && typeof (v as LocalPref).at === 'number';

export function createPrefs(io: PrefsIO, delay = DELAY, now: () => number = Date.now) {
  let values = new Map<string, unknown>();
  let loaded = false;
  let version = 0;
  const waiting = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { version++; for (const fn of [...listeners]) fn(); };

  /** When each waiting value was set (so a value kept offline can be compared with the server's). */
  const setAt = new Map<string, number>();
  const keepLocal = (key: string, value: unknown, at: number) => {
    const all = { ...(io.readLocal() ?? {}) };
    all[key] = { value, at };
    io.writeLocal(all);
  };

  /** One request at a time, in the order the values were set, so an older value never lands after a newer one. */
  let chain: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = [...waiting].map(([key, value]) => ({ key, value, at: setAt.get(key) ?? now() }));
    waiting.clear();
    for (const { key, value, at } of batch) {
      chain = chain.then(() => io.put(key, value)).catch((e) => {
        if (offline(e)) keepLocal(key, value, at);
        else console.warn('[prefs] not saved', key, e); // too large or refused: the page keeps it until reload
      });
    }
    return chain;
  }

  /** The page is going away: everything waiting goes out at once, without waiting for answers. */
  function flushNow(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const [key, value] of waiting) void io.put(key, value, true).catch(() => keepLocal(key, value, setAt.get(key) ?? now()));
    waiting.clear();
  }

  return {
    async load(): Promise<void> {
      let server: ServerPrefs;
      const local = Object.entries(io.readLocal() ?? {}).filter(([, v]) => isLocal(v)) as [string, LocalPref][];
      try {
        server = await io.get();
      } catch {
        values = new Map(local.map(([k, v]) => [k, v.value]));
        loaded = true;
        emit();
        return;
      }
      values = new Map(Object.entries(server.prefs));
      // Changes made while the server could not be reached go to the server now, unless it has a newer value since.
      if (local.length) {
        for (const [k, v] of local) {
          if ((server.updatedAt[k] ?? 0) > v.at) continue;
          values.set(k, v.value);
          waiting.set(k, v.value);
          setAt.set(k, v.at);
        }
        io.writeLocal(null);
        void flush();
      }
      loaded = true;
      emit();
    },
    ready: () => loaded,
    get<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
      const v = values.get(key);
      return valid(v) ? v : fallback;
    },
    /** `immediate`: a deliberate choice (fold the sidebar), sent at once instead of after the pause. */
    set(key: string, value: unknown, immediate = false): void {
      values.set(key, value);
      waiting.set(key, value);
      setAt.set(key, now());
      emit();
      if (timer) clearTimeout(timer);
      if (immediate) void flush();
      else timer = setTimeout(() => void flush(), delay);
    },
    flush,
    flushNow,
    reset(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      waiting.clear();
      values = new Map();
      loaded = false;
      emit();
    },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    version: () => version,
  };
}

export type Prefs = ReturnType<typeof createPrefs>;

let userKey = 'ql.prefs';
const browserIO: PrefsIO = {
  get: async () => {
    let res: Response;
    try { res = await fetch('/api/prefs', { credentials: 'same-origin' }); } catch { throw new ApiError(0, 'network'); }
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
    const r = (await res.json()) as Partial<ServerPrefs>;
    return { prefs: r.prefs ?? {}, updatedAt: r.updatedAt ?? {} };
  },
  put: async (key, value, keepalive = false) => {
    let res: Response;
    try {
      res = await fetch(`/api/prefs/${encodeURIComponent(key)}`, {
        method: 'PUT', credentials: 'same-origin', keepalive,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
      });
    } catch { throw new ApiError(0, 'network'); }
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
  },
  readLocal: () => {
    try { const v = JSON.parse(localStorage.getItem(userKey) ?? 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
  },
  writeLocal: (all) => {
    try { if (all) localStorage.setItem(userKey, JSON.stringify(all)); else localStorage.removeItem(userKey); } catch { /* storage blocked */ }
  },
};

/** The page's one preferences store. */
export const prefs = createPrefs(browserIO);

let loadedFor: string | null = null;
/** Loads the signed-in person's preferences once (the browser fallback is kept per person); another person starts clean. */
export function loadPrefs(userId: string): Promise<void> {
  if (loadedFor === userId) return Promise.resolve();
  if (loadedFor !== null) prefs.reset();
  loadedFor = userId;
  userKey = `ql.prefs.${userId}`;
  return prefs.load();
}

/** Logout: sends what is waiting, then forgets this person's preferences. */
export async function resetPrefs(): Promise<void> {
  await prefs.flush();
  prefs.reset();
  loadedFor = null;
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => prefs.flushNow());

/** Re-renders when any preference changes; returns the value of `key` (or `fallback` when missing or malformed). */
export function usePref<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  useSyncExternalStore(prefs.subscribe, prefs.version);
  return prefs.get(key, valid, fallback);
}

/** Re-renders when preferences are loaded or reset. */
export const usePrefsReady = (): boolean => useSyncExternalStore(prefs.subscribe, prefs.ready);

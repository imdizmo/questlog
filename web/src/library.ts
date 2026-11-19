import { LIBRARY_PORT } from '../../shared/suggestions';
import { LIBRARY_MIN_VERSION, versionAtLeast } from '../../shared/assets';
import { libraryPath, type PackIndex } from '../../shared/library';

/**
 * The Assets page's reads of the team's library (shared/library.ts). Where it reads comes from /api/status
 * `suggestions`, as for the Suggestion button: on This computer through Questlog's own server (`/api/library/...`), on
 * a team server straight from the library service (its page may read cross-origin; CSP connect-src allows it).
 */
export interface LibraryTarget { base: string; credentials: RequestCredentials }
/** `none`: no team server. `old`: the library service is missing, too old (before 0.7.0) or says no. */
export type LibraryState = 'none' | 'old' | 'ok';

export function libraryTargetOf(s: unknown): LibraryTarget | null {
  const v = s as Partial<Record<string, unknown>> | null;
  if (v?.via === 'local') return { base: '/api/library', credentials: 'same-origin' };
  // Never with cookies: the library service knows the person by Tailscale, and it is another site.
  if (v?.via === 'direct' && typeof v.host === 'string' && v.host) return { base: `http://${v.host}:${LIBRARY_PORT}`, credentials: 'omit' };
  return null;
}

/** Whether the browsers can open: whoami answers with a role, at version 0.7.0 or later. */
export async function checkLibrary(status: unknown, f: typeof fetch = fetch): Promise<{ state: LibraryState; target: LibraryTarget | null }> {
  const target = libraryTargetOf(status);
  if (!target) return { state: 'none', target: null };
  try {
    const who = await libJson(target, 'team/whoami', f) as { role?: unknown; version?: unknown } | null;
    const ok = typeof who?.role === 'string' && !!who.role && versionAtLeast(who.version, LIBRARY_MIN_VERSION);
    return { state: ok ? 'ok' : 'old', target };
  } catch {
    return { state: 'old', target };
  }
}

const urlOf = (t: LibraryTarget, path: string): string => {
  const p = libraryPath(path);
  if (!p) throw new Error('not a library read');
  return t.base + p;
};

async function read(t: LibraryTarget, path: string, f: typeof fetch): Promise<Response> {
  const r = await f(urlOf(t, path), { credentials: t.credentials, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`library answered ${r.status}`);
  return r;
}

export async function libJson(t: LibraryTarget, path: string, f: typeof fetch = fetch): Promise<unknown> {
  const r = await read(t, path, f);
  return r.json();
}

/** A picture as a Blob (PNG, JPEG or WebP only). */
export async function libPicture(t: LibraryTarget, path: string, f: typeof fetch = fetch): Promise<Blob> {
  const r = await read(t, path, f);
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('not a picture');
  return r.blob();
}

// A pack's index.json can be a few MB: read only when the pack is opened, and kept for the last few packs, keyed by
// the size and mtime that /library lists (the library sends no ETag yet).
const INDEX_KEEP = 4;
const indexCache = new Map<string, PackIndex>();
export const _clearIndexCache = () => indexCache.clear();

export async function packIndex(t: LibraryTarget, pack: string, stamp: { size: number; mtime: number | string }, f: typeof fetch = fetch): Promise<PackIndex> {
  const key = `${t.base}|${pack}|${stamp.size}|${stamp.mtime}`;
  const hit = indexCache.get(key);
  if (hit) {
    indexCache.delete(key); // most recent last
    indexCache.set(key, hit);
    return hit;
  }
  const raw = await libJson(t, `library/${pack}/index/index.json`, f) as Partial<PackIndex> | null;
  const idx: PackIndex = { engine: raw?.engine, assets: Array.isArray(raw?.assets) ? raw.assets.filter((a) => a && typeof a.path === 'string') : [] };
  for (const k of [...indexCache.keys()]) if (k.startsWith(`${t.base}|${pack}|`)) indexCache.delete(k);
  indexCache.set(key, idx);
  while (indexCache.size > INDEX_KEEP) indexCache.delete(indexCache.keys().next().value!);
  return idx;
}

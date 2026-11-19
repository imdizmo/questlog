/**
 * Reading the team's library for the Assets page (the library service's contract: ShelfServer 0.7.0, "Reading the
 * library from Questlog's page"). Only pictures and lists come in: the read routes below, nothing else (pack files,
 * map and prop zips, suggestions and the rest stay closed). This file holds what the page and the desktop server's
 * forward share: which paths may be read, and how big an answer may be.
 */
import type { AssetKind } from './assets';

/** At most this many bytes per answer: a big pack's index.json is a few MB; pictures are small (at most 4096 px). */
export const LIBRARY_CAPS = { index: 32 * 1024 * 1024, picture: 16 * 1024 * 1024, json: 4 * 1024 * 1024 } as const;

/** One path segment as the library names packs, folders and files; never `.` or `..`, no `%`, no slashes. */
const SEG = /^[A-Za-z0-9 _.,()+&'@-]{1,200}$/;
const okSeg = (s: string) => SEG.test(s) && s !== '.' && s !== '..';
const enc = (s: string) => encodeURIComponent(s);

/**
 * The library service's path for a page path like `library/<pack>/index/thumbs/a.png` or
 * `maps/<id>/picture?version=2` (segments not yet %-encoded), %-encoded per segment; null for anything outside the
 * read routes.
 */
export function libraryPath(p: string): string | null {
  const [path, query, ...more] = p.split('?');
  if (more.length) return null;
  const parts = path.split('/');
  if (!parts.every(okSeg)) return null;
  const [a, b, c, ...rest] = parts;
  if (query !== undefined) {
    // Only a map's or prop's picture takes a query: version=<n>.
    if (!((a === 'maps' || a === 'props') && c === 'picture' && parts.length === 3 && /^version=\d{1,9}$/.test(query))) return null;
    return `/${a}/${enc(b)}/picture?${query}`;
  }
  if (parts.length === 2 && a === 'team' && b === 'whoami') return '/team/whoami';
  if (parts.length === 1 && (a === 'library' || a === 'maps' || a === 'props')) return `/${a}`;
  if (parts.length === 3 && (a === 'maps' || a === 'props') && c === 'picture') return `/${a}/${enc(b)}/picture`;
  if (a === 'library' && c === 'index' && rest.length >= 1) return `/library/${enc(b)}/index/${rest.map(enc).join('/')}`;
  return null;
}

/** The kind an Asset Shelf asset comes in as: meshes are 3D models (their picture only), the rest pictures. */
export const shelfKind = (cls: unknown): AssetKind => (typeof cls === 'string' && /Mesh/i.test(cls) ? 'model' : 'picture');

/** How big an answer to a path may be. */
export const capFor = (path: string): number => (/\.json$/i.test(path.split('?')[0]) && path.startsWith('library/') ? LIBRARY_CAPS.index
  : /\/picture$|\.(png|jpe?g|webp)$/i.test(path.split('?')[0]) || path.includes('/index/') ? LIBRARY_CAPS.picture : LIBRARY_CAPS.json);

/** The library's rows, as the contract describes them (only the fields the page reads). */
export interface LibraryPack { id: string; files: { name: string; size: number; mtime: number | string }[] }
export interface PackInfo { title?: string; seller?: string; category?: string; cover?: string }
export interface PackIndex { engine?: string; assets: { path: string; package?: string; name?: string; class?: string; thumb?: string }[] }
export interface PublishedItem { id: string; name: string; version: number; publishedBy?: { name?: string } }

/**
 * The Assets library (a page beside the Wiki): pictures, 3D models, maps and concepts of one project, each a copy that
 * Questlog keeps, with a link back to where it came from. This file holds what the page and the server share: the
 * words, the bytes that are accepted, the library service's version gate, and how the page filters and groups.
 */

export const ASSET_KINDS = ['picture', 'model', 'map', 'concept'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** What an asset is for (the toggles on the page); none is null. */
export const ASSET_FORS = ['Characters', 'Creatures', 'Items', 'Places', 'Interface', 'Key art'] as const;
export type AssetFor = (typeof ASSET_FORS)[number];

/** Where the copy came from. `url`: downloaded by the server; the two library ones: picked in their browser. */
export const ASSET_SOURCES = ['uploaded', 'url', 'asset-shelf', 'groundwork'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/**
 * The link back, as the library contract stores it (`server` is the team's address, set by Questlog's own server),
 * or the address a picture was downloaded from.
 */
export type LibraryLinkInput = { kind: 'asset'; pack: string; path: string; packTitle?: string } | { kind: 'map' | 'prop'; id: string; version: number };
export type AssetLink = (LibraryLinkInput & { server: string }) | { url: string };

export interface Asset {
  id: string;
  projectId: string;
  title: string;
  kind: AssetKind;
  for: AssetFor | null;
  source: AssetSource;
  link: AssetLink | null;
  hasPicture: boolean;
  pictureMime: string | null;
  /** A `.glb` the person added (shown in the 3D viewer). */
  hasModel: boolean;
  /** Bytes Questlog keeps for it (picture and model). */
  size: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Wiki entries that got its picture ("Use as a picture of…"), while that copy is still attached. */
  usedIn: { cardId: string; title: string }[];
}

export const PICTURE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const GLB_MIME = 'model/gltf-binary';
export type AcceptedMime = (typeof PICTURE_MIMES)[number] | typeof GLB_MIME;

/** The type from the first bytes (PNG, JPEG, WebP, binary glTF 2); null for anything else. Needs 12 bytes. */
export function sniff(b: Uint8Array): AcceptedMime | null {
  const ascii = (off: number, s: string) => b.length >= off + s.length && [...s].every((c, i) => b[off + i] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'glTF') && b.length >= 8 && b[4] === 2 && b[5] === 0 && b[6] === 0 && b[7] === 0) return GLB_MIME;
  return null;
}
export const SNIFF_BYTES = 12;

/** Whether a version string like `0.7.0` (a suffix such as `-beta` is ignored) is at least `min`. */
export function versionAtLeast(v: unknown, min: string): boolean {
  if (typeof v !== 'string' || !/^\d+(\.\d+)*/.test(v)) return false;
  const a = v.match(/^\d+(\.\d+)*/)![0].split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The library service that answers the Assets browsers (contract: ShelfServer 0.7.0). */
export const LIBRARY_MIN_VERSION = '0.7.0';

export const kindLabel = (k: AssetKind): string => ({ picture: 'Picture', model: '3D model', map: 'Map', concept: 'Concept' })[k];

export interface AssetFilter { q: string; kind: AssetKind | 'all'; fors: ReadonlySet<string> }

export function filterAssets(list: readonly Asset[], f: AssetFilter): Asset[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((a) => (f.kind === 'all' || a.kind === f.kind) && (!f.fors.size || (!!a.for && f.fors.has(a.for)))
    && (!q || a.title.toLowerCase().includes(q)));
}

const GROUPS: { title: string; sources: AssetSource[] }[] = [
  { title: 'From Asset Shelf', sources: ['asset-shelf'] },
  { title: 'Maps from Groundwork', sources: ['groundwork'] },
  { title: 'Uploaded', sources: ['uploaded', 'url'] },
];

/** The gallery's sections by source, in the page's order; empty ones are left out. */
export function groupAssets(list: readonly Asset[]): { title: string; items: Asset[] }[] {
  return GROUPS.map((g) => ({ title: g.title, items: list.filter((a) => g.sources.includes(a.source)) })).filter((g) => g.items.length);
}

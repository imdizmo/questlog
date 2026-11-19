import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, dispatch, messageFor } from './api';
import { addLiveTap, store } from './store';
import { showToast } from './toast';
import type { Asset, AssetFor, AssetKind, LibraryLinkInput } from '../../shared/assets';

/**
 * The Assets page's reads and writes (server/assets.ts). The list is read per project and read again after the
 * person's own writes and whenever an `asset` event for that project arrives on the live socket.
 */

const SAY: Record<string, string> = {
  bad_type: 'Assets take PNG, JPEG or WebP pictures and single-file .glb models.',
  bad_asset_url: "Couldn't download a picture or .glb from that address. Check it is public and points straight at the file. Addresses on your own network (the team server included) are not fetched: for Asset Shelf or Groundwork pictures, use Add › From Asset Shelf or From Groundwork.",
  no_team: 'That needs a team server.',
  no_picture: 'This asset has no picture to use.',
  not_found: 'That is gone, or you may not change it.',
};
export const assetMessage = (code: string): string => SAY[code] ?? messageFor(code);

async function call<T>(method: string, url: string, body?: BodyInit | object, type?: string): Promise<T> {
  let res: Response;
  const raw = body instanceof Blob || body instanceof ArrayBuffer;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': raw ? (type || 'application/octet-stream') : 'application/json' },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) store.reset('unauthenticated');
    throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json?.data);
  }
  return json as T;
}

export const fetchAssets = (projectId: string) => call<{ items: Asset[] }>('GET', `/api/assets?projectId=${encodeURIComponent(projectId)}`).then((r) => r.items);

export interface NewAsset {
  projectId: string;
  title: string;
  kind?: AssetKind;
  for?: AssetFor | null;
  source?: 'uploaded' | 'asset-shelf' | 'groundwork';
  /** For the library sources; the server fills in the team's address. */
  link?: LibraryLinkInput;
}

/** Adds a picture or a .glb as the raw body (the browser streams a File; nothing is read into memory here). */
export function uploadAsset(a: NewAsset, body: Blob): Promise<Asset> {
  const q = new URLSearchParams({ projectId: a.projectId, title: a.title });
  if (a.kind) q.set('kind', a.kind);
  if (a.for) q.set('for', a.for);
  if (a.source) q.set('source', a.source);
  if (a.link) q.set('link', JSON.stringify(a.link));
  return call<Asset>('POST', `/api/assets?${q}`, body, body.type);
}

export const addFromUrl = (projectId: string, url: string, title: string, f: AssetFor | null) =>
  call<Asset>('POST', '/api/assets/from-url', { projectId, url, title: title || undefined, for: f });

export const setAssetPicture = (id: string, png: Blob) => call<Asset>('PUT', `/api/assets/${encodeURIComponent(id)}/picture`, png, png.type);

export const useAssetOn = (id: string, cardId: string) => call<{ fileId: string }>('POST', `/api/assets/${encodeURIComponent(id)}/use`, { cardId });

export const updateAsset = (id: string, patch: { title?: string; kind?: AssetKind; for?: AssetFor | null }) => dispatch<Asset>('assets', 'update', { id, ...patch });
export const deleteAsset = (id: string) => dispatch('assets', 'delete', { id });

export const pictureUrl = (a: Pick<Asset, 'id' | 'updatedAt'>) => `/api/assets/${encodeURIComponent(a.id)}/picture?v=${a.updatedAt}`;
export const modelUrl = (a: Pick<Asset, 'id'>) => `/api/assets/${encodeURIComponent(a.id)}/model`;

/**
 * "Use as a picture of…" for wiki types: the server copies the asset's picture into the project's covers (the store a
 * type's uploaded picture uses) and sets it on the type (POST /api/assets/:id/use-for-type). The copy is the type's
 * own; deleting the asset leaves it. Kept as a hook so a page can swap it (tests, a later picker).
 */
export type TypePictureHook = (asset: Asset, typeId: string) => Promise<void>;
export const assetAsTypePicture: TypePictureHook = async (asset, typeId) => {
  await call<{ fileId: string }>('POST', `/api/assets/${encodeURIComponent(asset.id)}/use-for-type`, { typeId });
};
let typePictureHook: TypePictureHook | null = assetAsTypePicture;
export function setTypePictureHook(fn: TypePictureHook | null): void { typePictureHook = fn; }
export const typePicture = () => typePictureHook;

/** A project's assets, kept fresh: `reload` after a write; teammates' changes arrive through the live socket. */
export function useAssets(projectId: string | null): { items: Asset[] | null; error: string | null; reload: () => void } {
  const [items, setItems] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const reload = useCallback(() => {
    if (!projectId) return;
    const mine = ++gen.current;
    fetchAssets(projectId).then(
      (l) => { if (mine === gen.current) { setItems(l); setError(null); } },
      (e) => { if (mine === gen.current) setError(assetMessage(e instanceof ApiError ? e.code : 'network')); },
    );
  }, [projectId]);
  useEffect(() => {
    setItems(null);
    reload();
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Several events in a row (an upload, then its picture) read the list once.
    const off = addLiveTap((events) => {
      if (!events.some((e) => (e.model === 'asset' && (e.row as { projectId?: string }).projectId === projectId) || (e.model === 'project' && e.op !== 'upsert'))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 150);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [projectId, reload]);
  return { items, error, reload };
}

export function toastError(e: unknown, what: string): void {
  const code = e instanceof ApiError ? e.code : 'network';
  showToast(`${what}: ${assetMessage(code)}`);
}

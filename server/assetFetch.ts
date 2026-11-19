/**
 * "From a URL" on the Assets page: the server downloads a picture or a `.glb` and keeps its own copy. The address
 * comes from the person, so this is a trust boundary, guarded like the cover download (server/covers.ts):
 *
 * - http(s) only, no user info. Every hop's host is looked up once, every address it has must be public
 *   (isBlockedAddress: no loopback, private, link-local, Tailscale or reserved ranges), and the connection goes to the
 *   first of those same addresses, so a second lookup can never send it elsewhere.
 * - At most MAX_REDIRECTS redirects, each checked the same way; 10 s for the whole download.
 * - A declared length over the cap is refused unread; otherwise the bytes are counted as they stream to disk.
 * - The answer must say image/png, image/jpeg, image/webp, model/gltf-binary or application/octet-stream, and the
 *   first bytes decide: a picture type must hold a picture, the other two a binary glTF 2. Anything else is 415.
 *
 * Errors: 400 bad_asset_url (refused or failed), 413 (the cap's own error), 415 bad_type.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Db } from './db';
import { AppError } from './errors';
import { isBlockedAddress } from './covers';
import { dropAssetBlob, storeAssetBlob, type StoredBlob } from './assets';
import { GLB_MIME, PICTURE_MIMES } from '../shared/assets';

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const PICTURES = new Set<string>(PICTURE_MIMES);
const MODEL_TYPES = new Set([GLB_MIME, 'application/octet-stream']);

const fail = () => new AppError(400, 'bad_asset_url');

/**
 * Downloads `url` into the assets folder (see the file comment). `opts.allowAddress` replaces the address guard and
 * exists for tests only; it is a function argument, never request data.
 */
export async function downloadAsset(db: Db, url: string, max: number, tooLarge: () => AppError, opts?: { allowAddress?: (ip: string) => boolean }): Promise<StoredBlob & { finalUrl: string }> {
  const allowed = opts?.allowAddress ?? ((ip: string) => !isBlockedAddress(ip));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    let cur = url;
    for (let hop = 0; ; hop++) {
      let u: URL;
      try { u = new URL(cur); } catch { throw fail(); }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw fail();
      const host = u.hostname.replace(/^\[|\]$/g, '');
      let addrs: { address: string; family: number }[];
      if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
      else {
        const aborted = new Promise<never>((_r, rej) => {
          if (ac.signal.aborted) rej(fail());
          ac.signal.addEventListener('abort', () => rej(fail()), { once: true });
        });
        addrs = await Promise.race([lookup(host, { all: true }), aborted]).catch(() => { throw fail(); });
      }
      if (!addrs.length || !addrs.every((a) => allowed(a.address))) throw fail();
      const pin = addrs[0];
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const rq = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
          method: 'GET', agent: false, signal: ac.signal, headers: { accept: 'image/png, image/jpeg, image/webp, model/gltf-binary;q=0.9, */*;q=0.1', 'user-agent': 'questlog-asset-fetch' },
          lookup: ((_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family))) as any,
        }, resolve);
        rq.on('error', reject);
        rq.end();
      }).catch(() => { throw fail(); });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy(); // never read a redirect body
        if (hop >= MAX_REDIRECTS) throw fail();
        try { cur = new URL(res.headers.location, u).href; } catch { throw fail(); }
        continue;
      }
      if (status !== 200) { res.destroy(); throw fail(); }
      const said = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!PICTURES.has(said) && !MODEL_TYPES.has(said)) { res.destroy(); throw new AppError(415, 'bad_type'); }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > max) { res.destroy(); throw tooLarge(); }
      ac.signal.addEventListener('abort', () => res.destroy(new Error('timeout')), { once: true });
      let blob: StoredBlob;
      try {
        blob = await storeAssetBlob(db, res, max, tooLarge);
      } catch (e) {
        res.destroy();
        if (e instanceof AppError) throw e;
        throw fail();
      }
      // The type it said and the bytes must agree: a picture is a picture, anything else must be a .glb.
      if (PICTURES.has(said) !== PICTURES.has(blob.mime)) {
        await dropAssetBlob(db, blob.id);
        throw new AppError(415, 'bad_type');
      }
      return { ...blob, finalUrl: u.href };
    }
  } finally {
    ac.abort(); // closes any request or response still open
    clearTimeout(timer);
  }
}

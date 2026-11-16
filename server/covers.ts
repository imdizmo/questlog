import { createWriteStream, renameSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { newId, toCamel, type Db } from './db';
import { AppError } from './errors';
import type { Ctx } from './dispatch';
import { filesDirOf } from './files';
import { uploadRoom } from './billing';
import { COVER_MAX_BYTES, COVER_MIMES, type Cover } from '../shared/covers';

const MIMES = new Set<string>(COVER_MIMES);
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

export const coversDirOf = (db: Db): string | undefined => {
  const d = filesDirOf(db);
  return d && join(d, 'covers');
};
/** Disk path of a cover id (ids are server-made uuids). */
export const coverPath = (dir: string, id: string): string => join(dir, id);

export const coverRow = (db: Db, id: string) => {
  const r = db.prepare('SELECT * FROM covers WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

/** What the commands accept for `cover`. */
export const coverSchema = z.union([
  z.strictObject({ kind: z.literal('art'), id: z.number().int().min(1).max(13) }),
  z.strictObject({ kind: z.literal('file'), fileId: z.string().min(1).max(100) }),
]).nullable();

/** Throws 400 bad_cover unless the cover is art or a file of the same project. */
export function assertCoverUsable(db: Db, projectId: string, cover: Cover): void {
  if (cover?.kind !== 'file') return;
  const r = coverRow(db, cover.fileId);
  if (!r || r.projectId !== projectId) throw new AppError(400, 'bad_cover');
}

/** Disk cleanup after commit; ids only in logs. */
export function unlinkCovers(db: Db, ids: string[]): void {
  const dir = coversDirOf(db);
  if (!dir) return;
  for (const id of ids) {
    unlink(coverPath(dir, id)).catch((e) => {
      if (e?.code !== 'ENOENT') console.error('[jt] could not delete cover', id, String(e?.code ?? e?.message ?? e));
    });
  }
}

/** Ids of every cover file of this project (collect before a hard delete). */
export const projectCoverIds = (db: Db, projectId: string): string[] =>
  (db.prepare('SELECT id FROM covers WHERE project_id=?').all(projectId) as { id: string }[]).map((r) => r.id);

/** Removes a cover file row and its bytes once no deck, project or Open Deck (banner, promo image) points at it any more. */
export function releaseCover(ctx: Ctx, old: Cover): void {
  if (old?.kind !== 'file') return;
  const { db } = ctx;
  const id = old.fileId;
  const used = db.prepare(
    "SELECT 1 FROM decks WHERE json_extract(cover_json,'$.fileId')=? UNION ALL SELECT 1 FROM projects WHERE json_extract(cover_json,'$.fileId')=?"
    + ' UNION ALL SELECT 1 FROM open_decks WHERE banner_file_id=? OR promo_file_id=?',
  ).get(id, id, id, id);
  if (used) return;
  db.prepare('DELETE FROM covers WHERE id=?').run(id);
  ctx.afterCommit(() => unlinkCovers(db, [id]));
}

class Counter extends Transform {
  size = 0;
  constructor(private max: number, private mkErr: () => Error) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.size += chunk.length;
    if (this.size > this.max) return cb(this.mkErr());
    cb(null, chunk);
  }
}

/** Streams `source` to a temp file (cap counted while streaming), then renames and records it. Removes partial files on any failure. */
async function storeStream(ctx: Ctx, projectId: string, source: NodeJS.ReadableStream, mime: string, mkErr: () => AppError, wrap: (e: unknown) => AppError, destroySource = false, max = COVER_MAX_BYTES, planCheck = false): Promise<string> {
  const dir = coversDirOf(ctx.db);
  if (!dir) throw new AppError(500, 'no_files_dir');
  await mkdir(dir, { recursive: true });
  const id = newId();
  const tmp = coverPath(dir, `.tmp-${id}`);
  const final = coverPath(dir, id);
  const counter = new Counter(max, mkErr);
  let renamed = false;
  try {
    // Piped by hand so a refused upload fails our streams without destroying the request itself.
    source.on('error', (e) => counter.destroy(e));
    source.on('close', () => { if (!(source as any).readableEnded) counter.destroy(new Error('aborted')); });
    source.pipe(counter);
    await pipeline(counter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (counter.size === 0) throw new AppError(400, 'invalid_input');
    // Other uploads may have used the storage while this one streamed in.
    if (planCheck) {
      const { storageLeft } = uploadRoom(ctx.db);
      if (storageLeft !== null && counter.size > storageLeft) throw new AppError(413, 'plan_limit', { limit: 'storage' });
    }
    renameSync(tmp, final);
    renamed = true;
    ctx.db.prepare('INSERT INTO covers (id,project_id,uploader_id,mime,size,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, projectId, ctx.actor.id, mime, counter.size, Date.now());
    return id;
  } catch (e) {
    // Any failure tears the source down (an upload request is closed by its route instead).
    if (destroySource) (source as any).destroy?.();
    await unlink(tmp).catch(() => {});
    if (renamed) await unlink(final).catch(() => {});
    throw wrap(e);
  }
}

/** The plan's storage left caps a cover (413 plan_limit {limit:'storage'}, like a card file); `plan` is that cap when it is the lower one. */
function coverCap(db: Db, tooLarge: () => AppError = () => new AppError(413, 'too_large')) {
  const { storageLeft } = uploadRoom(db);
  const plan = storageLeft !== null && storageLeft < COVER_MAX_BYTES ? storageLeft : null;
  return { plan, mkErr: () => (plan === null ? tooLarge() : new AppError(413, 'plan_limit', { limit: 'storage' })) };
}

/** Raw-body upload. Mime must be one of the four image types (415 bad_type); more than 10 MB is 413 too_large. */
export async function storeCoverUpload(ctx: Ctx, projectId: string, stream: NodeJS.ReadableStream, mime: string): Promise<string> {
  if (!MIMES.has(mime)) throw new AppError(415, 'bad_type');
  const { plan, mkErr } = coverCap(ctx.db);
  return storeStream(ctx, projectId, stream, mime, mkErr, (e) => {
    if (e instanceof AppError) return e;
    if ((e as any)?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/.test(String((e as any)?.message))) return new AppError(404, 'not_found');
    return e instanceof Error ? (e as any) : new AppError(400, 'invalid_input');
  }, false, plan ?? COVER_MAX_BYTES, true);
}

// ---- URL fetch (SSRF boundary) ----

const v4 = (a: number[]): boolean => {
  const [a0, a1] = a;
  return a0 === 0 || a0 === 10 || a0 === 127 || (a0 === 100 && a1 >= 64 && a1 <= 127) || (a0 === 169 && a1 === 254)
    || (a0 === 172 && a1 >= 16 && a1 <= 31) || (a0 === 192 && a1 === 168) || (a0 === 192 && a1 === 0 && (a[2] === 0 || a[2] === 2))
    || (a0 === 198 && (a1 === 18 || a1 === 19 || (a1 === 51 && a[2] === 100))) || (a0 === 203 && a1 === 0 && a[2] === 113) || a0 >= 224;
};

/** Eight 16-bit groups of an IPv6 literal, or null when malformed. */
function v6groups(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  const dotted = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = dotted[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

/** True unless the address is a public one. IPv6 is allow-only (global unicast 2000::/3); embedded IPv4 (mapped, SIIT, NAT64, 6to4) is unwrapped and checked. Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4(ip.split('.').map(Number));
  if (kind !== 6) return true;
  const g = v6groups(ip);
  if (!g) return true;
  const hi = (x: number) => x >> 8;
  const lo = (x: number) => x & 255;
  const tail = [hi(g[6]), lo(g[6]), hi(g[7]), lo(g[7])];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(tail); // ::ffff:0:0/96 mapped
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4(tail); // ::ffff:0:0:0/96 SIIT
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(tail); // 64:ff9b::/96
    if (g[2] === 1) return v4([hi(g[3]), lo(g[3]), lo(g[4]), hi(g[5])]); // 64:ff9b:1::/48 (RFC 6052 layout)
    return true;
  }
  if ((g[0] & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true; // Teredo, documentation
  if (g[0] === 0x2002) return v4([hi(g[1]), lo(g[1]), hi(g[2]), lo(g[2])]); // 6to4
  return false;
}

const fail = () => new AppError(400, 'bad_cover_url');

/**
 * Server-side fetch of an image URL into a project cover. http(s) only; every resolved address must pass the
 * guard, and the connection is pinned to the vetted address so DNS cannot change between check and connect.
 * `opts.allowAddress` replaces the guard and exists for tests only; it is a function argument, never request data.
 */
export async function fetchCoverUrl(ctx: Ctx, projectId: string, url: string, opts?: { allowAddress?: (ip: string) => boolean }): Promise<string> {
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
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const rq = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
          method: 'GET', agent: false, signal: ac.signal, headers: { accept: 'image/*', 'user-agent': 'jt-cover-fetch' },
          lookup: ((_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family))) as any,
        }, resolve);
        rq.on('error', reject);
        rq.end();
      }).catch(() => { throw fail(); });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy(); // never read a redirect body: the timer stops when we return
        if (hop >= MAX_REDIRECTS) throw fail();
        try { cur = new URL(res.headers.location, u).href; } catch { throw fail(); }
        continue;
      }
      const mime = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const declared = Number(res.headers['content-length']);
      if (status !== 200 || !MIMES.has(mime) || (Number.isFinite(declared) && declared > COVER_MAX_BYTES)) { res.destroy(); throw fail(); }
      const { plan, mkErr } = coverCap(ctx.db, fail);
      if (plan !== null && Number.isFinite(declared) && declared > plan) { res.destroy(); throw mkErr(); }
      ac.signal.addEventListener('abort', () => res.destroy(new Error('timeout')), { once: true });
      // Any failure is one bad_cover_url, except the plan's storage limit.
      return await storeStream(ctx, projectId, res, mime, mkErr, (e) => (e instanceof AppError && e.code === 'plan_limit' ? e : fail()), true, plan ?? COVER_MAX_BYTES, true);
    }
  } finally {
    ac.abort(); // closes any request or response still open
    clearTimeout(timer);
  }
}

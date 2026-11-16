import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { newId, tx, type Db } from './db';
import { AppError } from './errors';
import { nextActionId, type ChangeEvent, type Ctx } from './dispatch';
import { assertCardAccess, assertNotDeleted, emitCard } from './commands/cards';
import { recordHistory } from './history';
import { cardRow } from './commands/rows';
import { fileRow, filePath, INLINE_MIMES, refreshCover } from './files';
import { storeCoverUpload, coverRow, coversDirOf, coverPath } from './covers';
import { can, sessionActor } from './permissions';
import { uploadRoom } from './billing';
import { COVER_MAX_BYTES, COVER_MIMES } from '../shared/covers';
import type { LiveHub } from './live';
import type { User } from '../shared/types';

export interface FileRouteDeps {
  db: Db;
  hub: LiveHub;
  dir: string;
  maxBytes: number;
  needUser(req: FastifyRequest): User;
  visibleCard(user: User, where: string, arg: string | number): { card: any; deck: any };
}

/** Lone UTF-16 surrogates (they make encodeURIComponent throw) become U+FFFD. */
const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

/** Display name only (never a disk path): no separators or control characters, at most 200 characters (code points). */
export function cleanName(raw: unknown): string {
  const t = wellFormed(typeof raw === 'string' ? raw : '').replace(/[\\/\u0000-\u001f\u007f]/g, '').trim();
  const s = Array.from(t).slice(0, 200).join('').trim();
  return s || 'file';
}

export function cleanMime(h: unknown): string {
  const m = (typeof h === 'string' ? h : '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m) && m.length <= 100 ? m : 'application/octet-stream';
}

/** RFC 5987/6266 header: quoted ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', raw: string): string {
  const name = wellFormed(raw);
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${star}`;
}

/** Counts the bytes (413 past `max`: `tooLarge`, by default file_too_large) and keeps the first HEAD_BYTES for the image check. */
class Counter extends Transform {
  size = 0;
  head = Buffer.alloc(0);
  constructor(private max: number, private tooLarge: () => AppError = () => new AppError(413, 'file_too_large')) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.size += chunk.length;
    if (this.size > this.max) return cb(this.tooLarge());
    if (this.head.length < HEAD_BYTES) this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES - this.head.length)]);
    cb(null, chunk);
  }
}

const HEAD_BYTES = 12;
/** Whether the first bytes match the image type (the inline types only). */
function looksLike(mime: string, b: Buffer): boolean {
  const at = (off: number, ascii: string) => b.subarray(off, off + ascii.length).toString('latin1') === ascii;
  switch (mime) {
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
  }
  return false;
}

export interface StoreFileInput {
  db: Db;
  dir: string;
  maxBytes: number;
  /** Actor (must be able to edit the card) and the events of the write. */
  ctx: Ctx;
  cardId: string;
  stream: NodeJS.ReadableStream;
  name: string;
  mime: string;
  /** An inline image type whose bytes don't match it is stored as application/octet-stream (served as a download). */
  checkImage?: boolean;
}

/**
 * The cap for one upload: the server's `maxBytes`, or lower under the plan (413 plan_limit {limit: 'fileSize' or
 * 'storage'} when the plan's cap is the one hit).
 */
export function uploadCap(db: Db, maxBytes: number): { max: number; tooLarge: () => AppError } {
  const { fileBytes, storageLeft } = uploadRoom(db);
  const plan = [fileBytes === null ? null : { max: fileBytes, limit: 'fileSize' }, storageLeft === null ? null : { max: storageLeft, limit: 'storage' }]
    .filter((x): x is { max: number; limit: string } => !!x && x.max < maxBytes)
    .sort((a, b) => a.max - b.max)[0];
  return plan
    ? { max: plan.max, tooLarge: () => new AppError(413, 'plan_limit', { limit: plan.limit }) }
    : { max: maxBytes, tooLarge: () => new AppError(413, 'file_too_large') };
}

/**
 * Streams one upload to a temp file (413 file_too_large past `maxBytes`, 413 plan_limit past the plan's file size or
 * storage left, 400 when empty), then in one transaction
 * re-checks the card (still there, not deleted, still editable), adds the file row, history and cover, and moves the
 * file into place. The temp file is removed on any failure. Returns the file id; the caller publishes ctx.events.
 */
export async function storeCardFile(o: StoreFileInput): Promise<string> {
  const { db, dir, ctx, cardId, stream } = o;
  await mkdir(dir, { recursive: true });
  const id = newId();
  const tmp = filePath(dir, `.tmp-${id}`);
  const final = filePath(dir, id);
  const cap = uploadCap(db, o.maxBytes);
  const counter = new Counter(cap.max, cap.tooLarge);
  try {
    // The source is piped by hand so a refused upload fails our streams without destroying the request itself.
    stream.on('error', (e) => counter.destroy(e));
    stream.on('close', () => { if (!(stream as any).readableEnded) counter.destroy(new Error('aborted')); });
    stream.pipe(counter);
    await pipeline(counter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (counter.size === 0) throw new AppError(400, 'invalid_input');
    const mime = o.checkImage && INLINE_MIMES.has(o.mime) && !looksLike(o.mime, counter.head) ? 'application/octet-stream' : o.mime;
    try {
      tx(db, () => {
        // The card may have been deleted (or removed with its project) while the bytes streamed in.
        const now = cardRow(db, cardId);
        if (!now || now.visibility === 'deleted') throw new AppError(404, 'not_found');
        assertCardAccess(ctx, now);
        // Other uploads may have used the storage while this one streamed in.
        const { storageLeft } = uploadRoom(db);
        if (storageLeft !== null && counter.size > storageLeft) throw new AppError(413, 'plan_limit', { limit: 'storage' });
        db.prepare('INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, cardId, ctx.actor.id, o.name, mime, counter.size, Date.now());
        renameSync(tmp, final);
        ctx.emit('file', 'upsert', fileRow(db, id));
        recordHistory(db, cardId, ctx.actor.id, [{ kind: 'file', from: null, to: o.name }]);
        if (!refreshCover(ctx, cardId)) emitCard(ctx, cardId);
      });
    } catch (e) {
      await unlink(final).catch(() => {});
      throw e;
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return id;
}

export function registerFileRoutes(app: FastifyInstance, d: FileRouteDeps): void {
  const { db, dir, maxBytes } = d;

  // Encapsulated: the raw-stream parser must not leak to the JSON routes.
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    inst.post('/api/cards/:id/files', { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const user = d.needUser(req);
      const { card } = d.visibleCard(user, 'id=?', (req.params as { id: string }).id);
      const events: ChangeEvent[] = [];
      const ctx: Ctx = { db, actor: sessionActor(user), events, emit: (model, op, row) => { events.push({ model, op, row }); }, afterCommit: () => {} };
      assertCardAccess(ctx, card);
      assertNotDeleted(card);
      const declared = Number(req.headers['content-length']);
      const cap = uploadCap(db, maxBytes);
      if (Number.isFinite(declared) && declared > cap.max) throw cap.tooLarge();
      const stream = req.body as NodeJS.ReadableStream | undefined;
      if (!stream || typeof (stream as any).pipe !== 'function') throw new AppError(400, 'invalid_input');
      let id: string;
      try {
        id = await storeCardFile({
          db, dir, maxBytes, ctx, cardId: card.id, stream,
          name: cleanName((req.query as { name?: string }).name), mime: cleanMime(req.headers['content-type']),
        });
      } catch (e) {
        // Stop reading the rest of a refused upload: close the connection once the error response is out.
        reply.header('connection', 'close');
        reply.raw.once('finish', () => req.raw.destroy());
        throw e;
      }
      try {
        d.hub.publish(nextActionId(), events);
      } catch (e) {
        console.error('live publish failed', e); // the write is already committed
      }
      return { id };
    });

    inst.post('/api/covers', { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const user = d.needUser(req);
      const projectId = (req.query as { projectId?: string }).projectId ?? '';
      if (!can(db, user, 'content.edit', projectId)) throw new AppError(404, 'not_found');
      const mime = cleanMime(req.headers['content-type']);
      const declared = Number(req.headers['content-length']);
      const stream = req.body as NodeJS.ReadableStream | undefined;
      const refuse = (e: unknown) => {
        reply.header('connection', 'close');
        reply.raw.once('finish', () => req.raw.destroy());
        return e;
      };
      if (!(COVER_MIMES as readonly string[]).includes(mime)) throw refuse(new AppError(415, 'bad_type'));
      if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) throw refuse(new AppError(413, 'too_large'));
      if (!stream || typeof (stream as any).pipe !== 'function') throw new AppError(400, 'invalid_input');
      const ctx: Ctx = { db, actor: sessionActor(user), events: [], emit: () => {}, afterCommit: () => {} };
      try {
        return { id: await storeCoverUpload(ctx, projectId, stream, mime) };
      } catch (e) {
        throw refuse(e);
      }
    });
  });

  app.get('/api/covers/:id', async (req, reply) => {
    const user = d.needUser(req);
    const c = coverRow(db, (req.params as { id: string }).id);
    if (!c || !can(db, user, 'project.view', c.projectId)) throw new AppError(404, 'not_found');
    const dirC = coversDirOf(db);
    const path = dirC && coverPath(dirC, c.id);
    const st = path ? await stat(path).catch(() => null) : null;
    if (!path || !st) throw new AppError(404, 'not_found');
    // Same rule as card files: the 304 comes only after the project-view check above.
    const etag = `"${c.id}"`;
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', 'private, no-cache').send();
    }
    return reply
      .header('content-type', c.mime)
      .header('content-length', st.size)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .send(createReadStream(path));
  });

  app.get('/api/files/:id', async (req, reply) => {
    const user = d.needUser(req);
    const f = fileRow(db, (req.params as { id: string }).id);
    if (!f) throw new AppError(404, 'not_found');
    d.visibleCard(user, 'id=?', f.cardId);
    const path = filePath(dir, f.id);
    const st = await stat(path).catch(() => null);
    if (!st) throw new AppError(404, 'not_found');
    // Ids are never reused, so the id is the ETag. Revalidation runs after the visibility check above:
    // someone who lost access gets 404, never a 304 that keeps a cached copy alive.
    const etag = `"${f.id}"`;
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', 'private, no-cache').send();
    }
    return reply
      .header('content-type', INLINE_MIMES.has(f.mime) ? f.mime : 'application/octet-stream')
      .header('content-length', st.size)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .header('content-disposition', contentDisposition(INLINE_MIMES.has(f.mime) ? 'inline' : 'attachment', f.name))
      .send(createReadStream(path));
  });
}

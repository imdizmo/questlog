/**
 * The Assets library (shared/assets.ts): a project's pictures, 3D models, maps and concepts. Questlog keeps its own
 * copy of each, under `<files>/assets/`: a picture (`picture_id`) and, for a `.glb` the person added, the model
 * (`model_id`). Deleting an asset removes Questlog's copy only, never the source, and never a copy a wiki entry got
 * through "Use as a picture of…" (that one is the entry's own attachment).
 *
 * - Bytes come in as a raw body (from the computer, or a picture the page fetched from the team's library) or are
 *   downloaded by the server (server/assetFetch.ts). Either way they are counted against the file size cap while they
 *   stream to a temp file, then accepted by their first bytes only (PNG, JPEG, WebP, binary glTF 2); the declared type
 *   is never trusted.
 * - Reading needs the project (project.view); adding and changing need content.edit. Both answer 404 otherwise, as
 *   covers do.
 * - Rename, retag and delete are commands (`assets/update`, `assets/delete`), so tokens and MCP follow the usual rules;
 *   every change emits an `asset` event to the project's viewers.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { newId, type Db } from './db';
import { AppError } from './errors';
import { dispatch, nextActionId, runAction, type Ctx } from './dispatch';
import { releaseCover, storeCoverUpload } from './covers';
import { entryTypeRow } from './commands/wiki';
import { filesDirOf } from './files';
import { can, sessionActor } from './permissions';
import { uploadCap, storeCardFile, cleanName } from './file-routes';
import { uploadRoom } from './billing';
import { canSeeCard, cardProjectId } from './access';
import { downloadAsset } from './assetFetch';
import { cardRow } from './commands/rows';
import type { LiveHub } from './live';
import { teamHostname } from '../shared/suggestions';
import { titleOf } from '../shared/cards';
import {
  ASSET_FORS, ASSET_KINDS, GLB_MIME, PICTURE_MIMES, SNIFF_BYTES, sniff,
  type AcceptedMime, type Asset, type AssetLink, type AssetSource,
} from '../shared/assets';
import type { User } from '../shared/types';

export const assetsDirOf = (db: Db): string | undefined => {
  const d = filesDirOf(db);
  return d && join(d, 'assets');
};
/** Disk path of a blob id (ids are server-made uuids, never request data). */
export const assetBlobPath = (dir: string, id: string): string => join(dir, id);

// ---- rows ----

function toAsset(r: Record<string, any>, usedIn: Asset['usedIn']): Asset {
  let link: AssetLink | null = null;
  try { link = r.link_json ? JSON.parse(r.link_json) : null; } catch { /* written by us; never unreadable */ }
  return {
    id: r.id, projectId: r.project_id, title: r.title, kind: r.kind, for: r.for_tag ?? null, source: r.source, link,
    hasPicture: !!r.picture_id, pictureMime: r.picture_mime ?? null, hasModel: !!r.model_id,
    size: (r.picture_size ?? 0) + (r.model_size ?? 0), createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    usedIn,
  };
}

/**
 * Where assets are used: live cards of the asset's own project holding a copy. Only that project: a copy can reach
 * another project's card (a cloned project copies its attachments), and naming that card would show it to people who
 * can't see that project. Within the project, seeing the asset means seeing its cards (canSeeCard: a card with a deck
 * follows its project), so the asset's readers and its live event's receivers may see every card listed here.
 */
const USES = `SELECT f.asset_id a, c.id cardId, substr(c.content, 1, 400) content FROM files f JOIN cards c ON c.id=f.card_id
  JOIN decks d ON d.id=c.deck_id JOIN assets s ON s.id=f.asset_id
  WHERE c.visibility!='deleted' AND d.project_id=s.project_id AND f.asset_id`;

/**
 * Where assets are used in wiki blocks (Model, Picture, Map, Pictures in a row): live cards of the asset's project whose
 * layout names it. Only cards that have a layout of their own are read; a card is listed once per asset.
 */
const LAYOUT_USES = `SELECT j.value a, c.id cardId, substr(c.content, 1, 400) content FROM cards c JOIN decks d ON d.id=c.deck_id,
  json_tree(c.layout_json, '$.data') j
  WHERE c.layout_json IS NOT NULL AND c.visibility!='deleted' AND d.project_id=? AND j.type='text' AND (j.key='assetId' OR j.path LIKE '%.assetIds')`;

/** Both kinds of use of the project's assets (or of one), each card once per asset, copies first. */
function usesOf(db: Db, projectId: string, assetId?: string): Map<string, Asset['usedIn']> {
  const out = new Map<string, Asset['usedIn']>();
  const add = (u: { a: string; cardId: string; content: string }) => {
    const l = out.get(u.a) ?? [];
    if (!l.some((x) => x.cardId === u.cardId)) l.push({ cardId: u.cardId, title: titleOf(u.content) });
    out.set(u.a, l);
  };
  const files = assetId ? db.prepare(`${USES}=? ORDER BY f.created_at`).iterate(assetId)
    : db.prepare(`${USES} IN (SELECT id FROM assets WHERE project_id=?) ORDER BY f.created_at`).iterate(projectId);
  for (const u of files as Iterable<{ a: string; cardId: string; content: string }>) add(u);
  const blocks = assetId ? db.prepare(`${LAYOUT_USES} AND j.value=? ORDER BY c.seq`).iterate(projectId, assetId)
    : db.prepare(`${LAYOUT_USES} ORDER BY c.seq`).iterate(projectId);
  for (const u of blocks as Iterable<{ a: string; cardId: string; content: string }>) add(u);
  return out;
}

/** The raw row (blob ids included), or undefined. */
export const rawRow = (db: Db, id: string) => db.prepare('SELECT * FROM assets WHERE id=?').get(id) as Record<string, any> | undefined;

export function assetRow(db: Db, id: string): Asset | undefined {
  const r = rawRow(db, id);
  if (!r) return undefined;
  return toAsset(r, usesOf(db, r.project_id, id).get(id) ?? []);
}

/** A project's assets, newest first, each with where it is used. */
export function listAssets(db: Db, projectId: string, limit = 5000): Asset[] {
  const uses = usesOf(db, projectId);
  return (db.prepare('SELECT * FROM assets WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as Record<string, any>[])
    .map((r) => toAsset(r, uses.get(r.id) ?? []));
}

/** Blob ids of a project's assets (collect before the project's rows go). */
export const projectAssetBlobIds = (db: Db, projectId: string): string[] =>
  (db.prepare('SELECT picture_id p, model_id m FROM assets WHERE project_id=?').all(projectId) as { p: string | null; m: string | null }[])
    .flatMap((r) => [r.p, r.m]).filter((x): x is string => !!x);

/** Deletes blobs after the commit; failures are logged (ids only), never thrown. */
export function unlinkAssetBlobs(db: Db, ids: string[]): void {
  const dir = assetsDirOf(db);
  if (!dir) return;
  for (const id of ids) {
    unlink(assetBlobPath(dir, id)).catch((e) => {
      if (e?.code !== 'ENOENT') console.error('[jt] could not delete asset copy', id, String(e?.code ?? e?.message ?? e));
    });
  }
}

/** Removes one blob now (a copy that was never recorded). */
export async function dropAssetBlob(db: Db, id: string): Promise<void> {
  const dir = assetsDirOf(db);
  if (dir) await unlink(assetBlobPath(dir, id)).catch(() => {});
}

/** The team's address as the link back names it: the desktop's team (This computer) or this team server; null: none. */
export function teamServerName(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.JT_WORKSPACE_LABEL?.trim()) return teamHostname(env.JATIFY_TEAM);
  return teamHostname(env.JATIFY_TEAM_SERVER);
}

// ---- storing bytes ----

/** Counts the bytes (the given error past `max`) and keeps the first SNIFF_BYTES for the type check. */
class Counter extends Transform {
  size = 0;
  head = Buffer.alloc(0);
  constructor(private max: number, private tooLarge: () => AppError) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.size += chunk.length;
    if (this.size > this.max) return cb(this.tooLarge());
    if (this.head.length < SNIFF_BYTES) this.head = Buffer.concat([this.head, chunk.subarray(0, SNIFF_BYTES - this.head.length)]);
    cb(null, chunk);
  }
}

export interface StoredBlob { id: string; size: number; mime: AcceptedMime }

/**
 * Streams `source` into `<files>/assets/<new id>` (temp file first; 413 past `max`, 400 when empty, 415 bad_type when
 * the first bytes are none of the accepted kinds). The blob is in place when this returns; the caller records it or
 * removes it.
 */
export async function storeAssetBlob(db: Db, source: NodeJS.ReadableStream, max: number, tooLarge: () => AppError): Promise<StoredBlob> {
  const dir = assetsDirOf(db);
  if (!dir) throw new AppError(500, 'no_files_dir');
  await mkdir(dir, { recursive: true });
  const id = newId();
  const tmp = assetBlobPath(dir, `.tmp-${id}`);
  const counter = new Counter(max, tooLarge);
  try {
    // Piped by hand so a refused upload fails our streams without destroying the request itself.
    source.on('error', (e) => counter.destroy(e));
    source.on('close', () => { if (!(source as any).readableEnded) counter.destroy(new Error('aborted')); });
    source.pipe(counter);
    await pipeline(counter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (counter.size === 0) throw new AppError(400, 'invalid_input');
    const mime = sniff(new Uint8Array(counter.head));
    if (!mime) throw new AppError(415, 'bad_type');
    renameSync(tmp, assetBlobPath(dir, id));
    return { id, size: counter.size, mime };
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const removeBlob = async (db: Db, b: StoredBlob | null) => { if (b) await dropAssetBlob(db, b.id); };

// ---- what a new asset may say ----

/** Display title: no control characters, at most 200 characters; empty is "Untitled". */
export function cleanTitle(raw: unknown): string {
  const t = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(t).slice(0, 200).join('').trim() || 'Untitled';
}

const seg = z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f]+$/);
const libraryLink = z.union([
  z.strictObject({ kind: z.literal('asset'), pack: seg, path: z.string().min(1).max(1000), packTitle: z.string().max(200).optional(), server: z.string().optional() }),
  z.strictObject({ kind: z.enum(['map', 'prop']), id: seg, version: z.number().int().min(1), server: z.string().optional() }),
]);

const metaSchema = z.object({
  projectId: z.string().min(1).max(100),
  title: z.string().max(2000).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  for: z.union([z.enum(ASSET_FORS), z.literal('')]).optional(),
  source: z.enum(['uploaded', 'asset-shelf', 'groundwork']).default('uploaded'),
  link: z.string().max(4000).optional(),
});
export type NewAssetMeta = { projectId: string; title: string; kind?: Asset['kind']; for: Asset['for']; source: AssetSource; link: AssetLink | null };

/** The query of an upload as a new asset's words (400 invalid_input when any is wrong; library links need a team). */
export function parseMeta(q: unknown): NewAssetMeta {
  const p = metaSchema.safeParse(q);
  if (!p.success) throw new AppError(400, 'invalid_input');
  const m = p.data;
  let link: AssetLink | null = null;
  if (m.source !== 'uploaded') {
    let raw: unknown;
    try { raw = JSON.parse(m.link ?? ''); } catch { throw new AppError(400, 'invalid_input'); }
    const l = libraryLink.safeParse(raw);
    if (!l.success || (m.source === 'asset-shelf') !== (l.data.kind === 'asset')) throw new AppError(400, 'invalid_input');
    const server = teamServerName();
    if (!server) throw new AppError(400, 'no_team');
    link = { ...l.data, server } as AssetLink;
  } else if (m.link !== undefined) throw new AppError(400, 'invalid_input');
  return { projectId: m.projectId, title: cleanTitle(m.title), kind: m.kind, for: m.for ? m.for : null, source: m.source, link };
}

/**
 * Re-checks the plan's storage inside the action, as a card upload does: other uploads may have used the room while
 * this one streamed in (the cap it streamed under was the room at its start). 413 plan_limit {limit: 'storage'}; the
 * caller removes the stored blob.
 */
export function assertStorageRoom(db: Db, size: number): void {
  const { storageLeft } = uploadRoom(db);
  if (storageLeft !== null && size > storageLeft) throw new AppError(413, 'plan_limit', { limit: 'storage' });
}

/** A downloaded asset's default title: the address's last path segment without its extension, decoded when it can be. */
export function titleFromUrl(url: string): string {
  const seg = url.split(/[?#]/)[0].split('/').pop() ?? '';
  let name = seg;
  try { name = decodeURIComponent(seg); } catch { /* a malformed escape: the segment as it is */ }
  return name.replace(/\.[^.]+$/, '');
}

/** A model needs its .glb, unless it came from a library (those bring pictures only). */
export const modelAllowed = (source: AssetSource, hasModel: boolean) => hasModel || source === 'asset-shelf' || source === 'groundwork';

/**
 * Records a new asset from a stored blob (inside an action: re-checks the project, emits). A `.glb` is a model with
 * no picture yet; a picture keeps the kind it was given.
 */
export function insertAsset(ctx: Ctx, meta: NewAssetMeta, blob: StoredBlob): Asset {
  const { db } = ctx;
  if (!can(db, ctx.actor, 'content.edit', meta.projectId)) throw new AppError(404, 'not_found');
  const glb = blob.mime === GLB_MIME;
  const kind = glb ? 'model' : meta.kind ?? 'picture';
  if (kind === 'model' && !modelAllowed(meta.source, glb)) throw new AppError(400, 'invalid_input');
  assertStorageRoom(db, blob.size);
  const id = newId();
  const now = Date.now();
  db.prepare(`INSERT INTO assets (id,project_id,title,kind,for_tag,source,link_json,picture_id,picture_mime,picture_size,model_id,model_size,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, meta.projectId, meta.title, kind, meta.for, meta.source, meta.link ? JSON.stringify(meta.link) : null,
    glb ? null : blob.id, glb ? null : blob.mime, glb ? 0 : blob.size, glb ? blob.id : null, glb ? blob.size : 0,
    ctx.actor.id, now, now,
  );
  const a = assetRow(db, id)!;
  ctx.emit('asset', 'upsert', a);
  return a;
}

// ---- routes ----

export interface AssetRouteDeps {
  db: Db;
  hub: LiveHub;
  maxBytes: number;
  needUser(req: FastifyRequest): User;
}

export function registerAssetRoutes(app: FastifyInstance, d: AssetRouteDeps): void {
  const { db, hub, maxBytes } = d;

  /** Runs `fn` as one action of the signed-in person and publishes its events. */
  const act = <T>(user: User, fn: (ctx: Ctx) => T): T => {
    const r = runAction(db, user, fn);
    try { hub.publish(r.actionId, r.events); } catch (e) { console.error('live publish failed', e); }
    return r.result;
  };
  const viewable = (user: User, id: string) => {
    const r = rawRow(db, id);
    if (!r || !can(db, user, 'project.view', r.project_id)) throw new AppError(404, 'not_found');
    return r;
  };
  /** Stop reading the rest of a refused upload: close the connection once the error is out. */
  const refuse = (req: FastifyRequest, reply: FastifyReply, e: unknown) => {
    reply.header('connection', 'close');
    reply.raw.once('finish', () => req.raw.destroy());
    return e;
  };
  const bodyStream = (req: FastifyRequest): NodeJS.ReadableStream => {
    const s = req.body as NodeJS.ReadableStream | undefined;
    if (!s || typeof (s as any).pipe !== 'function') throw new AppError(400, 'invalid_input');
    return s;
  };
  const sendBlob = async (req: FastifyRequest, reply: FastifyReply, blobId: string | null, mime: string) => {
    const dir = assetsDirOf(db);
    const path = dir && blobId ? assetBlobPath(dir, blobId) : null;
    const st = path ? await stat(path).catch(() => null) : null;
    if (!path || !st) throw new AppError(404, 'not_found');
    // Blob ids are never reused, so the id is the ETag; the 304 comes only after the view check.
    const etag = `"${blobId}"`;
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      return reply.code(304).header('etag', etag).header('cache-control', 'private, no-cache').send();
    }
    return reply.header('content-type', mime).header('content-length', st.size).header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-cache').header('etag', etag).send(createReadStream(path));
  };

  app.get('/api/assets', async (req) => {
    const user = d.needUser(req);
    const projectId = String((req.query as { projectId?: unknown }).projectId ?? '');
    if (!can(db, user, 'project.view', projectId)) throw new AppError(404, 'not_found');
    // Each card listed under "Used in" is checked for this person too (see USES).
    const sees = (cardId: string) => {
      const c = cardRow(db, cardId);
      return !!c && canSeeCard(db, user, c, c.deckId ? cardProjectId(db, cardId) : null);
    };
    return { items: listAssets(db, projectId).map((a) => ({ ...a, usedIn: a.usedIn.filter((u) => sees(u.cardId)) })) };
  });
  app.get('/api/assets/:id/picture', async (req, reply) => {
    const r = viewable(d.needUser(req), (req.params as { id: string }).id);
    return sendBlob(req, reply, r.picture_id, r.picture_mime);
  });
  app.get('/api/assets/:id/model', async (req, reply) => {
    const r = viewable(d.needUser(req), (req.params as { id: string }).id);
    return sendBlob(req, reply, r.model_id, GLB_MIME);
  });

  /** A downloaded picture or .glb (server/assetFetch.ts): source `url`, linked to the address it came from. */
  app.post('/api/assets/from-url', async (req) => {
    const user = d.needUser(req);
    const p = z.object({ projectId: z.string().min(1).max(100), url: z.string().min(1).max(4000), title: z.string().max(2000).optional(), for: z.enum(ASSET_FORS).nullable().optional() })
      .safeParse(req.body);
    if (!p.success) throw new AppError(400, 'invalid_input');
    if (!can(db, user, 'content.edit', p.data.projectId)) throw new AppError(404, 'not_found');
    const cap = uploadCap(db, maxBytes);
    const got = await downloadAsset(db, p.data.url, cap.max, cap.tooLarge);
    try {
      const title = p.data.title?.trim() ? p.data.title : titleFromUrl(got.finalUrl);
      return act(user, (ctx) => insertAsset(ctx, { projectId: p.data.projectId, title: cleanTitle(title), for: p.data.for ?? null, source: 'url', link: { url: got.finalUrl } }, got));
    } catch (e) {
      await removeBlob(db, got);
      throw e;
    }
  });

  /** Puts an asset's picture on a wiki entry: a copy attached to the card (its pictures and cover follow as usual). */
  app.post('/api/assets/:id/use', async (req) => {
    const user = d.needUser(req);
    const r = viewable(user, (req.params as { id: string }).id);
    const cardId = String((req.body as { cardId?: unknown } | null)?.cardId ?? '');
    const card = cardRow(db, cardId);
    // Only an entry of the asset's own project, that the person may edit.
    const pid = card?.deckId ? (db.prepare('SELECT project_id p FROM decks WHERE id=?').get(card.deckId) as { p: string } | undefined)?.p : undefined;
    if (!card || card.visibility === 'deleted' || pid !== r.project_id || !can(db, user, 'content.edit', pid)) throw new AppError(404, 'not_found');
    const dir = assetsDirOf(db);
    if (!r.picture_id || !dir) throw new AppError(409, 'no_picture');
    const events: any[] = [];
    const ctx: Ctx = { db, actor: sessionActor(user), events, emit: (model, op, row) => { events.push({ model, op, row }); }, afterCommit: () => {} };
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[r.picture_mime as string] ?? 'png';
    const filesDir = filesDirOf(db)!;
    const fileId = await storeCardFile({
      db, dir: filesDir, maxBytes, ctx, cardId: card.id, stream: createReadStream(assetBlobPath(dir, r.picture_id)),
      name: cleanName(`${r.title}.${ext}`), mime: r.picture_mime, assetId: r.id,
    });
    events.push({ model: 'asset', op: 'upsert', row: assetRow(db, r.id)! });
    try { hub.publish(nextActionId(), events); } catch (e) { console.error('live publish failed', e); }
    return { fileId };
  });

  /**
   * Makes an asset's picture a wiki type's picture: a copy in the project's covers (the store uploaded type pictures
   * use), set through wiki/updateType, which releases the type's previous upload. The copy is the type's own: deleting
   * the asset leaves it. The copy is dropped again when the type can't take it.
   */
  app.post('/api/assets/:id/use-for-type', async (req) => {
    const user = d.needUser(req);
    const r = viewable(user, (req.params as { id: string }).id);
    const typeId = String((req.body as { typeId?: unknown } | null)?.typeId ?? '');
    const type = entryTypeRow(db, typeId);
    // Only a type of the asset's own project, for someone who manages it (like every type edit).
    if (!type || type.projectId !== r.project_id || !can(db, user, 'project.manage', type.projectId)) throw new AppError(404, 'not_found');
    const dir = assetsDirOf(db);
    if (!r.picture_id || !dir) throw new AppError(409, 'no_picture');
    const ctx: Ctx = { db, actor: sessionActor(user), events: [], emit: () => {}, afterCommit: (fn) => fn() };
    const fileId = await storeCoverUpload(ctx, type.projectId, createReadStream(assetBlobPath(dir, r.picture_id)), r.picture_mime);
    let done;
    try {
      done = dispatch(db, user, 'wiki/updateType', { id: type.id, picture: { kind: 'file', fileId } });
    } catch (e) {
      releaseCover(ctx, { kind: 'file', fileId });
      throw e;
    }
    try { hub.publish(done.actionId, done.events); } catch (e) { console.error('live publish failed', e); }
    return { fileId };
  });

  // Raw bodies: encapsulated so the stream parser does not reach the JSON routes.
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    inst.post('/api/assets', { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const user = d.needUser(req);
      let meta: NewAssetMeta;
      try {
        meta = parseMeta(req.query);
        if (!can(db, user, 'content.edit', meta.projectId)) throw new AppError(404, 'not_found');
      } catch (e) { throw refuse(req, reply, e); }
      const cap = uploadCap(db, maxBytes);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > cap.max) throw refuse(req, reply, cap.tooLarge());
      let blob: StoredBlob | null = null;
      try {
        blob = await storeAssetBlob(db, bodyStream(req), cap.max, cap.tooLarge);
        const b = blob;
        return act(user, (ctx) => insertAsset(ctx, meta, b));
      } catch (e) {
        await removeBlob(db, blob);
        throw refuse(req, reply, e);
      }
    });

    /** A model's picture (the page renders one from the .glb), replacing the one it had. */
    inst.put('/api/assets/:id/picture', { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const user = d.needUser(req);
      let r: Record<string, any>;
      try {
        r = viewable(user, (req.params as { id: string }).id);
        if (!can(db, user, 'content.edit', r.project_id)) throw new AppError(404, 'not_found');
        if (!r.model_id) throw new AppError(409, 'not_a_model');
      } catch (e) { throw refuse(req, reply, e); }
      const cap = uploadCap(db, maxBytes);
      let blob: StoredBlob | null = null;
      try {
        blob = await storeAssetBlob(db, bodyStream(req), cap.max, cap.tooLarge);
        if (!(PICTURE_MIMES as readonly string[]).includes(blob.mime)) throw new AppError(415, 'bad_type');
        const b = blob;
        const out = act(user, (ctx) => {
          const now = rawRow(db, r.id);
          if (!now) throw new AppError(404, 'not_found');
          assertStorageRoom(db, b.size);
          db.prepare('UPDATE assets SET picture_id=?, picture_mime=?, picture_size=?, updated_at=? WHERE id=?').run(b.id, b.mime, b.size, Date.now(), r.id);
          if (now.picture_id) { const old = now.picture_id as string; ctx.afterCommit(() => unlinkAssetBlobs(db, [old])); }
          const a = assetRow(db, r.id)!;
          ctx.emit('asset', 'upsert', a);
          return a;
        });
        return out;
      } catch (e) {
        await removeBlob(db, blob);
        throw refuse(req, reply, e);
      }
    });
  });
}

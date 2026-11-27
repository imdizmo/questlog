import { opendirSync, unlinkSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db';
import { toCamel } from './db';
import type { Ctx } from './dispatch';
import { accountRow, cardRow } from './commands/rows';

/** Mime types shown inline; everything else is sent as an attachment. */
export const INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Where each database keeps its attachment bytes (set by buildApp; unset in command-only tests). */
const dirs = new WeakMap<Db, string>();
export const setFilesDir = (db: Db, dir: string): void => { dirs.set(db, dir); };
export const filesDirOf = (db: Db): string | undefined => dirs.get(db);
/** Disk path of a file id. Ids are server-made uuids, never user input. */
export const filePath = (dir: string, id: string): string => join(dir, id);

export const fileRow = (db: Db, id: string) => {
  const r = db.prepare('SELECT * FROM files WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

/** Own cover by the account rule: first = oldest image, latest = newest, anything else = none. */
function ownCover(db: Db, cardId: string, rule: string): string | null {
  if (rule !== 'first' && rule !== 'latest') return null;
  const dir = rule === 'first' ? 'ASC' : 'DESC';
  const marks = [...INLINE_MIMES].map(() => '?').join(',');
  const r = db.prepare(`SELECT id FROM files WHERE card_id=? AND mime IN (${marks}) ORDER BY created_at ${dir}, rowid ${dir} LIMIT 1`)
    .get(cardId, ...INLINE_MIMES) as { id: string } | undefined;
  return r?.id ?? null;
}

function wantedCover(db: Db, cardId: string): string | null {
  const s = accountRow(db).settings as { coverFromAttachments?: string; heroCoverFromSubs?: boolean };
  const own = ownCover(db, cardId, s.coverFromAttachments ?? 'first');
  if (own || !s.heroCoverFromSubs) return own;
  const sub = db.prepare("SELECT cover_file_id f FROM cards WHERE parent_card_id=? AND visibility!='deleted' AND cover_file_id IS NOT NULL ORDER BY seq LIMIT 1")
    .get(cardId) as { f: string } | undefined;
  return sub?.f ?? null;
}

/**
 * Recomputes cards.cover_file_id; emits the card when it changed and walks up to its hero.
 * Returns true when the given card itself was emitted (callers then needn't emit it again).
 */
export function refreshCover(ctx: Ctx, cardId: string | null): boolean {
  const seen = new Set<string>();
  let self = false;
  for (let cur = cardId; cur && !seen.has(cur); ) {
    seen.add(cur);
    const row = ctx.db.prepare('SELECT cover_file_id c, parent_card_id p FROM cards WHERE id=?').get(cur) as { c: string | null; p: string | null } | undefined;
    if (!row) break;
    const want = wantedCover(ctx.db, cur);
    if (want === row.c) break;
    ctx.db.prepare('UPDATE cards SET cover_file_id=? WHERE id=?').run(want, cur);
    ctx.emit('card', 'upsert', cardRow(ctx.db, cur)!);
    if (cur === cardId) self = true;
    cur = row.p;
  }
  return self;
}

/** Every card whose cover could depend on the cover settings (after they change). */
export function refreshAllCovers(ctx: Ctx): void {
  const ids = ctx.db.prepare('SELECT id FROM cards WHERE cover_file_id IS NOT NULL OR id IN (SELECT card_id FROM files) OR id IN (SELECT parent_card_id FROM cards WHERE parent_card_id IS NOT NULL)')
    .all() as { id: string }[];
  for (const { id } of ids) refreshCover(ctx, id);
}

/** Deletes disk files after the database commit. Failures are logged (id only) and never thrown. */
export function unlinkFiles(db: Db, ids: string[]): void {
  const dir = filesDirOf(db);
  if (!dir) return;
  for (const id of ids) {
    unlink(filePath(dir, id)).catch((e) => {
      if (e?.code !== 'ENOENT') console.error('[jt] could not delete file', id, String(e?.code ?? e?.message ?? e));
    });
  }
}

/** Ids of every file attached to a card of this project, and of Home's pictures kept for it (collect before a hard delete). */
export const projectFileIds = (db: Db, projectId: string): string[] =>
  (db.prepare(`SELECT f.id id FROM files f JOIN cards c ON c.id=f.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id=?
    UNION ALL SELECT id FROM files WHERE project_id=?`)
    .all(projectId, projectId) as { id: string }[]).map((r) => r.id);

/**
 * Startup cleanup of the files dir: partial uploads (`.tmp-*`) left by a crash, and files whose row is gone
 * (a crash between commit and unlink). Streams the directory; logs counts only.
 */
export function sweepFilesDir(db: Db, dir: string): { tmp: number; orphans: number } {
  const out = { tmp: 0, orphans: 0 };
  let d;
  try { d = opendirSync(dir); } catch { return out; }
  const has = db.prepare('SELECT 1 FROM files WHERE id=?');
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (e.isDirectory() && e.name === 'covers') { sweepSubDir(join(dir, 'covers'), coverKnown(db), out); continue; }
      if (e.isDirectory() && e.name === 'assets') { sweepSubDir(join(dir, 'assets'), assetKnown(db), out); continue; }
      if (!e.isFile()) continue;
      const tmp = e.name.startsWith('.tmp-');
      if (!tmp && has.get(e.name)) continue;
      try { unlinkSync(join(dir, e.name)); out[tmp ? 'tmp' : 'orphans']++; } catch { /* gone already or not ours to remove */ }
    }
  } finally {
    d.closeSync();
  }
  return out;
}

/** Whether a name in the covers folder is a cover the database lists. */
const coverKnown = (db: Db) => {
  const has = db.prepare('SELECT 1 FROM covers WHERE id=?');
  return (name: string) => !!has.get(name);
};

/** Whether a name in the assets folder is an asset's picture or model (server/assets.ts). */
const assetKnown = (db: Db) => {
  const pic = db.prepare('SELECT 1 FROM assets WHERE picture_id=?');
  const model = db.prepare('SELECT 1 FROM assets WHERE model_id=?');
  return (name: string) => !!pic.get(name) || !!model.get(name);
};

/** Same cleanup for a subdirectory (covers, assets): partial uploads and files the database does not list. */
function sweepSubDir(dir: string, known: (name: string) => boolean, out: { tmp: number; orphans: number }): void {
  let d;
  try { d = opendirSync(dir); } catch { return; }
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (!e.isFile()) continue;
      const tmp = e.name.startsWith('.tmp-');
      if (!tmp && known(e.name)) continue;
      try { unlinkSync(join(dir, e.name)); out[tmp ? 'tmp' : 'orphans']++; } catch { /* gone already */ }
    }
  } finally {
    d.closeSync();
  }
}

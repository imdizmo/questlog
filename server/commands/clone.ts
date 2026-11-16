/**
 * `clone/projects {projectIds, visibility}` (workspace admins): copies projects inside this workspace.
 *
 * Copied: the project ("<name> (copy)") with its sections, tags and member access; its decks with journeys,
 * guardians and subscribers; its cards (the trash excepted) with hierarchy, dependencies inside the project,
 * attachments (new file rows and copied bytes; card text pointing at a copied file points at the copy), comment
 * threads with entries and reactions, subscribers, finished time entries and history.
 * Milestones in use are merged into the oldest milestone with the same date, colour and name (within one workspace
 * that is the card's own milestone unless an older identical one exists), which then covers the copy too. Runs are
 * kept only when global. Uploaded covers are not copied (the copy shows none).
 * Not copied: bookmarks, hands, done piles, notifications, personal tags, vision boards and saved board queries.
 *
 * Attachment bytes are copied before the transaction (copyFile: the kernel copies, nothing is buffered here); the
 * copies are removed again if the transaction fails, and any that ended up unused are removed after it.
 */
import { z } from 'zod';
import { copyFile, statfs, unlink } from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import { newId, type Db } from '../db';
import { AppError } from '../errors';
import { assertCan, type Actor } from '../permissions';
import { runAction, toActor, type ChangeEvent, type Ctx } from '../dispatch';
import { filePath, filesDirOf } from '../files';
import { projectRow } from './rows';
import { assertFeature, assertProjectSlots, uploadRoom } from '../billing';
import { markMilestone } from './milestones';
import { takeImportSlot } from './imports';
import type { User } from '../../shared/types';

/** Live cards copied by one clone request, all projects together (one transaction). */
export const MAX_CLONE_CARDS = 20_000;
/** Free disk space that must remain after the attachment copies. */
const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;

const cloneSchema = z.object({
  projectIds: z.array(z.string().min(1).max(100)).min(1).max(20).refine((a) => new Set(a).size === a.length, 'ids must be unique'),
  visibility: z.enum(['full', 'limited']),
});

type Row = Record<string, unknown>;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Uploaded covers live with their project; a copy would point at the source's upload, so it gets no cover. */
const coverJson = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try { return (JSON.parse(v) as { kind?: string } | null)?.kind === 'file' ? null : v; } catch { return null; }
};

export async function cloneProjects(db: Db, user: User | Actor, payload: unknown): Promise<{ payload: { projects: { id: string; name: string }[] }; actionId: string; events: ChangeEvent[] }> {
  const parsed = cloneSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, 'invalid_payload');
  const { projectIds, visibility } = parsed.data;
  const actor = toActor(user);
  assertCan(db, actor, 'account.manage');
  assertCan(db, actor, 'project.create');
  for (const id of projectIds) if (!projectRow(db, id)) throw new AppError(404, 'not_found');
  assertProjectSlots(db, projectIds.length);
  if (visibility === 'limited') assertFeature(db, 'limitedVisibility');
  const ids = placeholders(projectIds.length);
  const live = `FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (${ids}) AND c.visibility!='deleted'`;
  const { n } = db.prepare(`SELECT COUNT(*) n ${live}`).get(...projectIds) as { n: number };
  if (n > MAX_CLONE_CARDS) throw new AppError(400, 'too_many_cards', { max: MAX_CLONE_CARDS });

  const dir = filesDirOf(db);
  const release = takeImportSlot();
  const copies = new Map<string, string>();
  const drop = async (newIds: Iterable<string>) => {
    if (!dir) return;
    for (const id of newIds) await unlink(filePath(dir, id)).catch(() => {});
  };
  try {
    if (dir) {
      const files = db.prepare(`SELECT f.id id, f.size size FROM files f JOIN cards c ON c.id=f.card_id JOIN decks d ON d.id=c.deck_id
          WHERE d.project_id IN (${ids}) AND c.visibility!='deleted'`).all(...projectIds) as { id: string; size: number }[];
      // The copies must fit with room to spare, so a large clone can't fill the disk.
      const bytes = files.reduce((t, f) => t + f.size, 0);
      assertStorageFor(db, bytes);
      if (bytes > 0) {
        const fs = await statfs(dir);
        if (bytes + DISK_RESERVE_BYTES > fs.bavail * fs.bsize) throw new AppError(507, 'not_enough_disk', { bytes });
      }
      for (const { id } of files) {
        const copy = newId();
        try {
          await copyFile(filePath(dir, id), filePath(dir, copy), fsc.COPYFILE_EXCL);
          copies.set(id, copy);
        } catch (e) {
          // The bytes are gone (or the row was removed meanwhile): that file is left out.
          if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
        }
      }
    }
    const used = new Set<string>();
    const r = runAction(db, actor, (ctx) => {
      assertCan(db, ctx.actor, 'account.manage');
      // Projects and uploads may have been added while the files were copied.
      assertProjectSlots(db, projectIds.length);
      if (copies.size) {
        const { n } = db.prepare(`SELECT COALESCE(SUM(size), 0) n FROM files WHERE id IN (${placeholders(copies.size)})`).get(...copies.keys()) as { n: number };
        assertStorageFor(db, n);
      }
      const out = projectIds.map((pid) => cloneOne(ctx, pid, visibility, copies, used));
      // Whole projects appeared: everyone reloads instead of receiving every row.
      ctx.events.length = 0;
      for (const p of out) {
        ctx.emit('project', 'upsert', projectRow(db, p.id)!);
        ctx.emit('project', 'access', { id: p.id });
      }
      return out;
    });
    await drop([...copies].filter(([src]) => !used.has(src)).map(([, copy]) => copy));
    return { payload: { projects: r.result }, actionId: r.actionId, events: r.events };
  } catch (e) {
    await drop(copies.values());
    throw e;
  } finally {
    release();
  }
}

/** 413 plan_limit {limit:'storage'} when `bytes` more attachment bytes would not fit the plan's storage. */
function assertStorageFor(db: Db, bytes: number): void {
  const { storageLeft } = uploadRoom(db);
  if (storageLeft !== null && bytes > storageLeft) throw new AppError(413, 'plan_limit', { limit: 'storage' });
}

function cloneOne(ctx: Ctx, srcId: string, visibility: 'full' | 'limited', copies: Map<string, string>, used: Set<string>): { id: string; name: string } {
  const { db } = ctx;
  const stmts = new Map<string, ReturnType<Db['prepare']>>();
  /** INSERT of a row's columns (the cached statement per table and column set keeps thousands of rows cheap). */
  const insert = (table: string, row: Row) => {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders(keys.length)})`;
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    s.run(...(keys.map((k) => row[k]) as any[]));
  };
  const rows = (sql: string, ...a: unknown[]) => db.prepare(sql).iterate(...(a as any[])) as IterableIterator<Row>;

  const src = db.prepare('SELECT * FROM projects WHERE id=?').get(srcId) as Row;
  db.prepare('UPDATE account SET project_seq = project_seq + 1').run();
  const pSeq = (db.prepare('SELECT project_seq s FROM account').get() as { s: number }).s;
  const pid = newId();
  const name = `${src.name as string} (copy)`;
  insert('projects', { ...src, id: pid, seq: pSeq, name, visibility, is_archived: 0, created_at: Date.now(), cover_json: coverJson(src.cover_json) });
  db.prepare('INSERT INTO project_access (project_id, user_id, project_role) SELECT ?, user_id, project_role FROM project_access WHERE project_id=?').run(pid, srcId);

  // Milestones: the oldest identical one (date, colour, name) is used and now covers the copy; global ones cover it already.
  const msMap = new Map<string, string>();
  const milestoneFor = (old: unknown): string | null => {
    if (typeof old !== 'string') return null;
    const hit = msMap.get(old);
    if (hit) return hit;
    const m = db.prepare('SELECT * FROM milestones WHERE id=?').get(old) as Row | undefined;
    if (!m) return null;
    const same = m.is_global ? old : (db.prepare('SELECT id FROM milestones WHERE name=? AND date IS ? AND color=? AND is_global=0 ORDER BY account_seq LIMIT 1')
      .get(m.name as string, m.date as string | null, m.color as string) as { id: string }).id;
    if (!m.is_global) db.prepare('INSERT OR IGNORE INTO milestone_projects (milestone_id, project_id) VALUES (?,?)').run(same, pid);
    msMap.set(old, same);
    markMilestone(ctx, same);
    return same;
  };
  const zoneFor = (oldMs: unknown, newMs: string | null, zone: unknown): string | null => {
    if (typeof zone !== 'string' || !newMs) return null;
    if (newMs === oldMs) return zone;
    const z = db.prepare('SELECT name FROM milestone_zones WHERE id=?').get(zone) as { name: string } | undefined;
    return z ? (db.prepare('SELECT id FROM milestone_zones WHERE milestone_id=? AND name=? ORDER BY sort_index LIMIT 1').get(newMs, z.name) as { id: string } | undefined)?.id ?? null : null;
  };
  const sprintFor = (s: unknown): string | null => typeof s === 'string' && !!db.prepare(
    'SELECT 1 FROM sprints x JOIN sprint_configs g ON g.id=x.config_id WHERE x.id=? AND g.is_global=1').get(s) ? s : null;

  // Decks with guardians, subscribers and journeys.
  const decks = new Map<string, string>();
  const defaults: [string, string][] = [];
  for (const d of db.prepare('SELECT * FROM decks WHERE project_id=? ORDER BY space_id, sort_index, seq').all(srcId) as Row[]) {
    db.prepare('UPDATE account SET deck_seq = deck_seq + 1').run();
    const seq = (db.prepare('SELECT deck_seq s FROM account').get() as { s: number }).s;
    const id = newId();
    decks.set(d.id as string, id);
    if (d.default_card_id) defaults.push([id, d.default_card_id as string]);
    insert('decks', { ...d, id, seq, project_id: pid, default_card_id: null, cover_json: coverJson(d.cover_json), auto_milestone_id: milestoneFor(d.auto_milestone_id), created_at: Date.now() });
    db.prepare('INSERT INTO deck_guardians (deck_id, user_id) SELECT ?, user_id FROM deck_guardians WHERE deck_id=?').run(id, d.id as string);
    db.prepare('INSERT INTO deck_subscriptions (user_id, deck_id, created_at) SELECT user_id, ?, created_at FROM deck_subscriptions WHERE deck_id=?').run(id, d.id as string);
    const j = db.prepare('SELECT * FROM journeys WHERE deck_id=?').get(d.id as string) as Row | undefined;
    if (j) insert('journeys', { ...j, id: newId(), deck_id: id });
  }

  // Cards: new ids and numbers first (parents may come later in seq order), then links.
  const cards = new Map<string, string>();
  const srcDecks = [...decks.keys()];
  const liveCards = `SELECT * FROM cards WHERE deck_id IN (${placeholders(srcDecks.length)}) AND visibility!='deleted' ORDER BY seq`;
  const fileRef = /\/api\/files\/([0-9a-fA-F-]{36})/g;
  if (srcDecks.length) {
    for (const c of rows(`SELECT id FROM cards WHERE deck_id IN (${placeholders(srcDecks.length)}) AND visibility!='deleted' ORDER BY seq`, ...srcDecks)) cards.set(c.id as string, newId());
    const base = (db.prepare('SELECT card_seq s FROM account').get() as { s: number }).s;
    db.prepare('UPDATE account SET card_seq = card_seq + ?').run(cards.size);
    let seq = base;
    for (const c of rows(liveCards, ...srcDecks)) {
      const id = cards.get(c.id as string)!;
      const ms = milestoneFor(c.milestone_id);
      const sprint = sprintFor(c.sprint_id);
      insert('cards', {
        ...c, id, seq: ++seq, deck_id: decks.get(c.deck_id as string), parent_card_id: null,
        content: (c.content as string).replace(fileRef, (m, f: string) => (copies.has(f) ? `/api/files/${copies.get(f)}` : m)),
        cover_file_id: typeof c.cover_file_id === 'string' ? copies.get(c.cover_file_id) ?? null : null,
        milestone_id: ms, milestone_zone_id: zoneFor(c.milestone_id, ms, c.milestone_zone_id),
        sprint_id: sprint, sprint_joined_at: sprint ? c.sprint_joined_at : null, carry_count: sprint ? c.carry_count : 0, snoozed_at: null,
        // Entry types and the page tree belong to the source project and are not cloned: the copy is plain Lore.
        entry_type_id: null, wiki_parent_id: null,
      });
    }
  }
  const setParent = db.prepare('UPDATE cards SET parent_card_id=? WHERE id=?');
  for (const [old, id] of cards) {
    const p = (db.prepare('SELECT parent_card_id p FROM cards WHERE id=?').get(old) as { p: string | null }).p;
    if (p && cards.has(p)) setParent.run(cards.get(p)!, id);
    for (const d of rows('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=?', old)) {
      if (cards.has(d.l as string)) insert('card_deps', { locked_card_id: id, locking_card_id: cards.get(d.l as string) });
    }
    for (const f of rows('SELECT * FROM files WHERE card_id=?', old)) {
      const copy = copies.get(f.id as string);
      if (!copy) continue;
      insert('files', { ...f, id: copy, card_id: id });
      used.add(f.id as string);
    }
    for (const r of rows('SELECT * FROM resolvables WHERE card_id=?', old)) {
      const rid = newId();
      insert('resolvables', { ...r, id: rid, card_id: id });
      for (const e of rows('SELECT * FROM resolvable_entries WHERE resolvable_id=?', r.id)) {
        const eid = newId();
        insert('resolvable_entries', { ...e, id: eid, resolvable_id: rid });
        for (const x of rows('SELECT * FROM resolvable_reactions WHERE entry_id=?', e.id)) insert('resolvable_reactions', { ...x, id: newId(), entry_id: eid });
      }
    }
    db.prepare('INSERT INTO card_subscriptions (user_id, card_id, created_at) SELECT user_id, ?, created_at FROM card_subscriptions WHERE card_id=?').run(id, old);
    // Finished entries only: a running timer belongs to the card someone is working on.
    for (const t of rows('SELECT * FROM time_segments WHERE card_id=? AND duration_ms IS NOT NULL', old)) insert('time_segments', { ...t, id: newId(), card_id: id });
    for (const h of rows('SELECT * FROM card_history WHERE card_id=?', old)) {
      const inSource = h.project_id === srcId;
      insert('card_history', {
        ...h, card_id: id,
        deck_id: typeof h.deck_id === 'string' ? decks.get(h.deck_id) ?? h.deck_id : null,
        project_id: inSource ? pid : h.project_id,
        milestone_id: typeof h.milestone_id === 'string' ? msMap.get(h.milestone_id) ?? h.milestone_id : null,
        // Like the cards: only global runs follow the copy, so a source run's activity doesn't list the copy.
        sprint_id: sprintFor(h.sprint_id),
      });
    }
  }
  for (const [deck, card] of defaults) if (cards.has(card)) db.prepare('UPDATE decks SET default_card_id=? WHERE id=?').run(cards.get(card)!, deck);
  return { id: pid, name };
}

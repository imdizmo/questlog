import { z } from 'zod';
import { newId, toCamel } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { assertCan, can, projectConfined } from '../permissions';
import { accountRow } from './rows';
import { colors } from '../../shared/schedule';
import type { Command, Ctx } from '../dispatch';

/** Server-local calendar date, YYYY-MM-DD. */
export const todayLocal = (): string => (globalThis as any).Temporal.Now.plainDateISO().toString();

export interface MilestoneRow {
  id: string; accountSeq: number; name: string; date: string | null; startDate: string | null; color: string;
  isGlobal: boolean; isPinned: boolean; createdBy: string | null; createdAt: number; projectIds: string[];
}

export function milestoneRow(db: Db, id: string): MilestoneRow | undefined {
  const r = db.prepare('SELECT * FROM milestones WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const m = toCamel<any>(r);
  m.isGlobal = !!m.isGlobal;
  m.isPinned = !!m.isPinned;
  m.projectIds = (db.prepare('SELECT project_id p FROM milestone_projects WHERE milestone_id=? ORDER BY project_id').all(id) as { p: string }[]).map((x) => x.p);
  return m;
}

export const zoneRow = (db: Db, id: string) => {
  const r = db.prepare('SELECT * FROM milestone_zones WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

const progressRow = (db: Db, milestoneId: string, projectId: string, day: string) => {
  const r = db.prepare('SELECT * FROM milestone_progress WHERE milestone_id=? AND project_id=? AND day=?').get(milestoneId, projectId, day) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

/** A milestone covers a project when it is global or lists it. */
export function milestoneCovers(db: Db, milestoneId: string, projectId: string): boolean {
  const m = db.prepare('SELECT is_global g FROM milestones WHERE id=?').get(milestoneId) as { g: number } | undefined;
  if (!m) return false;
  return !!m.g || !!db.prepare('SELECT 1 FROM milestone_projects WHERE milestone_id=? AND project_id=?').get(milestoneId, projectId);
}

/**
 * Upserts today's per-project aggregate rows for these milestones (one aggregate query each, no cards in memory).
 * Counts non-deleted, non-doc cards that sit in a deck; a project that dropped to zero gets a zero row.
 */
export function refreshProgress(ctx: Ctx, milestoneIds: Iterable<string | null | undefined>, day = todayLocal()): void {
  const { db } = ctx;
  for (const mid of new Set(milestoneIds)) {
    if (!mid) continue;
    if (!db.prepare('SELECT 1 FROM milestones WHERE id=?').get(mid)) continue;
    const agg = db.prepare(
      `SELECT d.project_id p, COUNT(*) t, SUM(c.status='done') dn, COALESCE(SUM(c.effort),0) te,
              COALESCE(SUM(CASE WHEN c.status='done' THEN c.effort END),0) de
       FROM cards c JOIN decks d ON d.id=c.deck_id
       WHERE c.milestone_id=? AND c.visibility!='deleted' AND c.is_doc=0 GROUP BY d.project_id`).all(mid) as
      { p: string; t: number; dn: number; te: number; de: number }[];
    const byProject = new Map(agg.map((r) => [r.p, r]));
    const had = (db.prepare('SELECT project_id p FROM milestone_progress WHERE milestone_id=? AND day=?').all(mid, day) as { p: string }[]).map((r) => r.p);
    for (const p of new Set([...byProject.keys(), ...had])) {
      const r = byProject.get(p) ?? { t: 0, dn: 0, te: 0, de: 0 };
      const before = progressRow(db, mid, p, day);
      if (before && before.totalCount === r.t && before.doneCount === r.dn && before.totalEffort === r.te && before.doneEffort === r.de) continue;
      db.prepare(
        `INSERT INTO milestone_progress (milestone_id, project_id, day, total_count, done_count, total_effort, done_effort) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(milestone_id, project_id, day) DO UPDATE SET total_count=excluded.total_count, done_count=excluded.done_count,
           total_effort=excluded.total_effort, done_effort=excluded.done_effort`).run(mid, p, day, r.t, r.dn, r.te, r.de);
      ctx.emit('milestoneProgress', 'upsert', progressRow(db, mid, p, day)!);
    }
  }
}

/** Queue a milestone for one recount just before commit (contexts without a queue recount at once). */
export function markMilestone(ctx: Ctx, id: string | null | undefined): void {
  if (!id) return;
  if (ctx.dirtyMilestones) ctx.dirtyMilestones.add(id);
  else refreshProgress(ctx, [id]);
}

/** Recounts every queued milestone once; called inside the transaction, right before commit. */
export function flushProgress(ctx: Ctx): void {
  if (!ctx.dirtyMilestones?.size) return;
  const ids = [...ctx.dirtyMilestones];
  ctx.dirtyMilestones.clear();
  refreshProgress(ctx, ids);
}

/** Resolve a card's new milestone/zone against its project; returns the values to store. Throws on violations. */
export function resolveCardMilestone(db: Db, projectId: string | null, cur: { milestoneId: string | null; zoneId: string | null },
  input: { milestoneId?: string | null; milestoneZoneId?: string | null }): { milestoneId: string | null; zoneId: string | null } {
  let milestoneId = input.milestoneId === undefined ? cur.milestoneId : input.milestoneId;
  let zoneId = input.milestoneZoneId === undefined ? cur.zoneId : input.milestoneZoneId;
  if (milestoneId) {
    if (!db.prepare('SELECT 1 FROM milestones WHERE id=?').get(milestoneId)) throw new AppError(404, 'not_found');
    if (!projectId || !milestoneCovers(db, milestoneId, projectId)) {
      // A move to a project the milestone doesn't cover quietly leaves it; an explicit assignment is an error.
      if (input.milestoneId) throw new AppError(400, 'milestone_project');
      milestoneId = null;
    }
  }
  if (input.milestoneZoneId && !milestoneId) throw new AppError(400, 'invalid_zone');
  if (milestoneId !== cur.milestoneId && input.milestoneZoneId === undefined) zoneId = null;
  if (!milestoneId) zoneId = null;
  if (zoneId) {
    const z = zoneRow(db, zoneId);
    if (!z || z.milestoneId !== milestoneId) throw new AppError(400, 'invalid_zone');
  }
  return { milestoneId, zoneId };
}

export const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s, 'bad date');
const body = {
  name: z.string().trim().min(1).max(200),
  date: dayStr.nullable(),
  startDate: dayStr.nullable(),
  color: z.enum(colors),
  isGlobal: z.boolean(),
  projectIds: z.array(z.string()).max(500),
};
const bodySchema = z.object(body).refine((b) => !b.date || !b.startDate || b.startDate <= b.date, 'start after date');

export function assertEnabled(db: Db): void {
  if ((accountRow(db).settings as { milestonesEnabled?: boolean }).milestonesEnabled === false) throw new AppError(409, 'feature_disabled');
}

/** Whoever may change this scope: account.manage for global, project.manage on every listed project otherwise. */
export function assertManage(ctx: Ctx, isGlobal: boolean, projectIds: string[]): void {
  const { db, actor } = ctx;
  if (isGlobal) return assertCan(db, actor, 'account.manage');
  if (projectIds.length === 0) throw new AppError(400, 'project_required');
  for (const p of projectIds) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(p)) throw new AppError(400, 'invalid_payload', { field: 'projectIds' });
    assertCan(db, actor, 'project.manage', p);
  }
}

function writeProjects(db: Db, id: string, isGlobal: boolean, projectIds: string[]): void {
  db.prepare('DELETE FROM milestone_projects WHERE milestone_id=?').run(id);
  if (!isGlobal) for (const p of new Set(projectIds)) db.prepare('INSERT INTO milestone_projects (milestone_id, project_id) VALUES (?,?)').run(id, p);
}

function loadManaged(ctx: Ctx, id: string): MilestoneRow {
  const m = milestoneRow(ctx.db, id);
  if (!m) throw new AppError(404, 'not_found');
  assertManage(ctx, m.isGlobal, m.projectIds);
  return m;
}

/**
 * Zones may be edited by anyone who can edit content in a covered project (any project, when global). A project-confined
 * token edits zones only of a non-global milestone whose every covered project it may edit (zones are shared by all).
 */
function assertZoneAccess(ctx: Ctx, m: MilestoneRow): void {
  const { db, actor } = ctx;
  if (projectConfined(actor) && (m.isGlobal || !m.projectIds.every((p) => can(db, actor, 'content.edit', p)))) throw new AppError(403, 'forbidden');
  const ids = m.isGlobal ? (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id) : m.projectIds;
  if (!ids.some((p) => can(db, actor, 'content.edit', p))) throw new AppError(403, 'forbidden');
}

function emitMilestone(ctx: Ctx, id: string): void {
  ctx.emit('milestone', 'upsert', milestoneRow(ctx.db, id)!);
}

export const milestoneCommands: Record<string, Command> = {
  'milestones/create': {
    schema: bodySchema,
    run(ctx, input) {
      const { db, actor } = ctx;
      assertEnabled(db);
      assertManage(ctx, input.isGlobal, input.projectIds);
      db.prepare('UPDATE account SET plan_seq = plan_seq + 1').run();
      const seq = (db.prepare('SELECT plan_seq s FROM account').get() as { s: number }).s;
      const id = newId();
      db.prepare('INSERT INTO milestones (id, account_seq, name, date, start_date, color, is_global, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, seq, input.name, input.date, input.startDate, input.color, input.isGlobal ? 1 : 0, actor.id, Date.now());
      writeProjects(db, id, input.isGlobal, input.projectIds);
      emitMilestone(ctx, id);
      return { id, accountSeq: seq };
    },
  },
  'milestones/update': {
    schema: z.object({ id: z.string(), ...body }).refine((b) => !b.date || !b.startDate || b.startDate <= b.date, 'start after date'),
    run(ctx, input) {
      const { db } = ctx;
      assertEnabled(db);
      const old = loadManaged(ctx, input.id);
      assertManage(ctx, input.isGlobal, input.projectIds);
      db.prepare('UPDATE milestones SET name=?, date=?, start_date=?, color=?, is_global=? WHERE id=?')
        .run(input.name, input.date, input.startDate, input.color, input.isGlobal ? 1 : 0, input.id);
      writeProjects(db, input.id, input.isGlobal, input.projectIds);
      // Cards in projects the milestone no longer covers leave it.
      // No per-card events: clients apply the same rule from the milestone's new projectIds.
      if (!input.isGlobal) {
        db.prepare(
          `UPDATE cards SET milestone_id=NULL, milestone_zone_id=NULL WHERE milestone_id=?
           AND deck_id IN (SELECT id FROM decks WHERE project_id NOT IN (SELECT project_id FROM milestone_projects WHERE milestone_id=?))`).run(input.id, input.id);
      }
      // Viewers who lose sight of it drop their copy first.
      if (old.isGlobal !== input.isGlobal || old.projectIds.some((p) => !input.projectIds.includes(p))) ctx.emit('milestone', 'remove', old);
      markMilestone(ctx, input.id);
      // Scope shrank: the 'remove' above tells viewers who lose it; those who keep it get the upsert in the same batch.
      emitMilestone(ctx, input.id);
    },
  },
  'milestones/delete': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const m = loadManaged(ctx, id);
      db.prepare('DELETE FROM milestones WHERE id=?').run(id);
      // The FKs cleared the cards' milestone and zone. No per-card events: clients clear them (and drop zones and progress) on this remove.
      ctx.emit('milestone', 'remove', m);
    },
  },
  'milestones/setPinned': {
    schema: z.object({ id: z.string(), isPinned: z.boolean() }),
    run(ctx, { id, isPinned }) {
      assertEnabled(ctx.db);
      loadManaged(ctx, id);
      ctx.db.prepare('UPDATE milestones SET is_pinned=? WHERE id=?').run(isPinned ? 1 : 0, id);
      emitMilestone(ctx, id);
    },
  },
  'milestoneZones/create': {
    schema: z.object({ milestoneId: z.string(), name: z.string().trim().min(1).max(200) }),
    run(ctx, { milestoneId, name }) {
      const { db } = ctx;
      assertEnabled(db);
      const m = milestoneRow(db, milestoneId);
      if (!m) throw new AppError(404, 'not_found');
      assertZoneAccess(ctx, m);
      const next = ((db.prepare('SELECT MAX(sort_index) m FROM milestone_zones WHERE milestone_id=?').get(milestoneId) as { m: number | null }).m ?? 0) + 1;
      const id = newId();
      db.prepare('INSERT INTO milestone_zones (id, milestone_id, name, sort_index) VALUES (?,?,?,?)').run(id, milestoneId, name, next);
      ctx.emit('milestoneZone', 'upsert', zoneRow(db, id)!);
      return { id };
    },
  },
  'milestoneZones/update': {
    schema: z.object({ id: z.string(), name: z.string().trim().min(1).max(200) }),
    run(ctx, { id, name }) {
      const { db } = ctx;
      assertEnabled(db);
      const z = zoneRow(db, id);
      if (!z) throw new AppError(404, 'not_found');
      assertZoneAccess(ctx, milestoneRow(db, z.milestoneId)!);
      db.prepare('UPDATE milestone_zones SET name=? WHERE id=?').run(name, id);
      ctx.emit('milestoneZone', 'upsert', zoneRow(db, id)!);
    },
  },
  'milestoneZones/delete': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const z = zoneRow(db, id);
      if (!z) throw new AppError(404, 'not_found');
      assertZoneAccess(ctx, milestoneRow(db, z.milestoneId)!);
      db.prepare('DELETE FROM milestone_zones WHERE id=?').run(id);
      // The FK cleared the cards' zone; clients clear it on this remove.
      ctx.emit('milestoneZone', 'remove', { id, milestoneId: z.milestoneId });
    },
  },
};

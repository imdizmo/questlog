import { z } from 'zod';
import { newId, toCamel } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { accountRow } from './rows';
import { addDays, colors, runEndsAt, runLabel, runWindow } from '../../shared/schedule';
import { assertManage, dayStr, todayLocal } from './milestones';
import type { Command, Ctx } from '../dispatch';

export const MOVE_KINDS = ['review', 'blocked', 'undone'] as const;

export interface SprintConfigRow {
  id: string; name: string; runLabelTemplate: string; color: string; upcoming: number; durationWeeks: number; startDay: string;
  moveOnFinish: string[]; isGlobal: boolean; endHour: number; endTz: string; createdBy: string | null; createdAt: number; isArchived: boolean;
  projectIds: string[];
}

export function configRow(db: Db, id: string): SprintConfigRow | undefined {
  const r = db.prepare('SELECT * FROM sprint_configs WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const c = toCamel<any>(r);
  c.isGlobal = !!c.isGlobal;
  c.projectIds = (db.prepare('SELECT project_id p FROM sprint_config_projects WHERE config_id=? ORDER BY project_id').all(id) as { p: string }[]).map((x) => x.p);
  return c;
}

export function sprintRow(db: Db, id: string) {
  const r = db.prepare('SELECT * FROM sprints WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const s = toCamel<any>(r);
  s.isFinished = !!s.isFinished;
  return s;
}

const progressRow = (db: Db, sprintId: string, projectId: string, day: string) => {
  const r = db.prepare('SELECT * FROM sprint_progress WHERE sprint_id=? AND project_id=? AND day=?').get(sprintId, projectId, day) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

export function assertEnabled(db: Db): void {
  if ((accountRow(db).settings as { sprintsEnabled?: boolean }).sprintsEnabled === false) throw new AppError(409, 'feature_disabled');
}

/** A config covers a project when it is global or lists it. */
export function configCovers(db: Db, configId: string, projectId: string): boolean {
  const c = db.prepare('SELECT is_global g FROM sprint_configs WHERE id=?').get(configId) as { g: number } | undefined;
  if (!c) return false;
  return !!c.g || !!db.prepare('SELECT 1 FROM sprint_config_projects WHERE config_id=? AND project_id=?').get(configId, projectId);
}

export function sprintCovers(db: Db, sprintId: string, projectId: string): boolean {
  const s = db.prepare('SELECT config_id c FROM sprints WHERE id=?').get(sprintId) as { c: string } | undefined;
  return !!s && configCovers(db, s.c, projectId);
}

/** Upserts today's per-project aggregate rows for these runs; same shape as the milestone refresh. */
export function refreshSprintProgress(ctx: Ctx, sprintIds: Iterable<string | null | undefined>, day = todayLocal()): void {
  const { db } = ctx;
  for (const sid of new Set(sprintIds)) {
    if (!sid) continue;
    if (!db.prepare('SELECT 1 FROM sprints WHERE id=?').get(sid)) continue;
    const agg = db.prepare(
      `SELECT d.project_id p, COUNT(*) t, SUM(c.status='done') dn, COALESCE(SUM(c.effort),0) te,
              COALESCE(SUM(CASE WHEN c.status='done' THEN c.effort END),0) de
       FROM cards c JOIN decks d ON d.id=c.deck_id
       WHERE c.sprint_id=? AND c.visibility!='deleted' AND c.is_doc=0 GROUP BY d.project_id`).all(sid) as
      { p: string; t: number; dn: number; te: number; de: number }[];
    const byProject = new Map(agg.map((r) => [r.p, r]));
    const had = (db.prepare('SELECT project_id p FROM sprint_progress WHERE sprint_id=? AND day=?').all(sid, day) as { p: string }[]).map((r) => r.p);
    for (const p of new Set([...byProject.keys(), ...had])) {
      const r = byProject.get(p) ?? { t: 0, dn: 0, te: 0, de: 0 };
      const before = progressRow(db, sid, p, day);
      if (before && before.totalCount === r.t && before.doneCount === r.dn && before.totalEffort === r.te && before.doneEffort === r.de) continue;
      db.prepare(
        `INSERT INTO sprint_progress (sprint_id, project_id, day, total_count, done_count, total_effort, done_effort) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(sprint_id, project_id, day) DO UPDATE SET total_count=excluded.total_count, done_count=excluded.done_count,
           total_effort=excluded.total_effort, done_effort=excluded.done_effort`).run(sid, p, day, r.t, r.dn, r.te, r.de);
      ctx.emit('sprintProgress', 'upsert', progressRow(db, sid, p, day)!);
    }
  }
}

/** Queue a run for one recount just before commit (contexts without a queue recount at once). */
export function markSprint(ctx: Ctx, id: string | null | undefined): void {
  if (!id) return;
  if (ctx.dirtySprints) ctx.dirtySprints.add(id);
  else refreshSprintProgress(ctx, [id]);
}

export function flushSprintProgress(ctx: Ctx): void {
  if (!ctx.dirtySprints?.size) return;
  const ids = [...ctx.dirtySprints];
  ctx.dirtySprints.clear();
  refreshSprintProgress(ctx, ids);
}

/** Resolve a card's new run against its project; returns the id to store. Throws on violations. */
export function resolveCardSprint(db: Db, projectId: string | null, cur: string | null, input: { sprintId?: string | null }): string | null {
  let sprintId = input.sprintId === undefined ? cur : input.sprintId;
  if (sprintId) {
    if (!db.prepare('SELECT 1 FROM sprints WHERE id=?').get(sprintId)) throw new AppError(404, 'not_found');
    if (!projectId || !sprintCovers(db, sprintId, projectId)) {
      // A move to a project the run's config doesn't cover quietly leaves it; an explicit assignment is an error.
      if (input.sprintId) throw new AppError(400, 'sprint_project');
      sprintId = null;
    }
  }
  return sprintId;
}

const next = (db: Db): number => {
  db.prepare('UPDATE account SET plan_seq = plan_seq + 1').run();
  return (db.prepare('SELECT plan_seq s FROM account').get() as { s: number }).s;
};

/** Adds unfinished runs until the config has `upcoming` of them (archived configs get none). */
export function topUpRuns(ctx: Ctx, configId: string): void {
  const { db } = ctx;
  const cfg = configRow(db, configId);
  if (!cfg || cfg.isArchived) return;
  const open = (db.prepare('SELECT COUNT(*) n FROM sprints WHERE config_id=? AND is_finished=0').get(configId) as { n: number }).n;
  for (let i = open; i < cfg.upcoming; i++) appendRun(ctx, cfg);
}

/** Creates the run after the config's last one; each starts the day after the previous ends. */
export function appendRun(ctx: Ctx, cfg: SprintConfigRow): { id: string; accountSeq: number } {
  const { db } = ctx;
  const last = db.prepare('SELECT run_nr n, end_day e FROM sprints WHERE config_id=? ORDER BY run_nr DESC LIMIT 1').get(cfg.id) as { n: number; e: string } | undefined;
  const nr = (last?.n ?? 0) + 1;
  const w = runWindow(last ? addDays(last.e, 1) : cfg.startDay, 1, cfg.durationWeeks);
  const seq = next(db);
  const id = newId();
  db.prepare('INSERT INTO sprints (id, config_id, account_seq, run_nr, label, start_day, end_day, ends_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, cfg.id, seq, nr, runLabel(cfg.runLabelTemplate, nr), w.startDay, w.endDay, runEndsAt(w.endDay, cfg.endHour, cfg.endTz));
  ctx.emit('sprint', 'upsert', sprintRow(db, id)!);
  return { id, accountSeq: seq };
}

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];
const UPCOMING = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
const oneOf = (set: number[]) => z.number().int().refine((n) => set.includes(n), 'not an allowed value');

/** Wire shape (the names clients send); `norm` maps it to the internal field names. */
const wire = {
  name: z.string().trim().regex(/^\p{L}{1,5}$/u, 'name must be 1-5 letters'),
  runLabelTemplate: z.string().trim().min(1).max(100).refine((t) => t.includes('%RUN_NR%'), 'Add at least one variable'),
  color: z.enum(colors),
  upcomingSprints: oneOf(UPCOMING),
  sprintDurationWeeks: oneOf(WEEKS),
  sprintStartDate: dayStr,
  moveOnFinish: z.array(z.enum(MOVE_KINDS)).max(3),
  isGlobal: z.boolean(),
  projectIds: z.array(z.string()).max(500),
  endHour: z.number().int().min(1).max(24).default(24),
  endHourTimezone: z.string().min(1).max(64).default('UTC').refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'bad time zone'),
};
const norm = (w: z.infer<z.ZodObject<typeof wire>>) => ({
  name: w.name, runLabelTemplate: w.runLabelTemplate, color: w.color, upcoming: w.upcomingSprints, durationWeeks: w.sprintDurationWeeks,
  startDay: w.sprintStartDate, moveOnFinish: [...new Set(w.moveOnFinish)], isGlobal: w.isGlobal, projectIds: w.projectIds, endHour: w.endHour, endTz: w.endHourTimezone,
});

/** A start date more than a year back would make catch-up generate runs for a long time. */
function assertStartDay(day: string): void {
  if (day < addDays(todayLocal(), -366)) throw new AppError(400, 'invalid_payload', { field: 'sprintStartDate' });
}

function writeProjects(db: Db, id: string, isGlobal: boolean, projectIds: string[]): void {
  db.prepare('DELETE FROM sprint_config_projects WHERE config_id=?').run(id);
  if (!isGlobal) for (const p of new Set(projectIds)) db.prepare('INSERT INTO sprint_config_projects (config_id, project_id) VALUES (?,?)').run(id, p);
}

function loadManaged(ctx: Ctx, id: string): SprintConfigRow {
  const c = configRow(ctx.db, id);
  if (!c) throw new AppError(404, 'not_found');
  assertManage(ctx, c.isGlobal, c.projectIds);
  return c;
}

const emitConfig = (ctx: Ctx, id: string) => ctx.emit('sprintConfig', 'upsert', configRow(ctx.db, id)!);

export const sprintCommands: Record<string, Command> = {
  'sprints/createConfig': {
    schema: z.object(wire).transform(norm),
    run(ctx, input) {
      const { db, actor } = ctx;
      assertEnabled(db);
      assertManage(ctx, input.isGlobal, input.projectIds);
      assertStartDay(input.startDay);
      const id = newId();
      db.prepare(
        `INSERT INTO sprint_configs (id, name, run_label_template, color, upcoming, duration_weeks, start_day, move_on_finish_json, is_global, end_hour, end_tz, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.name, input.runLabelTemplate, input.color, input.upcoming, input.durationWeeks, input.startDay, JSON.stringify(input.moveOnFinish),
          input.isGlobal ? 1 : 0, input.endHour, input.endTz, actor.id, Date.now());
      writeProjects(db, id, input.isGlobal, input.projectIds);
      emitConfig(ctx, id);
      const cfg = configRow(db, id)!;
      const sprints = [];
      for (let i = 0; i < cfg.upcoming; i++) sprints.push(appendRun(ctx, cfg));
      return { id, sprints };
    },
  },
  'sprints/updateConfig': {
    schema: z.object({ id: z.string(), ...wire }).transform((w) => ({ id: w.id, ...norm(w) })),
    run(ctx, input) {
      const { db } = ctx;
      assertEnabled(db);
      const old = loadManaged(ctx, input.id);
      assertManage(ctx, input.isGlobal, input.projectIds);
      if (input.startDay !== old.startDay) assertStartDay(input.startDay);
      db.prepare(
        `UPDATE sprint_configs SET name=?, run_label_template=?, color=?, upcoming=?, duration_weeks=?, start_day=?, move_on_finish_json=?, is_global=?, end_hour=?, end_tz=? WHERE id=?`)
        .run(input.name, input.runLabelTemplate, input.color, input.upcoming, input.durationWeeks, input.startDay, JSON.stringify(input.moveOnFinish),
          input.isGlobal ? 1 : 0, input.endHour, input.endTz, input.id);
      writeProjects(db, input.id, input.isGlobal, input.projectIds);
      if (!input.isGlobal) {
        // Cards in projects the config no longer covers leave its runs; clients apply the same rule from the new projectIds.
        const cond = `sprint_id IN (SELECT id FROM sprints WHERE config_id=?)
           AND deck_id IN (SELECT id FROM decks WHERE project_id NOT IN (SELECT project_id FROM sprint_config_projects WHERE config_id=?))`;
        const hit = (db.prepare(`SELECT DISTINCT sprint_id s FROM cards WHERE ${cond}`).all(input.id, input.id) as { s: string }[]).map((r) => r.s);
        db.prepare(`UPDATE cards SET sprint_id=NULL, carry_count=0, sprint_joined_at=NULL WHERE ${cond}`).run(input.id, input.id);
        for (const sid of hit) markSprint(ctx, sid);
      }
      // Viewers who lose sight of it drop their copy first.
      if (old.isGlobal !== input.isGlobal || old.projectIds.some((p) => !input.projectIds.includes(p))) ctx.emit('sprintConfig', 'remove', old);
      // Unstarted, unfinished runs are re-timed in order, each starting the day after the one before.
      const today: string = (globalThis as any).Temporal.Now.plainDateISO(input.endTz).toString();
      const rows = db.prepare('SELECT * FROM sprints WHERE config_id=? ORDER BY run_nr').all(input.id) as any[];
      let prevEnd: string | null = null;
      for (const r of rows) {
        if (!r.is_finished && r.start_day > today) {
          const w = runWindow(prevEnd ? addDays(prevEnd, 1) : input.startDay, 1, input.durationWeeks);
          db.prepare('UPDATE sprints SET label=?, start_day=?, end_day=?, ends_at=? WHERE id=?')
            .run(runLabel(input.runLabelTemplate, r.run_nr), w.startDay, w.endDay, runEndsAt(w.endDay, input.endHour, input.endTz), r.id);
          prevEnd = w.endDay;
        } else prevEnd = r.end_day;
      }
      emitConfig(ctx, input.id);
      for (const r of rows) ctx.emit('sprint', 'upsert', sprintRow(db, r.id)!);
      topUpRuns(ctx, input.id);
    },
  },
  'sprints/archiveConfig': {
    schema: z.object({ id: z.string() }),
    run(ctx, { id }) {
      loadManaged(ctx, id);
      ctx.db.prepare('UPDATE sprint_configs SET is_archived=1 WHERE id=?').run(id);
      emitConfig(ctx, id);
    },
  },
};

import { toCamel } from '../db';
import type { Db } from '../db';
import { MAX_SEGMENT_MS } from '../../shared/duration';
import type { TimeSegment } from '../../shared/types';
import type { Ctx } from '../dispatch';

/** One segment is at most a day long; the 8 h timer cap is a job (runTimerCap). */
export { MAX_SEGMENT_MS };
/** A timer left running is stopped after this long. */
export const TIMER_CAP_MS = 8 * 3600e3;

export const shape = (r: Record<string, unknown>): TimeSegment => {
  const { durationMs, ...rest } = toCamel<any>(r);
  return { ...rest, durationInMs: durationMs ?? null };
};

export function segmentRow(db: Db, id: string): TimeSegment | undefined {
  const r = db.prepare('SELECT * FROM time_segments WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r ? shape(r) : undefined;
}

function stopWhere(ctx: Ctx, where: string, arg: string, at: number): void {
  const { db } = ctx;
  const run = db.prepare(`SELECT id FROM time_segments WHERE ${where}=? AND duration_ms IS NULL`).all(arg) as { id: string }[];
  for (const { id } of run) {
    db.prepare('UPDATE time_segments SET duration_ms=MIN(MAX(0, ?-started_at), ?) WHERE id=?').run(at, TIMER_CAP_MS, id);
    ctx.emit('timeSegment', 'upsert', segmentRow(db, id)!);
  }
}

/** Stops the user's running segment (if any) at `at`. */
export const stopRunning = (ctx: Ctx, userId: string, at: number): void => stopWhere(ctx, 'user_id', userId, at);

/** Stops every running segment on the card (it became done, archived or deleted). */
export const stopCardTimers = (ctx: Ctx, cardId: string, at: number = Date.now()): void => stopWhere(ctx, 'card_id', cardId, at);

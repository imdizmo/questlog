import { z } from 'zod';
import { newId } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { assertCan } from '../permissions';
import { recordHistory } from '../history';
import { assertCardInTokenScope, cardProjectId } from '../access';
import { now as clockNow } from '../auth';
import { accountRow, cardRow } from './rows';
import { assertFeature } from '../billing';
import { applyTransition, assertAssignee, assertCardAccess, assertNotDeleted, emitCard, isHeroCard } from './cards';
import { handSyncOwner } from './hand';
import type { Command, Ctx } from '../dispatch';
import { MAX_SEGMENT_MS, TIMER_CAP_MS, segmentRow, shape, stopRunning } from './timers';
import type { HistoryChange, TimeSegment } from '../../shared/types';

export { MAX_SEGMENT_MS, TIMER_CAP_MS, segmentRow, shape, stopRunning };

/** Remove events carry cardId (and userId), so the hub can route them after the row is gone. */
const emitRemove = (ctx: Ctx, s: TimeSegment) => ctx.emit('timeSegment', 'remove', { id: s.id, cardId: s.cardId, userId: s.userId });

function assertEnabled(db: Db): void {
  if ((accountRow(db).settings as { timeTrackingMode?: string | null }).timeTrackingMode == null) throw new AppError(409, 'feature_disabled', { feature: 'timeTracking' });
}

const FUTURE_SLACK_MS = 60_000;
const durationSchema = z.number().int().gt(0).max(MAX_SEGMENT_MS);

export const timeCommands: Record<string, Command> = {
  'timeTracking/start': {
    schema: z.object({ userId: z.string(), cardId: z.string() }),
    run(ctx, input: { userId: string; cardId: string }) {
      const { db, actor } = ctx;
      assertEnabled(db);
      assertFeature(db, 'timeTracking');
      if (input.userId !== actor.id) throw new AppError(403, 'forbidden');
      const card = cardRow(db, input.cardId);
      if (!card) throw new AppError(404, 'not_found');
      assertCardAccess(ctx, card);
      assertNotDeleted(card);
      // A hero's work is its sub cards' work; time goes on those.
      if (isHeroCard(db, card.id as string)) throw new AppError(409, 'invalid_transition', { id: card.id });
      const at = clockNow();
      // Already timing a card that is still started: nothing to do. Otherwise it goes through the transition (e.g. done gives 409).
      const same = db.prepare('SELECT id FROM time_segments WHERE user_id=? AND card_id=? AND duration_ms IS NULL').get(actor.id, card.id as string) as { id: string } | undefined;
      if (same && card.status === 'started') return { id: same.id };
      // Starting stops the user's other running timers: a confined token may only do that on cards it can see.
      for (const r of db.prepare('SELECT card_id c FROM time_segments WHERE user_id=? AND duration_ms IS NULL').all(actor.id) as { c: string }[]) {
        if (r.c !== card.id) assertCardInTokenScope(db, actor, r.c);
      }
      stopRunning(ctx, actor.id, at);
      // Starting the timer starts the card through the normal rules (hero, guardians, Hand slot, done pile...).
      const changes: HistoryChange[] = card.status !== 'started' ? applyTransition(ctx, card, { status: 'started' }) : [];
      let ownerSet = false;
      if (card.status === 'started' && !card.assigneeId) {
        assertAssignee(db, actor.id, cardProjectId(db, card.id as string));
        db.prepare('UPDATE cards SET assignee_id=? WHERE id=?').run(actor.id, card.id);
        changes.push({ kind: 'owner', from: null, to: actor.id });
        ownerSet = true;
      }
      if (changes.length) recordHistory(db, card.id as string, actor.id, changes);
      if (ownerSet) handSyncOwner(ctx, card.id as string);
      const id = newId();
      db.prepare('INSERT INTO time_segments (id, card_id, user_id, started_at, duration_ms, created_at) VALUES (?,?,?,?,NULL,?)').run(id, card.id, actor.id, at, at);
      if (changes.length) emitCard(ctx, card.id as string);
      ctx.emit('timeSegment', 'upsert', segmentRow(db, id)!);
      return { id };
    },
  },
  'timeTracking/stop': {
    schema: z.object({ id: z.string() }),
    run(ctx, input: { id: string }) {
      const { db, actor } = ctx;
      const s = segmentRow(db, input.id);
      if (!s) throw new AppError(404, 'not_found');
      if (s.userId !== actor.id) throw new AppError(403, 'forbidden');
      assertCardInTokenScope(db, actor, s.cardId);
      if (s.durationInMs !== null) throw new AppError(409, 'not_running');
      db.prepare('UPDATE time_segments SET duration_ms=MIN(MAX(0, ?-started_at), ?) WHERE id=?').run(clockNow(), TIMER_CAP_MS, s.id);
      ctx.emit('timeSegment', 'upsert', segmentRow(db, s.id)!);
      return {};
    },
  },
  'timeTracking/create': {
    schema: z.object({ startedAt: z.number().int().nonnegative(), durationInMs: durationSchema, cardId: z.string(), userId: z.string() }),
    run(ctx, input: { startedAt: number; durationInMs: number; cardId: string; userId: string }) {
      const { db, actor } = ctx;
      assertEnabled(db);
      assertFeature(db, 'timeTracking');
      const card = cardRow(db, input.cardId);
      if (!card) throw new AppError(404, 'not_found');
      assertCardAccess(ctx, card);
      assertNotDeleted(card);
      const projectId = cardProjectId(db, card.id as string);
      // Booking time for someone else is a manager's call.
      if (input.userId !== actor.id) assertCan(db, actor, projectId ? 'project.manage' : 'account.manage', projectId ?? undefined);
      assertAssignee(db, input.userId, projectId);
      // Booked time is past time: it may not end later than a minute from now.
      if (input.startedAt + input.durationInMs > clockNow() + FUTURE_SLACK_MS) throw new AppError(400, 'invalid_input', { field: 'startedAt' });
      const id = newId();
      db.prepare('INSERT INTO time_segments (id, card_id, user_id, started_at, duration_ms, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, card.id, input.userId, input.startedAt, input.durationInMs, clockNow());
      recordHistory(db, card.id as string, actor.id, [{ kind: 'time', to: input.durationInMs }]);
      emitCard(ctx, card.id as string);
      ctx.emit('timeSegment', 'upsert', segmentRow(db, id)!);
      return { id };
    },
  },
  'timeTracking/delete': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, input: { id: string }) {
      const { db, actor } = ctx;
      assertEnabled(db);
      const s = segmentRow(db, input.id);
      if (!s) throw new AppError(404, 'not_found');
      const card = cardRow(db, s.cardId);
      if (!card || card.visibility === 'deleted') throw new AppError(404, 'not_found');
      assertCardAccess(ctx, card);
      if (s.userId !== actor.id) {
        const projectId = cardProjectId(db, s.cardId);
        assertCan(db, actor, projectId ? 'project.manage' : 'account.manage', projectId ?? undefined);
      }
      db.prepare('DELETE FROM time_segments WHERE id=?').run(s.id);
      if (s.durationInMs !== null) {
        recordHistory(db, s.cardId, actor.id, [{ kind: 'time', from: s.durationInMs }]);
        emitCard(ctx, s.cardId);
      }
      emitRemove(ctx, s);
      return {};
    },
  },
};

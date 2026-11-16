import { z } from 'zod';
import { AppError } from '../errors';
import { QUEST_STEP_KEYS } from '../../shared/quests';
import type { Command } from '../dispatch';
import type { Db } from '../db';

const MAX_INFO_BYTES = 1000;
const info = z.record(z.string().max(40), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 10, 'too many keys');

export const onboardingRow = (db: Db, userId: string, step: string) => {
  const r = db.prepare('SELECT step, info_json i, completed_at c FROM user_onboarding WHERE user_id=? AND step=?').get(userId, step) as { step: string; i: string | null; c: number } | undefined;
  return r && { userId, step: r.step, stepInfo: r.i ? JSON.parse(r.i) : null, completedAt: r.c };
};

export const onboardingCommands: Record<string, Command> = {
  /** Records that I completed a card step. Idempotent: the first completion stays, later ones change nothing. */
  'onboarding/progress': {
    schema: z.object({ step: z.string().refine((s) => QUEST_STEP_KEYS.has(s), 'unknown step'), stepInfo: info.optional() }),
    run(ctx, input) {
      const text = input.stepInfo ? JSON.stringify(input.stepInfo) : null;
      if (text && text.length > MAX_INFO_BYTES) throw new AppError(400, 'invalid_payload', { field: 'stepInfo' });
      const r = ctx.db.prepare('INSERT OR IGNORE INTO user_onboarding (user_id, step, info_json, completed_at) VALUES (?,?,?,?)')
        .run(ctx.actor.id, input.step, text, Date.now());
      const isNew = Number(r.changes) > 0;
      if (isNew) ctx.emit('onboardingStep', 'upsert', onboardingRow(ctx.db, ctx.actor.id, input.step)!);
      return { step: input.step, isNew };
    },
  },
};

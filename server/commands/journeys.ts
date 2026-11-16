import { z } from 'zod';
import { newId } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { assertCan } from '../permissions';
import { accountRow, deckRow } from './rows';
import { assertAssignee, assertNotDeleted, cardCommands, effortSchema, loadCard, prioritySchema } from './cards';
import type { Command, Ctx } from '../dispatch';
import type { Journey, JourneyStep } from '../../shared/types';

export const MAX_JOURNEY_STEPS = 30;

const stepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  assigneeId: z.string().nullable(),
  priority: prioritySchema.nullable(),
  effort: effortSchema.nullable(),
});

export function journeyRow(db: Db, deckId: string): Journey | undefined {
  const r = db.prepare('SELECT j.id, j.deck_id, j.steps, j.updated_at, d.project_id FROM journeys j JOIN decks d ON d.id=j.deck_id WHERE j.deck_id=?')
    .get(deckId) as { id: string; deck_id: string; steps: string; updated_at: number; project_id: string } | undefined;
  return r && { id: r.id, deckId: r.deck_id, projectId: r.project_id, steps: JSON.parse(r.steps) as JourneyStep[], updatedAt: r.updated_at };
}

function assertEnabled(db: Db): void {
  if ((accountRow(db).settings as { workflowMode?: string | null }).workflowMode !== 'journeys') throw new AppError(409, 'feature_disabled');
}

export const journeyCommands: Record<string, Command> = {
  'journeys/set': {
    schema: z.object({ deckId: z.string(), steps: z.array(stepSchema).max(MAX_JOURNEY_STEPS) }),
    run(ctx: Ctx, { deckId, steps }) {
      const { db, actor } = ctx;
      assertEnabled(db);
      const deck = deckRow(db, deckId);
      if (!deck) throw new AppError(404, 'not_found');
      assertCan(db, actor, 'project.manage', deck.projectId as string);
      const old = journeyRow(db, deckId);
      if (!steps.length) {
        if (old) {
          db.prepare('DELETE FROM journeys WHERE deck_id=?').run(deckId);
          ctx.emit('journey', 'remove', old);
        }
        return;
      }
      for (const s of steps) assertAssignee(db, s.assigneeId, deck.projectId as string);
      if (old) db.prepare('UPDATE journeys SET steps=?, updated_at=? WHERE deck_id=?').run(JSON.stringify(steps), Date.now(), deckId);
      else db.prepare('INSERT INTO journeys (id, deck_id, steps, updated_at) VALUES (?,?,?,?)').run(newId(), deckId, JSON.stringify(steps), Date.now());
      ctx.emit('journey', 'upsert', journeyRow(db, deckId)!);
    },
  },
  'journeys/apply': {
    schema: z.object({ cardId: z.string() }),
    run(ctx: Ctx, { cardId }) {
      const { db } = ctx;
      assertEnabled(db);
      const card = loadCard(ctx, cardId);
      assertNotDeleted(card);
      // A sub card cannot be a hero itself.
      if (card.parentCardId || card.isDoc) throw new AppError(409, 'invalid_hierarchy', { id: cardId });
      const journey = card.deckId ? journeyRow(db, card.deckId as string) : undefined;
      if (!journey) throw new AppError(404, 'not_found');
      const create = cardCommands['cards/create'];
      const cardIds: string[] = [];
      // Each sub card goes through cards/create, so access, history, events and deck automations apply.
      const projectId = deckRow(db, card.deckId as string)!.projectId as string;
      for (const s of journey.steps) {
        // An owner who has lost access since the journey was saved: the sub card is created unowned.
        let assigneeId = s.assigneeId;
        try { assertAssignee(db, assigneeId, projectId); } catch { assigneeId = null; }
        const input = create.schema.parse({
          content: `# ${s.title}`, deckId: card.deckId, parentCardId: cardId,
          assigneeId, priority: s.priority, effort: s.effort,
        });
        cardIds.push((create.run(ctx, input) as { id: string }).id);
      }
      return { cardIds };
    },
  },
};


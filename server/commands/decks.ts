import { z } from 'zod';
import { newId } from '../db';
import { AppError } from '../errors';
import { assertCan, can } from '../permissions';
import { activeGuardians } from '../guardians';
import { assertFeature } from '../billing';
import { projectRow, deckRow, cardRow } from './rows';
import { assertKnownTags, dropCardLinks, reemitDepNeighbours, syncHeroStatus } from './cards';
import type { Space } from '../../shared/types';
import { MAX_SECONDARY, normalizeView, ORDER_PROPS } from '../../shared/order';
import type { Cover } from '../../shared/covers';
import { assertEnabled, markMilestone, milestoneCovers } from './milestones';
import { markSprint } from './sprints';
import { stopCardTimers } from './timers';
import { assertCoverUsable, coverSchema, releaseCover } from '../covers';
import type { Command } from '../dispatch';
import type { Db } from '../db';

const deckType = z.enum(['asset', 'task', 'doc', 'mixed']);

const orderProp = z.enum(ORDER_PROPS as [string, ...string[]]);
const sortKey = z.object({ prop: orderProp, isReversed: z.boolean() });
const deckView = z.object({
  prop: orderProp,
  isReversed: z.boolean(),
  mode: z.enum(['miniCard', 'tableView']),
  secondary: z.array(sortKey).max(MAX_SECONDARY).nullable(),
  isCompact: z.boolean().optional(),
  hideEmpty: z.boolean().optional(),
});
/** The server doesn't know which features a viewer has on, so the stored view is normalised with all of them on. */
const ALL_FEATURES = { milestonesEnabled: true, sprintsEnabled: true, dueDateEnabled: true, timeTrackingOn: true };

const nextSort = (db: Db, projectId: string, spaceId: number) =>
  ((db.prepare('SELECT MAX(sort_index) m FROM decks WHERE project_id=? AND space_id=?').get(projectId, spaceId) as { m: number | null }).m ?? 0) + 1;

export const deckCommands: Record<string, Command> = {
  'decks/create': {
    schema: z.object({ title: z.string().trim().min(1), projectId: z.string(), spaceId: z.number().int().positive().optional(), cover: coverSchema.optional(), coverUrl: z.string().optional() }),
    run(ctx, input) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'content.edit', input.projectId);
      if (input.coverUrl !== undefined) throw new AppError(400, 'invalid_input');
      assertCoverUsable(db, input.projectId, input.cover ?? null);
      const spaces = projectRow(db, input.projectId)!.spaces as Space[];
      const space = input.spaceId === undefined ? spaces[0] : spaces.find((s) => s.id === input.spaceId);
      if (!space) throw new AppError(400, 'invalid_payload', { field: 'spaceId' });
      db.prepare('UPDATE account SET deck_seq = deck_seq + 1').run();
      const seq = (db.prepare('SELECT deck_seq s FROM account').get() as { s: number }).s;
      const id = newId();
      db.prepare('INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,description,sort_index,created_at,cover_json,creator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, seq, input.projectId, space.id, input.title, space.defaultDeckType, '', nextSort(db, input.projectId, space.id), Date.now(),
          input.cover ? JSON.stringify(input.cover) : null, ctx.actor.id);
      ctx.emit('deck', 'upsert', deckRow(db, id)!);
      return { id };
    },
  },
  'decks/update': {
    schema: z.object({
      id: z.string(),
      title: z.string().trim().min(1).optional(),
      deckType: deckType.optional(),
      description: z.string().optional(),
      spaceId: z.number().int().optional(),
      sortIndex: z.number().finite().optional(),
      autoTag: z.string().min(1).nullable().optional(),
      defaultCardId: z.string().min(1).nullable().optional(),
      cover: coverSchema.optional(),
      coverUrl: z.string().optional(),
      guardiansEnabled: z.boolean().optional(),
      guardianIds: z.array(z.string()).max(100).optional(),
      handSyncEnabled: z.boolean().optional(),
      autoMilestoneId: z.string().nullable().optional(),
      preferredOrder: deckView.nullable().optional(),
      publicOrder: deckView.nullable().optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const d = deckRow(db, input.id);
      if (!d) throw new AppError(404, 'not_found');
      assertCan(db, ctx.actor, 'content.edit', d.projectId);
      if (input.coverUrl !== undefined) throw new AppError(400, 'invalid_input');
      const guardianIds: string[] | undefined = input.guardianIds ? [...new Set<string>(input.guardianIds)] : undefined;
      if (input.guardiansEnabled !== undefined || guardianIds) assertCan(db, ctx.actor, 'project.manage', d.projectId);
      // Without the plan feature guardians can be switched off and removed, not switched on or added.
      if (input.guardiansEnabled === true && !d.guardiansEnabled) assertFeature(db, 'guardians');
      // What visitors of the project's Open Decks see first: a project setting, like sharing itself.
      if (input.publicOrder !== undefined) assertCan(db, ctx.actor, 'project.manage', d.projectId);
      if (guardianIds?.length) {
        const had = new Set((db.prepare('SELECT user_id u FROM deck_guardians WHERE deck_id=?').all(input.id) as { u: string }[]).map((r) => r.u));
        if (guardianIds.some((u) => !had.has(u))) assertFeature(db, 'guardians');
      }
      for (const u of guardianIds ?? []) {
        if (!can(db, { id: u }, 'project.view', d.projectId)) throw new AppError(400, 'invalid_user', { userId: u });
      }
      if (input.cover !== undefined) assertCoverUsable(db, d.projectId, input.cover);
      let spaceId = d.spaceId as number;
      let sortIndex = input.sortIndex ?? (d.sortIndex as number);
      if (input.spaceId !== undefined && input.spaceId !== spaceId) {
        const spaces = projectRow(db, d.projectId)!.spaces as Space[];
        if (!spaces.some((s) => s.id === input.spaceId)) throw new AppError(400, 'invalid_payload', { field: 'spaceId' });
        spaceId = input.spaceId;
        if (input.sortIndex === undefined) sortIndex = nextSort(db, d.projectId, spaceId);
      }
      if (input.autoMilestoneId) assertEnabled(db);
      if (input.autoMilestoneId && !milestoneCovers(db, input.autoMilestoneId, d.projectId as string)) {
        const exists = !!db.prepare('SELECT 1 FROM milestones WHERE id=?').get(input.autoMilestoneId);
        throw new AppError(exists ? 400 : 404, exists ? 'milestone_project' : 'not_found');
      }
      if (input.autoTag != null) assertKnownTags(db, d.projectId, [input.autoTag]);
      if (input.defaultCardId != null) {
        const c = cardRow(db, input.defaultCardId);
        if (!c || c.deckId !== input.id || c.visibility !== 'default') throw new AppError(400, 'invalid_payload', { field: 'defaultCardId' });
      }
      db.prepare('UPDATE decks SET title=?, deck_type=?, description=?, space_id=?, sort_index=?, auto_tag=?, default_card_id=?, cover_json=?, guardians_enabled=?, hand_sync_enabled=?, auto_milestone_id=?, preferred_order=?, public_order=? WHERE id=?').run(
        input.title ?? d.title, input.deckType ?? d.deckType, input.description ?? d.description, spaceId, sortIndex,
        input.autoTag === undefined ? d.autoTag : input.autoTag,
        input.defaultCardId === undefined ? d.defaultCardId : input.defaultCardId,
        input.cover === undefined ? (d.cover ? JSON.stringify(d.cover) : null) : input.cover && JSON.stringify(input.cover),
        (input.guardiansEnabled ?? d.guardiansEnabled) ? 1 : 0, (input.handSyncEnabled ?? d.handSyncEnabled) ? 1 : 0,
        input.autoMilestoneId === undefined ? d.autoMilestoneId : input.autoMilestoneId,
        input.preferredOrder === undefined ? (d.preferredOrder ? JSON.stringify(d.preferredOrder) : null) : input.preferredOrder && JSON.stringify(normalizeView(input.preferredOrder, ALL_FEATURES)),
        input.publicOrder === undefined ? (d.publicOrder ? JSON.stringify(d.publicOrder) : null) : input.publicOrder && JSON.stringify(normalizeView(input.publicOrder, ALL_FEATURES)),
        input.id,
      );
      if (guardianIds) {
        const old = (db.prepare('SELECT user_id u FROM deck_guardians WHERE deck_id=?').all(input.id) as { u: string }[]).map((r) => r.u);
        for (const u of old) if (!guardianIds.includes(u)) {
          db.prepare('DELETE FROM deck_guardians WHERE deck_id=? AND user_id=?').run(input.id, u);
          ctx.emit('deckGuardian', 'remove', { deckId: input.id, userId: u, projectId: d.projectId });
        }
        for (const u of guardianIds) if (!old.includes(u)) {
          db.prepare('INSERT INTO deck_guardians (deck_id, user_id) VALUES (?,?)').run(input.id, u);
          ctx.emit('deckGuardian', 'upsert', { deckId: input.id, userId: u, projectId: d.projectId });
        }
      }
      if (input.cover !== undefined) releaseCover(ctx, d.cover as Cover);
      ctx.emit('deck', 'upsert', deckRow(db, input.id)!);
    },
  },
  'decks/delete': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const d = deckRow(db, id);
      if (!d) throw new AppError(404, 'not_found');
      assertCan(db, ctx.actor, 'content.edit', d.projectId);
      // Deleting the deck deletes every card in it, so it is a guardian-only action when guardians are active.
      const guards = activeGuardians(db, id);
      if (guards.length && !guards.includes(ctx.actor.id)) throw new AppError(403, 'guardian_only', { id });
      const cards = db.prepare('SELECT id, parent_card_id p FROM cards WHERE deck_id=?').all(id) as { id: string; p: string | null }[];
      const milestones = (db.prepare('SELECT DISTINCT milestone_id m FROM cards WHERE deck_id=? AND milestone_id IS NOT NULL').all(id) as { m: string }[]).map((r) => r.m);
      const sprints = (db.prepare('SELECT DISTINCT sprint_id s FROM cards WHERE deck_id=? AND sprint_id IS NOT NULL').all(id) as { s: string }[]).map((r) => r.s);
      for (const c of cards) stopCardTimers(ctx, c.id);
      // The cards leave the project (trashed, deckless): their wiki links go, as on any move out.
      for (const c of cards) dropCardLinks(ctx, c.id);
      db.prepare("UPDATE cards SET visibility='deleted', deck_id=NULL WHERE deck_id=?").run(id);
      db.prepare('DELETE FROM decks WHERE id=?').run(id);
      releaseCover(ctx, d.cover as Cover);
      for (const c of cards) ctx.emit('card', 'remove', { id: c.id, projectId: d.projectId });
      const gone = new Set(cards.map((c) => c.id));
      for (const c of cards) reemitDepNeighbours(ctx, c.id, gone);
      // Heroes outside the deck lose these sub cards: their completion is recomputed.
      for (const p of new Set(cards.map((c) => c.p))) if (p && !gone.has(p)) syncHeroStatus(ctx, p);
      for (const m of milestones) markMilestone(ctx, m);
      for (const sp of sprints) markSprint(ctx, sp);
      ctx.emit('deck', 'remove', { id, projectId: d.projectId });
    },
  },
};

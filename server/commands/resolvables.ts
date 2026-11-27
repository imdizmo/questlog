import { z } from 'zod';
import { newId } from '../db';
import { AppError } from '../errors';
import { recordHistory } from '../history';
import { cardRow, entryRow, reactionRow, resolvableRow } from './rows';
import { canSeeCard, cardProjectId } from '../access';
import { allowedActions } from '../../shared/cards';
import { cardDone } from './hand';
import { assertNotDeleted, emitCard, isHeroCard, loadCard, openContexts, reemitDepNeighbours, syncHeroStatus } from './cards';
import { assertGuardianAllows } from '../guardians';
import { onEntry, onEntryEdited, REMIND_AFTER_MS, updateOwn } from '../notifications';
import type { Command, Ctx } from '../dispatch';
import type { HistoryChange } from '../../shared/types';
import { touchTranslation } from '../translate/queue';

/** Cheap emoji-ish guard: no whitespace, no ASCII letters or digits. */
const EMOJI_ISH = /^[^\s A-Za-z0-9]+$/;

/** Entry of an open thread on a live card the actor may edit; 404 / 403 / 409 otherwise. */
function openEntry(ctx: Ctx, entryId: string) {
  const entry = entryRow(ctx.db, entryId);
  if (!entry) throw new AppError(404, 'not_found');
  const resolvable = resolvableRow(ctx.db, entry.resolvableId as string)!;
  assertNotDeleted(loadCard(ctx, resolvable.cardId as string));
  if (resolvable.isClosed) throw new AppError(409, 'invalid_transition', { id: resolvable.id });
  return { entry, resolvable };
}

/** Thread on a live card the actor can VIEW (no edit right needed); 404 otherwise. */
function visibleThread(ctx: Ctx, resolvableId: string) {
  const r = resolvableRow(ctx.db, resolvableId);
  if (!r) throw new AppError(404, 'not_found');
  const card = cardRow(ctx.db, r.cardId as string);
  if (!card || card.visibility === 'deleted'
    || !canSeeCard(ctx.db, ctx.actor, { deckId: card.deckId as string | null, creatorId: card.creatorId as string }, cardProjectId(ctx.db, card.id as string))) {
    throw new AppError(404, 'not_found');
  }
  return r;
}

/** Give the actor a default row so per-user settings have somewhere to live. */
function ensureRow(ctx: Ctx, resolvableId: string): void {
  const now = Date.now();
  ctx.db.prepare('INSERT OR IGNORE INTO resolvable_notifications (user_id,resolvable_id,is_participating,is_muted,unseen_entry_count,unseen_authors_json,created_at,last_updated_at) VALUES (?,?,1,0,0,?,?,?)')
    .run(ctx.actor.id, resolvableId, '[]', now, now);
}

export const resolvableCommands: Record<string, Command> = {
  'resolvables/create': {
    schema: z.object({
      cardId: z.string(),
      context: z.enum(['block', 'review', 'comment']),
      content: z.string().trim().min(1),
    }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const card = loadCard(ctx, input.cardId);
      if (input.context === 'comment') assertNotDeleted(card);
      else {
        const a = allowedActions(card, openContexts(db, card.id), { isHero: isHeroCard(db, card.id) });
        if (!(input.context === 'block' ? a.block : a.review)) throw new AppError(409, 'invalid_transition', { id: card.id });
      }
      const now = Date.now();
      const rid = newId(), eid = newId();
      db.prepare('INSERT INTO resolvables (id,card_id,context,creator_id,is_closed,created_at,latest_entry_at) VALUES (?,?,?,?,0,?,?)')
        .run(rid, card.id, input.context, actor.id, now, now);
      db.prepare('INSERT INTO resolvable_entries (id,resolvable_id,author_id,content,created_at) VALUES (?,?,?,?,?)')
        .run(eid, rid, actor.id, input.content, now);
      const changes: HistoryChange[] = [
        { kind: ({ block: 'blocked', review: 'reviewOpened', comment: 'commentOpened' } as Record<string, HistoryChange['kind']>)[input.context as string], quote: input.content },
      ];
      if (input.context === 'block' && card.status === 'started') {
        db.prepare("UPDATE cards SET status='not_started' WHERE id=?").run(card.id);
        changes.push({ kind: 'status', from: 'started', to: 'not_started' });
      }
      recordHistory(db, card.id, actor.id, changes);
      ctx.emit('resolvable', 'upsert', resolvableRow(db, rid)!);
      ctx.emit('resolvableEntry', 'upsert', entryRow(db, eid)!);
      onEntry(ctx, rid, eid, actor.id, true);
      touchTranslation(ctx, 'entry', eid);
      emitCard(ctx, card.id);
      return { id: rid, entryId: eid };
    },
  },

  'resolvables/comment': {
    schema: z.object({ resolvableId: z.string(), content: z.string().trim().min(1) }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const r = resolvableRow(db, input.resolvableId);
      if (!r) throw new AppError(404, 'not_found');
      const card = loadCard(ctx, r.cardId as string);
      assertNotDeleted(card);
      if (r.isClosed) throw new AppError(409, 'invalid_transition', { id: input.resolvableId });
      const now = Date.now(), eid = newId();
      db.prepare('INSERT INTO resolvable_entries (id,resolvable_id,author_id,content,created_at) VALUES (?,?,?,?,?)')
        .run(eid, input.resolvableId, actor.id, input.content, now);
      db.prepare('UPDATE resolvables SET latest_entry_at=? WHERE id=?').run(now, input.resolvableId);
      ctx.emit('resolvable', 'upsert', resolvableRow(db, input.resolvableId)!);
      ctx.emit('resolvableEntry', 'upsert', entryRow(db, eid)!);
      onEntry(ctx, input.resolvableId, eid, actor.id);
      touchTranslation(ctx, 'entry', eid);
      return { id: eid };
    },
  },

  'resolvables/editEntry': {
    schema: z.object({ entryId: z.string(), content: z.string().trim().min(1) }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const { entry, resolvable } = openEntry(ctx, input.entryId);
      if (entry.authorId !== actor.id) throw new AppError(403, 'not_author');
      db.prepare('UPDATE resolvable_entries SET content=?, version=version+1, last_changed_at=? WHERE id=?')
        .run(input.content, Date.now(), input.entryId);
      ctx.emit('resolvableEntry', 'upsert', entryRow(db, input.entryId)!);
      onEntryEdited(ctx, resolvable.id as string);
      touchTranslation(ctx, 'entry', input.entryId);
      return { id: input.entryId };
    },
  },

  'resolvables/addReaction': {
    schema: z.object({
      entryId: z.string(),
      value: z.object({ type: z.literal('emoji'), value: z.string().min(1).max(8).regex(EMOJI_ISH) }),
    }),
    run(ctx, input) {
      const { db, actor } = ctx;
      openEntry(ctx, input.entryId);
      const emoji = input.value.value;
      const existing = db.prepare('SELECT id FROM resolvable_reactions WHERE entry_id=? AND user_id=? AND emoji=?')
        .get(input.entryId, actor.id, emoji) as { id: string } | undefined;
      if (existing) return { id: existing.id };
      const id = newId();
      db.prepare('INSERT INTO resolvable_reactions (id,entry_id,user_id,emoji,created_at) VALUES (?,?,?,?,?)')
        .run(id, input.entryId, actor.id, emoji, Date.now());
      ctx.emit('reaction', 'upsert', reactionRow(db, id)!);
      return { id };
    },
  },

  'resolvables/removeReaction': {
    schema: z.object({ id: z.string() }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const x = reactionRow(db, input.id);
      if (!x) throw new AppError(404, 'not_found');
      if (x.userId !== actor.id) throw new AppError(403, 'forbidden');
      const { resolvable } = openEntry(ctx, x.entryId as string);
      db.prepare('DELETE FROM resolvable_reactions WHERE id=?').run(input.id);
      // Keep the routing keys: the row is gone, so LiveHub can't look them up.
      ctx.emit('reaction', 'remove', { ...x, resolvableId: resolvable.id, cardId: resolvable.cardId });
      return {};
    },
  },

  'resolvables/close': {
    schema: z.object({ id: z.string(), markCardDone: z.boolean().optional() }),
    run(ctx, input) {
      const { db, actor } = ctx;
      const r = resolvableRow(db, input.id);
      if (!r) throw new AppError(404, 'not_found');
      const card = loadCard(ctx, r.cardId as string);
      assertNotDeleted(card);
      if (r.isClosed) throw new AppError(409, 'invalid_transition', { id: input.id });
      if (input.markCardDone && r.context !== 'review') throw new AppError(400, 'invalid_payload', { field: 'markCardDone' });
      if (input.markCardDone && isHeroCard(db, card.id)) throw new AppError(409, 'invalid_transition', { id: card.id });
      if (input.markCardDone) assertGuardianAllows(db, actor, card, 'done');
      db.prepare('UPDATE resolvables SET is_closed=1, closed_at=?, closed_by=? WHERE id=?').run(Date.now(), actor.id, input.id);
      const first = db.prepare('SELECT content FROM resolvable_entries WHERE resolvable_id=? ORDER BY created_at, rowid LIMIT 1')
        .get(input.id) as { content: string } | undefined;
      const changes: HistoryChange[] = [{
        kind: ({ block: 'unblocked', review: 'reviewClosed', comment: 'commentClosed' } as Record<string, HistoryChange['kind']>)[r.context as string],
        ...(first ? { quote: first.content } : {}),
      }];
      if (input.markCardDone) {
        db.prepare("UPDATE cards SET status='done' WHERE id=?").run(card.id);
        changes.push({ kind: 'status', from: card.status, to: 'done' });
        cardDone(ctx, card.id);
      }
      recordHistory(db, card.id, actor.id, changes);
      ctx.emit('resolvable', 'upsert', resolvableRow(db, input.id)!);
      emitCard(ctx, card.id);
      if (input.markCardDone) {
        reemitDepNeighbours(ctx, card.id);
        syncHeroStatus(ctx, card.parentCardId as string | null);
      }
      return { cardId: card.id };
    },
  },

  'resolvables/markSeen': {
    schema: z.object({ resolvableId: z.string() }),
    run(ctx, input) {
      visibleThread(ctx, input.resolvableId);
      updateOwn(ctx, input.resolvableId, 'markSeen');
      return {};
    },
  },

  'resolvables/snooze': {
    schema: z.object({ resolvableId: z.string(), until: z.null().optional() }),
    run(ctx, input) {
      visibleThread(ctx, input.resolvableId);
      ensureRow(ctx, input.resolvableId);
      updateOwn(ctx, input.resolvableId, 'snooze', input.until === null ? null : Date.now() + REMIND_AFTER_MS);
      return {};
    },
  },

  'resolvables/setParticipation': {
    schema: z.object({ resolvableId: z.string(), isParticipating: z.boolean() }),
    run(ctx, input) {
      visibleThread(ctx, input.resolvableId);
      ensureRow(ctx, input.resolvableId);
      updateOwn(ctx, input.resolvableId, 'participation', input.isParticipating ? 1 : 0);
      return {};
    },
  },

  'resolvables/setMuted': {
    schema: z.object({ resolvableId: z.string(), isMuted: z.boolean() }),
    run(ctx, input) {
      visibleThread(ctx, input.resolvableId);
      ensureRow(ctx, input.resolvableId);
      updateOwn(ctx, input.resolvableId, 'muted', input.isMuted ? 1 : 0);
      return {};
    },
  },
};

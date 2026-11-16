/**
 * Open Decks commands (server/open.ts has the public routes).
 * - `openDecks/update`: the Project settings "Open Decks" tab; project managers only.
 * - `open/*`: what visitors do: upvote, take the upvote back, follow a project's update emails. Guests may dispatch
 *   these and nothing else (dispatch.ts GUEST_NAMESPACES); team members use them from the app too.
 * - `guests/remove`: admins delete a guest account.
 * All three namespaces are token-denied (server/tokens.ts): sharing a project is a person's decision, and votes and
 * subscriptions are a person's own.
 */
import { z } from 'zod';
import type { Command, Ctx } from '../dispatch';
import { AppError } from '../errors';
import { assertCan, can, isGuest } from '../permissions';
import { coverRow, releaseCover } from '../covers';
import { now } from '../auth';
import { projectRow } from './rows';
import { openDeckSettings, publicDeckOf, validUrlName, type OpenDeckSettings } from '../open';

const imageId = z.string().min(1).max(100).nullable();

const updateSchema = z.object({
  projectId: z.string(),
  enabled: z.boolean().optional(),
  urlName: z.string().max(100).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  bannerFileId: imageId.optional(),
  welcome: z.string().max(2000).optional(),
  showComments: z.boolean().optional(),
  upvoting: z.boolean().optional(),
  listed: z.boolean().optional(),
  promoFileId: imageId.optional(),
});

/** An image the open deck may show: an uploaded cover of the same project. */
function assertImage(ctx: Ctx, projectId: string, id: string | null | undefined, field: string): void {
  if (!id) return;
  const c = coverRow(ctx.db, id);
  if (!c || c.projectId !== projectId) throw new AppError(400, 'bad_cover', { field });
}

/**
 * The public project of a card a visitor acts on. Not public (or the card isn't live in a deck): 404, except for team
 * members who can see the project in the app, who learn that upvoting is off (403 upvoting_off) instead.
 */
function publicProjectOfCard(ctx: Ctx, cardId: string): OpenDeckSettings {
  const { db, actor } = ctx;
  const row = db.prepare("SELECT d.project_id p FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.visibility='default'").get(cardId) as { p: string } | undefined;
  if (!row) throw new AppError(404, 'not_found');
  const o = publicDeckOf(db, row.p);
  const member = !isGuest(db, actor.id) && can(db, actor, 'project.view', row.p);
  if (!o) throw member ? new AppError(403, 'upvoting_off') : new AppError(404, 'not_found');
  if (!o.upvoting) throw new AppError(403, 'upvoting_off');
  return o;
}
const countOf = (ctx: Ctx, cardId: string) => (ctx.db.prepare('SELECT COUNT(*) n FROM upvotes WHERE card_id=?').get(cardId) as { n: number }).n;

export const openDeckCommands: Record<string, Command> = {
  'openDecks/update': {
    schema: updateSchema,
    run(ctx, input) {
      const { db } = ctx;
      const p = projectRow(db, input.projectId);
      if (!p) throw new AppError(404, 'not_found');
      assertCan(db, ctx.actor, 'project.manage', input.projectId);
      const old = openDeckSettings(db, input.projectId);
      const urlName = input.urlName ?? old?.urlName;
      if (!urlName) throw new AppError(400, 'invalid_payload', { field: 'urlName' });
      if (!validUrlName(urlName)) throw new AppError(400, 'invalid_url_name');
      const taken = db.prepare('SELECT project_id FROM open_decks WHERE url_name=? AND project_id != ?').get(urlName, input.projectId);
      if (taken) throw new AppError(409, 'url_taken');
      assertImage(ctx, input.projectId, input.bannerFileId, 'bannerFileId');
      assertImage(ctx, input.projectId, input.promoFileId, 'promoFileId');
      const next: OpenDeckSettings = {
        projectId: input.projectId,
        enabled: input.enabled ?? old?.enabled ?? true,
        urlName,
        displayName: input.displayName ?? old?.displayName ?? (p.name as string).slice(0, 80),
        bannerFileId: input.bannerFileId === undefined ? old?.bannerFileId ?? null : input.bannerFileId,
        welcome: input.welcome ?? old?.welcome ?? '',
        showComments: input.showComments ?? old?.showComments ?? false,
        upvoting: input.upvoting ?? old?.upvoting ?? true,
        listed: input.listed ?? old?.listed ?? false,
        promoFileId: input.promoFileId === undefined ? old?.promoFileId ?? null : input.promoFileId,
        createdAt: old?.createdAt ?? now(),
      };
      db.prepare(`INSERT INTO open_decks (project_id, url_name, display_name, banner_file_id, welcome, show_comments, upvoting, listed, promo_file_id, enabled, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET url_name=excluded.url_name, display_name=excluded.display_name,
        banner_file_id=excluded.banner_file_id, welcome=excluded.welcome, show_comments=excluded.show_comments, upvoting=excluded.upvoting,
        listed=excluded.listed, promo_file_id=excluded.promo_file_id, enabled=excluded.enabled`).run(
        next.projectId, next.urlName, next.displayName, next.bannerFileId, next.welcome, next.showComments ? 1 : 0, next.upvoting ? 1 : 0,
        next.listed ? 1 : 0, next.promoFileId, next.enabled ? 1 : 0, next.createdAt);
      // A replaced image goes once nothing else (deck or project cover, the other image) uses it.
      for (const was of [old?.bannerFileId, old?.promoFileId]) {
        if (was && was !== next.bannerFileId && was !== next.promoFileId) releaseCover(ctx, { kind: 'file', fileId: was });
      }
      return next;
    },
  },

  'open/upvote': {
    schema: z.object({ cardId: z.string() }),
    run(ctx, { cardId }) {
      publicProjectOfCard(ctx, cardId);
      ctx.db.prepare('INSERT OR IGNORE INTO upvotes (card_id, user_id, created_at) VALUES (?,?,?)').run(cardId, ctx.actor.id, now());
      return { upvotes: countOf(ctx, cardId), upvoted: true };
    },
  },
  'open/unvote': {
    schema: z.object({ cardId: z.string() }),
    run(ctx, { cardId }) {
      publicProjectOfCard(ctx, cardId);
      ctx.db.prepare('DELETE FROM upvotes WHERE card_id=? AND user_id=?').run(cardId, ctx.actor.id);
      return { upvotes: countOf(ctx, cardId), upvoted: false };
    },
  },
  'open/subscribe': {
    schema: z.object({ projectId: z.string(), cadence: z.enum(['daily', 'weekly']) }),
    run(ctx, { projectId, cadence }) {
      if (!publicDeckOf(ctx.db, projectId)) throw new AppError(404, 'not_found');
      // The first email covers what happens from now on (server/jobs.ts runOpenDeckUpdates starts at created_at).
      ctx.db.prepare(`INSERT INTO open_subscriptions (project_id, user_id, cadence, created_at) VALUES (?,?,?,?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET cadence=excluded.cadence`).run(projectId, ctx.actor.id, cadence, now());
      return { subscription: cadence };
    },
  },
  /**
   * Admins remove a guest account (an Open Decks visitor): the user row goes, and with it their sessions, upvotes and
   * subscriptions. Only guests: members are disabled, never deleted. Frees the address (for an invite, say).
   */
  'guests/remove': {
    schema: z.object({ userId: z.string() }),
    run(ctx, { userId }) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'user.manage');
      if (!isGuest(db, userId)) throw new AppError(404, 'not_found');
      db.prepare('DELETE FROM saved_searches WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM users WHERE id=?').run(userId);
      return { removed: true };
    },
  },
  'open/unsubscribe': {
    schema: z.object({ projectId: z.string() }),
    run(ctx, { projectId }) {
      ctx.db.prepare('DELETE FROM open_subscriptions WHERE project_id=? AND user_id=?').run(projectId, ctx.actor.id);
      return { subscription: null };
    },
  },
};

import { z } from 'zod';
import { AppError } from '../errors';
import { assertCan, isGuest } from '../permissions';
import { DEFAULT_SETTINGS, type AccountSettings } from '../../shared/types';
import { refreshAllCovers } from '../files';
import { createInvite, INVITE_MS, revokeDevices } from '../auth';
import { enqueueEmail, publicUrlOf } from '../email';
import { inviteEmail } from '../email-templates';
import { accountRow, userRow } from './rows';
import { assertFeature, assertSeatFor, takesSeat } from '../billing';
import type { Command } from '../dispatch';

const settingsSchema = z.strictObject({
  effortScale: z.string(),
  priorityLabels: z.strictObject({ a: z.string(), b: z.string(), c: z.string() }),
  staleHours: z.number().int().min(1),
  autoArchiveHours: z.number().int().min(0).nullable(),
  fallbackEffort: z.number().int().min(0),
  maxHandSlots: z.number().int().min(7).max(28),
  timelineScale: z.string(),
  weekStart: z.string(),
  workdays: z.array(z.number().int().min(1).max(7)),
  hideCompletedCounts: z.boolean(),
  defaultInboxDeckId: z.string().nullable(),
  coverFromAttachments: z.string(),
  heroCoverFromSubs: z.boolean(),
  questLevel: z.string(),
  milestonesEnabled: z.boolean(),
  sprintsEnabled: z.boolean(),
  visionBoardEnabled: z.boolean(),
  effortEnabled: z.boolean(),
  dueDateEnabled: z.boolean(),
  dependenciesEnabled: z.boolean(),
  workflowMode: z.string().nullable(),
  timeTrackingMode: z.string().nullable(),
  mcpEnabled: z.boolean(),
  mcpDailyLimit: z.number().int().min(1).max(1_000_000).nullable(),
}).partial();

const roleOf = (ctx: { db: any }, userId: string): string =>
  (ctx.db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(userId) as { role: string } | undefined)?.role ?? '';
const isOwner = (ctx: { db: any }, userId: string) => roleOf(ctx, userId) === 'owner';

/** The canonical IANA name of a zone (aliases like Asia/Calcutta resolve to Asia/Kolkata), or null when it is no zone. */
export function canonicalZone(z: string): string | null {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: z }).resolvedOptions().timeZone; } catch { return null; }
}

export const accountCommands: Record<string, Command> = {
  'users/update': {
    schema: z.object({ id: z.string(), timezone: z.string().transform((z, c) => {
      const zone = canonicalZone(z);
      if (!zone) c.issues.push({ code: 'custom', message: 'invalid timezone', input: z });
      return zone ?? z;
    }) }),
    run(ctx, { id, timezone }) {
      if (id !== ctx.actor.id) throw new AppError(403, 'forbidden');
      assertCan(ctx.db, ctx.actor, 'workspace.personal');
      ctx.db.prepare('UPDATE users SET timezone=? WHERE id=?').run(timezone, id);
      ctx.emit('user', 'upsert', userRow(ctx.db, id)!);
    },
  },
  'accounts/update': {
    schema: z.object({ name: z.string().trim().min(1).optional(), settings: settingsSchema.optional(), userApiTokensEnabled: z.boolean().optional() }),
    run(ctx, input) {
      assertCan(ctx.db, ctx.actor, 'account.manage');
      // Switching personal tokens on or off is token management, and MCP is an integration: sessions only.
      const sessionOnly = input.userApiTokensEnabled !== undefined || input.settings?.mcpEnabled !== undefined || input.settings?.mcpDailyLimit !== undefined;
      if (sessionOnly && ctx.actor.via !== 'session') throw new AppError(403, 'missing_scope', { requiredScope: 'session' });
      const acc = accountRow(ctx.db);
      const merged: AccountSettings = { ...DEFAULT_SETTINGS, ...acc.settings, ...input.settings };
      ctx.db.prepare('UPDATE account SET name=?, settings_json=?, user_api_tokens_enabled=?')
        .run(input.name ?? acc.name, JSON.stringify(merged), input.userApiTokensEnabled === undefined ? (acc.userApiTokensEnabled ? 1 : 0) : (input.userApiTokensEnabled ? 1 : 0));
      ctx.emit('account', 'upsert', accountRow(ctx.db));
      if (merged.coverFromAttachments !== (acc.settings as AccountSettings).coverFromAttachments || merged.heroCoverFromSubs !== (acc.settings as AccountSettings).heroCoverFromSubs) refreshAllCovers(ctx);
    },
  },
  'users/setRole': {
    schema: z.object({ userId: z.string(), role: z.enum(['owner', 'admin', 'member', 'observer']) }),
    run(ctx, { userId, role }) {
      assertCan(ctx.db, ctx.actor, 'user.manage');
      if (role === 'owner' || isOwner(ctx, userId)) throw new AppError(403, 'forbidden');
      const u = userRow(ctx.db, userId);
      // Guests are Open Decks visitors, not people of the workspace: they can't be promoted into it.
      if (!u || isGuest(ctx.db, userId)) throw new AppError(404, 'not_found');
      const old = roleOf(ctx, userId);
      if (role === 'observer' && old !== 'observer') assertFeature(ctx.db, 'observerRole');
      if (!u.disabled && !takesSeat(old)) assertSeatFor(ctx.db, role);
      ctx.db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role')
        .run(userId, role);
      ctx.emit('accountRole', 'upsert', { userId, role });
    },
  },
  'users/disable': {
    schema: z.object({ userId: z.string(), disabled: z.boolean() }),
    run(ctx, { userId, disabled }) {
      assertCan(ctx.db, ctx.actor, 'user.manage');
      if (isOwner(ctx, userId)) throw new AppError(403, 'forbidden');
      const u = userRow(ctx.db, userId);
      if (!u || isGuest(ctx.db, userId)) throw new AppError(404, 'not_found');
      if (!disabled && u.disabled) assertSeatFor(ctx.db, roleOf(ctx, userId));
      ctx.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, userId);
      if (disabled) {
        ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        revokeDevices(ctx.db, userId);
      }
      ctx.emit('user', 'upsert', userRow(ctx.db, userId)!);
    },
  },
  'invites/create': {
    // `email`: also send the link there (through the outbox; the link is still returned).
    schema: z.object({ role: z.enum(['admin', 'member', 'observer']), projectIds: z.array(z.string()), email: z.email().max(254).optional() }),
    run(ctx, input) {
      assertCan(ctx.db, ctx.actor, 'user.manage');
      if (input.role === 'observer') assertFeature(ctx.db, 'observerRole');
      assertSeatFor(ctx.db, input.role);
      const token = createInvite(ctx.db, ctx.actor, { role: input.role, projectIds: input.projectIds });
      if (input.email) {
        const mail = inviteEmail({
          workspace: accountRow(ctx.db).name, inviter: ctx.actor.name, role: input.role,
          url: `${publicUrlOf(ctx.db)}/join/${token}`, days: Math.round(INVITE_MS / 86400e3),
        });
        if (enqueueEmail(ctx.db, { to: input.email, ...mail, kind: 'invite' }) === null) throw new AppError(400, 'invalid_payload');
      }
      return { token };
    },
  },
  'invites/disable': {
    schema: z.object({ tokenHash: z.string() }),
    run(ctx, { tokenHash }) {
      assertCan(ctx.db, ctx.actor, 'user.manage');
      ctx.db.prepare('UPDATE invites SET disabled=1 WHERE token_hash=?').run(tokenHash);
    },
  },
};

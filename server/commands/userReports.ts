/**
 * User report settings (Workspace settings → User reports): one app per workspace with its "Create cards in" deck,
 * the severity → deck map, the "severity sets priority" switch, an access key and report tokens.
 *
 * - Admins only, session only (token actors are refused by dispatch first: the namespace is on the token deny-list).
 * - Only SHA-256 hashes are stored. The plain access key and tokens are returned once, by the command that makes them.
 * - Nothing is emitted live: the settings page reloads GET /api/user-reports after each change.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { newId, type Db } from '../db';
import { AppError } from '../errors';
import { now } from '../auth';
import { assertCan } from '../permissions';
import { deckRow } from './rows';
import type { Command, Ctx } from '../dispatch';

export const REPORT_TOKEN_PREFIX = 'jtrt_';
export const ACCESS_KEY_PREFIX = 'jtrk_';
/** A report token or access key: its prefix plus 32 random bytes in base64url. */
export const REPORT_SECRET = /^jtr[tk]_[A-Za-z0-9_-]{43}$/;
export const SEVERITIES = ['critical', 'high', 'low'] as const;
export type Severity = typeof SEVERITIES[number];
/** Report tokens per app (enabled or not). */
export const MAX_REPORT_TOKENS = 200;
export const DEFAULT_TOKEN_LABEL = 'default';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newSecret = (prefix: string): string => prefix + randomBytes(32).toString('base64url');

export interface ReportApp {
  id: string; name: string; deckId: string | null; severityDecks: Partial<Record<Severity, string>>; severityPriority: boolean; createdAt: number;
}
export interface ReportToken { id: string; label: string; enabled: boolean; createdAt: number }

export function reportApp(db: Db): ReportApp | null {
  const r = db.prepare('SELECT id, name, deck_id, severity_decks, severity_priority, created_at FROM report_apps ORDER BY created_at LIMIT 1').get() as Record<string, any> | undefined;
  if (!r) return null;
  return { id: r.id, name: r.name, deckId: r.deck_id, severityDecks: JSON.parse(r.severity_decks), severityPriority: !!r.severity_priority, createdAt: r.created_at };
}

export const reportTokens = (db: Db, appId: string): ReportToken[] =>
  (db.prepare('SELECT id, label, enabled, created_at FROM report_tokens WHERE app_id=? ORDER BY created_at, rowid').all(appId) as Record<string, any>[])
    .map((r) => ({ id: r.id, label: r.label, enabled: !!r.enabled, createdAt: r.created_at }));

/** A new report token for the app; returns the plain token (the only time it exists). 409 limit_reached past the cap. */
export function insertReportToken(db: Db, appId: string, label: string): { id: string; token: string } {
  const { n } = db.prepare('SELECT COUNT(*) n FROM report_tokens WHERE app_id=?').get(appId) as { n: number };
  if (n >= MAX_REPORT_TOKENS) throw new AppError(409, 'limit_reached', { limit: MAX_REPORT_TOKENS });
  const id = newId();
  const token = newSecret(REPORT_TOKEN_PREFIX);
  db.prepare('INSERT INTO report_tokens (id, app_id, label, token_hash, enabled, created_at) VALUES (?,?,?,?,1,?)').run(id, appId, label, sha256(token), now());
  return { id, token };
}

export const labelSchema = z.string().trim().min(1).max(80);

function admin(ctx: Ctx): void {
  if (ctx.actor.via !== 'session') throw new AppError(403, 'missing_scope', { requiredScope: 'session' });
  assertCan(ctx.db, ctx.actor, 'account.manage');
}

function needApp(db: Db): ReportApp {
  const app = reportApp(db);
  if (!app) throw new AppError(404, 'not_found');
  return app;
}

/** Reports become task cards: a doc deck (or a missing deck) can't receive them. */
function assertReportDeck(db: Db, deckId: string, field: string): void {
  const d = deckRow(db, deckId);
  if (!d || d.deckType === 'doc') throw new AppError(400, 'invalid_payload', { field });
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  deckId: z.string().optional(),
  severityDecks: z.object({ critical: z.string().nullable().optional(), high: z.string().nullable().optional(), low: z.string().nullable().optional() }).strict().optional(),
  severityPriority: z.boolean().optional(),
});

export const userReportCommands: Record<string, Command> = {
  /** Creates the app with its "default" token and an access key; returns both plain values (shown once). */
  'userReports/setup': {
    schema: z.object({ name: z.string().trim().min(1).max(100), deckId: z.string() }),
    run(ctx, input: { name: string; deckId: string }) {
      admin(ctx);
      const { db } = ctx;
      if (reportApp(db)) throw new AppError(409, 'already_setup');
      assertReportDeck(db, input.deckId, 'deckId');
      const id = newId();
      const accessKey = newSecret(ACCESS_KEY_PREFIX);
      db.prepare('INSERT INTO report_apps (id, name, deck_id, access_key_hash, created_at) VALUES (?,?,?,?,?)').run(id, input.name, input.deckId, sha256(accessKey), now());
      const { token } = insertReportToken(db, id, DEFAULT_TOKEN_LABEL);
      return { id, accessKey, token };
    },
  },

  'userReports/update': {
    schema: updateSchema,
    run(ctx, input: z.infer<typeof updateSchema>) {
      admin(ctx);
      const { db } = ctx;
      const app = needApp(db);
      if (input.deckId !== undefined) assertReportDeck(db, input.deckId, 'deckId');
      let severityDecks = app.severityDecks;
      if (input.severityDecks) {
        severityDecks = {};
        for (const s of SEVERITIES) {
          const d = input.severityDecks[s];
          if (!d) continue;
          assertReportDeck(db, d, `severityDecks.${s}`);
          severityDecks[s] = d;
        }
      }
      db.prepare('UPDATE report_apps SET name=?, deck_id=?, severity_decks=?, severity_priority=? WHERE id=?').run(
        input.name ?? app.name, input.deckId ?? app.deckId, JSON.stringify(severityDecks),
        (input.severityPriority ?? app.severityPriority) ? 1 : 0, app.id);
      return {};
    },
  },

  /** A new access key; the old one stops working at once. Returns the plain key (shown once). */
  'userReports/regenerateAccessKey': {
    schema: z.object({}),
    run(ctx) {
      admin(ctx);
      const app = needApp(ctx.db);
      const accessKey = newSecret(ACCESS_KEY_PREFIX);
      ctx.db.prepare('UPDATE report_apps SET access_key_hash=? WHERE id=?').run(sha256(accessKey), app.id);
      return { accessKey };
    },
  },

  'userReports/createToken': {
    schema: z.object({ label: labelSchema }),
    run(ctx, input: { label: string }) {
      admin(ctx);
      return insertReportToken(ctx.db, needApp(ctx.db).id, input.label);
    },
  },

  'userReports/setTokenEnabled': {
    schema: z.object({ id: z.string(), enabled: z.boolean() }),
    run(ctx, input: { id: string; enabled: boolean }) {
      admin(ctx);
      const app = needApp(ctx.db);
      const r = ctx.db.prepare('UPDATE report_tokens SET enabled=? WHERE id=? AND app_id=?').run(input.enabled ? 1 : 0, input.id, app.id);
      if (!r.changes) throw new AppError(404, 'not_found');
      return {};
    },
  },
};

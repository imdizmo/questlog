/**
 * Danger Zone (POST /dispatch/dangerZone/<action>): disable (hibernate) and reactivate the workspace. Owner only, never
 * for API tokens (`dangerZone` is token-denied). They may call Stripe, so they run outside the synchronous command
 * registry, like the billing commands.
 *
 * A disabled workspace keeps all its data. While it is disabled, the gate in server/app.ts (the "disabled-workspace
 * gate" onRequest hook) answers every entry point with 423 workspace_disabled, see DISABLED_GATE below. There is no
 * delete in the app: deleting is done by the operator from the command line (deleteWorkspace).
 */
import { z, type ZodType } from 'zod';
import { existsSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db';
import { AppError } from '../errors';
import type { Actor } from '../permissions';
import { assertTokenScope, nextActionId, toActor, type ChangeEvent } from '../dispatch';
import { billingModeOf, StripeError, stripeIds, type StripeClient } from '../billing';
import type { User } from '../../shared/types';

/** Why the owner is leaving, each with a follow-up question (our own wording). Sent by GET /api/exit-options. */
export const EXIT_OPTIONS = [
  { id: 'havingTrouble', label: 'Something isn’t working for us', followUp: 'What got in your way, and what would have helped?' },
  { id: 'foundAlternative', label: 'We moved to another tool', followUp: 'Which tool did you pick, and what made it the better fit?' },
  { id: 'tooExpensive', label: 'It costs more than we can spend', followUp: 'What would a price that works for your team look like?' },
  { id: 'projectEnded', label: 'Our project is finished', followUp: 'Congratulations! Is there anything we could have done better along the way?' },
  { id: 'other', label: 'Something else', followUp: 'Would you tell us a little more about why?' },
] as const;
export type ExitReason = (typeof EXIT_OPTIONS)[number]['id'];
const REASONS = EXIT_OPTIONS.map((o) => o.id) as [ExitReason, ...ExitReason[]];
export const EXIT_DETAIL_MAX = 2000;

/**
 * What the disabled-workspace gate does, by path. The gate judges the raw path, the decoded path and the matched route
 * pattern, and the strictest answer wins. Kept here
 * so later entry points inherit it by prefix: a new `/integrations/...` or `/open/...` route needs no gate code.
 * - `allow`: still served while disabled (logging in is owner-only there, reactivate checks the owner itself; the
 *   Stripe webhook keeps the subscription state true while the cancellation runs out; an email unsubscribe link only
 *   ever turns emails off and must always work).
 * - `hidden`: public pages answer 404, as if they never existed.
 * - `locked`: 423 workspace_disabled. Prefixes ending in '/' match below them, others match exactly or below.
 * Anything else (the app shell and its static files) is served, so the reactivate screen can render.
 */
export const DISABLED_GATE = {
  allow: ['/api/status', '/api/login', '/api/logout', '/dispatch/dangerZone/reactivate', '/api/billing/stripe-webhook', '/email/unsubscribe'],
  hidden: ['/open', '/api/open', '/dispatch/open/signUp'],
  locked: ['/api/', '/dispatch/', '/mcp', '/user-report/', '/integrations'],
} as const;

const under = (path: string, prefix: string) =>
  prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);

/** The gate's answer for a path while the workspace is disabled. */
export function disabledGate(path: string): 'pass' | 'hidden' | 'locked' {
  if ((DISABLED_GATE.allow as readonly string[]).includes(path)) return 'pass';
  if (DISABLED_GATE.hidden.some((p) => under(path, p))) return 'hidden';
  if (DISABLED_GATE.locked.some((p) => under(path, p))) return 'locked';
  return 'pass';
}

const disabledStmts = new WeakMap<Db, ReturnType<Db['prepare']>>();
/** One prepared statement per database: the gate asks on every request. */
export function isWorkspaceDisabled(db: Db): boolean {
  let st = disabledStmts.get(db);
  if (!st) disabledStmts.set(db, (st = db.prepare('SELECT is_disabled d FROM account')));
  return (st.get() as { d: number } | undefined)?.d === 1;
}

export const isOwner = (db: Db, userId: string): boolean =>
  !!db.prepare("SELECT 1 FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.id=? AND u.disabled=0 AND r.role='owner'").get(userId);

export interface DangerZoneDeps {
  /** Null when the server has no Stripe keys. */
  client: StripeClient | null;
  /** Closes every websocket (push and rooms) once the workspace is disabled. */
  closeSockets(): void;
}

interface Run { db: Db; actor: Actor; deps: DangerZoneDeps }
interface DangerZoneCommand<T = any> { schema: ZodType<T>; run(r: Run, input: T): Promise<unknown> }

/** The subscription to cancel or resume: only in stripe mode with one on record. */
const subscriptionOf = (db: Db): string | null => (billingModeOf(db) === 'stripe' ? stripeIds(db).subscription : null);

export const dangerZoneCommands: Record<string, DangerZoneCommand> = {
  'dangerZone/disable': {
    schema: z.object({ reason: z.enum(REASONS), detail: z.string().trim().max(EXIT_DETAIL_MAX).optional() }),
    async run({ db, actor, deps }, { reason, detail }) {
      // Billing stops first: if Stripe can't be told, nothing is disabled and the owner can try again.
      const sub = subscriptionOf(db);
      if (sub) {
        if (!deps.client) throw new AppError(503, 'stripe_not_configured');
        try {
          await deps.client.setCancelAtPeriodEnd(sub, true);
        } catch (e) {
          // Stripe no longer knows it (a missed "deleted" webhook): nothing left to bill, so disabling goes ahead.
          if (!(e instanceof StripeError && e.stripeStatus === 404)) throw e;
        }
      }
      const record = JSON.stringify({ reason, detail: detail || null, by: actor.id, at: Date.now() });
      db.prepare('UPDATE account SET is_disabled=1, disabled_reason=?').run(record);
      deps.closeSockets();
      return { disabled: true };
    },
  },
  'dangerZone/reactivate': {
    schema: z.object({}),
    async run({ db, deps }) {
      const was = isWorkspaceDisabled(db);
      db.prepare('UPDATE account SET is_disabled=0, disabled_reason=NULL').run();
      // Undo the cancellation while the period is still running. The workspace opens either way; if Stripe can't be
      // reached the owner sees it and can subscribe again under Billing.
      let subscriptionResumed = false;
      const sub = was ? subscriptionOf(db) : null;
      if (sub && deps.client) {
        try {
          await deps.client.setCancelAtPeriodEnd(sub, false);
          subscriptionResumed = true;
        } catch (e) {
          console.error('[jt] could not resume the subscription after reactivation', String((e as Error)?.message ?? e));
        }
      }
      return { reactivated: true, subscriptionResumed };
    },
  },
};

export async function runDangerZoneCommand(db: Db, user: User | Actor, name: string, payload: unknown, deps: DangerZoneDeps): Promise<{ payload: unknown; actionId: string; events: ChangeEvent[] }> {
  const cmd = Object.hasOwn(dangerZoneCommands, name) ? dangerZoneCommands[name] : undefined;
  if (!cmd) throw new AppError(404, 'unknown_command');
  const actor = toActor(user);
  assertTokenScope(actor, name);
  const parsed = cmd.schema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues });
  if (actor.via !== 'session' || !isOwner(db, actor.id)) throw new AppError(403, 'forbidden');
  const out = await cmd.run({ db, actor, deps }, parsed.data);
  return { payload: out, actionId: nextActionId(), events: [] };
}

export interface DeleteResult {
  /** Blobs of files and covers rows removed from the files folder. */
  removed: number;
  /** Rows whose blob was already gone. */
  missing: number;
  /** Rows whose id would resolve outside the files folder: refused, nothing removed for them. */
  refused: number;
  /** Files in the folder the database does not know about: left untouched. */
  unknown: number;
}

/** `path` inside `root` (never root itself, never outside it). */
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Regular files directly in `dir` (and its covers folder), for the "left untouched" count. */
function countFiles(dir: string): number {
  let n = 0;
  for (const d of [dir, join(dir, 'covers')]) {
    try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isFile()) n++; } catch { /* no folder */ }
  }
  return n;
}

/**
 * `pnpm start --delete-workspace --confirm "<workspace name>"` (server/main.ts): deletes a disabled workspace for good.
 * - Refuses while a server has the database open (an exclusive lock is taken and held until the blobs are gone), while
 *   the workspace is active, and unless the name is repeated exactly.
 * - Removes only the blobs the database knows about: one file per `files` row (`<filesDir>/<id>`) and per `covers` row
 *   (`<filesDir>/covers/<id>`), each resolved inside the files folder; an id that would land outside it is refused.
 *   User report uploads are stored as `files` rows, so they are covered. Anything else in the folder is left alone and
 *   counted; the folders themselves are removed only when that leaves them empty.
 * - Then removes the database with its -wal and -shm files.
 */
export function deleteWorkspace(dbPath: string, filesDir: string, confirmName: string | undefined): DeleteResult {
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  const db = new DatabaseSync(dbPath, { timeout: 0 });
  const out: DeleteResult = { removed: 0, missing: 0, refused: 0, unknown: 0 };
  const root = resolve(filesDir);
  try {
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
    } catch {
      throw new Error('The database is in use. Stop the server first.');
    }
    let acc: { name: string; d: number } | undefined;
    try {
      acc = db.prepare('SELECT name, is_disabled d FROM account').get() as { name: string; d: number } | undefined;
    } catch {
      throw new Error('This database holds no workspace that can be deleted.');
    }
    if (!acc) throw new Error('This database holds no workspace.');
    if (acc.d !== 1) throw new Error('The workspace is still active. Its owner disables it first (Workspace settings, Danger Zone).');
    if (confirmName !== acc.name) throw new Error(`To delete it, repeat its name: --confirm "${acc.name}"`);
    const blobs = [
      ...(db.prepare('SELECT id FROM files').all() as { id: string }[]).map((r) => resolve(root, r.id)),
      ...(db.prepare('SELECT id FROM covers').all() as { id: string }[]).map((r) => resolve(root, 'covers', r.id)),
    ];
    for (const path of blobs) {
      if (!inside(root, path)) { out.refused++; continue; }
      try { unlinkSync(path); out.removed++; } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') out.missing++;
        else throw e;
      }
    }
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  out.unknown = countFiles(root);
  // Only empty folders go; rmdir refuses anything else.
  for (const d of [join(root, 'covers'), root]) { try { rmdirSync(d); } catch { /* not empty, or absent */ } }
  return out;
}

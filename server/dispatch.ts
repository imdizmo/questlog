import type { ZodType } from 'zod';
import { tx, type Db } from './db';
import { AppError } from './errors';
import type { User } from '../shared/types';
import { accountCommands } from './commands/account';
import { projectCommands } from './commands/projects';
import { deckCommands } from './commands/decks';
import { cardCommands } from './commands/cards';
import { resolvableCommands } from './commands/resolvables';
import { presetCommands } from './commands/presets';
import { watchingCommands } from './commands/watchings';
import { flushProgress, milestoneCommands } from './commands/milestones';
import { flushSprintProgress, sprintCommands } from './commands/sprints';
import { timeCommands } from './commands/time';
import { searchCommands } from './commands/search';
import { journeyCommands } from './commands/journeys';
import { visionBoardCommands } from './commands/visionBoards';
import { bookmarkCommands, handCommands } from './commands/hand';
import { apiTokenCommands } from './commands/apiTokens';
import { translateQueueOf } from './translate/queue';
import { userReportCommands } from './commands/userReports';
import { onboardingCommands } from './commands/onboarding';
import { emailPrefCommands } from './commands/emailPrefs';
import { openDeckCommands } from './commands/openDecks';
import { wikiCommands } from './commands/wiki';
import { assetCommands } from './commands/assets';
import { discordCommands } from './integrations/discord';
import { slackCommands } from './integrations/slack';
import { gitCommands } from './integrations/git';
import { isGuest, sessionActor, type Actor } from './permissions';
import { TOKEN_DENIED_COMMANDS, TOKEN_DENIED_NAMESPACES, tokenCanDelete } from './tokens';

export type ModelName =
  | 'account' | 'user' | 'accountRole' | 'project' | 'projectAccess' | 'projectPref'
  | 'deck' | 'card' | 'resolvable' | 'resolvableEntry' | 'reaction' | 'handCard' | 'preset' | 'userCardTag' | 'cardDep' | 'file' | 'resolvableNotification' | 'cardSubscription' | 'deckSubscription' | 'deckGuardian' | 'journey' | 'visionBoard' | 'visionQuery' | 'bookmark' | 'donePile' | 'savedSearch' | 'onboardingStep'
  | 'milestone' | 'milestoneZone' | 'milestoneProgress'
  | 'sprintConfig' | 'sprint' | 'sprintProgress' | 'timeSegment' | 'apiToken'
  | 'entryType' | 'linkKind' | 'entryLink' | 'entryFamily' | 'asset' | 'translation';
/** 'access' (model 'project' only, row {id}): someone's view of this project may have changed; reload the snapshot. */
export type ChangeOp = 'upsert' | 'remove' | 'access';
export type ChangeEvent = { model: ModelName; op: ChangeOp; row: object };

export interface Ctx {
  db: Db;
  /** Session user or token actor (via, scopes, projectIds: see server/permissions.ts). */
  actor: Actor;
  events: ChangeEvent[];
  emit(model: ModelName, op: ChangeOp, row: object): void;
  /** Runs after the transaction committed (disk cleanup). Failures are logged, never thrown. */
  afterCommit(fn: () => void): void;
  /** Milestones whose progress needs one recount just before commit. Absent: recount at once. */
  dirtyMilestones?: Set<string>;
  /** Same for runs. */
  dirtySprints?: Set<string>;
}
export interface Command<T = any> {
  schema: ZodType<T>;
  run(ctx: Ctx, input: T): unknown;
  /**
   * The command deletes or irreversibly removes data, so a personal token needs "May delete" (assertTokenMayDelete).
   * A function decides from the validated input (cards/update deletes only with visibility 'deleted').
   */
  deletes?: boolean | ((input: T) => boolean);
}

export const registry: Record<string, Command> = {
  ...accountCommands,
  ...projectCommands,
  ...deckCommands,
  ...cardCommands,
  ...resolvableCommands,
  ...presetCommands,
  ...watchingCommands,
  ...handCommands,
  ...bookmarkCommands,
  ...milestoneCommands,
  ...journeyCommands,
  ...visionBoardCommands,
  ...sprintCommands,
  ...timeCommands,
  ...searchCommands,
  ...apiTokenCommands,
  ...userReportCommands,
  ...onboardingCommands,
  ...emailPrefCommands,
  ...openDeckCommands,
  ...wikiCommands,
  ...assetCommands,
  ...discordCommands,
  ...slackCommands,
  ...gitCommands,
};

let counter = 0;
export function nextActionId(): string {
  counter = (counter + 1) % 0x10000;
  return Date.now().toString(16).padStart(12, '0') + counter.toString(16).padStart(4, '0');
}

/** A plain user is a session actor. */
export const toActor = (u: User | Actor): Actor => ('via' in u ? u : sessionActor(u));

/**
 * What a token may dispatch at all: never the denied namespaces (token management, billing, integrations, invites),
 * and only with the write scope. 403 missing_scope {requiredScope}; sessions pass.
 */
export function assertTokenScope(actor: Actor, name: string): void {
  if (actor.via !== 'token') return;
  const ns = name.split('/')[0];
  if (TOKEN_DENIED_NAMESPACES.has(ns) || TOKEN_DENIED_COMMANDS.has(name)) throw new AppError(403, 'missing_scope', { requiredScope: 'session' });
  if (!actor.scopes.includes('write')) throw new AppError(403, 'missing_scope', { requiredScope: `${ns}:write` });
}

/** Whether this call deletes (Command.deletes, on the validated input). */
export const callDeletes = (cmd: Command, input: unknown): boolean =>
  typeof cmd.deletes === 'function' ? cmd.deletes(input) : !!cmd.deletes;

/**
 * Deleting through a token: a personal token needs "May delete" (tokens.ts tokenCanDelete), the same rule as MCP's
 * delete tools. 403 token_cannot_delete {command, message}. Sessions, the system and org tokens pass.
 */
export function assertTokenMayDelete(db: Db, actor: Actor, name: string): void {
  if (tokenCanDelete(db, actor)) return;
  throw new AppError(403, 'token_cannot_delete', { command: name, message: TOKEN_CANNOT_DELETE_MESSAGE });
}
export const TOKEN_CANNOT_DELETE_MESSAGE = 'This token can\'t delete. Create a token with "May delete" ticked.';

/**
 * Command namespaces a guest may dispatch: `open` (Open Decks visitors: upvote, unvote, subscribe, unsubscribe; each
 * command checks the project is public). Every other command is 403 for a guest.
 */
export const GUEST_NAMESPACES: ReadonlySet<string> = new Set(['open']);

/** 403 forbidden when a guest dispatches anything outside GUEST_NAMESPACES. */
export function assertGuestScope(db: Db, actor: Actor, name: string): void {
  if (actor.via === 'system' || GUEST_NAMESPACES.has(name.split('/')[0])) return;
  if (isGuest(db, actor.id)) throw new AppError(403, 'forbidden');
}

export function dispatch(
  db: Db,
  user: User | Actor,
  name: string,
  payload: unknown,
  opts: { undoOwnCreate?: boolean } = {},
): { payload: unknown; actionId: string; events: ChangeEvent[] } {
  const r = dispatchAll(db, user, [{ name, payload }], opts);
  return { payload: r.payloads[0], actionId: r.actionId, events: r.events };
}

/**
 * Several commands as one action: every call is checked and validated first, then all run in one transaction (the
 * first failure rolls back the lot). Used by the MCP batch tools (server/mcp.ts).
 * `beforeCommit` runs inside the same transaction after the commands, with their payloads (user reports store their
 * upload and email rows with the card they created).
 * `undoOwnCreate` skips the "May delete" check: only for removing again what the same request just created
 * (cover-dispatch.ts: a project whose cover could not be fetched).
 */
export function dispatchAll(
  db: Db,
  user: User | Actor,
  calls: { name: string; payload: unknown }[],
  opts: { beforeCommit?: (payloads: unknown[]) => void; undoOwnCreate?: boolean } = {},
): { payloads: unknown[]; actionId: string; events: ChangeEvent[] } {
  const actor = toActor(user);
  const steps = calls.map(({ name, payload }) => {
    const cmd = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (!cmd) throw new AppError(404, 'unknown_command');
    assertTokenScope(actor, name);
    assertGuestScope(db, actor, name);
    const parsed = cmd.schema.safeParse(payload);
    if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues });
    if (!opts.undoOwnCreate && callDeletes(cmd, parsed.data)) assertTokenMayDelete(db, actor, name);
    return { cmd, input: parsed.data };
  });
  const r = runAction(db, actor, (ctx) => {
    const out = steps.map(({ cmd, input }) => cmd.run(ctx, input) ?? {});
    opts.beforeCommit?.(out);
    return out;
  });
  return { payloads: r.result, actionId: r.actionId, events: r.events };
}

/**
 * One action outside the command registry (imports, clone): `fn` runs in one transaction with a fresh Ctx; milestone
 * and run progress are recounted before commit and after-commit steps run once it committed. The caller has done its
 * own permission checks and publishes the events.
 */
export function runAction<T>(db: Db, user: User | Actor, fn: (ctx: Ctx) => T): { result: T; actionId: string; events: ChangeEvent[] } {
  const actor = toActor(user);
  const events: ChangeEvent[] = [];
  const after: (() => void)[] = [];
  const ctx: Ctx = { db, actor, events, emit: (model, op, row) => { events.push({ model, op, row }); }, afterCommit: (fn) => { after.push(fn); }, dirtyMilestones: new Set(), dirtySprints: new Set() };
  const result = tx(db, () => {
    const out = fn(ctx);
    flushProgress(ctx);
    flushSprintProgress(ctx);
    return out;
  });
  for (const fn of after) {
    try { fn(); } catch (e) { console.error('[jt] after-commit step failed', String((e as Error)?.message ?? e)); }
  }
  translateQueueOf(db)?.wakeStale();
  return { result, actionId: nextActionId(), events: ctx.events };
}

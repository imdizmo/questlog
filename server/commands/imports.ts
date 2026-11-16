/**
 * Imports from other trackers into an existing project: Trello (the board's JSON export, read from the request) and
 * HacknPlan (its REST API, see server/importers/hacknplan.ts). Each importer turns its source into an ImportPlan;
 * applyImportPlan writes the plan in one transaction through the same paths as cards/create (checks, history, deck
 * automations), so a failing card imports nothing.
 * Nothing is downloaded: attachments and covers become links in the card text.
 */
import { z } from 'zod';
import { newId, type Db } from '../db';
import { AppError } from '../errors';
import { assertCan, type Actor } from '../permissions';
import { recordHistory } from '../history';
import { runAction, type ChangeEvent, type Ctx } from '../dispatch';
import type { User } from '../../shared/types';
import { allowedActions } from '../../shared/cards';
import { accountRow, cardRow, projectRow } from './rows';
import { now } from '../auth';
import { featureAllowed } from '../../shared/plans';
import { applyTransition, assertAssignee, createCard, emitCard, ensureProjectTags, isHeroCard, openContexts, tagsOf } from './cards';
import { deckCommands } from './decks';
import { markMilestone } from './milestones';
import { planTrello, trelloBoardSchema } from '../importers/trello';
import { fetchHacknPlanProject, planHacknPlan } from '../importers/hacknplan';
import type { OutboundClient } from '../integrations/http';
import type { ImportPlan, PlanCard } from '../importers/plan';

/** At most this many cards and decks per import (one transaction). */
export const MAX_IMPORT_CARDS = 5000;
export const MAX_IMPORT_DECKS = 200;
/** The Trello request body (the export file plus the project id) is refused past this size, unread. */
export const MAX_TRELLO_BYTES = 20 * 1024 * 1024;
/** Members who may own a card of the project, with a matcher for exact email / name (unique match only). */
function ownerMatcher(db: Db, projectId: string): (o: PlanCard['owner']) => string | null {
  const users = (db.prepare('SELECT id, name, email FROM users WHERE disabled=0').all() as { id: string; name: string; email: string }[])
    .filter((u) => { try { assertAssignee(db, u.id, projectId); return true; } catch { return false; } });
  const lc = (s: string) => s.trim().toLowerCase();
  return (o) => {
    if (!o) return null;
    const emails = new Set(o.emails.map(lc).filter(Boolean));
    const names = new Set(o.names.map(lc).filter(Boolean));
    const hits = users.filter((u) => emails.has(lc(u.email)) || names.has(lc(u.name)));
    return hits.length === 1 ? hits[0].id : null;
  };
}

/** The plan's milestones as milestones of the project: an existing one of the same name and date covering it is reused. */
function milestoneIds(ctx: Ctx, projectId: string, plan: ImportPlan): Map<string, string> {
  const { db, actor } = ctx;
  const out = new Map<string, string>();
  if ((accountRow(db).settings as { milestonesEnabled?: boolean }).milestonesEnabled === false) return out;
  const used = new Set(plan.cards.map((c) => c.milestoneKey).filter((k): k is string => !!k));
  for (const m of plan.milestones) {
    if (!used.has(m.key)) continue;
    const name = m.name.trim().slice(0, 200) || 'Milestone';
    const same = db.prepare(`SELECT m.id FROM milestones m WHERE m.name=? AND m.date IS ?
        AND (m.is_global=1 OR EXISTS (SELECT 1 FROM milestone_projects p WHERE p.milestone_id=m.id AND p.project_id=?)) ORDER BY m.account_seq LIMIT 1`)
      .get(name, m.date, projectId) as { id: string } | undefined;
    if (same) { out.set(m.key, same.id); continue; }
    db.prepare('UPDATE account SET plan_seq = plan_seq + 1').run();
    const seq = (db.prepare('SELECT plan_seq s FROM account').get() as { s: number }).s;
    const id = newId();
    db.prepare('INSERT INTO milestones (id, account_seq, name, date, start_date, color, is_global, created_by, created_at) VALUES (?,?,?,?,NULL,?,0,?,?)')
      .run(id, seq, name, m.date, 'blue', actor.id, Date.now());
    db.prepare('INSERT INTO milestone_projects (milestone_id, project_id) VALUES (?,?)').run(id, projectId);
    out.set(m.key, id);
  }
  return out;
}

/**
 * Writes a plan into the project (admins and the project's managers). Decks first, then hero cards before their sub
 * cards. Due dates are kept only when the workspace has them on (past dates included: they are history). Clients
 * reload the project instead of receiving thousands of card events.
 */
export function applyImportPlan(ctx: Ctx, projectId: string, plan: ImportPlan): { decks: number; cards: number } {
  const { db, actor } = ctx;
  const project = projectRow(db, projectId);
  if (!project) throw new AppError(404, 'not_found');
  assertCan(db, actor, 'project.manage', projectId);
  assertCan(db, actor, 'content.edit', projectId);
  if (project.isArchived) throw new AppError(409, 'project_archived');
  if (plan.cards.length > MAX_IMPORT_CARDS) throw new AppError(400, 'too_many_cards', { max: MAX_IMPORT_CARDS });
  if (plan.decks.length > MAX_IMPORT_DECKS) throw new AppError(400, 'too_many_decks', { max: MAX_IMPORT_DECKS });
  ensureProjectTags(ctx, projectId, plan.cards.flatMap((c) => tagsOf(c.tags)));
  const decks = new Map<string, string>();
  for (const d of plan.decks) {
    const { id } = deckCommands['decks/create'].run(ctx, { title: d.title.trim().slice(0, 200) || 'Untitled', projectId }) as { id: string };
    // Imported cards are tasks: a section whose new decks default to docs would refuse them.
    db.prepare("UPDATE decks SET deck_type='mixed' WHERE id=? AND deck_type='doc'").run(id);
    decks.set(d.key, id);
  }
  const owner = ownerMatcher(db, projectId);
  const milestones = milestoneIds(ctx, projectId, plan);
  const dueDates = !!(accountRow(db).settings as { dueDateEnabled?: boolean }).dueDateEnabled && featureAllowed(accountRow(db), 'dueDates', now());
  const ids = new Map<string, string>();
  const keys = new Set(plan.cards.map((c) => c.key));
  // Parents first; a parent that is missing (or part of a cycle) leaves the card without one.
  let todo = plan.cards.filter((c) => decks.has(c.deckKey));
  while (todo.length) {
    const ready = todo.filter((c) => !c.parentKey || !keys.has(c.parentKey) || ids.has(c.parentKey));
    const batch = ready.length ? ready : todo;
    for (const c of batch) {
      const parentCardId = c.parentKey && ready.length ? ids.get(c.parentKey) ?? null : null;
      const { id } = createCard(ctx, {
        content: c.content, deckId: decks.get(c.deckKey)!, isDoc: false, priority: c.priority, effort: c.effort,
        assigneeId: owner(c.owner), masterTags: tagsOf(c.tags), parentCardId,
      });
      ids.set(c.key, id);
      const due = dueDates ? c.dueDate : null;
      const ms = c.milestoneKey ? milestones.get(c.milestoneKey) ?? null : null;
      if (due || ms) {
        db.prepare('UPDATE cards SET due_date=COALESCE(?, due_date), milestone_id=COALESCE(?, milestone_id) WHERE id=?').run(due, ms, id);
        markMilestone(ctx, ms);
      }
    }
    const done = new Set(batch);
    todo = todo.filter((c) => !done.has(c));
  }
  // Done last, so a hero's status follows all of its sub cards.
  for (const c of plan.cards) {
    const id = ids.get(c.key);
    if (!c.done || !id) continue;
    const card = cardRow(db, id)!;
    if (!allowedActions(card as any, openContexts(db, id), { isHero: isHeroCard(db, id) }).done) continue;
    recordHistory(db, id, actor.id, applyTransition(ctx, card, { status: 'done' }));
    emitCard(ctx, id);
  }
  collapseEvents(ctx, projectId);
  return { decks: decks.size, cards: ids.size };
}

/** Thousands of rows changed: everyone reloads the project instead of receiving each row. */
export function collapseEvents(ctx: Ctx, projectId: string): void {
  ctx.events.length = 0;
  ctx.emit('project', 'upsert', projectRow(ctx.db, projectId)!);
  ctx.emit('project', 'access', { id: projectId });
}

const projectIdSchema = z.string().min(1).max(100);

export const trelloImportSchema = z.object({ projectId: projectIdSchema, board: trelloBoardSchema });

/** `imports/trello {projectId, board}`: the board's JSON export (lists, cards, labels, checklists, members). */
export function importTrello(db: Db, user: User | Actor, payload: unknown): { payload: { decks: number; cards: number }; actionId: string; events: ChangeEvent[] } {
  const parsed = trelloImportSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues.slice(0, 20) });
  const { projectId, board } = parsed.data;
  const r = runAction(db, user, (ctx) => applyImportPlan(ctx, projectId, planTrello(board)));
  return { payload: r.result, actionId: r.actionId, events: r.events };
}

export const hacknplanImportSchema = z.object({
  projectId: projectIdSchema,
  /** Sent only to HacknPlan as `Authorization: ApiKey <key>`; never stored or logged. Printable ASCII, no spaces. */
  apiKey: z.string().regex(/^[\x21-\x7e]{1,200}$/),
  /** A HacknPlan project number: never a path or a host. */
  hpProjectId: z.number().int().positive().max(2 ** 31),
  groupBy: z.enum(['category', 'board']),
});

/**
 * One import or clone at a time in the whole workspace (409 import_running): each holds a large body or a project's
 * worth of rows in memory and a long transaction. Returns the release function (safe to call more than once).
 */
let slotTaken = false;
export function takeImportSlot(): () => void {
  if (slotTaken) throw new AppError(409, 'import_running');
  slotTaken = true;
  let held = true;
  return () => { if (held) { held = false; slotTaken = false; } };
}

/**
 * `imports/hacknplan {projectId, apiKey, hpProjectId, groupBy}`: permission is checked before any request leaves the
 * server; the project is then read from HacknPlan (fixed host, server/importers/hacknplan.ts) and written in one
 * transaction (the permission is checked again there).
 */
export async function importHacknPlan(db: Db, user: User | Actor, payload: unknown, http: OutboundClient): Promise<{ payload: { decks: number; cards: number }; actionId: string; events: ChangeEvent[] }> {
  const parsed = hacknplanImportSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(400, 'invalid_payload');
  const input = parsed.data;
  const project = projectRow(db, input.projectId);
  if (!project) throw new AppError(404, 'not_found');
  assertCan(db, user, 'project.manage', input.projectId);
  if (project.isArchived) throw new AppError(409, 'project_archived');
  assertCan(db, user, 'content.edit', input.projectId);
  const release = takeImportSlot();
  try {
    const data = await fetchHacknPlanProject(http, input.apiKey, input.hpProjectId, MAX_IMPORT_CARDS);
    const plan = planHacknPlan(data, input.groupBy);
    const r = runAction(db, user, (ctx) => applyImportPlan(ctx, input.projectId, plan));
    return { payload: r.result, actionId: r.actionId, events: r.events };
  } finally {
    release();
  }
}


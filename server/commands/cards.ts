import { z } from 'zod';
import { newId, toCamel } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { assertCan, can, projectConfined } from '../permissions';
import { entryChange, recordHistory } from '../history';
import { keyFromName } from '../../shared/wiki';
import { canSeeCard, cardProjectId, handleMap } from '../access';
import { cardDone, cardReopened, handSyncOwner, insertHand } from './hand';
import { stopCardTimers } from './timers';
import { accountRow, cardLinkRefs, cardLinkRows, cardRow, deckRow, handCardRow, projectRow } from './rows';
import { allowedActions, titleOf } from '../../shared/cards';
import { parseContent } from '../../shared/content';
import { normalizeTagName } from '../../shared/csv';
import { isPastDate } from '../../shared/properties';
import { now as clockNow } from '../auth';
import { assertGuardianAllows } from '../guardians';
import { assertFeature } from '../billing';
import { assertEnabled as assertSprints, markSprint, resolveCardSprint } from './sprints';
import { assertEnabled, markMilestone, resolveCardMilestone, milestoneCovers } from './milestones';
import { fileRow, refreshCover, unlinkFiles } from '../files';
import { visionBoardRow, visionQueryRow } from '../boards';
import type { Command, Ctx } from '../dispatch';
import type { CardStatus, HistoryChange, ProjectTag, ResolvableContext, Visibility } from '../../shared/types';

const status = z.enum(['not_started', 'started', 'done']);
const visibility = z.enum(['default', 'archived', 'deleted']);

export const openContexts = (db: Db, cardId: string): Set<ResolvableContext> =>
  new Set((db.prepare('SELECT context FROM resolvables WHERE card_id=? AND is_closed=0').all(cardId) as { context: ResolvableContext }[])
    .map((r) => r.context));

/**
 * Deletes every wiki link the card is part of, as source or target, with a remove event in the link's own (old)
 * project. For a card leaving its project, or switching between card and Lore.
 */
export function dropCardLinks(ctx: Ctx, cardId: string): void {
  const { db } = ctx;
  const links = db.prepare('SELECT id, project_id projectId FROM entry_links WHERE from_card_id=? OR to_card_id=?').all(cardId, cardId) as { id: string; projectId: string }[];
  if (!links.length) return;
  db.prepare('DELETE FROM entry_links WHERE from_card_id=? OR to_card_id=?').run(cardId, cardId);
  for (const l of links) ctx.emit('entryLink', 'remove', l);
}

/** Permission to edit a card: its deck's project, or (no deck) its creator / an admin. */
export function assertCardAccess(ctx: Ctx, card: any): void {
  const { db, actor } = ctx;
  if (card.deckId) {
    const d = deckRow(db, card.deckId);
    if (d) return assertCan(db, actor, 'content.edit', d.projectId as string);
  }
  // A deckless card belongs to no project: never writable through a project-confined token.
  if (projectConfined(actor)) throw new AppError(403, 'forbidden');
  if (can(db, actor, 'account.manage')) return;
  if (card.creatorId === actor.id && roleOf(db, actor.id) === 'member') return;
  throw new AppError(403, 'forbidden');
}

const roleOf = (db: Db, userId: string): string | null =>
  (db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(userId) as { role: string } | undefined)?.role ?? null;

/** Assignee must be an enabled, non-observer user who can view the card's project. */
export function assertAssignee(db: Db, userId: string | null | undefined, projectId: string | null): void {
  if (!userId) return;
  const bad = () => new AppError(400, 'invalid_assignee');
  const u = db.prepare('SELECT disabled d FROM users WHERE id=?').get(userId) as { d: number } | undefined;
  if (!u || u.d) throw bad();
  const role = roleOf(db, userId);
  if (!role || role === 'observer' || role === 'guest') throw bad();
  if (projectId && !can(db, { id: userId }, 'project.view', projectId)) throw bad();
}

/** A deleted card accepts only a restore. */
export function assertNotDeleted(card: any): void {
  if (card.visibility === 'deleted') throw new AppError(409, 'invalid_transition', { id: card.id });
}

export function loadCard(ctx: Ctx, id: string) {
  const c = cardRow(ctx.db, id);
  if (!c) throw new AppError(404, 'not_found');
  assertCardAccess(ctx, c);
  return c;
}

/** Idempotent card watch; the row id is deterministic. */
export function addCardWatch(ctx: Ctx, userId: string, cardId: string): string {
  const { db } = ctx;
  const r = db.prepare('INSERT OR IGNORE INTO card_subscriptions (user_id, card_id, created_at) VALUES (?,?,?)').run(userId, cardId, Date.now());
  if (r.changes) ctx.emit('cardSubscription', 'upsert', toCamel(db.prepare('SELECT * FROM card_subscriptions WHERE user_id=? AND card_id=?').get(userId, cardId) as any));
  return `${userId}|${cardId}`;
}

/** Every card write ends here, so the milestone's progress is refreshed from this one place. */
export function emitCard(ctx: Ctx, id: string): void {
  const row = cardRow(ctx.db, id)!;
  ctx.emit('card', 'upsert', row);
  markMilestone(ctx, row.milestoneId as string | null);
  markSprint(ctx, row.sprintId as string | null);
}

function checkDeckType(db: Db, deckId: string | null, isDoc: boolean): void {
  if (!deckId) return;
  const d = deckRow(db, deckId);
  if (d && d.deckType === 'doc' && !isDoc) throw new AppError(409, 'deck_type_mismatch');
}

/** Applies status / visibility transitions (validated with allowedActions). Returns history changes. */
export function applyTransition(
  ctx: Ctx, card: any, to: { status?: CardStatus; visibility?: Visibility },
): HistoryChange[] {
  const { db, actor } = ctx;
  const changes: HistoryChange[] = [];
  const bad = () => new AppError(409, 'invalid_transition', { id: card.id });
  const a = allowedActions(card, openContexts(db, card.id), { isHero: isHeroCard(db, card.id) });
  if (to.status && to.status !== card.status) {
    if (to.status === 'started') {
      if (!a.start) throw bad();
      changes.push({ kind: 'status', from: card.status, to: 'started' });
      if (!card.assigneeId) {
        db.prepare('UPDATE cards SET assignee_id=? WHERE id=?').run(actor.id, card.id);
        changes.push({ kind: 'owner', from: null, to: actor.id });
      }
      insertHand(ctx, actor.id, card.id);
    } else if (to.status === 'not_started') {
      if (!(card.status === 'started' ? a.stop : a.reopen)) throw bad();
      changes.push({ kind: 'status', from: card.status, to: 'not_started' });
    } else {
      if (!a.done) throw bad();
      assertGuardianAllows(db, actor, card, 'done');
      changes.push({ kind: 'status', from: card.status, to: 'done' });
    }
    db.prepare('UPDATE cards SET status=? WHERE id=?').run(to.status, card.id);
    if (to.status === 'done') cardDone(ctx, card.id);
    else if (card.status === 'done') cardReopened(ctx, card.id);
  }
  if (to.visibility && to.visibility !== card.visibility) {
    const ok = to.visibility === 'archived' ? a.archive
      : to.visibility === 'deleted' ? a.delete
      : card.visibility !== 'default';
    if (!ok) throw bad();
    if (to.visibility === 'archived' || to.visibility === 'deleted') assertGuardianAllows(db, actor, card, to.visibility === 'archived' ? 'archive' : 'delete');
    changes.push({ kind: 'visibility', from: card.visibility, to: to.visibility });
    db.prepare('UPDATE cards SET visibility=? WHERE id=?').run(to.visibility, card.id);
    if (to.visibility !== 'default') stopCardTimers(ctx, card.id);
    refreshCover(ctx, card.parentCardId as string | null);
    if (card.visibility === 'deleted') emitCardDependents(ctx, card.id);
    // Wiki links of a deleted card stay in the database but leave every view until it is restored.
    else if (to.visibility === 'deleted') for (const l of cardLinkRefs(db, card.id)) ctx.emit('entryLink', 'remove', l);
  }
  if (changes.length) syncHeroStatus(ctx, card.parentCardId as string | null);
  // Restored from the trash: its sub cards may have changed meanwhile, so its own status is stale.
  if (to.visibility === 'default' && card.visibility === 'deleted') syncHeroStatus(ctx, card.id);
  return changes;
}

/** A hero is any card with at least one non-deleted child. */
export const isHeroCard = (db: Db, id: string): boolean =>
  !!db.prepare("SELECT 1 FROM cards WHERE parent_card_id=? AND visibility!='deleted' LIMIT 1").get(id);

/** Non-deleted children (the ones clients see). */
const childIds = (db: Db, parentId: string): string[] =>
  (db.prepare("SELECT id FROM cards WHERE parent_card_id=? AND visibility!='deleted' ORDER BY seq").all(parentId) as { id: string }[]).map((r) => r.id);

/**
 * A hero's stored status follows its live (non-deleted) sub cards: all done (at least one) → done; any not done
 * while the hero is done → not_started (assignee kept). Records a 'status' row, emits the hero and its lock
 * neighbours, then walks up to the hero's own hero. A card with no live sub cards is left alone.
 * Deliberately bypasses the guardian rule: the hero's status is derived from its sub cards, each of which was
 * already guarded in its own deck, so nobody completes a guarded hero directly.
 */
export function syncHeroStatus(ctx: Ctx, heroId: string | null | undefined): void {
  const { db, actor } = ctx;
  const seen = new Set<string>();
  for (let cur = heroId ?? null; cur && !seen.has(cur); ) {
    seen.add(cur);
    const h = db.prepare('SELECT status, visibility, parent_card_id p FROM cards WHERE id=?').get(cur) as
      { status: CardStatus; visibility: Visibility; p: string | null } | undefined;
    if (!h || h.visibility === 'deleted') return;
    const k = db.prepare("SELECT COUNT(*) n, SUM(status='done') d FROM cards WHERE parent_card_id=? AND visibility!='deleted'")
      .get(cur) as { n: number; d: number | null };
    if (!k.n) return;
    const want: CardStatus = k.d === k.n ? 'done' : h.status === 'done' ? 'not_started' : h.status;
    if (want === h.status) return;
    db.prepare('UPDATE cards SET status=? WHERE id=?').run(want, cur);
    if (want === 'done') cardDone(ctx, cur);
    else if (h.status === 'done') cardReopened(ctx, cur);
    recordHistory(db, cur, actor.id, [{ kind: 'status', from: h.status, to: want }]);
    emitCard(ctx, cur);
    reemitDepNeighbours(ctx, cur);
    cur = h.p;
  }
}

/**
 * The card came back into view (restored, or moved into another project): clients dropped its files, personal
 * tags and deps (the snapshot leaves them out while it is deleted / elsewhere), so send them again.
 * Deps whose other end is deleted stay hidden, as in the snapshot.
 */
export function emitCardDependents(ctx: Ctx, cardId: string): void {
  const { db } = ctx;
  for (const f of db.prepare('SELECT id FROM files WHERE card_id=? ORDER BY created_at, id').all(cardId) as { id: string }[]) {
    ctx.emit('file', 'upsert', fileRow(db, f.id));
  }
  for (const t of db.prepare('SELECT * FROM user_card_tags WHERE card_id=? ORDER BY user_id, tag').all(cardId) as Record<string, unknown>[]) {
    ctx.emit('userCardTag', 'upsert', toCamel(t));
  }
  // A restored card brings its board and saved queries back.
  const board = db.prepare('SELECT id FROM vision_boards WHERE card_id=?').get(cardId) as { id: string } | undefined;
  if (board) ctx.emit('visionBoard', 'upsert', visionBoardRow(db, board.id)!);
  for (const q of db.prepare('SELECT id FROM vision_queries WHERE card_id=? ORDER BY created_at, id').all(cardId) as { id: string }[]) {
    ctx.emit('visionQuery', 'upsert', visionQueryRow(db, q.id)!);
  }
  const deps = db.prepare(`SELECT d.locked_card_id l, d.locking_card_id k FROM card_deps d
      JOIN cards a ON a.id=d.locked_card_id JOIN cards b ON b.id=d.locking_card_id
      WHERE (d.locked_card_id=? OR d.locking_card_id=?) AND a.visibility!='deleted' AND b.visibility!='deleted'`)
    .all(cardId, cardId) as { l: string; k: string }[];
  for (const d of deps) ctx.emit('cardDep', 'upsert', { lockedCardId: d.l, lockingCardId: d.k });
  // Wiki links, unless their other end is deleted too.
  for (const l of cardLinkRows(db, cardId)) ctx.emit('entryLink', 'upsert', l);
}

/** Done state or visibility changed: cards it locks, and cards locking it, have derived flags to refresh. */
export function reemitDepNeighbours(ctx: Ctx, cardId: string, except?: Set<string>): void {
  const ids = new Set<string>();
  for (const r of ctx.db.prepare('SELECT locked_card_id a, locking_card_id b FROM card_deps WHERE locking_card_id=? OR locked_card_id=?').all(cardId, cardId) as { a: string; b: string }[]) {
    ids.add(r.a); ids.add(r.b);
  }
  ids.delete(cardId);
  for (const id of ids) if (!except?.has(id)) emitCard(ctx, id);
}

/** True when `ancestor` is `id` itself or one of its parents (walks parent_card_id upward). */
function isSelfOrAncestor(db: Db, ancestor: string, id: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); ) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = (db.prepare('SELECT parent_card_id p FROM cards WHERE id=?').get(cur) as { p: string | null } | undefined)?.p ?? null;
  }
  return false;
}

/**
 * Moves cards under new parents (null = detach), recording `parent` on each child and `children` on each
 * affected parent. The card being updated (selfId) records into selfChanges and is emitted by the caller.
 */
function relink(ctx: Ctx, moves: { childId: string; to: string | null }[], selfId: string, selfChanges: HistoryChange[]): void {
  const { db, actor } = ctx;
  const parents = new Set<string>();
  const before = new Map<string, string[]>();
  const watch = (p: string | null) => { if (p && !before.has(p)) { before.set(p, childIds(db, p)); parents.add(p); } };
  const childChanges = new Map<string, HistoryChange[]>();
  for (const { childId, to } of moves) {
    const child = cardRow(db, childId);
    if (!child) throw new AppError(404, 'not_found');
    if (to === child.parentCardId) continue;
    assertCardAccess(ctx, child);
    if (to) {
      const par = cardRow(db, to);
      if (!par) throw new AppError(404, 'not_found');
      assertCardAccess(ctx, par);
      if (par.visibility === 'deleted' || child.visibility === 'deleted' || par.isDoc || child.isDoc) {
        throw new AppError(409, 'invalid_hierarchy', { id: childId });
      }
      const pp = cardProjectId(db, to);
      if (!pp || pp !== cardProjectId(db, childId)) throw new AppError(409, 'invalid_hierarchy', { id: childId, reason: 'cross_project' });
      if (isSelfOrAncestor(db, childId, to)) throw new AppError(409, 'hierarchy_cycle', { id: childId, parentCardId: to });
    }
    watch(child.parentCardId as string | null);
    watch(to);
    db.prepare('UPDATE cards SET parent_card_id=? WHERE id=?').run(to, childId);
    childChanges.set(childId, [{ kind: 'parent', from: child.parentCardId, to }]);
  }
  const done = (id: string, ch: HistoryChange[]) => {
    if (id === selfId) selfChanges.push(...ch);
    else { recordHistory(db, id, actor.id, ch); emitCard(ctx, id); }
  };
  for (const [id, ch] of childChanges) done(id, ch);
  for (const p of parents) refreshCover(ctx, p);
  for (const p of parents) {
    const after = childIds(db, p);
    const was = before.get(p)!;
    if (after.length !== was.length || after.some((x, i) => x !== was[i])) done(p, [{ kind: 'children', from: was, to: after }]);
  }
  for (const p of parents) syncHeroStatus(ctx, p);
}

/** A card left its project: drop its parent link, its children and every dependency in both directions. */
function clearRelations(ctx: Ctx, card: any, changes: HistoryChange[]): void {
  const { db, actor } = ctx;
  const kids = (db.prepare('SELECT id FROM cards WHERE parent_card_id=?').all(card.id) as { id: string }[]).map((r) => r.id);
  if (card.parentCardId || kids.length) {
    relink(ctx, [...(card.parentCardId ? [{ childId: card.id, to: null }] : []), ...kids.map((childId) => ({ childId, to: null }))], card.id, changes);
  }
  const lockers = (db.prepare('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=? ORDER BY locking_card_id').all(card.id) as { l: string }[]).map((r) => r.l);
  const locked = (db.prepare('SELECT locked_card_id l FROM card_deps WHERE locking_card_id=?').all(card.id) as { l: string }[]).map((r) => r.l);
  const depsOf = (id: string) => (db.prepare('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=? ORDER BY locking_card_id').all(id) as { l: string }[]).map((r) => r.l);
  const lockedOld = new Map(locked.map((id) => [id, depsOf(id)]));
  if (!lockers.length && !locked.length) return;
  db.prepare('DELETE FROM card_deps WHERE locked_card_id=? OR locking_card_id=?').run(card.id, card.id);
  for (const l of lockers) { ctx.emit('cardDep', 'remove', { lockedCardId: card.id, lockingCardId: l }); emitCard(ctx, l); }
  if (lockers.length) changes.push({ kind: 'deps', from: lockers, to: [] });
  for (const l of locked) {
    ctx.emit('cardDep', 'remove', { lockedCardId: l, lockingCardId: card.id });
    recordHistory(db, l, actor.id, [{ kind: 'deps', from: lockedOld.get(l), to: depsOf(l) }]);
    emitCard(ctx, l);
  }
}

/** Replaces the card's locking cards; needs the feature flag, visible lockers, and no cycles. */
function setInDeps(ctx: Ctx, card: any, wanted: string[], changes: HistoryChange[]): void {
  const { db, actor } = ctx;
  if (!(accountRow(db).settings as { dependenciesEnabled?: boolean }).dependenciesEnabled) throw new AppError(409, 'feature_disabled', { feature: 'dependencies' });
  const next = uniq(wanted);
  // Without the plan feature existing dependencies stay and can be removed, but none are added.
  const had = new Set((db.prepare('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=?').all(card.id) as { l: string }[]).map((r) => r.l));
  if (next.some((l) => !had.has(l))) assertFeature(db, 'dependencies');
  for (const lid of next) {
    const l = cardRow(db, lid);
    if (!l || !canSeeCard(db, actor, l as any, l.deckId ? cardProjectId(db, lid) : null)) throw new AppError(404, 'not_found');
    if (lid === card.id) throw new AppError(409, 'dependency_cycle', { id: lid });
    const cp = cardProjectId(db, card.id);
    if (l.visibility === 'deleted' || !cp || cardProjectId(db, lid) !== cp) throw new AppError(409, 'invalid_dependency', { id: lid });
    // Cycle when the locked card already (transitively) locks this locker: walk lockers upward from it.
    const seen = new Set<string>([lid]);
    const stack = [lid];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const r of db.prepare('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=?').all(cur) as { l: string }[]) {
        if (r.l === card.id) throw new AppError(409, 'dependency_cycle', { id: lid });
        if (!seen.has(r.l)) { seen.add(r.l); stack.push(r.l); }
      }
    }
  }
  const old = (db.prepare('SELECT locking_card_id l FROM card_deps WHERE locked_card_id=? ORDER BY locking_card_id').all(card.id) as { l: string }[]).map((r) => r.l);
  const sorted = [...next].sort();
  if (old.length === sorted.length && old.every((x, i) => x === sorted[i])) return;
  for (const l of old.filter((x) => !next.includes(x))) {
    db.prepare('DELETE FROM card_deps WHERE locked_card_id=? AND locking_card_id=?').run(card.id, l);
    ctx.emit('cardDep', 'remove', { lockedCardId: card.id, lockingCardId: l });
    emitCard(ctx, l);
  }
  for (const l of next.filter((x) => !old.includes(x))) {
    db.prepare('INSERT INTO card_deps (locked_card_id, locking_card_id) VALUES (?,?)').run(card.id, l);
    ctx.emit('cardDep', 'upsert', { lockedCardId: card.id, lockingCardId: l });
    emitCard(ctx, l);
  }
  changes.push({ kind: 'deps', from: old, to: sorted });
}

export const prioritySchema = z.enum(['a', 'b', 'c']);
export const effortSchema = z.number().finite().min(0);
export const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const t = new Date(s + 'T00:00:00Z').getTime(); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; }, 'bad date');
export const tagNamesSchema = z.array(z.string()).max(100);

/** The server's local calendar day (YYYY-MM-DD) from the injectable clock, shifted back `daysAgo` days. */
export function localDay(daysAgo = 0): string {
  const d = new Date(clockNow());
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Due dates may not be in the past; yesterday is accepted to allow for timezone differences. */
export function assertDueDate(db: Db, day: string | null): void {
  if (day === null) return;
  if (!(accountRow(db).settings as { dueDateEnabled?: boolean }).dueDateEnabled) throw new AppError(409, 'feature_disabled', { feature: 'dueDate' });
  assertFeature(db, 'dueDates');
  if (isPastDate(day, localDay(1))) throw new AppError(400, 'past_date');
}

export const projectTagNames = (db: Db, projectId: string | null): Set<string> =>
  new Set(projectId ? ((projectRow(db, projectId)?.tags ?? []) as ProjectTag[]).map((t) => t.name) : []);

/** Every name must be a tag of the project. */
export function assertKnownTags(db: Db, projectId: string | null, names: string[]): void {
  const known = projectTagNames(db, projectId);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw new AppError(400, 'unknown_tag', { tags: unknown });
}

const uniq = (a: string[]) => [...new Set(a)];

/** Tags, mentions and checkbox stats derived from content; inline #tags naming a project tag join masterTags. */
export function deriveContent(db: Db, content: string, projectId: string | null) {
  const p = parseContent(content);
  const byName = handleMap(db);
  const mentionedUserIds = uniq(p.mentions.map((m) => byName.get(m.normalize('NFC').toLowerCase())).filter((x): x is string => !!x));
  const known = projectTagNames(db, projectId);
  return { tags: p.tags, mentionedUserIds, checkboxStats: p.checkboxStats, inlineMaster: p.tags.filter((t) => known.has(t)) };
}

export const writeDerived = (db: Db, id: string, d: ReturnType<typeof deriveContent>, masterTags: string[]) =>
  db.prepare('UPDATE cards SET tags_json=?, mentioned_user_ids_json=?, checkbox_stats_json=?, master_tags_json=? WHERE id=?')
    .run(JSON.stringify(d.tags), JSON.stringify(d.mentionedUserIds), d.checkboxStats ? JSON.stringify(d.checkboxStats) : null, JSON.stringify(masterTags), id);

/** A deck's default card must stay in that deck and visible; otherwise the deck loses it. */
export function releaseTemplate(ctx: Ctx, cardId: string): void {
  const { db } = ctx;
  const decks = db.prepare(`SELECT d.id id FROM decks d JOIN cards c ON c.id=d.default_card_id
    WHERE d.default_card_id=? AND (c.deck_id IS NOT d.id OR c.visibility != 'default')`).all(cardId) as { id: string }[];
  for (const d of decks) {
    db.prepare('UPDATE decks SET default_card_id=NULL WHERE id=?').run(d.id);
    ctx.emit('deck', 'upsert', deckRow(db, d.id)!);
  }
}

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const nextSort = (db: Db, deckId: string) =>
  ((db.prepare('SELECT MAX(sort_index) m FROM cards WHERE deck_id=?').get(deckId) as { m: number | null }).m ?? 0) + 1;

export type CardPatch = {
  content?: string; contentVersion?: number; deckId?: string; assigneeId?: string | null; isDoc?: boolean;
  status?: CardStatus; visibility?: Visibility; priority?: string | null; effort?: number | null; masterTags?: string[];
  dueDate?: string | null; childCards?: string[]; parentCardId?: string | null; inDeps?: string[];
  milestoneId?: string | null; milestoneZoneId?: string | null; sprintId?: string | null;
};

/** Everything `cards/update` does to one loaded (access-checked) card; `cards/bulkUpdate` reuses it per card. */
export function applyCardUpdate(ctx: Ctx, card: any, input: CardPatch): void {
  const { db, actor } = ctx;
  if (card.visibility === 'deleted') {
    const { visibility: v, ...rest } = input;
    if (v !== 'default' || Object.values(rest).some((x) => x !== undefined)) assertNotDeleted(card);
  }
  const changes: HistoryChange[] = [];
  let deckId: string | null = card.deckId;
  let isDoc: boolean = card.isDoc;
  if (input.deckId !== undefined && input.deckId !== card.deckId) {
    const d = deckRow(db, input.deckId);
    if (!d) throw new AppError(404, 'not_found');
    assertCan(db, actor, 'content.edit', d.projectId as string);
    assertGuardianAllows(db, actor, card, 'moveOut');
    changes.push({ kind: 'deck', from: card.deckId, to: input.deckId });
    deckId = input.deckId;
  }
  if (input.isDoc !== undefined && input.isDoc !== card.isDoc) {
    changes.push({ kind: 'doc', from: card.isDoc, to: input.isDoc });
    isDoc = input.isDoc;
  }
  // A typed wiki entry stays Lore of its type's project: its type, key and references only make sense there. Measured
  // against the type, so an entry left without a deck (deck deleted) can still move back into its project.
  if (card.entryTypeId && (!isDoc || (deckId !== card.deckId && entryTypeProject(db, card.entryTypeId) !== deckRow(db, deckId!)?.projectId))) {
    throw new AppError(409, 'entry_typed', { id: card.id });
  }
  if (deckId !== card.deckId || isDoc !== card.isDoc) checkDeckType(db, deckId, isDoc);
  if (isDoc && (input.childCards?.length || input.parentCardId)) throw new AppError(409, 'invalid_hierarchy', { id: card.id });
  if (isDoc && !card.isDoc && (card.parentCardId || isHeroCard(db, card.id))) throw new AppError(409, 'invalid_hierarchy', { id: card.id });
  let content: string = card.content;
  let contentVersion: number = card.contentVersion;
  if (input.content !== undefined && input.content !== card.content) {
    if (input.contentVersion === undefined) throw new AppError(400, 'invalid_payload', { field: 'contentVersion' });
    if (input.contentVersion !== card.contentVersion) throw new AppError(409, 'conflict', card);
    const [ot, nt] = [titleOf(card.content), titleOf(input.content)];
    changes.push(ot !== nt ? { kind: 'title', from: ot, to: nt } : { kind: 'content' });
    content = input.content;
    contentVersion++;
  } else if (input.content !== undefined && input.contentVersion !== undefined && input.contentVersion !== card.contentVersion) {
    throw new AppError(409, 'conflict', card);
  }
  const oldProjectId = card.deckId ? (deckRow(db, card.deckId)?.projectId as string | undefined) ?? null : null;
  const newProjectId = deckId ? (deckRow(db, deckId)!.projectId as string) : null;
  let assigneeId: string | null = card.assigneeId;
  if (input.assigneeId !== undefined && input.assigneeId !== card.assigneeId) {
    changes.push({ kind: 'owner', from: card.assigneeId, to: input.assigneeId });
    assigneeId = input.assigneeId;
  }
  // A new owner, or a kept owner after a deck move, must be able to see the card's project.
  if (assigneeId !== card.assigneeId || deckId !== card.deckId) assertAssignee(db, assigneeId, newProjectId);
  const sortIndex = deckId !== card.deckId && deckId ? nextSort(db, deckId) : card.sortIndex;
  // Properties.
  let priority: string | null = card.priority;
  if (input.priority !== undefined && input.priority !== card.priority) {
    changes.push({ kind: 'priority', from: card.priority, to: input.priority });
    priority = input.priority;
  }
  let effort: number | null = card.effort;
  if (input.effort !== undefined && input.effort !== card.effort) {
    changes.push({ kind: 'effort', from: card.effort, to: input.effort });
    effort = input.effort;
  }
  let dueDate: string | null = card.dueDate;
  if (input.dueDate !== undefined && input.dueDate !== card.dueDate) {
    // Re-sending the stored date is no new write (API clients send whole cards): only a change is checked.
    assertDueDate(db, input.dueDate);
    changes.push({ kind: 'dueDate', from: card.dueDate, to: input.dueDate });
    dueDate = input.dueDate;
  }
  const oldTags: string[] = card.masterTags;
  let masterTags = oldTags;
  const newKnown = projectTagNames(db, newProjectId);
  if (input.masterTags !== undefined) {
    assertKnownTags(db, newProjectId, input.masterTags);
    masterTags = input.masterTags;
  } else if (newProjectId !== oldProjectId) {
    masterTags = masterTags.filter((t) => newKnown.has(t));
  }
  const derived = deriveContent(db, content, newProjectId);
  if (content !== card.content) masterTags = uniq([...masterTags, ...derived.inlineMaster]);
  if (deckId !== card.deckId && deckId) {
    const at = deckRow(db, deckId)!.autoTag as string | null;
    if (at && newKnown.has(at)) masterTags = uniq([...masterTags, at]);
  }
  if (!sameTags(masterTags, oldTags)) changes.push({ kind: 'tags', from: oldTags, to: masterTags });
  // Milestone: a move into a deck with an Auto Milestone fills an empty one.
  const cur = { milestoneId: card.milestoneId as string | null, zoneId: card.milestoneZoneId as string | null };
  if (input.milestoneId || input.milestoneZoneId) assertEnabled(db);
  let ms = resolveCardMilestone(db, newProjectId, cur, input);
  if (deckId !== card.deckId && deckId && !ms.milestoneId && input.milestoneId === undefined) {
    const am = deckRow(db, deckId)!.autoMilestoneId as string | null;
    if (am && newProjectId && milestoneCovers(db, am, newProjectId)) ms = { milestoneId: am, zoneId: null };
  }
  if (ms.milestoneId !== cur.milestoneId) changes.push({ kind: 'milestone', from: cur.milestoneId, to: ms.milestoneId });
  else if (ms.zoneId !== cur.zoneId) changes.push({ kind: 'milestoneZone', from: cur.zoneId, to: ms.zoneId });
  const curSprint = card.sprintId as string | null;
  if (input.sprintId) assertSprints(db);
  const sprintId = resolveCardSprint(db, newProjectId, curSprint, input);
  if (sprintId !== curSprint) changes.push({ kind: 'sprint', from: curSprint, to: sprintId });
  db.prepare('UPDATE cards SET deck_id=?, is_doc=?, content=?, content_version=?, assignee_id=?, sort_index=?, priority=?, effort=?, due_date=?, milestone_id=?, milestone_zone_id=?, sprint_id=? WHERE id=?')
    .run(deckId, isDoc ? 1 : 0, content, contentVersion, assigneeId, sortIndex, priority, effort, dueDate, ms.milestoneId, ms.zoneId, sprintId, card.id);
  // A hand-made run change starts the card fresh in that run (or out of any run).
  if (sprintId !== curSprint) db.prepare('UPDATE cards SET sprint_joined_at=?, carry_count=0 WHERE id=?').run(sprintId ? Date.now() : null, card.id);
  writeDerived(db, card.id, derived, masterTags);
  // Hierarchy and dependencies run on the written row, so they see the new deck and doc flag.
  if (oldProjectId !== newProjectId) clearRelations(ctx, card, changes);
  // Wiki links stay inside one project, and only cards are works_on sources: leaving either loses them.
  if (oldProjectId !== newProjectId || !!card.isDoc !== isDoc) dropCardLinks(ctx, card.id);
  if (input.childCards !== undefined) {
    const want = uniq(input.childCards);
    const moves = [
      ...childIds(db, card.id).filter((c) => !want.includes(c)).map((childId) => ({ childId, to: null })),
      ...want.map((childId) => ({ childId, to: card.id as string | null })),
    ];
    relink(ctx, moves, card.id, changes);
  }
  if (input.parentCardId !== undefined) relink(ctx, [{ childId: card.id, to: input.parentCardId }], card.id, changes);
  if (input.inDeps !== undefined) setInDeps(ctx, card, input.inDeps, changes);
  const unfiled = oldProjectId !== newProjectId || (card.isDoc && !isDoc) ? leaveWiki(ctx, card, newProjectId, isDoc, changes) : [];
  if (assigneeId && assigneeId !== card.assigneeId) handSyncOwner(ctx, card.id);
  const fresh = cardRow(db, card.id)!;
  const moved = applyTransition(ctx, fresh, { status: input.status, visibility: input.visibility });
  changes.push(...moved);
  recordHistory(db, card.id, actor.id, changes);
  releaseTemplate(ctx, card.id);
  // Viewers of the old project who can't see the new one must drop their copy.
  if (oldProjectId && oldProjectId !== newProjectId) ctx.emit('card', 'remove', { id: card.id, projectId: oldProjectId });
  emitCard(ctx, card.id);
  // The old milestone lost this card (or its project): recount it too.
  if ((cur.milestoneId && cur.milestoneId !== ms.milestoneId) || oldProjectId !== newProjectId) markMilestone(ctx, cur.milestoneId);
  if (curSprint && curSprint !== sprintId) markSprint(ctx, curSprint);
  if (newProjectId && oldProjectId !== newProjectId) emitCardDependents(ctx, card.id);
  for (const id of unfiled) emitCard(ctx, id);
  if (moved.length) reemitDepNeighbours(ctx, card.id);
}

const entryTypeProject = (db: Db, typeId: string): string | undefined =>
  (db.prepare('SELECT project_id p FROM entry_types WHERE id=?').get(typeId) as { p: string } | undefined)?.p;

/**
 * Lore that changes project (or comes back into one) or becomes a card: its wiki parent and its children's links
 * are cleared where they would cross projects (all of them for a card), and in a new project a clashing key is
 * replaced. Returns the unfiled children, for the caller to emit.
 */
function leaveWiki(ctx: Ctx, card: any, newProjectId: string | null, isDoc: boolean, changes: HistoryChange[]): string[] {
  const { db } = ctx;
  // The project whose wiki the card is in now (none for a card). Links to pages of another project go; a page with
  // no deck (trashed with its deck) keeps its link, checked again when it comes back. So lore restored from a
  // deleted deck into its own project keeps its tree.
  const stay = isDoc ? newProjectId : null;
  const campaignOf = (id: string): string | null => (db.prepare('SELECT d.project_id p FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=?').get(id) as { p: string } | undefined)?.p ?? null;
  const children = (stay
    ? db.prepare('SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.wiki_parent_id=? AND d.project_id!=?').all(card.id, stay)
    : db.prepare('SELECT id FROM cards WHERE wiki_parent_id=?').all(card.id)) as { id: string }[];
  const unfile = db.prepare('UPDATE cards SET wiki_parent_id=NULL WHERE id=?');
  for (const c of children) unfile.run(c.id);
  const parent: string | null = card.wikiParentId && stay && campaignOf(card.wikiParentId) === stay ? card.wikiParentId : null;
  if (card.wikiParentId && !parent) unfile.run(card.id);
  let key: string | null = card.entryKey;
  const oldProjectId = card.deckId ? (deckRow(db, card.deckId)?.projectId as string | undefined) ?? null : null;
  if (key && newProjectId && newProjectId !== oldProjectId) {
    const taken = new Set((db.prepare('SELECT c.entry_key k FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.entry_key IS NOT NULL AND c.id!=?')
      .all(newProjectId, card.id) as { k: string }[]).map((r) => r.k));
    if (taken.has(key)) {
      key = keyFromName(key, taken);
      db.prepare('UPDATE cards SET entry_key=? WHERE id=?').run(key, card.id);
    }
  }
  changes.push(...entryChange([], { parent: { from: card.wikiParentId, to: parent }, key: { from: card.entryKey, to: key } }));
  return children.map((c) => c.id);
}

const createSchema = z.object({
  content: z.string(),
  deckId: z.string(),
  assigneeId: z.string().nullable().optional(),
  putInQueue: z.boolean().optional(),
  isDoc: z.boolean().optional(),
  priority: prioritySchema.nullable().optional(),
  effort: effortSchema.nullable().optional(),
  masterTags: tagNamesSchema.optional(),
  dueDate: dueDateSchema.nullable().optional(),
  parentCardId: z.string().nullable().optional(),
  presetId: z.string().optional(),
  subscribeCreator: z.boolean().optional(),
});
type CreateInput = z.infer<typeof createSchema>;

/** Everything `cards/create` does for one card (checks, defaults, deck automations, history, events); `cards/bulkImport` reuses it per row. */
export function createCard(ctx: Ctx, input: CreateInput): { id: string; accountSeq: number } {
  const { db, actor } = ctx;
  const deck = deckRow(db, input.deckId);
  if (!deck) throw new AppError(404, 'not_found');
  const projectId = deck.projectId as string;
  assertCan(db, actor, 'content.edit', projectId);
  // Later wins: the deck's default card, then the preset, then the explicit fields.
  const known = projectTagNames(db, projectId);
  let content = '';
  let priority: string | null = null;
  let effort: number | null = null;
  let masterTags: string[] = [];
  let assigneeId: string | null | undefined;
  const apply = (d: { content?: string; priority?: string | null; effort?: number | null; masterTags?: string[]; assigneeId?: string | null }) => {
    if (d.content) content = d.content;
    if (d.priority !== undefined) priority = d.priority;
    if (d.effort !== undefined) effort = d.effort;
    if (d.masterTags) masterTags = d.masterTags.filter((t) => known.has(t));
    if (d.assigneeId) {
      try { assertAssignee(db, d.assigneeId, projectId); assigneeId = d.assigneeId; } catch { /* stale template owner */ }
    }
  };
  const tplRow = deck.defaultCardId ? cardRow(db, deck.defaultCardId as string) : undefined;
  const tpl = tplRow && tplRow.deckId === deck.id && tplRow.visibility === 'default' ? tplRow : undefined;
  if (tpl) apply({ content: tpl.content as string, priority: tpl.priority as string | null, effort: tpl.effort as number | null, masterTags: tpl.masterTags as string[] });
  if (input.presetId !== undefined) {
    const pr = db.prepare('SELECT data_json d FROM card_presets WHERE id=?').get(input.presetId) as { d: string } | undefined;
    if (!pr) throw new AppError(404, 'not_found');
    apply(JSON.parse(pr.d));
  }
  if (input.assigneeId !== undefined) assigneeId = input.assigneeId;
  assertAssignee(db, assigneeId, projectId);
  if (input.content) content = input.content;
  if (input.priority !== undefined) priority = input.priority;
  if (input.effort !== undefined) effort = input.effort;
  if (input.masterTags !== undefined) { assertKnownTags(db, projectId, input.masterTags); masterTags = input.masterTags; }
  const dueDate = input.dueDate ?? null;
  assertDueDate(db, dueDate);
  if (input.parentCardId) {
    const par = cardRow(db, input.parentCardId);
    const parDeck = par?.deckId ? deckRow(db, par.deckId as string) : undefined;
    if (!par || parDeck?.projectId !== projectId) throw new AppError(400, 'invalid_payload', { field: 'parentCardId' });
    if (par.isDoc || par.visibility === 'deleted') throw new AppError(409, 'invalid_hierarchy', { id: input.parentCardId });
  }
  const derived = deriveContent(db, content, projectId);
  // Text from the system actor comes from anonymous reporters (user reports): it may not @mention anyone.
  if (actor.via === 'system') derived.mentionedUserIds = [];
  masterTags = uniq([...masterTags, ...derived.inlineMaster]);
  if (deck.autoTag && known.has(deck.autoTag as string)) masterTags = uniq([...masterTags, deck.autoTag as string]);
  const isDoc = input.isDoc ?? deck.deckType === 'doc';
  checkDeckType(db, input.deckId, isDoc);
  if (input.parentCardId && isDoc) throw new AppError(409, 'invalid_hierarchy');
  db.prepare('UPDATE account SET card_seq = card_seq + 1').run();
  const seq = (db.prepare('SELECT card_seq s FROM account').get() as { s: number }).s;
  const id = newId();
  const now = Date.now();
  const autoMilestone = deck.autoMilestoneId && milestoneCovers(db, deck.autoMilestoneId as string, projectId) ? deck.autoMilestoneId as string : null;
  db.prepare(`INSERT INTO cards (id,seq,deck_id,creator_id,assignee_id,content,status,visibility,is_doc,version,content_version,sort_index,created_at,last_updated_at,priority,effort,due_date,parent_card_id)
              VALUES (?,?,?,?,?,?,'not_started','default',?,0,1,?,?,?,?,?,?,?)`)
    .run(id, seq, input.deckId, actor.id, assigneeId ?? null, content, isDoc ? 1 : 0, nextSort(db, input.deckId), now, now,
      priority, effort, dueDate, input.parentCardId ?? null);
  writeDerived(db, id, derived, masterTags);
  if (autoMilestone) db.prepare('UPDATE cards SET milestone_id=? WHERE id=?').run(autoMilestone, id);
  recordHistory(db, id, actor.id, [{ kind: 'created' }, ...(input.parentCardId ? [{ kind: 'parent' as const, from: null, to: input.parentCardId }] : [])]);
  if (input.parentCardId) {
    recordHistory(db, input.parentCardId, actor.id, [{ kind: 'children', from: childIds(db, input.parentCardId).filter((c) => c !== id), to: childIds(db, input.parentCardId) }]);
    emitCard(ctx, input.parentCardId);
    refreshCover(ctx, input.parentCardId);
    syncHeroStatus(ctx, input.parentCardId);
  }
  if (input.subscribeCreator) addCardWatch(ctx, actor.id, id);
  if (input.putInQueue) insertHand(ctx, assigneeId ?? actor.id, id);
  else if (assigneeId) handSyncOwner(ctx, id);
  emitCard(ctx, id);
  return { id, accountSeq: seq };
}

/** Tag names as stored (normalized, de-duplicated, unusable names dropped). */
export const tagsOf = (names: string[] | undefined): string[] =>
  uniq((names ?? []).map(normalizeTagName).filter((n): n is string => n !== null));

/** Adds the (normalized) tag names the project lacks; 400 too_many_tags past 100 tags. Imports use it before creating cards. */
export function ensureProjectTags(ctx: Ctx, projectId: string, names: string[]): void {
  const { db } = ctx;
  const project = projectRow(db, projectId)!;
  const have = new Set((project.tags as ProjectTag[]).map((t) => t.name));
  const missing = uniq(names).filter((n) => !have.has(n));
  if (!missing.length) return;
  const tags = [...(project.tags as ProjectTag[]), ...missing.map((name) => ({ name, emoji: null }))];
  if (tags.length > 100) throw new AppError(400, 'too_many_tags', { max: 100 });
  db.prepare('UPDATE projects SET tags_json=? WHERE id=?').run(JSON.stringify(tags), projectId);
  ctx.emit('project', 'upsert', projectRow(db, projectId)!);
}

const bulkImportSchema = z.object({
  deckId: z.string(),
  cards: z.array(z.object({
    content: z.string().max(200_000),
    priority: prioritySchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
    status: z.enum(['started', 'done', 'doc', 'archived']).optional(),
    assigneeId: z.string().nullable().optional(),
    masterTags: z.array(z.string().max(200)).max(100).optional(),
  })).min(1).max(2000),
});

export const cardCommands: Record<string, Command> = {
  'cards/create': {
    schema: createSchema,
    run: createCard,
  },

  /**
   * CSV import (the browser parses and maps the file). One transaction, so a failing row imports nothing. Each row goes
   * through the same path as cards/create (checks, deck automations, history, events); tags the project lacks are
   * created first. `status` omitted means a plain card; 'doc' makes a doc card; 'archived' archives it. Returns
   * `{count, ids}` (ids in row order).
   */
  'cards/bulkImport': {
    schema: bulkImportSchema,
    run(ctx, input: z.infer<typeof bulkImportSchema>) {
      const { db, actor } = ctx;
      const deck = deckRow(db, input.deckId);
      if (!deck) throw new AppError(404, 'not_found');
      const projectId = deck.projectId as string;
      assertCan(db, actor, 'content.edit', projectId);
      ensureProjectTags(ctx, projectId, input.cards.flatMap((c) => tagsOf(c.masterTags)));
      const ids: string[] = [];
      for (const c of input.cards) {
        const { id } = createCard(ctx, {
          content: c.content, deckId: input.deckId, priority: c.priority, effort: c.effort, assigneeId: c.assigneeId,
          masterTags: tagsOf(c.masterTags), isDoc: c.status === 'doc' ? true : undefined,
        });
        ids.push(id);
        if (c.status !== 'started' && c.status !== 'done' && c.status !== 'archived') continue;
        const changes = applyTransition(ctx, cardRow(db, id), c.status === 'archived' ? { visibility: 'archived' } : { status: c.status });
        recordHistory(db, id, actor.id, changes);
        emitCard(ctx, id);
      }
      return { count: input.cards.length, ids };
    },
  },

  'cards/update': {
    schema: z.object({
      id: z.string(),
      content: z.string().optional(),
      contentVersion: z.number().int().optional(),
      deckId: z.string().optional(),
      assigneeId: z.string().nullable().optional(),
      isDoc: z.boolean().optional(),
      status: status.optional(),
      visibility: visibility.optional(),
      priority: prioritySchema.nullable().optional(),
      effort: effortSchema.nullable().optional(),
      masterTags: tagNamesSchema.optional(),
      dueDate: dueDateSchema.nullable().optional(),
      childCards: z.array(z.string()).max(500).optional(),
      parentCardId: z.string().nullable().optional(),
      inDeps: z.array(z.string()).max(200).optional(),
      milestoneId: z.string().nullable().optional(),
      milestoneZoneId: z.string().nullable().optional(),
      sprintId: z.string().nullable().optional(),
    }),
    run(ctx, input) {
      const { id, ...patch } = input;
      applyCardUpdate(ctx, loadCard(ctx, id), patch);
    },
  },

  'cards/removeFile': {
    schema: z.object({ fileId: z.string() }),
    run(ctx, { fileId }) {
      const { db } = ctx;
      const f = fileRow(db, fileId);
      if (!f) throw new AppError(404, 'not_found');
      const card = loadCard(ctx, f.cardId);
      assertNotDeleted(card);
      db.prepare('DELETE FROM files WHERE id=?').run(fileId);
      ctx.emit('file', 'remove', { id: fileId, cardId: f.cardId });
      recordHistory(db, f.cardId, ctx.actor.id, [{ kind: 'file', from: f.name, to: null }]);
      if (!refreshCover(ctx, f.cardId)) emitCard(ctx, f.cardId);
      ctx.afterCommit(() => unlinkFiles(db, [fileId]));
    },
  },

  'users/setCardTags': {
    schema: z.object({ cardId: z.string(), tags: z.array(z.string().trim().min(1).max(64)).max(50) }),
    run(ctx, { cardId, tags }) {
      const { db, actor } = ctx;
      const c = cardRow(db, cardId);
      if (!c || !canSeeCard(db, actor, c as any, c.deckId ? cardProjectId(db, cardId) : null)) throw new AppError(404, 'not_found');
      const next = uniq(tags);
      const old = (db.prepare('SELECT tag FROM user_card_tags WHERE user_id=? AND card_id=?').all(actor.id, cardId) as { tag: string }[]).map((r) => r.tag);
      for (const t of old.filter((t) => !next.includes(t))) {
        db.prepare('DELETE FROM user_card_tags WHERE user_id=? AND card_id=? AND tag=?').run(actor.id, cardId, t);
        ctx.emit('userCardTag', 'remove', { userId: actor.id, cardId, tag: t });
      }
      for (const t of next.filter((t) => !old.includes(t))) {
        db.prepare('INSERT INTO user_card_tags (user_id,card_id,tag) VALUES (?,?,?)').run(actor.id, cardId, t);
        ctx.emit('userCardTag', 'upsert', { userId: actor.id, cardId, tag: t });
      }
    },
  },

  'cards/bulkUpdate': {
    schema: z.object({
      ids: z.array(z.string()).min(1).max(500).refine((a) => new Set(a).size === a.length, 'ids must be unique'),
      status: status.optional(),
      visibility: visibility.optional(),
      assigneeId: z.string().nullable().optional(),
      priority: prioritySchema.nullable().optional(),
      effort: effortSchema.nullable().optional(),
      milestoneId: z.string().nullable().optional(),
      sprintId: z.string().nullable().optional(),
      deckId: z.string().optional(),
      addMasterTags: tagNamesSchema.optional(),
      removeMasterTags: tagNamesSchema.optional(),
    }).refine(({ ids, ...rest }) => Object.values(rest).some((v) => v !== undefined), 'at least one change is required'),
    run(ctx, input) {
      // All or nothing: the first card that fails throws, and the dispatch transaction rolls everything back.
      const { ids, addMasterTags, removeMasterTags, ...patch } = input;
      for (const id of ids) {
        const card = loadCard(ctx, id);
        const p: CardPatch = { ...patch };
        if (addMasterTags !== undefined || removeMasterTags !== undefined) {
          const drop = new Set(removeMasterTags ?? []);
          p.masterTags = uniq([...(card.masterTags as string[]), ...(addMasterTags ?? [])]).filter((t) => !drop.has(t));
        }
        applyCardUpdate(ctx, card, p);
      }
    },
  },
};

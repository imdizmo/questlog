import type { Db } from './db';
import { toCamel } from './db';
import { can, plainUser, visibleProjectIds, type Actor, type Who } from './permissions';
import { apiTokenRow } from './tokens';
import { canSeeCard } from './access';
import { donePileCutoff } from './commands/hand';
import { shape } from './commands/time';
import { CARD_SELECT, accountRow } from './commands/rows';
import { todayLocal } from './commands/milestones';
import { addDays } from '../shared/schedule';
import type { User } from '../shared/types';

const rows = (db: Db, sql: string, ...a: any[]) =>
  (db.prepare(sql).all(...a) as Record<string, unknown>[]).map((r) => toCamel<any>(r));
/** Days of progress history sent to the client. */
const PROGRESS_DAYS = 60;
/** Finished runs older than this stay out of the snapshot. */
const SPRINT_KEEP_DAYS = 90;
/** Time segments sent to the client: those that started in this window, plus any running one. */
const TIME_KEEP_DAYS = 30;
/** Hard cap on segments per snapshot, newest first. */
const TIME_MAX_ROWS = 2000;
const marks = (n: number) => Array(n).fill('?').join(',');

/**
 * The card visibility rule as a predicate over the cards row alias `c`: cards of the given visible projects, plus
 * deckless cards for their creator / admins (the same rule as canSeeCard, evaluated once for this user). Deleted cards
 * never. Shared by the snapshot (as cardScopeSql) and the read query API (per row, no id set to build).
 */
export function cardVisibleSql(db: Db, me: Who, vis: string[], c = 'c'): { sql: string; args: string[] } {
  const allDeckless = can(db, me, 'account.manage');
  const ownDeckless = canSeeCard(db, me, { deckId: null, creatorId: me.id }, null);
  const sql = `${c}.visibility != 'deleted' AND (
      ${c}.deck_id IN (SELECT id FROM decks WHERE project_id IN (${marks(vis.length)}))
      OR (${c}.deck_id IS NULL AND (${allDeckless ? 1 : 0} OR (${ownDeckless ? 1 : 0} AND ${c}.creator_id = ?))))`;
  return { sql, args: [...vis, me.id] };
}

/** Ids of the cards `me` may see, as a subquery with its arguments (cardVisibleSql). */
export function cardScopeSql(db: Db, me: Who, vis: string[]): { sql: string; args: string[] } {
  const p = cardVisibleSql(db, me, vis, 'c');
  return { sql: `SELECT c.id FROM cards c WHERE ${p.sql}`, args: p.args };
}

/** API tokens `me` may list: admins all of them, members their own personal tokens, token actors none (no token management). */
function visibleTokens(db: Db, me: User | Actor) {
  if ((me as Actor).via === 'token') return [];
  const all = can(db, me, 'account.manage');
  return (all
    ? db.prepare('SELECT * FROM api_tokens ORDER BY created_at, id').all()
    : db.prepare("SELECT * FROM api_tokens WHERE kind='user' AND user_id=? ORDER BY created_at, id").all(me.id)
  ).map((r) => apiTokenRow(r as Record<string, unknown>));
}

/** My completed card steps (never anyone else's). */
const onboardingRows = (db: Db, me: User | Actor) =>
  rows(db, 'SELECT step, info_json, completed_at FROM user_onboarding WHERE user_id=? ORDER BY completed_at, step', me.id)
    .map((r: any) => ({ userId: me.id, step: r.step, stepInfo: r.infoJson ? JSON.parse(r.infoJson) : null, completedAt: r.completedAt }));

const withEmails = (db: Db, me: User | Actor) => {
  const via = (me as Partial<Actor>).via;
  return via === undefined || via === 'session' || can(db, me, 'account.manage');
};

export function buildSnapshot(db: Db, me: User | Actor) {
  const vis = [...visibleProjectIds(db, me)];
  const pq = marks(vis.length);
  const projects = vis.length ? rows(db, `SELECT * FROM projects WHERE id IN (${pq}) ORDER BY seq`, ...vis) : [];
  const projectAccess = vis.length ? rows(db, `SELECT * FROM project_access WHERE project_id IN (${pq})`, ...vis) : [];
  const decks = vis.length ? rows(db, `SELECT * FROM decks WHERE project_id IN (${pq}) ORDER BY seq`, ...vis) : [];
  const { sql: cardScope, args: scopeArgs } = cardScopeSql(db, me, vis);
  const cards = rows(db, `SELECT ${CARD_SELECT} FROM cards WHERE id IN (${cardScope}) ORDER BY seq`, ...scopeArgs);
  const resolvables = rows(db, `SELECT * FROM resolvables WHERE is_closed=0 AND card_id IN (${cardScope}) ORDER BY created_at`, ...scopeArgs);
  const entries = rows(db,
    `SELECT e.* FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id
     WHERE r.is_closed=0 AND r.card_id IN (${cardScope}) ORDER BY e.created_at`, ...scopeArgs);
  const reactions = rows(db,
    `SELECT x.* FROM resolvable_reactions x JOIN resolvable_entries e ON e.id=x.entry_id JOIN resolvables r ON r.id=e.resolvable_id
     WHERE r.is_closed=0 AND r.card_id IN (${cardScope}) ORDER BY x.created_at, x.id`, ...scopeArgs);
  const notifications = rows(db,
    `SELECT n.* FROM resolvable_notifications n JOIN resolvables r ON r.id=n.resolvable_id
     WHERE n.user_id=? AND r.is_closed=0 AND r.card_id IN (${cardScope}) ORDER BY n.created_at, n.resolvable_id`, me.id, ...scopeArgs);
  const handCards = rows(db, `SELECT * FROM hand_cards WHERE card_id IN (${cardScope}) ORDER BY user_id, sort_index`, ...scopeArgs);
  // Relations are same-project, so a dep is visible exactly when its locked card is; checking both is cheap insurance.
  const cardDeps = rows(db,
    `SELECT locked_card_id, locking_card_id FROM card_deps
     WHERE locked_card_id IN (${cardScope}) AND locking_card_id IN (${cardScope})`, ...scopeArgs, ...scopeArgs);
  const files = rows(db, `SELECT * FROM files WHERE card_id IN (${cardScope}) ORDER BY created_at, id`, ...scopeArgs);
  const userCardTags = rows(db,
    `SELECT * FROM user_card_tags WHERE user_id=? AND card_id IN (${cardScope}) ORDER BY card_id, tag`, me.id, ...scopeArgs);
  const cardSubscriptions = rows(db,
    `SELECT * FROM card_subscriptions WHERE user_id=? AND card_id IN (${cardScope}) ORDER BY created_at, card_id`, me.id, ...scopeArgs);
  const deckSubscriptions = vis.length ? rows(db,
    `SELECT s.* FROM deck_subscriptions s JOIN decks d ON d.id=s.deck_id WHERE s.user_id=? AND d.project_id IN (${pq}) ORDER BY s.created_at, s.deck_id`, me.id, ...vis) : [];
  const deckGuardians = vis.length ? rows(db,
    `SELECT g.* FROM deck_guardians g JOIN decks d ON d.id=g.deck_id WHERE d.project_id IN (${pq}) ORDER BY g.deck_id, g.user_id`, ...vis) : [];
  const journeys = vis.length ? rows(db,
    `SELECT j.id, j.deck_id, d.project_id, j.steps, j.updated_at FROM journeys j JOIN decks d ON d.id=j.deck_id WHERE d.project_id IN (${pq}) ORDER BY j.deck_id`, ...vis)
    .map((j: any) => ({ ...j, steps: JSON.parse(j.steps) })) : [];
  // Wiki: types and link kinds of visible projects; links only between cards this viewer sees (none to trashed entries).
  const entryTypes = vis.length ? rows(db, `SELECT * FROM entry_types WHERE project_id IN (${pq}) ORDER BY project_id, sort_index, created_at, id`, ...vis) : [];
  const linkKinds = vis.length ? rows(db, `SELECT * FROM link_kinds WHERE project_id IN (${pq}) ORDER BY project_id, created_at, id`, ...vis) : [];
  const entryLinks = vis.length ? rows(db,
    `SELECT * FROM entry_links WHERE project_id IN (${pq}) AND from_card_id IN (${cardScope}) AND to_card_id IN (${cardScope})
     ORDER BY from_card_id, sort_index, created_at, id`, ...vis, ...scopeArgs, ...scopeArgs) : [];
  // Boards and their saved queries follow their host card: visible projects only, nothing for deleted cards (archived ones stay).
  const visionBoards = rows(db,
    `SELECT id, account_seq, card_id, creator_id, state, created_at, updated_at FROM vision_boards WHERE card_id IN (${cardScope}) ORDER BY account_seq`, ...scopeArgs);
  const visionQueries = rows(db, `SELECT * FROM vision_queries WHERE card_id IN (${cardScope}) ORDER BY created_at, id`, ...scopeArgs)
    .map((q: any) => ({ ...q, query: JSON.parse(q.query) }));
  const bookmarks = rows(db, `SELECT * FROM bookmarks WHERE user_id=? AND card_id IN (${cardScope}) ORDER BY created_at, card_id`, me.id, ...scopeArgs);
  const donePile = rows(db, `SELECT * FROM done_pile WHERE user_id=? AND done_at>=? AND card_id IN (${cardScope}) ORDER BY done_at, card_id`, me.id, donePileCutoff(), ...scopeArgs);
  // Milestones: global ones, plus those covering a visible project (all their project ids, never names).
  const mrows = (vis.length
    ? rows(db, `SELECT * FROM milestones WHERE is_global=1 OR id IN (SELECT milestone_id FROM milestone_projects WHERE project_id IN (${pq})) ORDER BY account_seq`, ...vis)
    : rows(db, 'SELECT * FROM milestones WHERE is_global=1 ORDER BY account_seq'));
  const msIds = mrows.map((m: any) => m.id as string);
  const mq = marks(msIds.length);
  const mps = msIds.length ? rows(db, `SELECT * FROM milestone_projects WHERE milestone_id IN (${mq}) ORDER BY milestone_id, project_id`, ...msIds) : [];
  const pidsOf = new Map<string, string[]>();
  for (const r of mps) (pidsOf.get(r.milestoneId) ?? pidsOf.set(r.milestoneId, []).get(r.milestoneId)!).push(r.projectId);
  const milestones = mrows.map((m: any) => ({ ...m, isGlobal: !!m.isGlobal, isPinned: !!m.isPinned, projectIds: pidsOf.get(m.id) ?? [] }));
  const milestoneZones = msIds.length ? rows(db, `SELECT * FROM milestone_zones WHERE milestone_id IN (${mq}) ORDER BY milestone_id, sort_index`, ...msIds) : [];
  // Progress rows only for projects this viewer can see; the client sums them.
  const milestoneProgress = msIds.length && vis.length
    ? rows(db, `SELECT * FROM milestone_progress WHERE day >= ? AND milestone_id IN (${mq}) AND project_id IN (${pq}) ORDER BY milestone_id, project_id, day`,
      addDays(todayLocal(), -PROGRESS_DAYS), ...msIds, ...vis)
    : [];
  // Runs: configs that are global or cover a visible project; unfinished runs plus those that ended recently.
  const crows = (vis.length
    ? rows(db, `SELECT * FROM sprint_configs WHERE is_global=1 OR id IN (SELECT config_id FROM sprint_config_projects WHERE project_id IN (${pq})) ORDER BY created_at, id`, ...vis)
    : rows(db, 'SELECT * FROM sprint_configs WHERE is_global=1 ORDER BY created_at, id'));
  const cfIds = crows.map((c: any) => c.id as string);
  const cq = marks(cfIds.length);
  const cps = cfIds.length ? rows(db, `SELECT * FROM sprint_config_projects WHERE config_id IN (${cq}) ORDER BY config_id, project_id`, ...cfIds) : [];
  const cpids = new Map<string, string[]>();
  for (const r of cps) (cpids.get(r.configId) ?? cpids.set(r.configId, []).get(r.configId)!).push(r.projectId);
  const sprintConfigs = crows.map((c: any) => ({ ...c, isGlobal: !!c.isGlobal, projectIds: cpids.get(c.id) ?? [] }));
  const sprints = (cfIds.length
    ? rows(db, `SELECT * FROM sprints WHERE config_id IN (${cq}) AND (is_finished=0 OR end_day >= ?) ORDER BY config_id, run_nr`, ...cfIds, addDays(todayLocal(), -SPRINT_KEEP_DAYS))
    : []).map((s: any) => ({ ...s, isFinished: !!s.isFinished }));
  const spIds = sprints.map((s: any) => s.id as string);
  const sq = marks(spIds.length);
  const sprintProgress = spIds.length && vis.length
    ? rows(db, `SELECT * FROM sprint_progress WHERE day >= ? AND sprint_id IN (${sq}) AND project_id IN (${pq}) ORDER BY sprint_id, project_id, day`,
      addDays(todayLocal(), -PROGRESS_DAYS), ...spIds, ...vis)
    : [];
  const timeSegments = (db.prepare(
    `SELECT * FROM time_segments WHERE (started_at >= ? OR duration_ms IS NULL) AND card_id IN (${cardScope}) ORDER BY started_at DESC, id LIMIT ${TIME_MAX_ROWS}`)
    .all(Date.now() - TIME_KEEP_DAYS * 86400e3, ...scopeArgs) as Record<string, unknown>[]).map(shape);
  return {
    me: plainUser(me),
    account: accountRow(db),
    // Addresses as /api/query shows them: to a token, only when it acts as an admin (sessions keep the full list).
    // Guests (Open Decks visitors) are no members: they never show in people lists or pickers.
    users: rows(db, `SELECT id,${withEmails(db, me) ? 'email,tailscale_login,' : ''}name,timezone,disabled,kind,created_at FROM users
      WHERE id NOT IN (SELECT user_id FROM account_roles WHERE role='guest') ORDER BY created_at, id`),
    accountRoles: rows(db, "SELECT * FROM account_roles WHERE role != 'guest'"),
    projects,
    projectAccess,
    projectPrefs: rows(db, 'SELECT * FROM project_prefs WHERE user_id=?', me.id).filter((p: any) => vis.includes(p.projectId)),
    decks,
    cards,
    resolvables,
    entries,
    reactions,
    notifications,
    handCards,
    bookmarks,
    donePile,
    cardDeps,
    files,
    userCardTags,
    cardSubscriptions,
    deckSubscriptions,
    deckGuardians,
    journeys,
    entryTypes,
    linkKinds,
    entryLinks,
    visionBoards,
    visionQueries,
    milestones,
    milestoneZones,
    milestoneProgress,
    sprintConfigs,
    sprints,
    sprintProgress,
    timeSegments,
    savedSearches: rows(db, 'SELECT * FROM saved_searches WHERE user_id=? ORDER BY created_at, id', me.id).map((s: any) => ({ ...s, forceOr: !!s.forceOr })),
    onboarding: onboardingRows(db, me),
    presets: rows(db, 'SELECT * FROM card_presets ORDER BY created_at, id'),
    apiTokens: visibleTokens(db, me),
  };
}

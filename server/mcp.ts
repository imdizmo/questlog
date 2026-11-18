/**
 * MCP server: JSON-RPC 2.0 over `POST /mcp` (Streamable HTTP, answered as application/json; no sessions, no SSE).
 *
 * - Auth: personal API tokens only (`jtut_…`; an org token is 401 invalid_token), and only while settings.mcpEnabled.
 * - Limits: per token a burst of MCP_LIMITS.burst requests, then one per second; workspace tool calls per UTC day
 *   (the lower of settings.mcpDailyLimit and the plan's, null = unlimited; 429 mcp_daily_limit).
 * - Tools are thin wrappers acting as the token's user: reads use the shared visibility rules (canSeeCard,
 *   visibleProjectIds, cardVisibleSql, runQuery), writes go through dispatchAll (access, guardians, history, live
 *   events), so no command logic lives here. There are no delete tools.
 * - Tool failures are `isError: true` results; protocol errors are JSON-RPC errors; auth and limits are HTTP errors.
 */
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { toCamel, tx, type Db } from './db';
import { AppError } from './errors';
import { now } from './auth';
import { mcpDailyLimit } from './billing';
import { dispatchAll, type ChangeEvent } from './dispatch';
import { can, isActiveMember, visibleProjectIds, type Actor } from './permissions';
import { bearerOf, tokenActor, TOKEN_PREFIX } from './tokens';
import { canSeeCard, cardProjectId } from './access';
import { cardVisibleSql } from './snapshot';
import { runQuery } from './query';
import { CARD_SELECT, accountRow } from './commands/rows';
import { searchTokenSchema } from './commands/search';
import { dueDateSchema, effortSchema, prioritySchema } from './commands/cards';
import { milestoneRow } from './commands/milestones';
import { derivedStatus, titleOf } from '../shared/cards';
import { compileSearch, MAX_CHIPS, type SearchCtx } from '../shared/search';
import { colors } from '../shared/schedule';
import { DEFAULT_SETTINGS, type AccountSettings, type Card, type ResolvableContext } from '../shared/types';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_INFO = { name: 'questlog', version: pkg.version } as const;
export const MCP_LIMITS = {
  /** Text of one tool result. */
  resultBytes: 50 * 1024,
  /** Requests a token may make at once, then `refillPerSec`. */
  burst: 60,
  refillPerSec: 1,
  /** Tokens (and IPs) the limiters remember; least recently seen evicted first. */
  maxKeys: 10_000,
  /** Failed authentications per IP before 429: a burst of 40, then 8 per second. */
  authFailBurst: 40,
  authFailPerSec: 8,
  createCards: 50,
  listMax: 200,
  /** Characters of one comment entry, history change or card snippet a read tool loads (cut in SQL). */
  textChars: 2000,
  /** Comment entries one get_comments call loads in total. */
  entriesPerCall: 2000,
  /** Open threads get_card lists. */
  openThreads: 200,
  /** Wall time a search_cards scan may take before it answers with what it found (hasMore). */
  searchMs: 2000,
} as const;

/**
 * Collects rows until their text reaches the result cap: read tools stop loading there (hasMore) instead of
 * building a large value for capResult to cut down.
 */
class ResultBudget {
  private used = 0;
  /** Counts one row; false once the rows so far fill the result (the row is then left out). */
  take(row: unknown): boolean {
    const n = Buffer.byteLength(JSON.stringify(row));
    if (this.used > 0 && this.used + n > MCP_LIMITS.resultBytes) return false;
    this.used += n;
    return true;
  }
}
/** SQL for a text column cut to MCP_LIMITS.textChars, plus a flag when it was cut. */
const cutSql = (col: string, as: string) =>
  `substr(${col}, 1, ${MCP_LIMITS.textChars}) ${as}, length(${col}) > ${MCP_LIMITS.textChars} ${as}_cut`;
/** Folds `<x>Cut` flags from cutSql into `truncated: true` on the row (and drops them when false). */
const foldCut = (r: Record<string, unknown>): Record<string, unknown> => {
  let cut = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith('Cut')) cut ||= !!v; else out[k] = v;
  }
  return cut ? { ...out, truncated: true } : out;
};

// ---------------------------------------------------------------------------------------------------------------
// Limits

/** Token bucket per key: `cap` at once, refilled at `perSec`. The map is LRU-bounded at `maxKeys`. */
export class BurstLimiter {
  private buckets = new Map<string, { n: number; t: number }>();
  constructor(private cap: number, private perSec: number, private maxKeys: number = MCP_LIMITS.maxKeys) {}

  get size(): number {
    return this.buckets.size;
  }

  private level(key: string, t: number): number {
    const b = this.buckets.get(key);
    return b ? Math.min(this.cap, b.n + ((t - b.t) / 1000) * this.perSec) : this.cap;
  }

  /** Seconds until one request would be allowed (0 = now), without taking it. */
  peek(key: string, t: number = now()): number {
    const n = this.level(key, t);
    return n >= 1 ? 0 : Math.max(1, Math.ceil((1 - n) / this.perSec));
  }

  /** Takes one request: 0 when allowed, else the seconds to wait (nothing is taken). */
  take(key: string, t: number = now()): number {
    const wait = this.peek(key, t);
    const n = this.level(key, t);
    this.buckets.delete(key); // re-inserted: most recently used last
    this.buckets.set(key, { n: wait ? n : n - 1, t });
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    return wait;
  }
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const settingsOf = (db: Db): AccountSettings => ({ ...DEFAULT_SETTINGS, ...(accountRow(db).settings as Partial<AccountSettings>) });

/** Counts one tool call against today's workspace limit (429 mcp_daily_limit when it is used up). */
function countCall(db: Db, tokenId: string, limit: number | null): void {
  const t = now();
  const day = utcDay(t);
  tx(db, () => {
    const used = (db.prepare('SELECT count FROM mcp_calls WHERE day=?').get(day) as { count: number } | undefined)?.count ?? 0;
    if (limit !== null && used >= limit) {
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      throw new AppError(429, 'mcp_daily_limit', { limit }, { 'retry-after': String(Math.max(1, Math.ceil((midnight - t) / 1000))) });
    }
    db.prepare('INSERT INTO mcp_calls (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);
    db.prepare('UPDATE mcp_connections SET calls=calls+1 WHERE token_id=?').run(tokenId);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Tool helpers

interface ToolCtx {
  db: Db;
  actor: Actor;
  /** Runs commands as the actor in one transaction and publishes their live events; returns each command's payload. */
  run(calls: { name: string; payload: unknown }[]): any[];
}
interface Tool {
  description: string;
  schema: z.ZodObject;
  run(c: ToolCtx, input: any): unknown;
}

const notFound = () => new AppError(404, 'not_found');
const limit = (dflt = 50) => z.number().int().min(1).max(MCP_LIMITS.listMax).default(dflt).describe(`Most items to return (1-${MCP_LIMITS.listMax}).`);
const cardRef = z.string().min(1).max(64).describe('Task id, or its number (e.g. "42").');
const marks = (n: number) => Array(n).fill('?').join(',');
const rowsOf = (db: Db, sql: string, ...args: any[]) => (db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => toCamel<any>(r));
/** LIKE pattern for a literal substring. */
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A card the actor may see (never a deleted one), by id or number; else 404 not_found. */
function resolveCard(db: Db, actor: Actor, ref: string): Card {
  const seq = /^#?\d+$/.test(ref) ? Number(ref.replace('#', '')) : null;
  const r = db.prepare(`SELECT ${CARD_SELECT} FROM cards WHERE id=?${seq !== null ? ' OR seq=?' : ''} LIMIT 1`).get(...(seq !== null ? [ref, seq] : [ref])) as Record<string, unknown> | undefined;
  if (!r) throw notFound();
  const card = toCamel<Card>(r);
  if (card.visibility === 'deleted' || !canSeeCard(db, actor, card, card.deckId ? cardProjectId(db, card.id) : null)) throw notFound();
  return card;
}

const openContextsOf = (db: Db, cardId: string) =>
  new Set((db.prepare('SELECT context FROM resolvables WHERE card_id=? AND is_closed=0').all(cardId) as { context: ResolvableContext }[]).map((r) => r.context));

/** The fields an agent needs to recognise and act on a card. */
function compactCard(c: Card, open: Set<ResolvableContext>, withContent = false) {
  return {
    id: c.id, seq: c.seq, title: titleOf(c.content), status: c.status, workflowStatus: derivedStatus(c, open),
    deckId: c.deckId, assigneeId: c.assigneeId, priority: c.priority, effort: c.effort, dueDate: c.dueDate,
    masterTags: c.masterTags, milestoneId: c.milestoneId, sprintId: c.sprintId, parentCardId: c.parentCardId,
    isDoc: c.isDoc, visibility: c.visibility, lastUpdatedAt: c.lastUpdatedAt,
    ...(withContent ? { content: c.content } : {}),
  };
}

/** Cards of the visible card set in hand order for one user (the actor's view of that Hand). */
function handCards(db: Db, actor: Actor, userId: string): Card[] {
  const ids = (db.prepare('SELECT card_id c FROM hand_cards WHERE user_id=? ORDER BY sort_index').all(userId) as { c: string }[]).map((r) => r.c);
  const out: Card[] = [];
  for (const id of ids) {
    try { out.push(resolveCard(db, actor, id)); } catch { /* not visible to the actor */ }
  }
  return out;
}

const query = (c: ToolCtx, root: unknown[]) => runQuery(c.db, c.actor, { _root: root }) as any;

// ---------------------------------------------------------------------------------------------------------------
// Inputs shared by the write tools

const cardFields = {
  assigneeId: z.string().nullable().optional().describe('Owner user id (list_members), or null for none.'),
  priority: prioritySchema.nullable().optional().describe('a = high, b = medium, c = low.'),
  effort: effortSchema.nullable().optional(),
  masterTags: z.array(z.string()).max(100).optional().describe("Project tag names (the project's existing tags)."),
  dueDate: dueDateSchema.nullable().optional().describe('YYYY-MM-DD.'),
  parentCardId: z.string().nullable().optional().describe('Hero task id to put this task under.'),
};
const newCard = z.object({
  deckId: z.string().describe('List id (list_decks).'),
  content: z.string().min(1).max(200_000).describe('Markdown; the first line is the title.'),
  isDoc: z.boolean().optional().describe('Create a doc task.'),
  putInQueue: z.boolean().optional().describe("Also put it in the owner's Hand."),
  ...cardFields,
});
const cardChanges = {
  status: z.enum(['not_started', 'started', 'done']).optional(),
  visibility: z.enum(['default', 'archived']).optional().describe('archived hides the task; default restores it.'),
  assigneeId: cardFields.assigneeId,
  priority: cardFields.priority,
  effort: cardFields.effort,
  milestoneId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional().describe('Run id (list_runs), or null.'),
  deckId: z.string().optional().describe('Move to this list.'),
};
const milestoneFields = {
  name: z.string().trim().min(1).max(200),
  date: dueDateSchema.nullable().optional().describe('End date, YYYY-MM-DD.'),
  startDate: dueDateSchema.nullable().optional().describe('YYYY-MM-DD.'),
  color: z.enum(colors).optional(),
  isGlobal: z.boolean().optional().describe('Covers every project (admins only).'),
  projectIds: z.array(z.string()).max(500).optional().describe('Projects it covers (needed unless global).'),
};

// ---------------------------------------------------------------------------------------------------------------
// Tools

const TOOLS: Record<string, Tool> = {
  // ---- reads ----
  get_context: {
    description: 'Who you are acting as, the workspace, its projects and enabled features. Call this first.',
    schema: z.object({}),
    run({ db, actor }) {
      const s = settingsOf(db);
      const vis = [...visibleProjectIds(db, actor)];
      const role = (db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(actor.id) as { role: string } | undefined)?.role ?? null;
      return {
        user: { id: actor.id, name: actor.name, role, timezone: actor.timezone },
        token: { access: actor.scopes.includes('write') ? 'write' : 'read', role: actor.tokenRole, projectIds: actor.projectIds },
        workspace: { name: accountRow(db).name },
        projects: vis.length ? rowsOf(db, `SELECT id, seq, name, is_archived FROM projects WHERE id IN (${marks(vis.length)}) ORDER BY seq`, ...vis) : [],
        features: {
          milestones: s.milestonesEnabled, runs: s.sprintsEnabled, timeTracking: s.timeTrackingMode != null,
          dueDates: s.dueDateEnabled, dependencies: s.dependenciesEnabled,
        },
        priorityLabels: s.priorityLabels,
        today: utcDay(now()),
      };
    },
  },
  list_decks: {
    description: 'Lists you can see, optionally of one project.',
    schema: z.object({ projectId: z.string().optional() }),
    run({ db, actor }, { projectId }) {
      const vis = [...visibleProjectIds(db, actor)].filter((p) => !projectId || p === projectId);
      if (!vis.length) return { items: [] };
      return { items: rowsOf(db, `SELECT id, seq, title, project_id, space_id, deck_type FROM decks WHERE project_id IN (${marks(vis.length)}) ORDER BY seq LIMIT 3000`, ...vis) };
    },
  },
  search_cards: {
    description: 'Find tasks with search tokens (as in the app search bar) and/or text in the task content. Newest first.',
    schema: z.object({
      text: z.string().min(1).max(200).optional().describe('Case-insensitive text anywhere in the task content.'),
      tokens: z.array(searchTokenSchema).max(MAX_CHIPS).optional()
        .describe('Search tokens {category, value, isNegated, op?}, e.g. {category:"status", value:"started", isNegated:false}; owner/creator/mentioned take user ids, deck/milestone/sprint take ids.'),
      forceOr: z.boolean().optional().describe('Match any token instead of all.'),
      deckId: z.string().optional(),
      includeArchived: z.boolean().optional(),
      includeContent: z.boolean().optional().describe('Include each task\'s full content.'),
      limit: limit(),
      offset: z.number().int().min(0).max(100_000).default(0),
    }),
    run({ db, actor }, input) {
      const vis = [...visibleProjectIds(db, actor)];
      const scope = cardVisibleSql(db, actor, vis, 'cards');
      const where = [scope.sql, input.includeArchived ? "cards.visibility IN ('default','archived')" : "cards.visibility='default'"];
      const args: unknown[] = [...scope.args];
      if (input.deckId) { where.push('cards.deck_id=?'); args.push(input.deckId); }
      if (input.text) { where.push("cards.content LIKE ? ESCAPE '\\'"); args.push(likeOf(input.text)); }
      // Open thread kinds are looked up per scanned card (indexed), not loaded for the whole workspace.
      const openStmt = db.prepare('SELECT context FROM resolvables WHERE card_id=? AND is_closed=0');
      const openOf = (id: string) => new Set((openStmt.all(id) as { context: ResolvableContext }[]).map((r) => r.context));
      const personal = new Map<string, string[]>();
      for (const r of db.prepare('SELECT card_id, tag FROM user_card_tags WHERE user_id=?').all(actor.id) as { card_id: string; tag: string }[]) {
        personal.set(r.card_id, [...(personal.get(r.card_id) ?? []), r.tag]);
      }
      const subs = db.prepare("SELECT COUNT(*) n FROM cards WHERE parent_card_id=? AND visibility!='deleted'");
      const zone = actor.timezone || 'UTC';
      let today: string;
      try { today = (globalThis as any).Temporal.Now.plainDateISO(zone).toString(); } catch { today = utcDay(now()); }
      const ctx: SearchCtx = {
        status: (c) => derivedStatus(c, openOf(c.id)),
        personalTags: (id) => personal.get(id) ?? [],
        subCount: (id) => (subs.get(id) as { n: number }).n,
        todayDay: today,
        sprints: rowsOf(db, 'SELECT id, config_id, start_day, end_day FROM sprints'),
        now: now(),
      };
      const match = compileSearch(input.tokens ?? [], !!input.forceOr, ctx);
      const items: unknown[] = [];
      let skipped = 0;
      let hasMore = false;
      const budget = new ResultBudget();
      const deadline = Date.now() + MCP_LIMITS.searchMs;
      let scanned = 0;
      let timedOut = false;
      // Streamed: only the page is kept; stops at the result cap or the time budget (hasMore; timedOut asks for a narrower search).
      for (const r of db.prepare(`SELECT ${CARD_SELECT} FROM cards WHERE ${where.join(' AND ')} ORDER BY cards.last_updated_at DESC, cards.seq DESC`)
        .iterate(...(args as any[])) as Iterable<Record<string, unknown>>) {
        if (++scanned % 256 === 0 && Date.now() > deadline) { hasMore = timedOut = true; break; }
        const card = toCamel<Card>(r);
        if (!match(card)) continue;
        if (skipped < input.offset) { skipped++; continue; }
        if (items.length === input.limit) { hasMore = true; break; }
        const item = compactCard(card, openOf(card.id), !!input.includeContent);
        if (!budget.take(item)) { hasMore = true; break; }
        items.push(item);
      }
      return { items, hasMore, ...(timedOut ? { timedOut: true } : {}) };
    },
  },
  get_card: {
    description: 'One task with its full content, list, open threads and subtasks.',
    schema: z.object({ cardId: cardRef }),
    run({ db, actor }, { cardId }) {
      const card = resolveCard(db, actor, cardId);
      const deck = card.deckId ? db.prepare('SELECT id, title, project_id projectId FROM decks WHERE id=?').get(card.deckId) : null;
      const openThreads = rowsOf(db, 'SELECT id, context, creator_id, created_at FROM resolvables WHERE card_id=? AND is_closed=0 ORDER BY created_at LIMIT ?', card.id, MCP_LIMITS.openThreads);
      const subCards = (db.prepare("SELECT id FROM cards WHERE parent_card_id=? AND visibility!='deleted' ORDER BY sort_index, seq LIMIT 500").all(card.id) as { id: string }[]).map((r) => r.id);
      return { ...compactCard(card, openContextsOf(db, card.id), true), creatorId: card.creatorId, createdAt: card.createdAt, deck, openThreads, subCards };
    },
  },
  get_comments: {
    description: 'Conversation threads (comments, blocks, reviews) on a task with their entries, newest thread first.',
    schema: z.object({ cardId: cardRef, includeResolved: z.boolean().default(true), limit: limit(20) }),
    run({ db, actor }, input) {
      const card = resolveCard(db, actor, input.cardId);
      // Bounded before loading: entry text is cut in SQL, entries per call are capped, and loading stops once the
      // result is full (hasMore: ask again with a smaller limit, or read one thread's card in the app).
      const threads = rowsOf(db, `SELECT id, context, creator_id, is_closed, closed_at, closed_by, created_at FROM resolvables WHERE card_id=?${input.includeResolved ? '' : ' AND is_closed=0'} ORDER BY created_at DESC, rowid DESC LIMIT ?`, card.id, input.limit);
      const entries = db.prepare(`SELECT id, author_id, ${cutSql('content', 'content')}, created_at, last_changed_at FROM resolvable_entries WHERE resolvable_id=? ORDER BY created_at, rowid LIMIT ?`);
      const budget = new ResultBudget();
      let left: number = MCP_LIMITS.entriesPerCall;
      let hasMore = false;
      const items: unknown[] = [];
      for (const t of threads) {
        if (left <= 0 || !budget.take(t)) { hasMore = true; break; }
        const list: unknown[] = [];
        for (const e of entries.iterate(t.id, left + 1) as Iterable<Record<string, unknown>>) {
          const row = foldCut(toCamel(e));
          if (left <= 0 || !budget.take(row)) { hasMore = true; break; }
          list.push(row);
          left--;
        }
        items.push({ ...t, entries: list });
        if (hasMore) break;
      }
      return { cardId: card.id, items, hasMore };
    },
  },
  get_card_history: {
    description: 'Changes made to a task, newest first.',
    schema: z.object({ cardId: cardRef, limit: limit() }),
    run({ db, actor }, input) {
      const card = resolveCard(db, actor, input.cardId);
      // A change list too long to load whole (a long title) comes back as changes: null, truncated: true.
      const budget = new ResultBudget();
      const items: unknown[] = [];
      let hasMore = false;
      for (const r of db.prepare(`SELECT version, changer_id, at,
          CASE WHEN length(changes_json) <= ${MCP_LIMITS.textChars} THEN changes_json END changes_json, length(changes_json) > ${MCP_LIMITS.textChars} changes_cut
          FROM card_history WHERE card_id=? ORDER BY version DESC LIMIT ?`)
        .iterate(card.id, input.limit) as Iterable<Record<string, unknown>>) {
        const row = foldCut(toCamel(r));
        if (!budget.take(row)) { hasMore = true; break; }
        items.push(row);
      }
      return { cardId: card.id, items, hasMore };
    },
  },
  list_conversations: {
    description: 'Threads you take part in, most recently active first, with their unseen entry counts.',
    schema: z.object({ includeResolved: z.boolean().default(false), limit: limit() }),
    run({ db, actor }, input) {
      const scope = cardVisibleSql(db, actor, [...visibleProjectIds(db, actor)], 'c');
      // Only the start of the card text is loaded: enough for its title line.
      const rows = rowsOf(db, `SELECT r.id, r.card_id, r.context, r.is_closed, r.latest_entry_at, n.unseen_entry_count, c.seq card_seq, substr(c.content, 1, ${MCP_LIMITS.textChars}) card_content
        FROM resolvable_notifications n JOIN resolvables r ON r.id=n.resolvable_id JOIN cards c ON c.id=r.card_id
        WHERE n.user_id=? AND n.is_participating=1${input.includeResolved ? '' : ' AND r.is_closed=0'} AND ${scope.sql}
        ORDER BY r.latest_entry_at DESC LIMIT ?`, actor.id, ...scope.args, input.limit);
      return { items: rows.map(({ cardContent, ...r }) => ({ ...r, cardTitle: titleOf(String(cardContent)) })) };
    },
  },
  search_comments: {
    description: 'Comment entries containing a text, newest first.',
    schema: z.object({ text: z.string().min(1).max(200), cardId: cardRef.optional(), limit: limit() }),
    run({ db, actor }, input) {
      const scope = cardVisibleSql(db, actor, [...visibleProjectIds(db, actor)], 'c');
      const card = input.cardId ? resolveCard(db, actor, input.cardId) : null;
      const budget = new ResultBudget();
      const items: unknown[] = [];
      let hasMore = false;
      for (const r of db.prepare(`SELECT e.id, e.resolvable_id thread_id, e.author_id, ${cutSql('e.content', 'content')}, e.created_at, r.card_id, c.seq card_seq
        FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id JOIN cards c ON c.id=r.card_id
        WHERE e.content LIKE ? ESCAPE '\\' AND ${scope.sql}${card ? ' AND c.id=?' : ''}
        ORDER BY e.created_at DESC LIMIT ?`).iterate(likeOf(input.text), ...(scope.args as any[]), ...(card ? [card.id] : []), input.limit) as Iterable<Record<string, unknown>>) {
        const row = foldCut(toCamel(r));
        if (!budget.take(row)) { hasMore = true; break; }
        items.push(row);
      }
      return { items, hasMore };
    },
  },
  list_hand: {
    description: "Tasks in your Hand (or another member's), in order.",
    schema: z.object({ userId: z.string().optional() }),
    run({ db, actor }, { userId }) {
      return { items: handCards(db, actor, userId ?? actor.id).map((c) => compactCard(c, openContextsOf(db, c.id))) };
    },
  },
  list_milestones: {
    description: 'Milestones you can see.',
    schema: z.object({}),
    run(c) {
      const r = query(c, [{ milestones: ['accountSeq', 'name', 'date', 'startDate', 'color', 'isGlobal', 'isPinned', 'projectIds'] }]);
      return { items: (r._root.milestones as string[]).map((id) => r.milestones?.[id]) };
    },
  },
  list_runs: {
    description: 'Runs (sprints) you can see, with their run config name.',
    schema: z.object({ includeFinished: z.boolean().default(false) }),
    run(c, { includeFinished }) {
      const r = query(c, [{ sprints: ['configId', 'label', 'runNr', 'startDay', 'endDay', 'isFinished'] }, { sprintConfigs: ['name', 'isArchived'] }]);
      const items = (r._root.sprints as string[]).map((id) => r.sprints?.[id])
        .filter((s: any) => includeFinished || !s.isFinished)
        .map((s: any) => ({ ...s, configName: r.sprintConfigs?.[s.configId]?.name ?? null }));
      return { items };
    },
  },
  list_members: {
    description: 'People in the workspace (ids for owners, mentions and Hands).',
    schema: z.object({}),
    run(c) {
      const r = query(c, [{ users: ['name', 'role', 'kind'] }]);
      return { items: (r._root.users as string[]).map((id) => r.users?.[id]).filter((u: any) => u.role && u.kind !== 'service').map(({ kind: _k, ...u }: any) => u) };
    },
  },

  // ---- writes ----
  create_card: {
    description: 'Create a task in a list.',
    schema: newCard,
    run(c, input) {
      const [r] = c.run([{ name: 'cards/create', payload: input }]);
      return { id: r.id, seq: r.accountSeq };
    },
  },
  create_cards: {
    description: `Create up to ${MCP_LIMITS.createCards} tasks at once: all or none.`,
    schema: z.object({ cards: z.array(newCard).min(1).max(MCP_LIMITS.createCards) }),
    run(c, { cards }) {
      return { items: c.run(cards.map((p: unknown) => ({ name: 'cards/create', payload: p }))).map((r) => ({ id: r.id, seq: r.accountSeq })) };
    },
  },
  update_card: {
    description: 'Change a task. Content replaces the whole task text (first line is the title).',
    schema: z.object({
      cardId: cardRef,
      content: z.string().min(1).max(200_000).optional(),
      contentVersion: z.number().int().optional().describe('Fails with a conflict if the content changed since this version.'),
      masterTags: cardFields.masterTags,
      dueDate: cardFields.dueDate,
      parentCardId: cardFields.parentCardId,
      isDoc: z.boolean().optional(),
      ...cardChanges,
    }),
    run(c, { cardId, ...patch }) {
      const card = resolveCard(c.db, c.actor, cardId);
      if (Object.values(patch).every((v) => v === undefined)) throw new AppError(400, 'nothing_to_change');
      const contentVersion = patch.content !== undefined ? (patch.contentVersion ?? card.contentVersion) : undefined;
      c.run([{ name: 'cards/update', payload: { id: card.id, ...patch, contentVersion } }]);
      return { id: card.id };
    },
  },
  update_cards: {
    description: 'Apply the same change to several tasks: all or none.',
    schema: z.object({
      cardIds: z.array(cardRef).min(1).max(MCP_LIMITS.listMax),
      addTags: z.array(z.string()).max(100).optional(),
      removeTags: z.array(z.string()).max(100).optional(),
      ...cardChanges,
    }),
    run(c, { cardIds, addTags, removeTags, ...patch }) {
      const ids = [...new Set(cardIds.map((ref: string) => resolveCard(c.db, c.actor, ref).id))];
      c.run([{ name: 'cards/bulkUpdate', payload: { ids, ...patch, addMasterTags: addTags, removeMasterTags: removeTags } }]);
      return { ids };
    },
  },
  add_comment: {
    description: 'Reply in a thread (threadId), or start a new thread on a task: a comment, a block or a review request.',
    schema: z.object({
      cardId: cardRef,
      content: z.string().trim().min(1).max(100_000),
      threadId: z.string().optional().describe('Reply to this thread.'),
      kind: z.enum(['comment', 'block', 'review']).default('comment').describe('Kind of a new thread.'),
    }),
    run(c, input) {
      const card = resolveCard(c.db, c.actor, input.cardId);
      if (input.threadId) {
        const t = c.db.prepare('SELECT card_id FROM resolvables WHERE id=?').get(input.threadId) as { card_id: string } | undefined;
        if (!t || t.card_id !== card.id) throw notFound();
        const [r] = c.run([{ name: 'resolvables/comment', payload: { resolvableId: input.threadId, content: input.content } }]);
        return { threadId: input.threadId, commentId: r.id };
      }
      const [r] = c.run([{ name: 'resolvables/create', payload: { cardId: card.id, context: input.kind, content: input.content } }]);
      return { threadId: r.id, commentId: r.entryId };
    },
  },
  update_comment: {
    description: 'Edit one of your own comments.',
    schema: z.object({ commentId: z.string(), content: z.string().trim().min(1).max(100_000) }),
    run(c, input) {
      c.run([{ name: 'resolvables/editEntry', payload: { entryId: input.commentId, content: input.content } }]);
      return { commentId: input.commentId };
    },
  },
  set_thread_resolved: {
    description: 'Resolve (close) a thread. Resolved threads cannot be reopened. markCardDone also completes the task (review threads).',
    schema: z.object({ threadId: z.string(), resolved: z.literal(true), markCardDone: z.boolean().optional() }),
    run(c, input) {
      const [r] = c.run([{ name: 'resolvables/close', payload: { id: input.threadId, markCardDone: input.markCardDone } }]);
      return { threadId: input.threadId, cardId: r.cardId };
    },
  },
  set_thread_participation: {
    description: 'Join or leave a thread (leaving stops its notifications for you).',
    schema: z.object({ threadId: z.string(), participating: z.boolean() }),
    run(c, input) {
      c.run([{ name: 'resolvables/setParticipation', payload: { resolvableId: input.threadId, isParticipating: input.participating } }]);
      return { threadId: input.threadId };
    },
  },
  add_to_hand: {
    description: 'Put tasks in your Hand, at the end or at a slot (1 = first).',
    schema: z.object({ cardIds: z.array(cardRef).min(1).max(MCP_LIMITS.listMax), slot: z.number().int().min(1).optional() }),
    run(c, input) {
      const ids = input.cardIds.map((ref: string) => resolveCard(c.db, c.actor, ref).id);
      c.run([{ name: 'handQueue/addCards', payload: { cardIds: ids, userId: c.actor.id, slot: input.slot } }]);
      return { ids };
    },
  },
  remove_from_hand: {
    description: 'Take tasks out of your Hand.',
    schema: z.object({ cardIds: z.array(cardRef).min(1).max(MCP_LIMITS.listMax) }),
    run(c, input) {
      const ids = input.cardIds.map((ref: string) => resolveCard(c.db, c.actor, ref).id);
      c.run([{ name: 'handQueue/removeCards', payload: { cardIds: ids, userId: c.actor.id } }]);
      return { ids };
    },
  },
  move_in_hand: {
    description: 'Move a task of your Hand to a slot (1 = first).',
    schema: z.object({ cardId: cardRef, slot: z.number().int().min(1) }),
    run(c, input) {
      const card = resolveCard(c.db, c.actor, input.cardId);
      const order = handCards(c.db, c.actor, c.actor.id).map((x) => x.id);
      if (!order.includes(card.id)) throw new AppError(404, 'not_in_hand');
      const rest = order.filter((id) => id !== card.id);
      rest.splice(Math.min(input.slot - 1, rest.length), 0, card.id);
      c.run([{ name: 'handQueue/reorder', payload: { userId: c.actor.id, cardIds: rest } }]);
      return { ids: rest };
    },
  },
  create_deck: {
    description: 'Create a list in a project.',
    schema: z.object({ projectId: z.string(), title: z.string().trim().min(1).max(200), spaceId: z.number().int().positive().optional() }),
    run(c, input) {
      const [r] = c.run([{ name: 'decks/create', payload: input }]);
      return { id: r.id };
    },
  },
  create_milestone: {
    description: 'Create a milestone for some projects (or a global one).',
    schema: z.object(milestoneFields),
    run(c, input) {
      const payload = {
        name: input.name, date: input.date ?? null, startDate: input.startDate ?? null, color: input.color ?? colors[0],
        isGlobal: input.isGlobal ?? false, projectIds: input.projectIds ?? [],
      };
      const [r] = c.run([{ name: 'milestones/create', payload }]);
      return { id: r.id, seq: r.accountSeq };
    },
  },
  update_milestone: {
    description: 'Change a milestone; fields left out keep their value.',
    schema: z.object({ milestoneId: z.string(), ...milestoneFields, name: milestoneFields.name.optional() }),
    run(c, { milestoneId, ...input }) {
      const m = milestoneRow(c.db, milestoneId);
      // Same rule as the milestones the actor can read (query.ts milestoneVisible); the command checks the right to manage.
      const visible = m && (m.isGlobal ? isActiveMember(c.db, c.actor) : m.projectIds.some((p) => visibleProjectIds(c.db, c.actor).has(p)));
      if (!m || !visible) throw notFound();
      const payload = {
        id: milestoneId, name: input.name ?? m.name, date: input.date === undefined ? m.date : input.date,
        startDate: input.startDate === undefined ? m.startDate : input.startDate, color: input.color ?? m.color,
        isGlobal: input.isGlobal ?? m.isGlobal, projectIds: input.projectIds ?? m.projectIds,
      };
      c.run([{ name: 'milestones/update', payload }]);
      return { id: milestoneId };
    },
  },
  track_time: {
    description: 'Start or stop your timer on a task (starting also starts the task).',
    schema: z.object({ cardId: cardRef, action: z.enum(['start', 'stop']) }),
    run(c, input) {
      const card = resolveCard(c.db, c.actor, input.cardId);
      if (input.action === 'start') {
        const [r] = c.run([{ name: 'timeTracking/start', payload: { userId: c.actor.id, cardId: card.id } }]);
        return { segmentId: r.id };
      }
      const seg = c.db.prepare('SELECT id FROM time_segments WHERE user_id=? AND card_id=? AND duration_ms IS NULL').get(c.actor.id, card.id) as { id: string } | undefined;
      if (!seg) throw new AppError(409, 'not_running');
      c.run([{ name: 'timeTracking/stop', payload: { id: seg.id } }]);
      return { segmentId: seg.id };
    },
  },
  log_time: {
    description: 'Book time already spent on a task (by default ending now).',
    schema: z.object({
      cardId: cardRef,
      minutes: z.number().int().min(1).max(24 * 60),
      startedAt: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 start time.'),
      userId: z.string().optional().describe("Book it for someone else (project managers only)."),
    }),
    run(c, input) {
      const card = resolveCard(c.db, c.actor, input.cardId);
      const durationInMs = input.minutes * 60_000;
      const startedAt = input.startedAt ? Date.parse(input.startedAt) : now() - durationInMs;
      const [r] = c.run([{ name: 'timeTracking/create', payload: { cardId: card.id, userId: input.userId ?? c.actor.id, startedAt, durationInMs } }]);
      return { segmentId: r.id };
    },
  },
};

export const MCP_TOOL_NAMES: readonly string[] = Object.keys(TOOLS);

const toolList = Object.entries(TOOLS).map(([name, t]) => {
  const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
  return { name, description: t.description, inputSchema };
});

// ---------------------------------------------------------------------------------------------------------------
// Results

/** JSON text of a result, at most MCP_LIMITS.resultBytes: list items are dropped from the end, then long strings cut. */
export function capResult(value: unknown, max: number = MCP_LIMITS.resultBytes): string {
  const fits = (s: string) => Buffer.byteLength(s) <= max;
  const s = JSON.stringify(value ?? {});
  if (fits(s)) return s;
  const v = value as Record<string, unknown>;
  if (v && Array.isArray(v.items)) {
    let lo = 0, hi = v.items.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(JSON.stringify({ ...v, items: v.items.slice(0, mid), truncated: true }))) lo = mid; else hi = mid - 1;
    }
    if (lo > 0) return JSON.stringify({ ...v, items: v.items.slice(0, lo), hasMore: true, truncated: true });
  }
  for (const cut of [8000, 2000, 500, 100]) {
    const out = JSON.stringify({ ...shorten(value, cut) as object, truncated: true });
    if (fits(out)) return out;
  }
  return JSON.stringify({ truncated: true, error: 'result_too_large' });
}
function shorten(v: unknown, cut: number): unknown {
  if (typeof v === 'string') return v.length > cut ? `${v.slice(0, cut)}… [truncated]` : v;
  if (Array.isArray(v)) return v.map((x) => shorten(x, cut));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, cut)]));
  return v;
}

const errorText = (e: unknown): string => {
  if (e instanceof AppError) return JSON.stringify(e.data === undefined ? { error: e.code } : { error: e.code, data: e.data });
  if (e instanceof z.ZodError) {
    return JSON.stringify({ error: 'invalid_arguments', issues: e.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`) });
  }
  console.error('[jt] mcp tool failed', String((e as Error)?.message ?? e));
  return JSON.stringify({ error: 'internal' });
};

// ---------------------------------------------------------------------------------------------------------------
// Protocol

type Json = Record<string, unknown>;
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export interface McpResponse { status: number; body?: unknown }

export class McpServer {
  private burst = new BurstLimiter(MCP_LIMITS.burst, MCP_LIMITS.refillPerSec);
  private authFails = new BurstLimiter(MCP_LIMITS.authFailBurst, MCP_LIMITS.authFailPerSec);

  constructor(private db: Db, private publish: (x: { actionId: string; events: ChangeEvent[] }) => void) {}

  /** A personal token's actor, or 401 (counted per IP: too many failures give 429 before any lookup). */
  private authenticate(ip: string, authorization: string | undefined): Actor {
    const wait = this.authFails.peek(ip);
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    try {
      const bearer = bearerOf(authorization);
      if (!bearer || !bearer.startsWith(TOKEN_PREFIX.user)) throw new AppError(401, 'invalid_token');
      return tokenActor(this.db, bearer);
    } catch (e) {
      this.authFails.take(ip);
      if (e instanceof AppError && e.status === 401) throw new AppError(401, e.code, e.data, { 'www-authenticate': 'Bearer realm="mcp"' });
      throw e;
    }
  }

  handle(ip: string, authorization: string | undefined, body: unknown): McpResponse {
    const { db } = this;
    const actor = this.authenticate(ip, authorization);
    const settings = settingsOf(db);
    if (!settings.mcpEnabled) throw new AppError(403, 'mcp_disabled');
    const tokenId = actor.tokenId!;
    const wait = this.burst.take(tokenId);
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    const t = now();
    db.prepare(`INSERT INTO mcp_connections (token_id, user_id, created_at, last_used_at) VALUES (?,?,?,?)
      ON CONFLICT(token_id) DO UPDATE SET last_used_at=excluded.last_used_at`).run(tokenId, actor.id, t, t);

    if (Array.isArray(body)) return { status: 200, body: rpcError(null, -32600, 'Batch requests are not supported') };
    const msg = (body && typeof body === 'object' ? body : {}) as Json;
    if (msg.jsonrpc !== '2.0') return { status: 200, body: rpcError(msg.id, -32600, 'Invalid request') };
    // Notifications (no id) and client responses get no body.
    if (msg.id === undefined || typeof msg.method !== 'string') return { status: 202 };
    const id = msg.id;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;

    switch (msg.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        const info = (params.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo : {}) as Json;
        if (typeof info.name === 'string') db.prepare('UPDATE mcp_connections SET client_name=? WHERE token_id=?').run(info.name.slice(0, 200), tokenId);
        return {
          status: 200,
          body: rpcResult(id, {
            protocolVersion, serverInfo: MCP_SERVER_INFO, capabilities: { tools: {} },
            instructions: 'Questlog: tasks in lists in projects. Some tool names differ from the words in the app: a hero task is a main task, the Hand is the list of active tasks, and a run is a sprint. Call get_context first. Tools act as you, with your token\'s permissions.',
          }),
        };
      }
      case 'ping':
        return { status: 200, body: rpcResult(id, {}) };
      case 'tools/list':
        return { status: 200, body: rpcResult(id, { tools: toolList }) };
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !Object.hasOwn(TOOLS, name)) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${String(name)}`) };
        countCall(db, tokenId, mcpDailyLimit(db, settings.mcpDailyLimit));
        return { status: 200, body: rpcResult(id, this.callTool(actor, TOOLS[name], params.arguments ?? {})) };
      }
      default:
        return { status: 200, body: rpcError(id, -32601, `Method not found: ${msg.method}`) };
    }
  }

  private callTool(actor: Actor, tool: Tool, args: unknown) {
    const ctx: ToolCtx = {
      db: this.db,
      actor,
      run: (calls) => {
        const r = dispatchAll(this.db, actor, calls);
        try {
          this.publish({ actionId: r.actionId, events: r.events });
        } catch (e) {
          console.error('live publish failed', e); // the write is already committed
        }
        return r.payloads as any[];
      },
    };
    try {
      const input = tool.schema.parse(args);
      return { content: [{ type: 'text', text: capResult(tool.run(ctx, input)) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: errorText(e) }], isError: true };
    }
  }
}

/** MCP usage for the settings page: today's workspace tool calls and connections per member (admins all, others their own). */
export function mcpUsage(db: Db, actor: Actor) {
  const all = can(db, actor, 'account.manage');
  const day = utcDay(now());
  const toolCallsToday = (db.prepare('SELECT count FROM mcp_calls WHERE day=?').get(day) as { count: number } | undefined)?.count ?? 0;
  const connections = (db.prepare(`SELECT m.user_id userId, u.name, MAX(m.last_used_at) lastUsedAt, SUM(m.calls) calls
    FROM mcp_connections m JOIN users u ON u.id=m.user_id ${all ? '' : 'WHERE m.user_id=?'} GROUP BY m.user_id ORDER BY u.name`)
    .all(...(all ? [] : [actor.id])) as { userId: string; name: string; lastUsedAt: number | null; calls: number }[]);
  return { toolCallsToday, connections };
}

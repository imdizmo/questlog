/**
 * Read query API (`POST /api/query`): the nested `{_root:[…]}` query shape, answered with a normalized
 * `{_root:{…ids}, <model>:{<id>:{…fields}}}` result.
 *
 * Safety rules:
 * - every row passes its model's visibility predicate, built from the same rules as the snapshot (readScope below);
 * - fields, relations and operators come from the registry only; user strings are never spliced into SQL (values are
 *   bound parameters, field names are looked up);
 * - cost is bounded: QUERY_LIMITS.
 */
import type { Db } from './db';
import { AppError } from './errors';
import { can, isActiveMember, visibleProjectIds, type Who } from './permissions';
import { cardScopeSql, cardVisibleSql } from './snapshot';
import { CARD_SELECT } from './commands/rows';

export const QUERY_LIMITS = {
  /** Relation levels below `_root`. */
  maxDepth: 6,
  /** Rows per list (silently capped, as observed). */
  listRows: 3000,
  /** Rows per response, over all lists (then 400 query_too_large). */
  totalRows: 20_000,
  /** Time budget, checked between lists. */
  budgetMs: 5000,
  /** Relation nodes per query. */
  maxLists: 12,
  // Per-statement cost, validated before any SQL runs: the time budget is only checked between lists, so a single
  // list must stay cheap on its own (worst allowed query on 50k cards: see the Task 1 report).
  /** Filter predicates per query: field terms and `$order` keys (weighted by Field.cost) plus `$or` groups. */
  maxPredicates: 25,
  /** Text-match terms (`contains` / `search`) per list and per query. */
  maxTextTermsPerList: 10,
  maxTextTerms: 20,
  /** Words in one `search`. */
  maxWords: 8,
  /** Text-match words per query: each is one LIKE scan of the field (a `contains` counts as one). */
  maxTextWords: 12,
  /** Array terms (`has` / `overlaps`) per query: each parses the row's JSON array. */
  maxArrayTerms: 4,
  /** Characters in one string filter value. */
  maxValueChars: 200,
  /** Values in one `in` / `overlaps` list. */
  maxValues: 500,
  /** Branches in one `$or`, and `$or` nesting. */
  maxOrBranches: 20,
  maxOrDepth: 4,
  /** Largest `$offset`. */
  maxOffset: 100_000,
  /** Keys in one `$order`. */
  maxOrder: 5,
} as const;

/**
 * Whoever is reading: a session user, or a token actor (server/permissions.ts Actor). A token is narrowed through the
 * shared permission rules: visibleProjectIds intersects its projects, `admin` needs an admin-role token, and a
 * project-confined token sees no deckless cards (cardVisibleSql via canSeeCard).
 */
export type QueryActor = Who;
export type QueryResult = { _root: Record<string, unknown> } & Record<string, any>;

interface Sql { sql: string; args: unknown[] }

/** What an actor may read. The single place where the visible project set is computed. */
interface Scope {
  /** Has an active account role (a removed or disabled user reads nothing). */
  active: boolean;
  admin: boolean;
  /** JSON array of visible project ids, bound as one parameter. */
  projects: string;
  /** Subquery of visible card ids (the snapshot's rule). */
  cards: Sql;
  /** The same rule as a predicate on the cards row `t` (no id set built per statement). */
  cardRow: Sql;
}

function readScope(db: Db, actor: QueryActor): Scope {
  const projectIds = [...visibleProjectIds(db, actor)];
  return {
    active: isActiveMember(db, actor),
    admin: can(db, actor, 'account.manage'),
    projects: JSON.stringify(projectIds),
    cards: cardScopeSql(db, actor, projectIds),
    cardRow: cardVisibleSql(db, actor, projectIds, 't'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Model registry

type FieldType = 'id' | 'text' | 'num' | 'bool' | 'json' | 'array';
/** `sql` is an expression over the row alias `t`; it never contains parameters. */
interface Field {
  sql: string;
  type: FieldType;
  adminOnly?: true;
  /** Budget weight of one predicate on this field: computed expressions cost more per row. Default 1. */
  cost?: number;
  /** Budget weight of a sort key on this field. Default: `cost`. */
  sortCost?: number;
  /** Long text (card and comment bodies, deck descriptions): never a sort key, sorting it costs seconds on big tables. */
  noSort?: true;
}
type ModelName = '_root' | 'account' | 'projects' | 'decks' | 'cards' | 'users' | 'milestones' | 'sprints' | 'sprintConfigs'
  | 'resolvables' | 'resolvableEntries' | 'projectTags' | 'handCards';
type Rel =
  | { model: 'account'; kind: 'single' }
  /** Every visible row of the model (account / root lists). */
  | { model: ModelName; kind: 'all' }
  /** belongsTo: the parent's `field` holds the target id. */
  | { model: ModelName; kind: 'one'; field: string }
  /** hasMany: the target's `fk` field holds the parent id. */
  | { model: ModelName; kind: 'many'; fk: string };
interface Model {
  source: string;
  fields: Record<string, Field>;
  rels: Record<string, Rel>;
  /** Default ORDER BY over `t` (the id is always appended as a tiebreak). */
  order: string;
  visible: (s: Scope) => Sql;
}

const f = (sql: string, type: FieldType = 'text'): Field => ({ sql, type });
const col = (name: string, type: FieldType = 'text') => f(`t.${name}`, type);
const longText = (name: string): Field => ({ ...col(name), noSort: true });
const inProjects = (expr: string) => (s: Scope): Sql => ({ sql: `${expr} IN (SELECT value FROM json_each(?))`, args: [s.projects] });
const inCards = (expr: string) => (s: Scope): Sql => ({ sql: `${expr} IN (${s.cards.sql})`, args: s.cards.args });
const flag = (b: boolean) => (b ? '1' : '0');
// Milestones and run configs: global ones, plus those covering a visible project (as in buildSnapshot).
const milestoneVisible = (alias: string) => (s: Scope): Sql => ({
  sql: `${flag(s.active)} AND (${alias}.is_global=1 OR ${alias}.id IN (SELECT milestone_id FROM milestone_projects WHERE project_id IN (SELECT value FROM json_each(?))))`,
  args: [s.projects],
});
const configVisible = (alias: string) => (s: Scope): Sql => ({
  sql: `${flag(s.active)} AND (${alias}.is_global=1 OR ${alias}.id IN (SELECT config_id FROM sprint_config_projects WHERE project_id IN (SELECT value FROM json_each(?))))`,
  args: [s.projects],
});

/** titleOf (shared/cards.ts) in SQL: first line, leading '#' and whitespace dropped, 'Untitled' when empty. */
// Literal control characters inside the SQL strings (no per-row char()/|| evaluation): the title is computed per row.
const WS = ' \t\v\f\r';
const NL = `'\n'`;
const FIRST_LINE = `substr(t.content, 1, coalesce(nullif(instr(t.content, ${NL}), 0) - 1, length(t.content)))`;
const CARD_TITLE = `COALESCE(NULLIF(rtrim(ltrim(${FIRST_LINE}, '#${WS}'), '${WS}'), ''), 'Untitled')`;

const ACCOUNT_LISTS: Record<string, Rel> = {
  projects: { model: 'projects', kind: 'all' },
  decks: { model: 'decks', kind: 'all' },
  cards: { model: 'cards', kind: 'all' },
  users: { model: 'users', kind: 'all' },
  milestones: { model: 'milestones', kind: 'all' },
  sprints: { model: 'sprints', kind: 'all' },
  sprintConfigs: { model: 'sprintConfigs', kind: 'all' },
  resolvables: { model: 'resolvables', kind: 'all' },
  resolvableEntries: { model: 'resolvableEntries', kind: 'all' },
  projectTags: { model: 'projectTags', kind: 'all' },
  handCards: { model: 'handCards', kind: 'all' },
};

const MODELS: Record<ModelName, Model> = {
  _root: {
    source: '', fields: {}, order: '', visible: () => ({ sql: '0', args: [] }),
    rels: { account: { model: 'account', kind: 'single' }, ...ACCOUNT_LISTS },
  },
  account: {
    source: 'account',
    fields: { id: col('id', 'id'), name: col('name'), createdAt: col('created_at', 'num') },
    rels: ACCOUNT_LISTS,
    order: 't.id',
    visible: (s) => ({ sql: flag(s.active), args: [] }),
  },
  projects: {
    source: 'projects',
    fields: {
      id: col('id', 'id'), seq: col('seq', 'num'), name: col('name'), visibility: col('visibility'),
      isArchived: col('is_archived', 'bool'), spaces: col('spaces_json', 'json'), tags: col('tags_json', 'json'),
      cover: col('cover_json', 'json'), createdAt: col('created_at', 'num'),
    },
    rels: {
      decks: { model: 'decks', kind: 'many', fk: 'projectId' },
      projectTags: { model: 'projectTags', kind: 'many', fk: 'projectId' },
    },
    order: 't.seq',
    visible: inProjects('t.id'),
  },
  decks: {
    source: 'decks',
    fields: {
      id: col('id', 'id'), seq: col('seq', 'num'), projectId: col('project_id', 'id'), spaceId: col('space_id', 'num'),
      title: col('title'), deckType: col('deck_type'), description: longText('description'), sortIndex: col('sort_index', 'num'),
      createdAt: col('created_at', 'num'), autoTag: col('auto_tag'), defaultCardId: col('default_card_id', 'id'),
      cover: col('cover_json', 'json'), creatorId: col('creator_id', 'id'), guardiansEnabled: col('guardians_enabled', 'bool'),
      handSyncEnabled: col('hand_sync_enabled', 'bool'), autoMilestoneId: col('auto_milestone_id', 'id'),
      preferredOrder: col('preferred_order', 'json'),
    },
    rels: {
      project: { model: 'projects', kind: 'one', field: 'projectId' },
      cards: { model: 'cards', kind: 'many', fk: 'deckId' },
    },
    order: 't.seq',
    visible: inProjects('t.project_id'),
  },
  cards: {
    source: `(SELECT ${CARD_SELECT} FROM cards)`,
    fields: {
      id: col('id', 'id'), seq: col('seq', 'num'), deckId: col('deck_id', 'id'), creatorId: col('creator_id', 'id'),
      assigneeId: col('assignee_id', 'id'), title: { ...f(CARD_TITLE), cost: 5, sortCost: 8 }, content: longText('content'), status: col('status'),
      visibility: col('visibility'), isDoc: col('is_doc', 'bool'), version: col('version', 'num'),
      contentVersion: col('content_version', 'num'), sortIndex: col('sort_index', 'num'), createdAt: col('created_at', 'num'),
      lastUpdatedAt: col('last_updated_at', 'num'), snoozedAt: col('snoozed_at', 'num'), doneAt: col('done_at', 'num'),
      priority: col('priority'), effort: col('effort', 'num'), dueDate: col('due_date'), parentCardId: col('parent_card_id', 'id'),
      milestoneId: col('milestone_id', 'id'), milestoneZoneId: col('milestone_zone_id', 'id'), sprintId: col('sprint_id', 'id'),
      carryCount: col('carry_count', 'num'), sprintJoinedAt: col('sprint_joined_at', 'num'),
      masterTags: col('master_tags_json', 'array'), tags: col('tags_json', 'array'), mentionedUserIds: col('mentioned_user_ids_json', 'array'),
      checkboxStats: col('checkbox_stats_json', 'json'), coverFileId: col('cover_file_id', 'id'),
      hasBlockingDeps: col('has_blocking_deps', 'bool'), isBlockingDep: col('is_blocking_dep', 'bool'),
      // Game wiki (Lore entries): type, stable key, field values, page-tree parent.
      entryTypeId: col('entry_type_id', 'id'), entryKey: col('entry_key'), fields: col('fields_json', 'json'), wikiParentId: col('wiki_parent_id', 'id'),
    },
    rels: {
      deck: { model: 'decks', kind: 'one', field: 'deckId' },
      assignee: { model: 'users', kind: 'one', field: 'assigneeId' },
      creator: { model: 'users', kind: 'one', field: 'creatorId' },
      parentCard: { model: 'cards', kind: 'one', field: 'parentCardId' },
      childCards: { model: 'cards', kind: 'many', fk: 'parentCardId' },
      resolvables: { model: 'resolvables', kind: 'many', fk: 'cardId' },
      milestone: { model: 'milestones', kind: 'one', field: 'milestoneId' },
      sprint: { model: 'sprints', kind: 'one', field: 'sprintId' },
      handCards: { model: 'handCards', kind: 'many', fk: 'cardId' },
    },
    order: 't.seq',
    visible: (s) => s.cardRow,
  },
  // Public fields only: never the password hash or sessions; the email for admins only.
  users: {
    // Guests are no members and never listed.
    source: "(SELECT u.id, u.name, u.email, u.kind, u.created_at, r.role FROM users u LEFT JOIN account_roles r ON r.user_id=u.id WHERE r.role IS NOT 'guest')",
    fields: { id: col('id', 'id'), name: col('name'), role: col('role'), kind: col('kind'), email: { ...col('email'), adminOnly: true } },
    rels: {},
    order: 't.created_at',
    visible: (s) => ({ sql: flag(s.active), args: [] }),
  },
  milestones: {
    source: 'milestones',
    fields: {
      id: col('id', 'id'), accountSeq: col('account_seq', 'num'), name: col('name'), date: col('date'), startDate: col('start_date'),
      color: col('color'), isGlobal: col('is_global', 'bool'), isPinned: col('is_pinned', 'bool'), createdBy: col('created_by', 'id'),
      createdAt: col('created_at', 'num'),
      // All covered project ids, never names (as in the snapshot).
      projectIds: f('(SELECT json_group_array(project_id) FROM (SELECT project_id FROM milestone_projects WHERE milestone_id=t.id ORDER BY project_id))', 'json'),
    },
    rels: { cards: { model: 'cards', kind: 'many', fk: 'milestoneId' } },
    order: 't.account_seq',
    visible: milestoneVisible('t'),
  },
  sprintConfigs: {
    source: 'sprint_configs',
    fields: {
      id: col('id', 'id'), name: col('name'), runLabelTemplate: col('run_label_template'), color: col('color'),
      upcoming: col('upcoming', 'num'), durationWeeks: col('duration_weeks', 'num'), startDay: col('start_day'),
      moveOnFinish: col('move_on_finish_json', 'json'), isGlobal: col('is_global', 'bool'), endHour: col('end_hour', 'num'),
      endTz: col('end_tz'), createdBy: col('created_by', 'id'), createdAt: col('created_at', 'num'), isArchived: col('is_archived', 'bool'),
      projectIds: f('(SELECT json_group_array(project_id) FROM (SELECT project_id FROM sprint_config_projects WHERE config_id=t.id ORDER BY project_id))', 'json'),
    },
    rels: { sprints: { model: 'sprints', kind: 'many', fk: 'configId' } },
    order: 't.created_at',
    visible: configVisible('t'),
  },
  sprints: {
    source: 'sprints',
    fields: {
      id: col('id', 'id'), configId: col('config_id', 'id'), accountSeq: col('account_seq', 'num'), runNr: col('run_nr', 'num'),
      label: col('label'), startDay: col('start_day'), endDay: col('end_day'), endsAt: col('ends_at', 'num'),
      isFinished: col('is_finished', 'bool'),
    },
    rels: {
      config: { model: 'sprintConfigs', kind: 'one', field: 'configId' },
      cards: { model: 'cards', kind: 'many', fk: 'sprintId' },
    },
    order: 't.config_id, t.run_nr',
    visible: (s) => {
      const c = configVisible('c')(s);
      return { sql: `t.config_id IN (SELECT c.id FROM sprint_configs c WHERE ${c.sql})`, args: c.args };
    },
  },
  resolvables: {
    source: 'resolvables',
    fields: {
      id: col('id', 'id'), cardId: col('card_id', 'id'), context: col('context'), creatorId: col('creator_id', 'id'),
      isClosed: col('is_closed', 'bool'), closedAt: col('closed_at', 'num'), closedBy: col('closed_by', 'id'),
      createdAt: col('created_at', 'num'), latestEntryAt: col('latest_entry_at', 'num'),
    },
    rels: {
      card: { model: 'cards', kind: 'one', field: 'cardId' },
      entries: { model: 'resolvableEntries', kind: 'many', fk: 'resolvableId' },
    },
    order: 't.created_at',
    visible: inCards('t.card_id'),
  },
  resolvableEntries: {
    source: 'resolvable_entries',
    fields: {
      id: col('id', 'id'), resolvableId: col('resolvable_id', 'id'), authorId: col('author_id', 'id'), content: longText('content'),
      createdAt: col('created_at', 'num'), version: col('version', 'num'), lastChangedAt: col('last_changed_at', 'num'),
    },
    rels: {
      resolvable: { model: 'resolvables', kind: 'one', field: 'resolvableId' },
      author: { model: 'users', kind: 'one', field: 'authorId' },
    },
    order: 't.created_at',
    visible: (s) => ({ sql: `t.resolvable_id IN (SELECT id FROM resolvables WHERE card_id IN (${s.cards.sql}))`, args: s.cards.args }),
  },
  // Project tags live in projects.tags_json; one row per tag, id "<projectId>|<name>".
  projectTags: {
    source: `(SELECT p.id || '|' || json_extract(j.value, '$.name') AS id, p.id AS project_id,
      json_extract(j.value, '$.name') AS name, json_extract(j.value, '$.emoji') AS emoji, j.key AS idx
      FROM projects p, json_each(CASE WHEN json_valid(p.tags_json) THEN p.tags_json ELSE '[]' END) j)`,
    fields: { id: col('id', 'id'), projectId: col('project_id', 'id'), name: col('name'), emoji: col('emoji') },
    rels: { project: { model: 'projects', kind: 'one', field: 'projectId' } },
    order: 't.project_id, t.idx',
    visible: inProjects('t.project_id'),
  },
  // Everyone's Hand rows for visible cards, as the snapshot sends them; id "<userId>|<cardId>" as in the client store.
  handCards: {
    source: "(SELECT user_id || '|' || card_id AS id, user_id, card_id, sort_index FROM hand_cards)",
    fields: { id: col('id', 'id'), userId: col('user_id', 'id'), cardId: col('card_id', 'id'), sortIndex: col('sort_index', 'num') },
    rels: {
      card: { model: 'cards', kind: 'one', field: 'cardId' },
      user: { model: 'users', kind: 'one', field: 'userId' },
    },
    order: 't.user_id, t.sort_index',
    visible: inCards('t.card_id'),
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Parser

interface Node {
  key: string;
  rel: Rel;
  fields: string[];
  children: Node[];
  where: Sql;
  order: string;
  limit: number;
  offset: number;
  first: boolean;
}

const unknown = (path: string) => new AppError(400, 'unknown_field', { path });
const invalid = (path: string) => new AppError(400, 'invalid_query', { path });
const tooLarge = (reason: string, path?: string) => new AppError(400, 'query_too_large', path === undefined ? { reason } : { reason, path });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^([A-Za-z_]\w*)(?:\(([\s\S]*)\))?$/;

const OPS: Record<FieldType, readonly string[]> = {
  id: ['eq', 'neq', 'in'],
  text: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'contains', 'search'],
  num: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in'],
  bool: ['eq', 'neq', 'in'],
  array: ['has', 'overlaps'],
  json: [],
};
const CMP: Record<string, string> = { lt: '<', lte: '<=', gt: '>', gte: '>=' };

const likeEsc = (s: string) => s.replace(/[\\%_]/g, '\\$&');

class Parser {
  lists = 0;
  predicates = 0;
  textTerms = 0;
  /** Text-match terms of the list being parsed. */
  listTextTerms = 0;
  textWords = 0;
  arrayTerms = 0;

  countWords(n: number, at: string) {
    if ((this.textWords += n) > QUERY_LIMITS.maxTextWords) throw tooLarge('text_words', at);
  }
  constructor(private scope: Scope) {}

  field(model: Model, name: string, path: string): Field {
    const fd = Object.hasOwn(model.fields, name) ? model.fields[name] : undefined;
    if (!fd || (fd.adminOnly && !this.scope.admin)) throw unknown(`${path}.${name}`);
    return fd;
  }

  /** One selection list: field names and `{relation(filter): [...]}` objects. */
  selection(modelName: ModelName, items: unknown, path: string, depth: number): { fields: string[]; children: Node[] } {
    if (!Array.isArray(items)) throw invalid(path);
    const model = MODELS[modelName];
    const fields = new Set<string>(modelName === '_root' ? [] : ['id']);
    const children: Node[] = [];
    for (const item of items) {
      if (typeof item === 'string' && modelName !== '_root') {
        this.field(model, item, path);
        fields.add(item);
      } else if (isObj(item)) {
        for (const [key, sub] of Object.entries(item)) children.push(this.relation(model, key, sub, path, depth + 1));
      } else {
        throw invalid(path);
      }
    }
    return { fields: [...fields], children };
  }

  relation(parent: Model, key: string, sub: unknown, parentPath: string, depth: number): Node {
    const m = KEY_RE.exec(key);
    if (!m) throw invalid(`${parentPath}.${key}`);
    const name = m[1];
    const path = `${parentPath}.${name}`;
    const rel = Object.hasOwn(parent.rels, name) ? parent.rels[name] : undefined;
    if (!rel) throw unknown(path);
    if (depth > QUERY_LIMITS.maxDepth) throw new AppError(400, 'query_too_deep', { path });
    if (++this.lists > QUERY_LIMITS.maxLists) throw tooLarge('lists', path);
    let filter: unknown = {};
    if (m[2] !== undefined) {
      try { filter = JSON.parse(m[2]); } catch { throw invalid(path); }
      if (!isObj(filter)) throw invalid(path);
    }
    const node = this.options(rel, filter as Record<string, unknown>, path);
    const { fields, children } = this.selection(rel.model, sub, path, depth);
    return { ...node, key, rel, fields, children };
  }

  /** The filter object of one relation: conditions plus $order/$limit/$offset/$first (lists only). */
  options(rel: Rel, filter: Record<string, unknown>, path: string) {
    const model = MODELS[rel.model];
    const isList = rel.kind === 'all' || rel.kind === 'many';
    let order = model.order;
    let limit: number = QUERY_LIMITS.listRows;
    let offset = 0;
    let first = false;
    const conds: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$order' && isList) order = this.order(model, v, path);
      else if (k === '$limit' && isList) {
        if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid(`${path}.$limit`);
        limit = Math.min(v as number, QUERY_LIMITS.listRows);
      } else if (k === '$offset' && isList) {
        if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid(`${path}.$offset`);
        if ((v as number) > QUERY_LIMITS.maxOffset) throw tooLarge('offset', `${path}.$offset`);
        offset = v as number;
      } else if (k === '$first' && isList) {
        if (typeof v !== 'boolean') throw invalid(`${path}.$first`);
        first = v;
      } else conds[k] = v;
    }
    if (first) limit = Math.min(limit, 1);
    this.listTextTerms = 0;
    return { where: this.where(model, conds, path, 0), order: `${order}, t.id`, limit, offset, first };
  }

  order(model: Model, v: unknown, path: string): string {
    const keys = Array.isArray(v) ? v : [v];
    if (keys.length === 0 || keys.length > QUERY_LIMITS.maxOrder || keys.some((x) => typeof x !== 'string')) throw invalid(`${path}.$order`);
    return (keys as string[]).map((k) => {
      const desc = k.startsWith('-');
      const name = desc ? k.slice(1) : k;
      const fd = this.field(model, name, `${path}.$order`);
      if (fd.type === 'json' || fd.type === 'array' || fd.noSort) throw unknown(`${path}.$order.${name}`);
      // Every sort key draws on the predicate budget (a computed field at its weight): a sort reads every matching row.
      if ((this.predicates += fd.sortCost ?? fd.cost ?? 1) > QUERY_LIMITS.maxPredicates) throw tooLarge('predicates', `${path}.$order.${name}`);
      return `${fd.sql} ${desc ? 'DESC' : 'ASC'}`;
    }).join(', ');
  }

  /** AND of the object's conditions; `$or` holds an array of such objects. */
  where(model: Model, conds: Record<string, unknown>, path: string, orDepth: number): Sql {
    const parts: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(conds)) {
      let t: Sql;
      if (k === '$or') {
        if (!Array.isArray(v) || v.length === 0 || !v.every(isObj)) throw invalid(`${path}.$or`);
        if (++this.predicates > QUERY_LIMITS.maxPredicates) throw tooLarge('predicates', `${path}.$or`);
        if (v.length > QUERY_LIMITS.maxOrBranches) throw tooLarge('or_branches', `${path}.$or`);
        if (orDepth >= QUERY_LIMITS.maxOrDepth) throw tooLarge('or_depth', `${path}.$or`);
        const alts = v.map((alt) => this.where(model, alt, path, orDepth + 1));
        t = { sql: `(${alts.map((a) => a.sql).join(' OR ')})`, args: alts.flatMap((a) => a.args) };
      } else if (k.startsWith('$')) {
        throw unknown(`${path}.${k}`);
      } else {
        t = this.term(model, k, v, path);
      }
      parts.push(t.sql);
      args.push(...t.args);
    }
    return { sql: parts.length ? `(${parts.join(' AND ')})` : '1', args };
  }

  term(model: Model, name: string, raw: unknown, path: string): Sql {
    const fd = this.field(model, name, path);
    const cost = fd.cost ?? 1;
    if ((this.predicates += cost) > QUERY_LIMITS.maxPredicates) throw tooLarge('predicates', `${path}.${name}`);
    let op: unknown = 'eq';
    let value = raw;
    if (isObj(raw)) ({ op, value } = raw);
    else if (Array.isArray(raw)) op = 'in';
    const at = `${path}.${name}`;
    if (typeof op !== 'string' || !OPS[fd.type].includes(op)) throw unknown(`${at}.${String(op)}`);
    if (op === 'contains' || op === 'search') {
      if (++this.listTextTerms > QUERY_LIMITS.maxTextTermsPerList) throw tooLarge('text_terms_per_list', at);
      if (++this.textTerms > QUERY_LIMITS.maxTextTerms) throw tooLarge('text_terms', at);
    }
    if ((op === 'has' || op === 'overlaps') && ++this.arrayTerms > QUERY_LIMITS.maxArrayTerms) throw tooLarge('array_terms', at);
    const str = (v: unknown): string => {
      if (typeof v !== 'string') throw invalid(at);
      if (v.length > QUERY_LIMITS.maxValueChars) throw tooLarge('value_length', at);
      return v;
    };
    const x = fd.sql;
    const scalar = (v: unknown): unknown => {
      const ok = fd.type === 'num' ? typeof v === 'number' && Number.isFinite(v)
        : fd.type === 'bool' ? typeof v === 'boolean' : typeof v === 'string';
      if (!ok) throw invalid(at);
      return typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? str(v) : v;
    };
    const list = (v: unknown): unknown[] => {
      if (!Array.isArray(v)) throw invalid(at);
      if (v.length > QUERY_LIMITS.maxValues) throw tooLarge('values', at);
      return v.map(scalar);
    };
    switch (op) {
      case 'eq': return { sql: `${x} IS ?`, args: [value === null ? null : scalar(value)] };
      case 'neq': return { sql: `${x} IS NOT ?`, args: [value === null ? null : scalar(value)] };
      case 'lt': case 'lte': case 'gt': case 'gte': return { sql: `${x} ${CMP[op]} ?`, args: [scalar(value)] };
      case 'in': return { sql: `${x} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(list(value))] };
      case 'contains': this.countWords(cost, at); return { sql: `${x} LIKE ? ESCAPE '\\'`, args: [`%${likeEsc(scalar(value) as string)}%`] };
      case 'search': {
        // Every word of the value must occur in the field, ignoring case (ASCII). Plain LIKE only: a word-boundary
        // check (lower() + GLOB per word) measured ~0.25 s per word on 50k cards, too slow to allow in one statement.
        const words = (scalar(value) as string).split(/\s+/).filter(Boolean);
        if (words.length > QUERY_LIMITS.maxWords) throw tooLarge('words', at);
        this.countWords(words.length * cost, at);
        if (!words.length) return { sql: '1', args: [] };
        return {
          sql: `(${words.map(() => `${x} LIKE ? ESCAPE '\\'`).join(' AND ')})`,
          args: words.map((w) => `%${likeEsc(w)}%`),
        };
      }
      case 'has':
        return { sql: `EXISTS (SELECT 1 FROM json_each(${x}) WHERE value = ?)`, args: [str(value)] };
      case 'overlaps': {
        if (!Array.isArray(value)) throw invalid(at);
        if (value.length > QUERY_LIMITS.maxValues) throw tooLarge('values', at);
        return { sql: `EXISTS (SELECT 1 FROM json_each(${x}) WHERE value IN (SELECT value FROM json_each(?)))`, args: [JSON.stringify(value.map(str))] };
      }
    }
    throw unknown(`${at}.${op}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Executor

/** A fetched row: `out` is its normalized response object, `raw` the selected values (relation keys included). */
interface Fetched { id: string; out: Record<string, unknown>; raw: Record<string, unknown> }

function convert(type: FieldType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'bool') return v !== 0;
  if (type === 'json' || type === 'array') return typeof v === 'string' ? JSON.parse(v) : v;
  return v;
}

class Executor {
  private rows = 0;
  private readonly deadline: number;
  readonly result: QueryResult = { _root: {} };

  constructor(private db: Db, private scope: Scope, private now: () => number) {
    this.deadline = now() + QUERY_LIMITS.budgetMs;
  }

  run(node: Node, parents: Fetched[]): void {
    if (this.now() > this.deadline) throw tooLarge('time');
    const { rel } = node;
    const model = MODELS[rel.model];
    // Selected fields plus those the child belongsTo relations need.
    const names = new Set(node.fields);
    names.add('id');
    for (const c of node.children) if (c.rel.kind === 'one') names.add(c.rel.field);
    const cols = [...names].map((n) => `${model.fields[n].sql} AS "${n}"`).join(', ');
    const vis = model.visible(this.scope);
    const where = `${vis.sql} AND ${node.where.sql}`;
    const whereArgs = [...vis.args, ...node.where.args];
    const room = QUERY_LIMITS.totalRows - this.rows + 1;
    let rows: Record<string, unknown>[] = [];

    if (rel.kind === 'single') {
      rows = this.all(`SELECT ${cols} FROM ${model.source} t WHERE ${where} LIMIT 1`, whereArgs);
      for (const p of parents) p.out[node.key] = rows[0]?.id ?? null;
    } else if (rel.kind === 'all') {
      const ids = this.ids(`SELECT t.id AS "id" FROM ${model.source} t WHERE ${where} ORDER BY ${node.order} LIMIT ? OFFSET ?`,
        [...whereArgs, Math.min(node.limit, room), node.offset]);
      rows = this.columns(model, cols, ids.map((r) => r.id));
      for (const p of parents) p.out[node.key] = node.first ? (ids[0]?.id ?? null) : ids.map((r) => r.id);
    } else if (rel.kind === 'one') {
      const want = [...new Set(parents.map((p) => p.raw[rel.field]).filter((v) => v !== null && v !== undefined))];
      if (want.length) {
        rows = this.all(`SELECT ${cols} FROM ${model.source} t WHERE t.id IN (SELECT value FROM json_each(?)) AND ${where} LIMIT ?`,
          [JSON.stringify(want), ...whereArgs, room]);
      }
      const found = new Set(rows.map((r) => r.id));
      for (const p of parents) {
        const id = p.raw[rel.field];
        p.out[node.key] = id !== null && found.has(id) ? id : null;
      }
    } else {
      const fk = model.fields[rel.fk].sql;
      const parentIds = [...new Set(parents.map((p) => p.id))];
      const ids = parentIds.length ? this.ids(
        `SELECT "id", "__p" FROM (SELECT t.id AS "id", ${fk} AS "__p", ROW_NUMBER() OVER (PARTITION BY ${fk} ORDER BY ${node.order}) AS "__rn"
           FROM ${model.source} t WHERE ${fk} IN (SELECT value FROM json_each(?)) AND ${where})
         WHERE "__rn" > ? AND "__rn" <= ? ORDER BY "__p", "__rn" LIMIT ?`,
        [JSON.stringify(parentIds), ...whereArgs, node.offset, node.offset + node.limit, room]) : [];
      rows = this.columns(model, cols, ids.map((r) => r.id));
      const byParent = new Map<unknown, unknown[]>();
      for (const r of ids) (byParent.get(r.__p) ?? byParent.set(r.__p, []).get(r.__p)!).push(r.id);
      for (const p of parents) {
        const list = byParent.get(p.id) ?? [];
        p.out[node.key] = node.first ? (list[0] ?? null) : list;
      }
    }

    this.rows += rows.length;
    if (this.rows > QUERY_LIMITS.totalRows) throw tooLarge('rows');
    if (!rows.length) return;
    const table = (this.result[rel.model] ??= {}) as Record<string, Record<string, unknown>>;
    const fetched: Fetched[] = rows.map((r) => {
      const id = r.id as string;
      const out = (table[id] ??= { id });
      for (const n of node.fields) out[n] = convert(model.fields[n].type, r[n]);
      return { id, out, raw: r };
    });
    for (const child of node.children) this.run(child, fetched);
  }

  /**
   * Lists run in two steps: the page of ids (filter, sort, offset: only the id and the sort keys per scanned row),
   * then the selected columns for that page only. Selecting the columns in the sorting statement made SQLite compute
   * them (e.g. the card title) for every scanned row.
   */
  private ids(sql: string, args: unknown[]): Record<string, unknown>[] {
    const rows = this.all(sql, args);
    if (this.rows + rows.length > QUERY_LIMITS.totalRows) throw tooLarge('rows');
    return rows;
  }

  private columns(model: Model, cols: string, ids: unknown[]): Record<string, unknown>[] {
    if (!ids.length) return [];
    const byId = new Map(this.all(`SELECT ${cols} FROM ${model.source} t WHERE t.id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)]).map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)!);
  }

  private all(sql: string, args: unknown[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...(args as any[])) as Record<string, unknown>[];
  }
}

/**
 * Runs a read query for `actor`. Throws AppError 400: `unknown_field {path}` for an unknown model, field or operator,
 * `invalid_query {path}` for a malformed query, `query_too_deep` beyond 6 levels, `query_too_large {reason, path?}`
 * beyond a cost cap (checked while parsing, before any SQL), the row cap or the time budget.
 */
export function runQuery(db: Db, actor: QueryActor, query: unknown, opts: { now?: () => number } = {}): QueryResult {
  if (!isObj(query) || !Array.isArray(query._root)) throw invalid('_root');
  const scope = readScope(db, actor);
  const { children } = new Parser(scope).selection('_root', query._root, '_root', 0);
  const exec = new Executor(db, scope, opts.now ?? Date.now);
  const root: Fetched = { id: '', out: exec.result._root, raw: {} };
  for (const node of children) exec.run(node, [root]);
  return exec.result;
}

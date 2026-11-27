import { seqFromCode, STATUS_LABEL, titleOf } from './cards';
import type { Card, DerivedStatus, Priority, ResolvableEntry, Sprint } from './types';

export type SearchCategory =
  | 'content' | 'status' | 'projectTag' | 'personalTag' | 'owner' | 'creator' | 'mentioned'
  | 'priority' | 'effort' | 'due' | 'milestone' | 'sprint' | 'sprintConfig' | 'card' | 'deck';

export type SearchOp = 'eq' | 'gte' | 'lte';

export interface SearchToken {
  category: SearchCategory;
  value: string | null;
  isNegated: boolean;
  op?: SearchOp;
}

export const CATEGORIES = [
  'content', 'status', 'projectTag', 'personalTag', 'owner', 'creator', 'mentioned',
  'priority', 'effort', 'due', 'milestone', 'sprint', 'sprintConfig', 'card', 'deck',
] as const satisfies readonly SearchCategory[];
export const OPS = ['eq', 'gte', 'lte'] as const satisfies readonly SearchOp[];

/* ---------- matching ---------- */

export interface SearchCtx {
  /** Derived workflow status (null for lore). */
  status(card: Card): DerivedStatus | null;
  personalTags(cardId: string): string[];
  subCount(cardId: string): number;
  /** Today as YYYY-MM-DD in the viewer's zone. */
  todayDay: string;
  sprints: Pick<Sprint, 'id' | 'configId' | 'startDay' | 'endDay'>[];
  now: number;
  /** The title the reader sees (a translation, web/src/translate.ts): text search matches it as well as the original. */
  shownTitle?(card: Card): string;
  /** A comment as the reader sees it, matched as well as the original. */
  shownEntry?(entry: ResolvableEntry): string;
}

const PRIORITY_RANK: Record<Priority, number> = { a: 3, b: 2, c: 1 };
const rankOf = (p: string | null): number => (p && p in PRIORITY_RANK ? PRIORITY_RANK[p as Priority] : 0);

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function compare(op: SearchOp | undefined, a: number, b: number): boolean {
  return op === 'gte' ? a >= b : op === 'lte' ? a <= b : a === b;
}

type Pred = (card: Card) => boolean;

/** The token's predicate, or null for a category this build does not know. */
function compileToken(tok: SearchToken, ctx: SearchCtx, weekEnd: string, sprintById: Map<string, SearchCtx['sprints'][number]>): Pred | null {
  const v = tok.value;
  switch (tok.category) {
    case 'content': {
      const needle = (v ?? '').toLowerCase();
      return (c) => titleOf(c.content).toLowerCase().includes(needle) || !!ctx.shownTitle?.(c).toLowerCase().includes(needle);
    }
    case 'status':
      if (v === 'undone') return (c) => c.status !== 'done';
      if (v === 'snoozing') return (c) => c.snoozedAt != null;
      return (c) => ctx.status(c) === v;
    case 'projectTag': {
      const n = (v ?? '').replace(/^#/, '').toLowerCase();
      return (c) => c.tags.some((x) => x.toLowerCase() === n) || c.masterTags.some((x) => x.toLowerCase() === n);
    }
    case 'personalTag': {
      const n = (v ?? '').replace(/^#/, '').toLowerCase();
      return (c) => ctx.personalTags(c.id).some((x) => x.toLowerCase() === n);
    }
    case 'owner': return (c) => c.assigneeId === v;
    case 'creator': return (c) => c.creatorId === v;
    case 'mentioned': return (c) => v != null && c.mentionedUserIds.includes(v);
    case 'priority': {
      if (!tok.op || tok.op === 'eq') return (c) => c.priority === v;
      const want = rankOf(v);
      return (c) => compare(tok.op, rankOf(c.priority), want);
    }
    case 'effort': {
      if (v === null) return (c) => c.effort == null;
      const want = Number(v);
      return (c) => c.effort != null && compare(tok.op, c.effort, want);
    }
    case 'due':
      if (v === 'today') return (c) => c.dueDate === ctx.todayDay;
      if (v === 'week') return (c) => c.dueDate != null && c.dueDate >= ctx.todayDay && c.dueDate <= weekEnd;
      return (c) => c.dueDate != null;
    case 'milestone': return (c) => c.milestoneId === v;
    case 'sprint': return (c) => c.sprintId === v;
    case 'sprintConfig': {
      const i = (v ?? '').lastIndexOf(':');
      if (i < 0) return () => false;
      const cfg = (v ?? '').slice(0, i);
      const when = (v ?? '').slice(i + 1);
      return (c) => {
        const s = c.sprintId ? sprintById.get(c.sprintId) : undefined;
        if (!s || s.configId !== cfg) return false;
        if (when === 'current') return s.startDay <= ctx.todayDay && ctx.todayDay <= s.endDay;
        if (when === 'future') return s.startDay > ctx.todayDay;
        if (when === 'past') return s.endDay < ctx.todayDay;
        return false;
      };
    }
    case 'card':
      switch (v) {
        case 'hero': return (c) => ctx.subCount(c.id) > 0;
        case 'sub': return (c) => c.parentCardId != null;
        case 'locked': return (c) => !!c.hasBlockingDeps;
        case 'locking': return (c) => !!c.isBlockingDep;
        case 'cover': return (c) => c.coverFileId != null;
        case 'doc': return (c) => c.isDoc;
        default: return () => false;
      }
    case 'deck': return (c) => c.deckId === v;
    // Tokens come from stored data (saved searches, Smart Node queries) that may predate validation.
    default: return null;
  }
}

export function compileSearch(tokens: SearchToken[], forceOr: boolean, ctx: SearchCtx): (card: Card) => boolean {
  if (tokens.length === 0) return () => true;
  const weekEnd = addDays(ctx.todayDay, 6);
  const sprintById = new Map(ctx.sprints.map((s) => [s.id, s]));
  const preds = tokens.map((tok) => {
    const p = compileToken(tok, ctx, weekEnd, sprintById);
    // An unknown token matches nothing, negated or not.
    if (!p) return () => false;
    return tok.isNegated ? (c: Card) => !p(c) : p;
  });
  return forceOr ? (c) => preds.some((p) => p(c)) : (c) => preds.every((p) => p(c));
}

/* ---------- suggestions ---------- */

export interface SuggestCtx {
  users: { id: string; name: string }[];
  decks: { id: string; title: string }[];
  projectTags: string[];
  personalTags: string[];
  milestones: { id: string; name: string }[];
  sprints: { id: string; configId: string; label: string }[];
  sprintConfigs: { id: string; name: string }[];
  priorityLabel(p: Priority): string;
  cardBySeq(seq: number): Card | null;
}

export type GoTo =
  | { kind: 'deck'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'comment'; text: string };

export interface Suggestion {
  label: string;
  token?: SearchToken;
  goto?: GoTo;
  disabled?: boolean;
  /** Extra words the typed text also matches (the older names, so typing "effort" still finds the effort rows). */
  alias?: string;
}
export interface SuggestionGroup {
  heading: string;
  items: Suggestion[];
}

const tok = (category: SearchCategory, value: string | null, label: string, op?: SearchOp, isNegated = false, alias?: string): Suggestion => ({
  label, token: { category, value, isNegated, ...(op ? { op } : {}) }, ...(alias ? { alias } : {}),
});

const STATUS_ORDER = ['unassigned', 'assigned', 'started', 'snoozing', 'blocked', 'review', 'done'] as const;
const CARD_FLAGS: [string, string, string?][] = [
  ['hero', 'Main task', 'hero task'], ['sub', 'Subtask', 'subtask'], ['locked', 'Locked task', 'locked task'], ['locking', 'Locking task', 'locking task'],
  ['cover', 'Has cover image'], ['doc', 'Lore', 'doc task'],
];
const EFFORTS = [0, 1, 2, 3, 5, 8];

type Heads = Record<string, Suggestion[]>;

function statusItems(neg: boolean): Suggestion[] {
  return [
    ...STATUS_ORDER.map((s) => tok('status', s, STATUS_LABEL[s], undefined, neg)),
    tok('status', 'undone', 'Undone', undefined, neg),
  ];
}
function priorityItems(ctx: SuggestCtx, neg: boolean): Suggestion[] {
  return (['a', 'b', 'c'] as Priority[]).flatMap((p) => {
    const l = ctx.priorityLabel(p);
    return [tok('priority', p, l, 'eq', neg), tok('priority', p, `>= ${l}`, 'gte', neg), tok('priority', p, `<= ${l}`, 'lte', neg)];
  }).concat([tok('priority', null, 'No priority', 'eq', neg)]);
}
function effortItems(neg: boolean): Suggestion[] {
  return [...EFFORTS.map((e) => tok('effort', String(e), `${e} effort`, 'eq', neg, `effort ${e}`)), tok('effort', null, 'No effort', 'eq', neg, 'no effort')];
}
function milestoneItems(ctx: SuggestCtx, neg: boolean): Suggestion[] {
  return [...ctx.milestones.map((m) => tok('milestone', m.id, m.name, undefined, neg)), tok('milestone', null, 'No milestone', undefined, neg, 'no milestone')];
}
function runItems(ctx: SuggestCtx, neg: boolean): Suggestion[] {
  return [...ctx.sprints.map((s) => tok('sprint', s.id, s.label, undefined, neg)), tok('sprint', null, 'Not in a sprint', undefined, neg, 'not in a run')];
}
function trackItems(ctx: SuggestCtx, neg: boolean): Suggestion[] {
  return ctx.sprintConfigs.flatMap((c) =>
    (['current', 'future', 'past'] as const).map((w) => tok('sprintConfig', `${c.id}:${w}`, `${c.name}: ${w} sprint`, undefined, neg, `${w} run`)));
}
function cardItems(neg: boolean): Suggestion[] {
  return CARD_FLAGS.map(([v, l, a]) => tok('card', v, l, undefined, neg, a));
}

const match = (label: string, q: string, alias?: string) => q === '' || label.toLowerCase().includes(q) || !!alias?.includes(q);
function pick(heads: Heads, q: string): SuggestionGroup[] {
  const out: SuggestionGroup[] = [];
  for (const [heading, all] of Object.entries(heads)) {
    const items = all.filter((i) => match(i.label, q, i.alias));
    if (items.length) out.push({ heading, items });
  }
  return out;
}

export function suggest(text: string, ctx: SuggestCtx): SuggestionGroup[] {
  if (text === '') return [];

  if (text.startsWith('!')) {
    const q = text.slice(1).trim().toLowerCase();
    return pick({
      Task: cardItems(true), Effort: effortItems(true), Priority: priorityItems(ctx, true),
      Status: statusItems(true), 'Milestone': milestoneItems(ctx, true), Sprint: runItems(ctx, true), 'Sprint track': trackItems(ctx, true),
    }, q);
  }

  if (text.startsWith('$')) {
    const seq = seqFromCode(text.slice(1).trim().toLowerCase());
    const c = seq == null ? null : ctx.cardBySeq(seq);
    return [{
      heading: 'Go to task',
      items: [c ? { label: titleOf(c.content), goto: { kind: 'card', id: c.id } } : { label: 'No task with this code', disabled: true }],
    }];
  }

  const prefix = /^(gd|gc|gm):(.*)$/.exec(text);
  if (prefix) {
    const rest = prefix[2].trim();
    if (prefix[1] === 'gd') {
      const q = rest.toLowerCase();
      const items = ctx.decks.filter((d) => match(d.title, q)).map((d): Suggestion => ({ label: d.title, goto: { kind: 'deck', id: d.id } }));
      return items.length ? [{ heading: 'Go to list', items }] : [];
    }
    if (prefix[1] === 'gc') {
      const seq = seqFromCode(rest.replace(/^\$/, '').toLowerCase());
      const c = seq == null ? null : ctx.cardBySeq(seq);
      return [{ heading: 'Go to task', items: [c ? { label: titleOf(c.content), goto: { kind: 'card', id: c.id } } : { label: 'No task with this code', disabled: true }] }];
    }
    return [{ heading: 'Go to comment', items: [{ label: `Comment containing '${rest}'`, goto: { kind: 'comment', text: rest } }] }];
  }

  if (text.startsWith('#')) {
    const q = text.slice(1).trim().toLowerCase();
    return pick({
      'Project tag': ctx.projectTags.map((n) => tok('projectTag', n, `#${n}`)),
      'Personal tag': ctx.personalTags.map((n) => tok('personalTag', n, `#${n}`)),
    }, q);
  }

  if (text.startsWith('@')) {
    const q = text.slice(1).trim().toLowerCase();
    const people = (cat: 'owner' | 'creator' | 'mentioned') => ctx.users.map((u) => tok(cat, u.id, `@${u.name}`));
    return pick({
      Owner: [tok('owner', null, 'No owner'), ...people('owner')],
      'Created by': people('creator'),
      Mentioned: people('mentioned'),
    }, q);
  }

  const q = text.trim().toLowerCase();
  const typed = text.trim();
  const groups = pick({
    Status: statusItems(false),
    Priority: priorityItems(ctx, false),
    Effort: effortItems(false),
    'Due date': [tok('due', 'today', 'Due today'), tok('due', 'week', 'Due within 7 days'), tok('due', 'any', 'Has a due date')],
    'Milestone': milestoneItems(ctx, false),
    Sprint: runItems(ctx, false),
    'Sprint track': trackItems(ctx, false),
    Task: cardItems(false),
  }, q);
  // Tags are only offered after '#'. Keyword hits (priority, effort, due ...) are added after the fixed rows.
  const status = groups.filter((g) => g.heading === 'Status');
  const rest = groups.filter((g) => g.heading !== 'Status');
  const deckItems = ctx.decks.filter((d) => match(d.title, q)).map((d): Suggestion => ({ label: d.title, goto: { kind: 'deck', id: d.id } }));
  return [
    ...status,
    { heading: 'Content', items: [{ label: `Title contains '${typed}'`, token: { category: 'content', value: typed, isNegated: false } }] },
    { heading: 'Go to list', items: deckItems.length ? deckItems : [{ label: 'No matching list', disabled: true }] },
    { heading: 'Go to task', items: [{ label: 'Type gc: or $ and a task code', disabled: true }] },
    { heading: 'Go to comment', items: [{ label: `Comment containing '${typed}'`, goto: { kind: 'comment', text: typed } }] },
    ...rest,
  ];
}

/* ---------- names and quick results ---------- */

function phrase(t: SearchToken, ctx: SuggestCtx): string {
  const v = t.value;
  const name = (list: { id: string; name: string }[]) => list.find((x) => x.id === v)?.name ?? 'unknown';
  switch (t.category) {
    case 'content': return `'${v ?? ''}'`;
    case 'status': return v === 'undone' ? 'undone' : (STATUS_LABEL[v as DerivedStatus] ?? v ?? '').toLowerCase();
    case 'projectTag': case 'personalTag': return `#${v}`;
    case 'owner': return v === null ? 'unowned' : `owned by ${name(ctx.users)}`;
    case 'creator': return `created by ${name(ctx.users)}`;
    case 'mentioned': return `mentioning ${name(ctx.users)}`;
    case 'priority': {
      if (v === null) return 'no-priority';
      const l = ctx.priorityLabel(v as Priority);
      return t.op === 'gte' ? `at least ${l} priority` : t.op === 'lte' ? `at most ${l} priority` : `${l} priority`;
    }
    case 'effort': return v === null ? 'no-effort' : `Effort ${t.op === 'gte' ? '>= ' : t.op === 'lte' ? '<= ' : ''}${v}`;
    case 'due': return v === 'today' ? 'due today' : v === 'week' ? 'due within 7 days' : 'with a due date';
    case 'milestone': return v === null ? 'without a milestone' : `in ${name(ctx.milestones)}`;
    case 'sprint': return v === null ? 'outside any sprint' : `in ${ctx.sprints.find((s) => s.id === v)?.label ?? 'a sprint'}`;
    case 'sprintConfig': {
      const i = (v ?? '').lastIndexOf(':');
      if (i < 0) return 'in a sprint track';
      const cfg = ctx.sprintConfigs.find((c) => c.id === (v ?? '').slice(0, i))?.name ?? 'a track';
      return `in the ${(v ?? '').slice(i + 1)} sprint of ${cfg}`;
    }
    case 'card': return CARD_FLAGS.find(([k]) => k === v)?.[1].toLowerCase() ?? String(v);
    case 'deck': return `in ${ctx.decks.find((d) => d.id === v)?.title ?? 'a list'}`;
    default: return 'unknown filter';
  }
}

/** A short name for a saved search, e.g. "'gets' cards" or "Not blocked cards". Forced-OR joins with "or". */
export function savedSearchName(tokens: SearchToken[], ctx: SuggestCtx, forceOr = false): string {
  if (tokens.length === 0) return 'All tasks';
  const parts = tokens.map((t) => {
    if (t.isNegated && t.value === null) {
      const inverse: Partial<Record<SearchCategory, string>> = {
        owner: 'owned', priority: 'prioritised', effort: 'estimated', milestone: 'in a milestone', sprint: 'in a sprint',
      };
      if (inverse[t.category]) return inverse[t.category]!;
    }
    return t.isNegated ? `not ${phrase(t, ctx)}` : phrase(t, ctx);
  });
  const s = `${parts.join(forceOr ? ' or ' : ' and ')} tasks`;
  return s[0].toUpperCase() + s.slice(1);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function quickResults(
  text: string, cards: Card[], entries: ResolvableEntry[], ctx?: SearchCtx,
): { cards: Card[]; comments: ResolvableEntry[]; codeHit: Card | null } {
  const q = text.trim();
  if (q === '') return { cards: [], comments: [], codeHit: null };
  const lower = q.toLowerCase();
  const found = cards
    .filter((c) => titleOf(c.content).toLowerCase().includes(lower) || !!ctx?.shownTitle?.(c).toLowerCase().includes(lower))
    .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
    .slice(0, 10);
  const words = lower.split(/\s+/).filter(Boolean).map((w) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(w)}($|[^\\p{L}\\p{N}_])`, 'u'));
  const when = (e: ResolvableEntry) => e.lastChangedAt ?? e.createdAt;
  const comments = entries
    .filter((e) => {
      const c = e.content.toLowerCase(), t = ctx?.shownEntry?.(e).toLowerCase();
      return words.every((r) => r.test(c)) || (t !== undefined && t !== c && words.every((r) => r.test(t)));
    })
    .sort((a, b) => when(b) - when(a))
    .slice(0, 5);
  const seq = seqFromCode(lower.replace(/^\$/, ''));
  const codeHit = seq == null ? null : (cards.find((c) => c.seq === seq) ?? null);
  return { cards: found, comments, codeHit };
}

/* ---------- ?search= URL form ---------- */

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export function encodeChips(tokens: SearchToken[], forceOr: boolean): string {
  return b64urlEncode(JSON.stringify({ tokens, forceOr }));
}

/** Same cap as the server's search/save (a longer search can be filtered but not saved). */
export const MAX_CHIPS = 20;

export function decodeChips(s: string): { tokens: SearchToken[]; forceOr: boolean } | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const raw: unknown = JSON.parse(b64urlDecode(s));
    if (typeof raw !== 'object' || raw === null) return null;
    const { tokens, forceOr } = raw as { tokens?: unknown; forceOr?: unknown };
    if (!Array.isArray(tokens) || tokens.length > MAX_CHIPS || typeof forceOr !== 'boolean') return null;
    const out: SearchToken[] = [];
    for (const t of tokens) {
      if (typeof t !== 'object' || t === null) return null;
      const { category, value, isNegated, op } = t as Record<string, unknown>;
      if (!CATEGORIES.includes(category as SearchCategory)) return null;
      if (value !== null && typeof value !== 'string') return null;
      if (typeof isNegated !== 'boolean') return null;
      if (op !== undefined && !OPS.includes(op as SearchOp)) return null;
      out.push({ category: category as SearchCategory, value, isNegated, ...(op ? { op: op as SearchOp } : {}) });
    }
    return { tokens: out, forceOr };
  } catch {
    return null;
  }
}

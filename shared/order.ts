import { STATUS_LABEL, titleOf } from './cards';
import type { SearchCategory, SearchToken } from './search';
import type { Card, DerivedStatus, Milestone, Priority, Sprint, User } from './types';

export type OrderProp =
  | 'priority' | 'effort' | 'status' | 'sprint' | 'milestone' | 'projectTags' | 'tags' | 'personalTags'
  | 'manual' | 'assignee' | 'creator' | 'lastUpdatedAt' | 'createdAt' | 'title' | 'changes'
  | 'timeTracked' | 'dueDate' | 'heroCard' | 'beastLevel';

export interface SortKey {
  prop: OrderProp;
  isReversed: boolean;
}

export interface DeckView {
  prop: OrderProp;
  isReversed: boolean;
  mode: 'miniCard' | 'tableView';
  secondary: SortKey[] | null;
  isCompact?: boolean;
  hideEmpty?: boolean;
}

export interface CardGroup {
  key: string;
  label: string;
  filterToken: SearchToken | null;
  cards: Card[];
  effortDone: number;
  effortTotal: number;
}

export interface OrderCtx {
  users: User[];
  milestones: Milestone[];
  sprints: Sprint[];
  isDone(card: Card): boolean;
  /** The derived status (shared/cards derivedStatus); null for doc cards. The engine never recomputes it. */
  status(card: Card): DerivedStatus | null;
  hasOpenNotification(cardId: string): boolean;
  /** Total tracked time in ms. */
  timeTotal(cardId: string): number;
  subCount(cardId: string): number;
  personalTags(cardId: string): string[];
  fallbackEffort: number;
  priorityLabel(p: Priority): string;
  /** Start (ms) of the current run of a sprint config, or null. */
  currentSprintStart(configId: string): number | null;
  /** Clock for the due-date buckets; defaults to Date.now(). */
  now?: number;
}

export interface ViewFeatures {
  milestonesEnabled: boolean;
  sprintsEnabled: boolean;
  dueDateEnabled: boolean;
  timeTrackingOn: boolean;
}

interface GroupInfo {
  key: string;
  label: string;
  rank: number;
  token: SearchToken | null;
}

interface PropDef {
  label: string;
  /** Most props put a card in one group; the tag props put it in one per tag. */
  groupOf(card: Card, ctx: OrderCtx): GroupInfo[];
  /** Orders cards when the prop is a secondary key; defaults to the group's rank then label. */
  sortValue?(card: Card, ctx: OrderCtx): number | string;
  /** Groups to emit even when no card falls in them (only Run and Milestone). */
  emptyGroups?(ctx: OrderCtx): GroupInfo[];
}

const tok = (category: SearchCategory, value: string | null, op?: 'eq'): SearchToken => ({
  category, value, isNegated: false, ...(op ? { op } : {}),
});
const g = (key: string, label: string, rank: number, token: SearchToken | null = null): GroupInfo[] => [
  { key, label, rank, token },
];

const STATUS_RANK: Record<DerivedStatus, number> = {
  unassigned: 0, assigned: 1, started: 2, snoozing: 3, blocked: 4, review: 5, done: 6,
};

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (ms: number): { key: string; start: number } => {
  const d = new Date(ms);
  return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() };
};

function byDay(field: 'createdAt' | 'lastUpdatedAt'): PropDef['groupOf'] {
  return (c) => {
    const d = localDay(c[field]);
    return g(`day:${d.key}`, d.key, d.start);
  };
}

/** Inline #tags plus the project tags set from the Properties panel, bulk bar and presets. */
const projectTagsOf = (c: Card): string[] => [...new Set([...c.tags, ...c.masterTags])];

function tagGroups(names: string[], category: 'projectTag' | 'personalTag'): GroupInfo[] {
  return names.map((n) => ({ key: `${category}:${n}`, label: n, rank: 0, token: tok(category, n) }));
}

function dueBucket(card: Card, ctx: OrderCtx): GroupInfo[] {
  if (!card.dueDate) return g('due:none', 'No due date', 4);
  const today = localDay(ctx.now ?? Date.now()).key;
  const weekEnd = localDay((ctx.now ?? Date.now()) + 6 * 86_400_000).key;
  if (card.dueDate < today) return g('due:overdue', 'Overdue', 0);
  if (card.dueDate === today) return g('due:today', 'Today', 1);
  if (card.dueDate <= weekEnd) return g('due:week', 'This week', 2);
  return g('due:later', 'Later', 3);
}

const PROPS: Record<OrderProp, PropDef> = {
  priority: {
    label: 'Priority',
    groupOf: (c, ctx) =>
      c.priority
        ? g(`priority:${c.priority}`, ctx.priorityLabel(c.priority), c.priority.charCodeAt(0), tok('priority', c.priority, 'eq'))
        : g('priority:none', 'No priority', 1000, tok('priority', null, 'eq')),
  },
  effort: {
    label: 'Effort',
    groupOf: (c) => {
      if (c.isDoc) return g('effort:doc', 'Lore', 1e6 - 1);
      if (c.effort == null) return g('effort:none', 'No effort', 1e6, tok('effort', null, 'eq'));
      return g(`effort:${c.effort}`, `${c.effort} effort`, c.effort, tok('effort', String(c.effort), 'eq'));
    },
  },
  status: {
    label: 'State',
    groupOf: (c, ctx) => {
      const s = ctx.status(c);
      return s ? g(`status:${s}`, STATUS_LABEL[s], STATUS_RANK[s], tok('status', s)) : g('status:doc', 'Lore', 100);
    },
  },
  sprint: {
    label: 'Sprint',
    groupOf: (c, ctx) => {
      const i = c.sprintId ? ctx.sprints.findIndex((s) => s.id === c.sprintId) : -1;
      const s = ctx.sprints[i];
      return s ? g(`sprint:${s.id}`, s.label, i, tok('sprint', s.id)) : g('sprint:none', 'No sprint', 1e6, tok('sprint', null));
    },
    emptyGroups: (ctx) => ctx.sprints.map((s, i) => ({ key: `sprint:${s.id}`, label: s.label, rank: i, token: tok('sprint', s.id) })),
  },
  milestone: {
    label: 'Milestone',
    groupOf: (c, ctx) => {
      const i = c.milestoneId ? ctx.milestones.findIndex((m) => m.id === c.milestoneId) : -1;
      const m = ctx.milestones[i];
      return m ? g(`milestone:${m.id}`, m.name, i, tok('milestone', m.id)) : g('milestone:none', 'No milestone', 1e6, tok('milestone', null));
    },
    emptyGroups: (ctx) => ctx.milestones.map((m, i) => ({ key: `milestone:${m.id}`, label: m.name, rank: i, token: tok('milestone', m.id) })),
  },
  projectTags: {
    label: 'Project Tags',
    groupOf: (c) => (projectTagsOf(c).length ? tagGroups(projectTagsOf(c), 'projectTag') : g('tag:none', 'No tags', 1e6)),
  },
  tags: {
    label: 'Tags',
    groupOf: (c, ctx) => {
      const all = [...tagGroups(projectTagsOf(c), 'projectTag'), ...tagGroups(ctx.personalTags(c.id), 'personalTag')];
      return all.length ? all : g('tag:none', 'No tags', 1e6);
    },
  },
  personalTags: {
    label: 'Personal Tags',
    groupOf: (c, ctx) => {
      const t = ctx.personalTags(c.id);
      return t.length ? tagGroups(t, 'personalTag') : g('tag:none', 'No tags', 1e6);
    },
  },
  manual: {
    label: 'Manual',
    groupOf: () => g('manual', 'Manual', 0),
    sortValue: (c) => c.sortIndex,
  },
  assignee: {
    label: 'Owner',
    groupOf: (c, ctx) => {
      if (!c.assigneeId) return g('owner:none', 'No owner', 1, tok('owner', null));
      const u = ctx.users.find((x) => x.id === c.assigneeId);
      return g(`owner:${c.assigneeId}`, u?.name ?? 'Unknown user', 0, tok('owner', c.assigneeId));
    },
  },
  creator: {
    label: 'Creator',
    groupOf: (c, ctx) => {
      const u = ctx.users.find((x) => x.id === c.creatorId);
      return g(`creator:${c.creatorId}`, u?.name ?? 'Unknown user', 0, tok('creator', c.creatorId));
    },
  },
  lastUpdatedAt: { label: 'Last updated', groupOf: byDay('lastUpdatedAt'), sortValue: (c) => c.lastUpdatedAt },
  createdAt: { label: 'Creation date', groupOf: byDay('createdAt'), sortValue: (c) => c.createdAt },
  title: {
    label: 'Title',
    groupOf: (c) => {
      const first = titleOf(c.content).charAt(0).toLocaleUpperCase();
      return g(`title:${first}`, first, 0);
    },
    sortValue: (c) => titleOf(c.content).toLocaleLowerCase(),
  },
  changes: {
    label: 'Changes',
    groupOf: (c, ctx) =>
      ctx.hasOpenNotification(c.id)
        ? g('changes:open', 'Tasks with open notifications', 0)
        : g('changes:none', 'Tasks with no open notifications', 1),
  },
  timeTracked: {
    label: 'Time tracked',
    groupOf: (c, ctx) => {
      const h = Math.floor(Math.max(0, ctx.timeTotal(c.id)) / 3_600_000);
      return g(`time:${h}`, `${h} h`, h);
    },
    sortValue: (c, ctx) => ctx.timeTotal(c.id),
  },
  dueDate: {
    label: 'Due date',
    groupOf: dueBucket,
    sortValue: (c) => c.dueDate ?? '￿',
  },
  heroCard: {
    label: 'Main Task',
    groupOf: (c, ctx) => {
      if (ctx.subCount(c.id) > 0) return g('hero:hero', 'Main tasks', 0, tok('card', 'hero'));
      if (c.parentCardId) return g('hero:sub', 'Subtasks', 1, tok('card', 'sub'));
      return g('hero:other', 'Other tasks', 2);
    },
  },
  beastLevel: {
    label: 'Difficulty',
    groupOf: (c, ctx) => {
      const { carryCount, sprintJoinedAt } = c;
      if (carryCount > 0) return g(`beast:${carryCount}`, String(carryCount), carryCount);
      const sprint = c.sprintId ? ctx.sprints.find((s) => s.id === c.sprintId) : undefined;
      const start = sprint ? ctx.currentSprintStart(sprint.configId) : null;
      if (sprintJoinedAt != null && start != null && sprintJoinedAt > start) return g('beast:new', 'new', 1e5);
      return g('beast:none', 'No difficulty', 1e6);
    },
  },
};

export const ORDER_PROPS = Object.keys(PROPS) as OrderProp[];
export const ORDER_LABELS: Record<OrderProp, string> = Object.fromEntries(
  ORDER_PROPS.map((p) => [p, PROPS[p].label]),
) as Record<OrderProp, string>;
export const NOT_SECONDARY: OrderProp[] = ['manual', 'changes', 'heroCard'];

const DEFAULT_VIEW: DeckView = { prop: 'priority', isReversed: false, mode: 'miniCard', secondary: null };

function propEnabled(p: OrderProp, f: ViewFeatures): boolean {
  if (p === 'milestone') return f.milestonesEnabled;
  if (p === 'sprint' || p === 'beastLevel') return f.sprintsEnabled;
  if (p === 'dueDate') return f.dueDateEnabled;
  if (p === 'timeTracked') return f.timeTrackingOn;
  return true;
}

const isProp = (p: unknown): p is OrderProp => typeof p === 'string' && Object.hasOwn(PROPS, p);

export function normalizeView(v: unknown, ctx: ViewFeatures): DeckView {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const prop = isProp(o.prop) && propEnabled(o.prop, ctx) ? o.prop : DEFAULT_VIEW.prop;
  const seen = new Set<OrderProp>([prop]);
  const secondary: SortKey[] = [];
  if (Array.isArray(o.secondary)) {
    for (const k of o.secondary) {
      const key = k && typeof k === 'object' ? (k as Record<string, unknown>) : {};
      if (!isProp(key.prop) || NOT_SECONDARY.includes(key.prop) || seen.has(key.prop) || !propEnabled(key.prop, ctx)) continue;
      seen.add(key.prop);
      secondary.push({ prop: key.prop, isReversed: key.isReversed === true });
    }
  }
  const out: DeckView = {
    prop,
    isReversed: o.isReversed === true,
    mode: o.mode === 'tableView' ? 'tableView' : 'miniCard',
    secondary: secondary.length ? secondary : null,
  };
  if (typeof o.isCompact === 'boolean') out.isCompact = o.isCompact;
  if (typeof o.hideEmpty === 'boolean') out.hideEmpty = o.hideEmpty;
  return out;
}

/** Same cap as decks/update's zod schema. */
export const MAX_SECONDARY = 5;

export function addSortKey(view: DeckView, prop: OrderProp, isReversed: boolean, multi: boolean): DeckView {
  if (!multi) return { ...view, prop, isReversed, secondary: null };
  const list = view.secondary ?? [];
  if (prop === view.prop) return { ...view, isReversed: !view.isReversed };
  if (NOT_SECONDARY.includes(prop)) return view;
  if (list.some((k) => k.prop === prop)) {
    return { ...view, secondary: list.map((k) => (k.prop === prop ? { ...k, isReversed: !k.isReversed } : k)) };
  }
  if (list.length >= MAX_SECONDARY) return view;
  return { ...view, secondary: [...list, { prop, isReversed }] };
}

type Sortable = number | string;
const cmp = (a: Sortable, b: Sortable): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });

export function groupCards(cards: Card[], view: DeckView, ctx: OrderCtx): CardGroup[] {
  const def = PROPS[view.prop];
  const groups = new Map<string, { info: GroupInfo; cards: Card[] }>();
  if (view.hideEmpty !== true) {
    for (const info of def.emptyGroups?.(ctx) ?? []) groups.set(info.key, { info, cards: [] });
  }
  for (const c of cards) {
    for (const info of def.groupOf(c, ctx)) {
      let gr = groups.get(info.key);
      if (!gr) groups.set(info.key, (gr = { info, cards: [] }));
      gr.cards.push(c);
    }
  }

  const sortKey = (p: OrderProp, c: Card): Sortable => {
    const d = PROPS[p];
    if (d.sortValue) return d.sortValue(c, ctx);
    const first = d.groupOf(c, ctx)[0];
    return first ? `${first.rank.toFixed(0).padStart(16, '0')}|${first.label}` : '';
  };
  // Precompute secondary keys per card so sorting stays O(n log n) with cheap comparisons.
  const keys = view.secondary ?? [];
  const primaryIsCardOrder = view.prop === 'manual';
  const order: SortKey[] = primaryIsCardOrder ? [{ prop: view.prop, isReversed: view.isReversed }, ...keys] : keys;
  const cache = new Map<Card, Sortable[]>();
  const keyed = (c: Card) => {
    let k = cache.get(c);
    if (!k) cache.set(c, (k = order.map((o) => sortKey(o.prop, c))));
    return k;
  };
  const cardCmp = (a: Card, b: Card): number => {
    const ka = keyed(a);
    const kb = keyed(b);
    for (let i = 0; i < order.length; i++) {
      const r = cmp(ka[i]!, kb[i]!);
      if (r !== 0) return order[i]!.isReversed ? -r : r;
    }
    return a.sortIndex - b.sortIndex || a.seq - b.seq;
  };

  const list = [...groups.values()];
  list.sort((a, b) => a.info.rank - b.info.rank || a.info.label.localeCompare(b.info.label, undefined, { numeric: true }) || (a.info.key < b.info.key ? -1 : 1));
  if (view.isReversed && !primaryIsCardOrder) list.reverse();

  const out: CardGroup[] = [];
  for (const { info, cards: members } of list) {
    if (view.hideEmpty && members.length === 0) continue;
    members.sort(cardCmp);
    let effortDone = 0;
    let effortTotal = 0;
    for (const c of members) {
      if (c.isDoc) continue;
      const e = c.effort ?? ctx.fallbackEffort;
      effortTotal += e;
      if (ctx.isDone(c)) effortDone += e;
    }
    out.push({ key: info.key, label: info.label, filterToken: info.token, cards: members, effortDone, effortTotal });
  }
  return out;
}

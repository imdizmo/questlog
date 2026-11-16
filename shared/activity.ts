import type { HistoryChange } from './types';

export type ActivityFilter = 'newCards' | 'workflow' | 'done' | 'attachments' | 'properties' | 'content' | 'conversations';
export const ACTIVITY_FILTERS: ActivityFilter[] = ['newCards', 'workflow', 'done', 'attachments', 'properties', 'content', 'conversations'];

export interface ActivityItem {
  id: string;
  at: number;
  actorId: string;
  cardId: string | null;
  deckId: string | null;
  /** Project of the deck (needed for "Created <deck> in <project>"). */
  projectId?: string | null;
  kind: 'history' | 'entry' | 'deckCreated';
  changes?: HistoryChange[];
  entryId?: string;
  quote?: string;
}

export interface ActivityLookup {
  card(id: string): string | null;
  user(id: string): string;
  deck(id: string): string;
  project(id: string): string;
  milestone(id: string): string;
  /** A zone as "<zone> of <milestone>". */
  milestoneZone(id: string): string;
  sprint(id: string): string;
  priorityLabel(p: string): string;
}

/** "abc1234 by Author" from a 'commit' change's `to` ({sha, author, url}). */
export function commitLabel(to: unknown): string {
  const t = to && typeof to === 'object' ? (to as { sha?: unknown; author?: unknown }) : {};
  return `${typeof t.sha === 'string' ? t.sha.slice(0, 7) : 'a commit'} by ${typeof t.author === 'string' && t.author ? t.author : 'someone'}`;
}

/** The commit's link, only when it is an http(s) URL. */
export function commitHref(to: unknown): string | null {
  const url = to && typeof to === 'object' ? (to as { url?: unknown }).url : null;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Primary filter of a change kind. Comment open/close are conversation events; block/review stay workflow. */
export function filterOf(kind: HistoryChange['kind']): ActivityFilter {
  switch (kind) {
    case 'created': return 'newCards';
    case 'status': case 'blocked': case 'unblocked': case 'reviewOpened': case 'reviewClosed': return 'workflow';
    case 'commentOpened': case 'commentClosed': return 'conversations';
    case 'file': return 'attachments';
    case 'content': case 'title': return 'content';
    default: return 'properties';
  }
}

/** Every filter a change belongs to (a status change to done is both workflow and done). */
export function filtersOf(c: HistoryChange): ActivityFilter[] {
  const f = filterOf(c.kind);
  return c.kind === 'status' && c.to === 'done' ? [f, 'done'] : [f];
}

const isProperty = (c: HistoryChange) => filterOf(c.kind) === 'properties';
export const MERGE_WINDOW_MS = 5 * 60_000;

/** Merge adjacent (newest-first) history items of one card and actor, at most 5 minutes apart, whose changes are all properties. */
export function mergeProperties(items: ActivityItem[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  let lastAt = 0;
  for (const it of items) {
    const prev = out[out.length - 1];
    const mergeable = (x: ActivityItem) => x.kind === 'history' && !!x.cardId && !!x.changes && x.changes.length > 0 && x.changes.every(isProperty);
    if (prev && mergeable(prev) && mergeable(it) && prev.cardId === it.cardId && prev.actorId === it.actorId && lastAt - it.at <= MERGE_WINDOW_MS) {
      // Older changes first, so the sentence reads in the order things happened.
      out[out.length - 1] = { ...prev, changes: [...it.changes!, ...prev.changes!] };
    } else out.push(it);
    lastAt = it.at;
  }
  return out;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Friday 20 Nov" from YYYY-MM-DD, treated as a calendar date (no timezone shift). */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]}`;
}

const tagsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function fragment(c: HistoryChange, card: string, l: ActivityLookup): string {
  const to = c.to;
  switch (c.kind) {
    case 'priority': return typeof to === 'string' ? `Priority set to ${l.priorityLabel(to)}` : 'Priority cleared';
    case 'effort': return to == null ? 'Effort cleared' : `Effort set to ${String(to)}`;
    case 'dueDate': return typeof to === 'string' ? `${card} set Due Date to ${formatDay(to)}` : `${card} cleared Due Date`;
    case 'owner': return typeof to === 'string' ? `${card} assigned to ${l.user(to)}` : `${card} unassigned`;
    case 'tags': {
      const before = new Set(tagsOf(c.from)); const after = new Set(tagsOf(to));
      const added = [...after].filter((t) => !before.has(t)); const removed = [...before].filter((t) => !after.has(t));
      const parts = [added.length ? `added ${added.map((t) => `#${t}`).join(' ')}` : '', removed.length ? `removed ${removed.map((t) => `#${t}`).join(' ')}` : ''].filter(Boolean);
      return `${card} ${parts.join(' and ') || 'changed tags'}`;
    }
    case 'created': return `${card} was created`;
    case 'status': return `${card} marked ${String(to).replace('_', ' ')}`;
    case 'content': return `${card} content edited`;
    case 'title': return `${card} renamed`;
    case 'deck': return typeof to === 'string' ? `${card} moved to ${l.deck(to)}` : `${card} left its list`;
    case 'snoozed': return `${card} snoozed after going quiet`;
    case 'unsnoozed': return `${card} woke up`;
    case 'visibility': return `${card} ${to === 'deleted' ? 'deleted' : to === 'archived' ? 'archived' : 'restored'}`;
    case 'doc': return `${card} ${to ? 'became lore' : 'is no longer lore'}`;
    case 'blocked': return `${card} blocked${c.quote ? `: ${c.quote}` : ''}`;
    case 'unblocked': return `${card} unblocked`;
    case 'reviewOpened': return `${card} sent for review`;
    case 'reviewClosed': return `${card} review closed`;
    case 'commentOpened': return `${card} comment started${c.quote ? `: ${c.quote}` : ''}`;
    case 'commentClosed': return `${card} comment closed`;
    case 'deps': return `${card} dependencies changed`;
    case 'parent': return `${card} main task changed`;
    case 'children': return `${card} subtasks changed`;
    case 'milestone': return typeof to === 'string' ? `${card} added to ${l.milestone(to)}` : typeof c.from === 'string' ? `${card} removed from ${l.milestone(c.from)}` : `${card} removed from its milestone`;
    case 'milestoneZone': return typeof to === 'string' ? `${card} moved to ${l.milestoneZone(to)}` : typeof c.from === 'string' ? `${card} left ${l.milestoneZone(c.from)}` : `${card} left its milestone zone`;
    case 'sprint': return typeof to === 'string' ? `${card} added to ${l.sprint(to)}` : typeof c.from === 'string' ? `${card} removed from ${l.sprint(c.from)}` : `${card} removed from its sprint`;
    case 'time': return to ? `${card} got time logged` : `${card} had logged time removed`;
    case 'commit': return `${card} referenced in commit ${commitLabel(to)}`;
    case 'file': return typeof to === 'string' ? `${card} attached ${to}` : `${card} removed ${String(c.from)}`;
    case 'entry': return `${card} lore fields changed`;
    default: return `${card} changed`;
  }
}

export function sentence(item: ActivityItem, l: ActivityLookup): string {
  if (item.kind === 'deckCreated') {
    return `Created ${item.deckId ? l.deck(item.deckId) : 'a list'} in ${item.projectId ? l.project(item.projectId) : 'a project'}`;
  }
  const card = (item.cardId && l.card(item.cardId)) || 'A task';
  if (item.kind === 'entry') return `${card} wrote ${item.quote ?? ''}`.trimEnd();
  return (item.changes ?? []).map((c) => fragment(c, card, l)).join(' and ');
}

import type { AccountSettings, Card, Deck, HandCard, Priority, Resolvable, ResolvableContext } from '../../shared/types';
import { cardCode, slugOf, titleOf } from '../../shared/cards';
import { cardEffort, priorityLabel } from '../../shared/properties';
import { parseContent } from '../../shared/content';

export const deckPath = (d: Pick<Deck, 'seq' | 'title'>) => `/decks/${d.seq}-${slugOf(d.title) || 'deck'}`;
const cardPart = (c: Pick<Card, 'seq' | 'content'>) => `${cardCode(c.seq)}-${slugOf(titleOf(c.content)) || 'card'}`;
/** Card inside its deck when the deck is known, otherwise the standalone card URL. */
export const cardHref = (c: Pick<Card, 'seq' | 'content'>, deck?: Pick<Deck, 'seq' | 'title'> | null) =>
  deck ? `${deckPath(deck)}/card/${cardPart(c)}` : `/card/${cardPart(c)}`;

/** Carries the current `?search=` chips onto a link that stays inside the deck being viewed. */
export function keepSearch(href: string): string {
  const search = new URLSearchParams(location.search).get('search');
  if (!search || !href.startsWith('/decks/')) return href;
  const deckPart = (p: string) => p.split('/')[2]?.split(/[-?]/)[0];
  if (deckPart(location.pathname) !== deckPart(href)) return href;
  return `${href}${href.includes('?') ? '&' : '?'}search=${encodeURIComponent(search)}`;
}

/** Words in card text, Markdown stripped (the same count the server's parseContent gives). */
export const wordCount = (s: string) => parseContent(s).wordCount;

/** Open thread contexts per card. */
export function openByCard(resolvables: Iterable<Resolvable>): Map<string, Set<ResolvableContext>> {
  const open = new Map<string, Set<ResolvableContext>>();
  for (const r of resolvables) {
    if (r.isClosed) continue;
    let set = open.get(r.cardId);
    if (!set) open.set(r.cardId, (set = new Set()));
    set.add(r.context);
  }
  return open;
}

/** 1-based hand slot per card, ranked within each person's hand; a card in several hands shows its best slot. */
export function handSlots(handCards: Iterable<HandCard>): Map<string, number> {
  const byUser = new Map<string, HandCard[]>();
  for (const h of handCards) {
    const list = byUser.get(h.userId);
    if (list) list.push(h);
    else byUser.set(h.userId, [h]);
  }
  const out = new Map<string, number>();
  for (const list of byUser.values()) {
    list.sort((a, b) => a.sortIndex - b.sortIndex);
    list.forEach((h, i) => {
      const prev = out.get(h.cardId);
      if (prev === undefined || i + 1 < prev) out.set(h.cardId, i + 1);
    });
  }
  return out;
}

/** Cards in deck order: tasks by sort index, then docs in their own group (observed). */
export function deckGroups<C extends Pick<Card, 'isDoc' | 'sortIndex' | 'seq'>>(cards: C[]): { tasks: C[]; docs: C[] } {
  const sorted = [...cards].sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq);
  return { tasks: sorted.filter((c) => !c.isDoc), docs: sorted.filter((c) => c.isDoc) };
}

// ---- recent decks (per browser; storage may be unavailable) ----
const RECENT_KEY = 'jt:recentDecks';
const RECENT_MAX = 5;

export function readRecentDecks(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecentDeck(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecentDecks().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch { /* private mode or blocked storage: recents are a convenience */ }
}

/** Copies text; falls back to a hidden textarea where the async clipboard is unavailable (plain-HTTP LAN). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export const formatTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Shared copy for both delete-deck dialogs. The deck's cards become deleted, deckless cards (server decks/delete). */
export const deleteDeckNote = (n: number) =>
  n === 0 ? ''
    : n === 1 ? 'Its 1 task will be deleted. Its creator or an admin can restore it from the task link.'
    : `Its ${n} tasks will be deleted. Their creators or an admin can restore them from the task link.`;

// ---- properties ----

/** Today in the browser's timezone as YYYY-MM-DD (the server allows one day of slack). */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** "Nov 15" for a YYYY-MM-DD day; the year only when it isn't this year. */
export function formatDay(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Deck groups in list order: High, Medium, Low, then no priority. */
export const PRIORITY_GROUPS: (Priority | null)[] = ['a', 'b', 'c', null];

/** Task cards grouped by priority (empty groups left out), keeping deck order inside each group. */
export function priorityGroups<C extends Pick<Card, 'priority'>>(tasks: C[]): { priority: Priority | null; cards: C[] }[] {
  return PRIORITY_GROUPS
    .map((p) => ({ priority: p, cards: tasks.filter((c) => (c.priority ?? null) === p) }))
    .filter((g) => g.cards.length > 0);
}

export interface DeckStats {
  /** done/total per priority, task cards only. */
  byPriority: { priority: Priority | null; done: number; total: number }[];
  effortDone: number;
  effortTotal: number;
}

/**
 * Deck footer numbers over live task cards. Effort is every card's own effort or the fallback;
 * sub cards count on their own, so a hero adds only its own effort (no double counting).
 */
export function deckStats<C extends Pick<Card, 'priority' | 'effort' | 'isDoc'>>(
  cards: C[],
  isDone: (c: C) => boolean,
  settings: Pick<AccountSettings, 'fallbackEffort'>,
): DeckStats {
  const tasks = cards.filter((c) => !c.isDoc);
  let effortDone = 0;
  let effortTotal = 0;
  for (const c of tasks) {
    const e = cardEffort(c, settings);
    effortTotal += e;
    if (isDone(c)) effortDone += e;
  }
  return {
    byPriority: PRIORITY_GROUPS.map((p) => {
      const list = tasks.filter((c) => (c.priority ?? null) === p);
      return { priority: p, done: list.filter(isDone).length, total: list.length };
    }),
    effortDone,
    effortTotal,
  };
}

/** Label for a priority, or "No priority". */
export const priorityName = (p: Priority | null, settings: Pick<AccountSettings, 'priorityLabels'>) =>
  p ? priorityLabel(p, settings) : 'No priority';

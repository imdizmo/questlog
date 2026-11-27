/**
 * Home's "Recently worked on": the person's own tasks and pages, newest first. The server says which cards they
 * changed or commented on lately (GET /api/me/recent, server/home.ts); this turns those into rows from the store, so
 * a card since deleted or moved out of sight is simply left out. Pure, unit tested (tests/web-home-recent.test.ts).
 */
import type { Card, Deck, Project } from '../../shared/types';
import { titleOf } from '../../shared/cards';
import { cardHref } from './cards';
import { entryPath } from './wiki';
import { projectPrefix } from './taskId';
import { titleNow } from './translate';

export interface RecentRow { id: string; title: string; sub: string; href: string; done: boolean; doc: boolean; at: number }
export const RECENT_MAX = 8;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", then the day ("12 Nov"). */
export function agoText(at: number, now: number): string {
  const d = now - at;
  if (d < MIN) return 'just now';
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute');
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour');
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function recentRows(
  s: { cards: Map<string, Card>; decks: Map<string, Deck>; projects: Map<string, Project> },
  items: { cardId: string; at: number }[],
  max = RECENT_MAX,
): RecentRow[] {
  const out: RecentRow[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (out.length >= max) break;
    if (seen.has(it.cardId)) continue;
    seen.add(it.cardId);
    const c = s.cards.get(it.cardId);
    if (!c || c.visibility === 'deleted') continue;
    const deck = c.deckId ? s.decks.get(c.deckId) : undefined;
    const project = deck ? s.projects.get(deck.projectId) : undefined;
    const title = titleNow(c);
    if (c.isDoc) {
      out.push({ id: c.id, title, sub: project ? `Page · ${project.name}` : 'Page', href: project ? entryPath(project.seq, c) : cardHref(c, deck), done: false, doc: true, at: it.at });
    } else {
      const code = `${project ? projectPrefix(project.name) : 'T'}-${c.seq + 1}`;
      out.push({ id: c.id, title, sub: deck ? `${code} · ${deck.title}` : code, href: cardHref(c, deck), done: c.status === 'done', doc: false, at: it.at });
    }
  }
  return out;
}

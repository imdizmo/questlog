import type { Card, DerivedStatus, ResolvableContext } from './types';

/** The one label table for derived status: card badges and deck tile counts. */
export const STATUS_LABEL: Record<DerivedStatus, string> = {
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  started: 'Started',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  snoozing: 'Snoozing',
};

const ALPHABET = '0123456789acefghjkmnpqrstuvwxyz'; // 31 symbols, no b d i l o
/** Codes start at "110": seq 0 + 992 (= 1·31² + 1·31). Every seq gets a distinct code. */
const CODE_OFFSET = 992;

export function cardCode(seq: number): string {
  let n = Math.max(0, Math.floor(seq)) + CODE_OFFSET;
  let out = '';
  do {
    out = ALPHABET[n % 31] + out;
    n = Math.floor(n / 31);
  } while (n > 0);
  return out;
}

/** Inverse of cardCode; null for anything that isn't a card code. */
export function seqFromCode(code: string): number | null {
  if (!code) return null;
  let n = 0;
  for (const ch of code) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return null;
    n = n * 31 + d;
  }
  const seq = n - CODE_OFFSET;
  if (!Number.isSafeInteger(n) || seq < 0 || cardCode(seq) !== code) return null;
  return seq;
}

export function titleOf(content: string): string {
  const first = content.split('\n', 1)[0] ?? '';
  const t = first.replace(/^[#\s]+/, '').trim();
  return t === '' ? 'Untitled' : t;
}

export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type Open = Set<ResolvableContext>;

export function derivedStatus(
  card: Pick<Card, 'status' | 'assigneeId' | 'isDoc'> & { snoozedAt?: number | null },
  openContexts: Open,
): DerivedStatus | null {
  if (card.isDoc) return null;
  if (card.status === 'done') return 'done';
  if (openContexts.has('block')) return 'blocked';
  if (openContexts.has('review')) return 'review';
  if (card.status === 'started') return card.snoozedAt ? 'snoozing' : 'started';
  if (card.assigneeId) return 'assigned';
  return 'unassigned';
}

export interface AllowedActions {
  start: boolean;
  stop: boolean;
  block: boolean;
  review: boolean;
  done: boolean;
  reopen: boolean;
  archive: boolean;
  delete: boolean;
  restore: boolean;
  toggleDoc: boolean;
}

export function allowedActions(
  card: Pick<Card, 'status' | 'isDoc' | 'visibility'>,
  openContexts: Open,
  opts?: { isHero?: boolean },
): AllowedActions {
  const none: AllowedActions = {
    start: false, stop: false, block: false, review: false, done: false,
    reopen: false, archive: false, delete: false, restore: false, toggleDoc: false,
  };
  if (card.visibility === 'deleted') return { ...none, restore: true };
  const common = { archive: card.visibility === 'default', restore: card.visibility === 'archived', delete: true, toggleDoc: true };
  if (card.isDoc) return { ...none, ...common };
  const threadOpen = openContexts.has('block') || openContexts.has('review');
  const free = !threadOpen;
  const hero = opts?.isHero === true;
  return {
    ...none,
    ...common,
    start: free && card.status === 'not_started',
    stop: card.status === 'started',
    block: !hero && free && card.status !== 'done',
    review: !hero && free && card.status !== 'done',
    done: !hero && free && card.status !== 'done',
    reopen: card.status === 'done',
  };
}

export function deckCounts(
  cards: (Pick<Card, 'id' | 'status' | 'assigneeId' | 'isDoc' | 'visibility'> & { snoozedAt?: number | null })[],
  openByCard: Map<string, Open>,
): Record<DerivedStatus, number> {
  const out: Record<DerivedStatus, number> = {
    unassigned: 0, assigned: 0, started: 0, blocked: 0, review: 0, snoozing: 0, done: 0,
  };
  const empty: Open = new Set();
  for (const c of cards) {
    if (c.visibility !== 'default') continue;
    const s = derivedStatus(c, openByCard.get(c.id) ?? empty);
    if (s) out[s]++;
  }
  return out;
}

// The Ctrl/⌘+K palette's logic: an in-memory index of the store, ranked and grouped search, the "New …" row's options
// and its type guess, recents and the last created type per device. Pure over the store, so it is unit tested.
import type { Card, Deck, EntryType, Project } from '../../shared/types';
import { cardCode, seqFromCode, titleOf } from '../../shared/cards';
import { nameKey } from '../../shared/autolink';
import type { State } from './store';
import type { Route } from './router';
import { canEditContent } from './store';
import { cardHref, deckPath } from './cards';
import { campaignTypes, entryPath, projectIdOf, wikiPath } from './wiki';
import { projectPrefix } from './taskId';
import { ApiError, messageFor } from './api';
import { IS_MAC } from './linkIgnores';

export type HitKind = 'entry' | 'task' | 'lore' | 'list' | 'project';
export const GROUPS: readonly { kind: HitKind; label: string }[] = [
  { kind: 'entry', label: 'Wiki entries' },
  { kind: 'task', label: 'Tasks' },
  { kind: 'lore', label: 'Lore' },
  { kind: 'list', label: 'Lists' },
  { kind: 'project', label: 'Projects' },
];
/** Rows per group; the index is searched in full, only the best ones are kept. */
export const PER_GROUP = 8;
export const RECENT_SHOWN = 8;
const RECENT_KEPT = 20;

export type PaletteState = Pick<State, 'cards' | 'decks' | 'projects' | 'entryTypes'>;

/** One searchable thing. `fold` is the title in nameKey form; `alt` holds aliases (and an entry's key). */
interface Item { kind: HitKind; id: string; title: string; fold: string; alt: readonly string[]; seq?: number }
export interface Hit { kind: HitKind; id: string; title: string; score: number }
export interface HitGroup { kind: HitKind | 'recent'; label: string; hits: Hit[] }

const kindOf = (c: Card): HitKind => (c.isDoc ? (c.entryTypeId ? 'entry' : 'lore') : 'task');

// ---- The index: one Item per live card, cached per card object (the store replaces a card's object when it changes),
// so a change re-folds only that card; the array is rebuilt once per `cards` map. ----
const itemOfCard = new WeakMap<Card, Item>();
function cardItem(c: Card): Item {
  let it = itemOfCard.get(c);
  if (it) return it;
  const title = titleOf(c.content);
  const alt: string[] = [];
  for (const a of c.aliases ?? []) alt.push(nameKey(a));
  if (c.entryKey) alt.push(c.entryKey.replace(/_/g, ' '));
  it = { kind: kindOf(c), id: c.id, title, fold: nameKey(title), alt, seq: c.seq };
  itemOfCard.set(c, it);
  return it;
}
const cardIndex = new WeakMap<Map<string, Card>, { items: Item[]; bySeq: Map<number, Card> }>();
function cardsIndexed(cards: Map<string, Card>) {
  let idx = cardIndex.get(cards);
  if (idx) return idx;
  const items: Item[] = [];
  const bySeq = new Map<number, Card>();
  for (const c of cards.values()) {
    if (c.visibility === 'deleted') continue;
    items.push(cardItem(c));
    bySeq.set(c.seq, c);
  }
  idx = { items, bySeq };
  cardIndex.set(cards, idx);
  return idx;
}
const smallIndex = new WeakMap<object, Item[]>();
function decksIndexed(decks: Map<string, Deck>): Item[] {
  let items = smallIndex.get(decks);
  if (!items) smallIndex.set(decks, (items = [...decks.values()].map((d) => ({ kind: 'list' as const, id: d.id, title: d.title, fold: nameKey(d.title), alt: [] }))));
  return items;
}
function projectsIndexed(projects: Map<string, Project>): Item[] {
  let items = smallIndex.get(projects);
  if (!items) smallIndex.set(projects, (items = [...projects.values()].map((p) => ({ kind: 'project' as const, id: p.id, title: p.name, fold: nameKey(p.name), alt: [] }))));
  return items;
}

// ---- Ranking ----
const isWordCh = (ch: string) => /[\p{L}\p{M}\p{N}_]/u.test(ch);
/** 0 exact, 1 prefix, 2 at a word start, 3 inside a word, -1 no match. */
function tier(t: string, q: string): number {
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  let i = t.indexOf(q);
  if (i < 0) return -1;
  while (i >= 0) {
    if (!isWordCh(t[i - 1])) return 2;
    i = t.indexOf(q, i + 1);
  }
  return 3;
}
/** Best tier of the title and its alternatives; 4 when every word of the query is somewhere in the title. */
function scoreOf(it: Item, q: string, words: readonly string[]): number {
  let best = tier(it.fold, q);
  if (best === 0) return 0;
  for (const a of it.alt) {
    const t = tier(a, q);
    if (t >= 0 && (best < 0 || t + 0.5 < best)) best = t + 0.5; // an alias match ranks just after the same title match
  }
  if (best < 0 && words.length > 1 && words.every((w) => it.fold.includes(w))) best = 4;
  return best;
}

/** Splits a folded query into words. */
const wordsOf = (fold: string) => fold.split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean);

/** Better first: lower score, then more recently opened, then shorter title, then title. */
function better(a: Hit, b: Hit, recent: Map<string, number>): boolean {
  if (a.score !== b.score) return a.score < b.score;
  const ra = recent.get(a.id) ?? Infinity, rb = recent.get(b.id) ?? Infinity;
  if (ra !== rb) return ra < rb;
  if (a.title.length !== b.title.length) return a.title.length < b.title.length;
  return a.title.localeCompare(b.title) < 0;
}
/** Keeps the best PER_GROUP of a group in order, by insertion: no sort over thousands of matches. */
function keep(list: Hit[], h: Hit, recent: Map<string, number>) {
  if (list.length === PER_GROUP && !better(h, list[PER_GROUP - 1], recent)) return;
  let i = list.length;
  while (i > 0 && better(h, list[i - 1], recent)) i--;
  list.splice(i, 0, h);
  if (list.length > PER_GROUP) list.pop();
}

/** "LH-127" → the card with seq 126 if its project prefix is LH; "$1a3" / a bare code → that card. */
function cardByCode(q: string, s: PaletteState, bySeq: Map<number, Card>): Card | undefined {
  const m = /^([a-z]{1,3})-(\d{1,9})$/.exec(q);
  if (m) {
    const c = bySeq.get(Number(m[2]) - 1);
    const p = c?.deckId ? s.projects.get(s.decks.get(c.deckId)?.projectId ?? '') : undefined;
    return c && (p ? projectPrefix(p.name) : 'T').toLowerCase() === m[1] ? c : undefined;
  }
  return undefined;
}

/**
 * The query's results in the fixed group order (empty groups left out), each group its best PER_GROUP. One pass over
 * the index, folded strings compared with indexOf: a few ms for 10 000 cards.
 */
export function search(s: PaletteState, query: string, recentIds: readonly string[] = []): HitGroup[] {
  const q = nameKey(query);
  if (!q) return [];
  const words = wordsOf(q);
  const recent = new Map(recentIds.map((id, i) => [id, i]));
  const byKind = new Map<HitKind, Hit[]>(GROUPS.map((g) => [g.kind, []]));
  const { items, bySeq } = cardsIndexed(s.cards);
  // A task id ("LH-127") puts that task first.
  const exactId = cardByCode(q, s, bySeq)?.id;
  const scan = (list: readonly Item[]) => {
    for (const it of list) {
      const score = it.id === exactId ? -1 : scoreOf(it, q, words);
      if (score < 0 && it.id !== exactId) continue;
      keep(byKind.get(it.kind)!, { kind: it.kind, id: it.id, title: it.title, score }, recent);
    }
  };
  scan(items);
  scan(decksIndexed(s.decks));
  scan(projectsIndexed(s.projects));
  return GROUPS.map((g) => ({ kind: g.kind, label: g.label, hits: byKind.get(g.kind)! })).filter((g) => g.hits.length);
}

// ---- Where a hit goes, and what the row says under its title ----
export interface HitView { href: string; sub: string; icon: string | null }
export function hitView(s: PaletteState, h: Pick<Hit, 'kind' | 'id'>): HitView | null {
  if (h.kind === 'project') {
    const p = s.projects.get(h.id);
    return p ? { href: wikiPath(p.seq), sub: p.isArchived ? 'Project · archived' : 'Project', icon: null } : null;
  }
  if (h.kind === 'list') {
    const d = s.decks.get(h.id);
    if (!d) return null;
    return { href: deckPath(d), sub: s.projects.get(d.projectId)?.name ?? '', icon: null };
  }
  const c = s.cards.get(h.id);
  if (!c || c.visibility === 'deleted') return null;
  const deck = c.deckId ? s.decks.get(c.deckId) : undefined;
  const pid = projectIdOf(s.decks, c);
  const project = pid ? s.projects.get(pid) : undefined;
  const type = c.entryTypeId ? s.entryTypes.get(c.entryTypeId) : undefined;
  const sub = [type?.name, h.kind === 'task' ? deck?.title : null, project?.name, c.visibility === 'archived' ? 'archived' : null].filter(Boolean).join(' · ');
  const href = c.isDoc && project ? entryPath(project.seq, c) : cardHref(c, deck);
  return { href, sub, icon: type?.icon ?? null };
}

// ---- Recents (per device) ----
const RECENT_KEY = 'jt:paletteRecent';
export type RecentRef = { kind: 'card' | 'list' | 'project'; id: string };
export function readRecent(): RecentRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is RecentRef => !!x && typeof x.id === 'string' && (x.kind === 'card' || x.kind === 'list' || x.kind === 'project')).slice(0, RECENT_KEPT);
  } catch { return []; }
}
export function pushRecent(ref: RecentRef): void {
  try {
    const next = [ref, ...readRecent().filter((x) => !(x.kind === ref.kind && x.id === ref.id))].slice(0, RECENT_KEPT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage blocked: no recents */ }
}
/** What a page shows, as a recent: the card of a card or entry page, the list of a list page. */
export function recentOfRoute(s: PaletteState, r: Route): RecentRef | null {
  if (r.name === 'card' || r.name === 'deckCard') {
    const seq = seqFromCode(r.code);
    const c = seq === null ? undefined : cardsIndexed(s.cards).bySeq.get(seq);
    return c ? { kind: 'card', id: c.id } : null;
  }
  if (r.name === 'wikiEntry') {
    const p = [...s.projects.values()].find((x) => x.seq === r.projectSeq);
    if (!p) return null;
    const seg = r.entry;
    for (const c of s.cards.values()) {
      if (!c.isDoc || c.visibility === 'deleted' || projectIdOf(s.decks, c) !== p.id) continue;
      if (seg.startsWith('$') ? cardCode(c.seq) === seg.slice(1) : c.entryKey === seg) return { kind: 'card', id: c.id };
    }
    return null;
  }
  if (r.name === 'deck') {
    const d = [...s.decks.values()].find((x) => x.seq === r.deckSeq);
    return d ? { kind: 'list', id: d.id } : null;
  }
  return null;
}
/** The recents that still exist, as hits (most recent first). */
export function recentHits(s: PaletteState, refs: readonly RecentRef[]): Hit[] {
  const out: Hit[] = [];
  for (const r of refs) {
    if (out.length >= RECENT_SHOWN) break;
    if (r.kind === 'card') {
      const c = s.cards.get(r.id);
      if (c && c.visibility !== 'deleted') out.push({ kind: kindOf(c), id: c.id, title: titleOf(c.content), score: 0 });
    } else if (r.kind === 'list') {
      const d = s.decks.get(r.id);
      if (d) out.push({ kind: 'list', id: d.id, title: d.title, score: 0 });
    } else {
      const p = s.projects.get(r.id);
      if (p) out.push({ kind: 'project', id: p.id, title: p.name, score: 0 });
    }
  }
  return out;
}
export const refOfHit = (h: Pick<Hit, 'kind' | 'id'>): RecentRef =>
  ({ kind: h.kind === 'list' ? 'list' : h.kind === 'project' ? 'project' : 'card', id: h.id });

// ---- Context: the project and list a new thing goes to ----
export interface PaletteContext { project: Project | null; deck: Deck | null }
const WIKI_LAST_KEY = 'jt:wikiProject';
export function paletteContext(s: PaletteState & Pick<State, 'me' | 'accountRoles' | 'projectAccess'>, r: Route): PaletteContext {
  let deck: Deck | null = null;
  let project: Project | null = null;
  if (r.name === 'deck' || r.name === 'deckCard' || r.name === 'deckActivity') deck = [...s.decks.values()].find((d) => d.seq === r.deckSeq) ?? null;
  else if (r.name === 'card') {
    const seq = seqFromCode(r.code);
    const c = seq === null ? undefined : cardsIndexed(s.cards).bySeq.get(seq);
    deck = (c?.deckId && s.decks.get(c.deckId)) || null;
  } else if ('projectSeq' in r) project = [...s.projects.values()].find((p) => p.seq === r.projectSeq) ?? null;
  if (deck) project = s.projects.get(deck.projectId) ?? null;
  if (!project) {
    let last: string | null = null;
    try { last = localStorage.getItem(WIKI_LAST_KEY); } catch { /* none */ }
    const editable = [...s.projects.values()].filter((p) => canEditContent(s as State, p)).sort((a, b) => a.seq - b.seq);
    project = editable.find((p) => p.id === last) ?? editable[0] ?? null;
  }
  return { project, deck };
}

// ---- The "New …" row ----
export type CreateOption =
  | { kind: 'entry'; type: EntryType; project: Project }
  | { kind: 'page'; project: Project }
  | { kind: 'task'; deck: Deck; project: Project };
export const optionKey = (o: CreateOption) => (o.kind === 'entry' ? `entry:${o.type.id}` : o.kind);

/** The first list of a project that takes tasks. */
export function firstTaskList(decks: Map<string, Deck>, projectId: string): Deck | null {
  return [...decks.values()].filter((d) => d.projectId === projectId && d.deckType !== 'doc')
    .sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)[0] ?? null;
}

/** What the New row can make here, in Tab order: the project's entry types, a plain page, a task. None without rights. */
export function createOptions(s: PaletteState & Pick<State, 'me' | 'accountRoles' | 'projectAccess'>, ctx: PaletteContext): CreateOption[] {
  const project = ctx.project;
  if (!project || !canEditContent(s as State, project)) return [];
  const out: CreateOption[] = campaignTypes(s.entryTypes, project.id).map((type) => ({ kind: 'entry', type, project }));
  out.push({ kind: 'page', project });
  const deck = ctx.deck && ctx.deck.projectId === project.id && ctx.deck.deckType !== 'doc' ? ctx.deck : firstTaskList(s.decks, project.id);
  if (deck) out.push({ kind: 'task', deck, project });
  return out;
}

const LAST_TYPE_KEY = 'jt:paletteLastType';
export type LastType = { kind: 'entry'; id: string; key: string } | { kind: 'page' } | { kind: 'task' };
export function readLastType(): LastType | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_TYPE_KEY) ?? 'null');
    if (v && (v.kind === 'page' || v.kind === 'task')) return { kind: v.kind };
    if (v && v.kind === 'entry' && typeof v.id === 'string' && typeof v.key === 'string') return { kind: 'entry', id: v.id, key: v.key };
  } catch { /* none */ }
  return null;
}
export function writeLastType(o: CreateOption): void {
  const v: LastType = o.kind === 'entry' ? { kind: 'entry', id: o.type.id, key: o.type.key } : { kind: o.kind };
  try { localStorage.setItem(LAST_TYPE_KEY, JSON.stringify(v)); } catch { /* not remembered */ }
}

/** Small words that say nothing about a type: never a template-word match ("The Wanderer" is not in "The Ashen Keep"). */
const STOPWORDS = new Set(['the', 'and', 'new', 'old', 'for', 'of', 'a', 'an', 'in', 'on', 'at', 'to', 'with']);

/**
 * The option the New row starts on: an entry type whose name (as whole words) or a word of one of its templates' names
 * is in the query (a name beats a template word; the first type in order wins a tie); else the type created last on
 * this device (by id, or by key in another project); else a task in a list context, else the first type, else a page.
 */
export function guessOption(options: readonly CreateOption[], query: string, last: LastType | null, inList = false): number {
  if (!options.length) return -1;
  const words = wordsOf(nameKey(query));
  const padded = ` ${words.join(' ')} `;
  const set = new Set(words);
  let byTemplate = -1;
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o.kind !== 'entry') continue;
    const name = wordsOf(nameKey(o.type.name));
    if (name.length && padded.includes(` ${name.join(' ')} `)) return i;
    if (byTemplate < 0 && o.type.templates?.some((t) => wordsOf(nameKey(t.name)).some((w) => w.length >= 3 && !STOPWORDS.has(w) && set.has(w)))) byTemplate = i;
  }
  if (byTemplate >= 0) return byTemplate;
  if (last) {
    let i: number;
    if (last.kind === 'entry') {
      i = options.findIndex((o) => o.kind === 'entry' && o.type.id === last.id);
      // The same type in another project: by its key.
      if (i < 0) i = options.findIndex((o) => o.kind === 'entry' && o.type.key === last.key);
    } else i = options.findIndex((o) => o.kind === last.kind);
    if (i >= 0) return i;
  }
  if (inList) { const t = options.findIndex((o) => o.kind === 'task'); if (t >= 0) return t; }
  return 0;
}

/** "New Place called “Ashen Keep”", for the row and its accessible name. */
export function createLabel(o: CreateOption, query: string): string {
  const what = o.kind === 'entry' ? o.type.name : o.kind;
  return `New ${what} called “${query.trim()}”`;
}
export const createSub = (o: CreateOption) => (o.kind === 'task' ? `in ${o.deck.title} · ${o.project.name}` : `in ${o.project.name}`);

/** What a failed create says under the New row (the toast would sit behind the modal palette). */
export const createErrorText = (e: unknown): string =>
  e instanceof ApiError ? messageFor(e.code) : 'Something went wrong. Try again.';

/**
 * The highlighted row: the one chosen (by key) while it is still there, else the first result. Never the New row by
 * itself: when the chosen row vanishes or there are no results, it falls back to a result or to nothing.
 */
export function resolveActive(rowKeys: readonly string[], chosen: string | null, hitCount: number): string | null {
  if (chosen !== null && rowKeys.includes(chosen)) return chosen;
  return hitCount > 0 ? rowKeys[0] : null;
}

/** Ctrl+K, or ⌘K on macOS (where Ctrl+K stays the editors' delete-to-line-end); KeyK for non-Latin layouts. */
export function isPaletteKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac = IS_MAC): boolean {
  if (e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return false;
  const k = e.key.toLowerCase();
  return k === 'k' || (e.code === 'KeyK' && !/^[a-z]$/.test(k));
}

/** Opens the palette with a query from elsewhere (the sidebar's find box on Enter); the shell sets it while mounted. */
let opener: ((query: string) => void) | null = null;
export const setPaletteOpener = (fn: ((query: string) => void) | null): void => { opener = fn; };
export const openPalette = (query: string): void => opener?.(query);

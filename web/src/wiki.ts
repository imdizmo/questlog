// Wiki selectors: the page tree, what links here, open quests, and small display helpers. Pure functions over the store.
import type { Card, Deck, EntryLink, EntryType, FieldDef, LinkKind } from '../../shared/types';
import type { State } from './store';
import type { BalanceResult } from '../../shared/balance';
import { cardCode, seqFromCode, titleOf } from '../../shared/cards';
import { parseContent } from '../../shared/content';
import { cachedNameIndex, findMentions, nameSourceOf, type NameIndex } from '../../shared/autolink';
import type { GraphData, GraphEdgeIn } from '../../shared/graph';
import { fieldsOf, isTypeOrChild, runChecks, typeChain, WORKS_ON, type Check, type CheckProblem, type ChecksResult } from '../../shared/wiki';
import { readLangNow, titleNow } from './translate';
import { store } from './store';

export type WikiState = Pick<State, 'cards' | 'decks' | 'entryTypes' | 'linkKinds' | 'entryLinks'>;
export interface WikiNode { id: string; card: Card; children: WikiNode[] }
/** `kindId` is set on link groups (reverse labels need not be unique). */
export interface BacklinkGroup { group: string; kindId?: string; items: { cardId: string; props?: Record<string, unknown> }[] }

const live = (c: Card | undefined): c is Card => !!c && c.visibility !== 'deleted';
const byTitle = (a: Card, b: Card) => titleOf(a.content).localeCompare(titleOf(b.content)) || a.seq - b.seq;

/** The project a card belongs to, through its deck; null for a deckless card. */
export const projectIdOf = (decks: Map<string, Pick<Deck, 'projectId'>>, card: Pick<Card, 'deckId'>): string | null =>
  (card.deckId && decks.get(card.deckId)?.projectId) || null;

/** Live (not deleted) Lore of a project, typed or not. */
export function campaignLore(cards: Iterable<Card>, projectId: string, decks: Map<string, Pick<Deck, 'projectId'>>): Card[] {
  const out: Card[] = [];
  for (const c of cards) if (c.isDoc && live(c) && projectIdOf(decks, c) === projectId) out.push(c);
  return out;
}

/** Typed and untyped Lore of the project, nested by wikiParentId and sorted by title. A missing parent makes a root. */
export function wikiTree(cards: Map<string, Card> | Iterable<Card>, projectId: string, decks: Map<string, Pick<Deck, 'projectId'>>): WikiNode[] {
  const list = campaignLore(cards instanceof Map ? cards.values() : cards, projectId, decks).sort(byTitle);
  const ids = new Set(list.map((c) => c.id));
  const kids = new Map<string, Card[]>();
  const roots: Card[] = [];
  for (const c of list) {
    const p = c.wikiParentId && c.wikiParentId !== c.id && ids.has(c.wikiParentId) ? c.wikiParentId : null;
    if (!p) { roots.push(c); continue; }
    const l = kids.get(p);
    if (l) l.push(c); else kids.set(p, [c]);
  }
  const seen = new Set<string>();
  const build = (c: Card): WikiNode => {
    seen.add(c.id);
    return { id: c.id, card: c, children: (kids.get(c.id) ?? []).filter((k) => !seen.has(k.id)).map(build) };
  };
  const tree = roots.map(build);
  // A parent loop leaves its members unreached: show them at the top rather than lose them.
  const stray = list.filter((c) => !seen.has(c.id));
  for (const c of stray) if (!seen.has(c.id)) tree.push(build(c));
  return stray.length ? tree.sort((a, b) => byTitle(a.card, b.card)) : tree;
}

// ---- Indexes, built once per `cards` map (the store replaces the map on every card change). ----

/** $code → ids of live cards whose text mentions it. */
const mentionCache = new WeakMap<Map<string, Card>, Map<string, string[]>>();
export function mentionIndex(cards: Map<string, Card>): Map<string, string[]> {
  let idx = mentionCache.get(cards);
  if (idx) return idx;
  idx = new Map();
  for (const c of cards.values()) {
    if (!live(c)) continue;
    for (const code of parseContent(c.content).cardCodes) {
      const l = idx.get(code);
      if (l) l.push(c.id); else idx.set(code, [c.id]);
    }
  }
  mentionCache.set(cards, idx);
  return idx;
}

interface RefHit { cardId: string; group: string; typeName: string; at: number }
/** "projectId\0key" → entry/entries field values of live typed entries that point at that key. */
const refCache = new WeakMap<Map<string, Card>, { types: Map<string, EntryType>; decks: Map<string, Pick<Deck, 'projectId'>>; idx: Map<string, RefHit[]> }>();
function refIndex(s: WikiState): Map<string, RefHit[]> {
  const hit = refCache.get(s.cards);
  if (hit && hit.types === s.entryTypes && hit.decks === s.decks) return hit.idx;
  const idx = new Map<string, RefHit[]>();
  const defsByType = new Map<string, FieldDef[]>();
  for (const c of s.cards.values()) {
    if (!c.isDoc || !live(c) || !c.entryTypeId) continue;
    const type = s.entryTypes.get(c.entryTypeId);
    const projectId = projectIdOf(s.decks, c);
    if (!type || !projectId) continue;
    let defs = defsByType.get(type.id);
    if (!defs) { defs = fieldsOf(s.entryTypes, type.id).filter((f) => !f.hidden && (f.kind === 'entry' || f.kind === 'entries')); defsByType.set(type.id, defs); }
    defs.forEach((f, at) => {
      const v = c.fields?.[f.key];
      const keys = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
      for (const k of keys) {
        const key = `${projectId}\0${k}`;
        const row = { cardId: c.id, group: `${type.name}: ${f.label}`, typeName: type.name, at };
        const l = idx.get(key);
        if (l) l.push(row); else idx.set(key, [row]);
      }
    });
  }
  refCache.set(s.cards, { types: s.entryTypes, decks: s.decks, idx });
  return idx;
}

/** The link kind a link of this project uses. */
const kindOf = (kinds: Map<string, LinkKind>, projectId: string, key: string): LinkKind | undefined =>
  [...kinds.values()].find((k) => k.projectId === projectId && k.key === key);

/**
 * What links to an entry, in groups: each link kind's reverse label (links to it), then "<Type>: <field>" for entry
 * field references to its key, then "Mentions" ($code in other Lore text), then "Mentioned in" (its names or aliases
 * recognised in other texts of the project, Lore or tasks, minus those already under Mentions). Deleted sources are left out.
 */
export function backlinks(s: WikiState, cardId: string): BacklinkGroup[] {
  const card = s.cards.get(cardId);
  if (!live(card)) return [];
  const projectId = projectIdOf(s.decks, card);
  const out: BacklinkGroup[] = [];

  const linkGroups = new Map<string, { kind: LinkKind; items: { cardId: string; props: Record<string, unknown>; sortIndex: number }[] }>();
  for (const l of s.entryLinks.values()) {
    if (l.toCardId !== cardId || l.kindKey === WORKS_ON || !live(s.cards.get(l.fromCardId))) continue;
    const kind = kindOf(s.linkKinds, l.projectId, l.kindKey);
    if (!kind) continue;
    let g = linkGroups.get(kind.id);
    if (!g) linkGroups.set(kind.id, (g = { kind, items: [] }));
    g.items.push({ cardId: l.fromCardId, props: l.props, sortIndex: l.sortIndex });
  }
  for (const g of [...linkGroups.values()].sort((a, b) => a.kind.reverseLabel.localeCompare(b.kind.reverseLabel))) {
    out.push({ group: g.kind.reverseLabel, kindId: g.kind.id, items: g.items.sort((a, b) => a.sortIndex - b.sortIndex).map(({ cardId: id, props }) => ({ cardId: id, props })) });
  }

  if (projectId && card.entryKey) {
    const hits = (refIndex(s).get(`${projectId}\0${card.entryKey}`) ?? []).filter((h) => h.cardId !== cardId);
    const groups = new Map<string, { typeName: string; at: number; ids: string[] }>();
    for (const h of hits) {
      const g = groups.get(h.group);
      if (g) g.ids.push(h.cardId); else groups.set(h.group, { typeName: h.typeName, at: h.at, ids: [h.cardId] });
    }
    for (const [group, g] of [...groups].sort(([, a], [, b]) => a.typeName.localeCompare(b.typeName) || a.at - b.at)) {
      out.push({ group, items: g.ids.map((id) => ({ cardId: id })) });
    }
  }

  // Only Lore of the same project: a mention from elsewhere can't be opened in this wiki.
  const mentions = (mentionIndex(s.cards).get(cardCode(card.seq)) ?? [])
    .map((id) => s.cards.get(id)!)
    .filter((c) => c.isDoc && c.id !== cardId && projectId !== null && projectIdOf(s.decks, c) === projectId)
    .sort(byTitle);
  if (mentions.length) out.push({ group: 'Mentions', items: mentions.map((c) => ({ cardId: c.id })) });

  // Texts of the project that name the entry (or an alias) without a $code: Lore and tasks, each card's ignores kept.
  if (projectId) {
    const index = campaignNameIndex(s, projectId);
    if (index.size) {
      const coded = new Set(mentions.map((c) => c.id));
      const named: Card[] = [];
      for (const c of s.cards.values()) {
        if (c.id === cardId || coded.has(c.id) || !live(c) || projectIdOf(s.decks, c) !== projectId) continue;
        if (namedIn(c, index).has(cardId)) named.push(c);
      }
      if (named.length) out.push({ group: 'Mentioned in', items: named.sort(byTitle).map((c) => ({ cardId: c.id })) });
    }
  }
  return out;
}

// ---- Names as links (shared/autolink): recognised at display time, never written into the text. ----

type NameState = Pick<State, 'cards' | 'decks'>;
const nameIndexCache = new WeakMap<Map<string, Card>, Map<string, { decks: NameState['decks']; index: NameIndex }>>();
/**
 * The names and aliases of a project's live Lore as one index. cachedNameIndex rebuilds the automaton only when a name
 * or alias changes; this memo also skips the signature while `cards` and `decks` stay the same maps.
 */
export function campaignNameIndex(s: NameState, projectId: string): NameIndex {
  let byProject = nameIndexCache.get(s.cards);
  if (!byProject) nameIndexCache.set(s.cards, (byProject = new Map()));
  const hit = byProject.get(projectId);
  if (hit && hit.decks === s.decks) return hit.index;
  const index = cachedNameIndex(campaignLore(s.cards.values(), projectId, s.decks).map(nameSourceOf));
  byProject.set(projectId, { decks: s.decks, index });
  return index;
}

const namedCache = new WeakMap<Card, { index: NameIndex; ids: ReadonlySet<string> }>();
/**
 * The entries a card's text links by name, below its title line (its own names and its "Not a link here" names left
 * out). Cached per card
 * object and index: a change rescans only the card that changed, a new name or alias every card once.
 */
export function namedIn(card: Card, index: NameIndex): ReadonlySet<string> {
  const hit = namedCache.get(card);
  if (hit && hit.index === index) return hit.ids;
  // The title line is the card's own name, shown unlinked everywhere: it never counts as a mention.
  const nl = card.content.indexOf('\n');
  const body = nl < 0 ? '' : card.content.slice(nl + 1);
  const ids = new Set(findMentions(body, index, { ignores: card.linkIgnores ?? [], selfId: card.id }).map((m) => m.cardId));
  namedCache.set(card, { index, ids });
  return ids;
}

/** How a text of a project links names: the index, the text's own card (never linked to itself) and its ignores. */
export interface NameLinks {
  index: NameIndex;
  selfId: string | null;
  ignores: readonly string[];
  /** The wiki page of an entry. */
  href(cardId: string): string | null;
  title(cardId: string): string | null;
}

/** NameLinks for a text of `projectId` (the text of `card` when given); null outside a project or without names. */
export function nameLinks(s: Pick<State, 'cards' | 'decks' | 'projects'>, projectId: string | null, card?: Pick<Card, 'id' | 'linkIgnores'> | null): NameLinks | null {
  const project = projectId ? s.projects.get(projectId) : undefined;
  if (!project) return null;
  const index = campaignNameIndex(s, project.id);
  if (index.size === 0) return null;
  return {
    index,
    selfId: card?.id ?? null,
    ignores: card?.linkIgnores ?? [],
    href: (id) => { const c = s.cards.get(id); return c ? entryPath(project.seq, c) : null; },
    title: (id) => { const c = s.cards.get(id); return c ? titleNow(c) : null; },
  };
}

// ---- The graph: a campaign's entries and every relation between them (shared/graph lays it out). ----

export type GraphState = Pick<State, 'cards' | 'decks' | 'entryTypes' | 'linkKinds' | 'entryLinks' | 'visionBoards'>;
interface GraphMemo { decks: unknown; entryTypes: unknown; linkKinds: unknown; entryLinks: unknown; visionBoards: unknown; tr: unknown; lang: string; data: GraphData }
const graphCache = new WeakMap<Map<string, Card>, Map<string, GraphMemo>>();

/**
 * A campaign's Lore (typed entries and pages, minus pages that only host a board) as graph nodes, and as edges: typed
 * links (kind key + label, works_on left out: it points at tasks), entry field references, `$code` mentions and
 * recognised names. Built once per change of the store maps it reads; names come from the per-card `namedIn` cache, so
 * an edit rescans only the card that changed.
 */
export function campaignGraphData(s: GraphState, projectId: string): GraphData {
  let byProject = graphCache.get(s.cards);
  if (!byProject) graphCache.set(s.cards, (byProject = new Map()));
  const hit = byProject.get(projectId);
  // Node labels are the reader's titles: new translations or another reading language rebuild it too.
  const tr = store.get().translations, lang = readLangNow();
  if (hit && hit.decks === s.decks && hit.entryTypes === s.entryTypes && hit.linkKinds === s.linkKinds && hit.entryLinks === s.entryLinks && hit.visionBoards === s.visionBoards
    && hit.tr === tr && hit.lang === lang) return hit.data;

  const hosts = new Set<string>();
  for (const b of s.visionBoards.values()) hosts.add(b.cardId);
  const lore = campaignLore(s.cards.values(), projectId, s.decks).filter((c) => !!c.entryTypeId || !hosts.has(c.id));
  const ids = new Set(lore.map((c) => c.id));
  const byKey = new Map<string, string>();
  for (const c of lore) if (c.entryKey) byKey.set(c.entryKey, c.id);
  const nodes = lore.map((c) => ({ id: c.id, label: titleNow(c) || 'Untitled', typeId: c.entryTypeId ?? null }));
  const edges: GraphEdgeIn[] = [];

  const kinds = new Map<string, LinkKind>();
  for (const k of s.linkKinds.values()) if (k.projectId === projectId) kinds.set(k.key, k);
  for (const l of s.entryLinks.values()) {
    if (l.projectId !== projectId || l.kindKey === WORKS_ON || !ids.has(l.fromCardId) || !ids.has(l.toCardId)) continue;
    edges.push({ from: l.fromCardId, to: l.toCardId, kind: 'link', key: l.kindKey, label: kinds.get(l.kindKey)?.label ?? l.kindKey });
  }
  const prefix = `${projectId}\0`;
  for (const [k, hits] of refIndex(s)) {
    if (!k.startsWith(prefix)) continue;
    const to = byKey.get(k.slice(prefix.length));
    if (!to) continue;
    for (const h of hits) if (ids.has(h.cardId)) edges.push({ from: h.cardId, to, kind: 'field', key: h.group, label: h.group });
  }
  const coded = mentionIndex(s.cards);
  for (const c of lore) {
    for (const from of coded.get(cardCode(c.seq)) ?? []) if (ids.has(from)) edges.push({ from, to: c.id, kind: 'mention', label: 'mentions' });
  }
  const index = campaignNameIndex(s, projectId);
  if (index.size) for (const c of lore) for (const to of namedIn(c, index)) if (ids.has(to)) edges.push({ from: c.id, to, kind: 'mention', label: 'mentions' });

  const data = { nodes, edges };
  byProject.set(projectId, { decks: s.decks, entryTypes: s.entryTypes, linkKinds: s.linkKinds, entryLinks: s.entryLinks, visionBoards: s.visionBoards, tr, lang, data });
  return data;
}

/** Quests of the entry's project that work on it (works_on links) or mention its $code, not done and not deleted, oldest first. */
export function openQuests(s: WikiState, cardId: string): Card[] {
  const card = s.cards.get(cardId);
  if (!card) return [];
  const projectId = projectIdOf(s.decks, card);
  const ids = new Set(mentionIndex(s.cards).get(cardCode(card.seq)) ?? []);
  for (const l of s.entryLinks.values()) if (l.kindKey === WORKS_ON && l.toCardId === cardId) ids.add(l.fromCardId);
  const out: Card[] = [];
  for (const id of ids) {
    const c = s.cards.get(id);
    if (live(c) && !c.isDoc && c.status !== 'done' && c.id !== cardId && projectId !== null && projectIdOf(s.decks, c) === projectId) out.push(c);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The live Lore entry of a project with this key. */
export function entryByKey(s: Pick<State, 'cards' | 'decks'>, projectId: string, key: string): Card | undefined {
  for (const c of s.cards.values()) {
    if (c.entryKey === key && c.isDoc && live(c) && projectIdOf(s.decks, c) === projectId) return c;
  }
  return undefined;
}

/** Links that say "this belongs under that", strongest first. */
const UNDER = ['located_in', 'found_in', 'member_of'];
/**
 * The page tree by connections: an entry sits under the page it is filed under, else under the place it is inside or
 * found in, else under its faction; a storyboard frame sits under its storyline. Everything else is a root, by title.
 * A loop of connections (A inside B inside A) is shown flat instead of dropped.
 */
export function connectionTree(s: WikiState, projectId: string, keep: (c: Card) => boolean = () => true): WikiNode[] {
  const list = campaignLore(s.cards.values(), projectId, s.decks).filter(keep).sort(byTitle);
  const ids = new Set(list.map((c) => c.id));
  const parent = new Map<string, string>();
  for (const c of list) if (c.wikiParentId && c.wikiParentId !== c.id && ids.has(c.wikiParentId)) parent.set(c.id, c.wikiParentId);
  const links = [...s.entryLinks.values()].filter((l) => l.fromCardId !== l.toCardId && ids.has(l.fromCardId) && ids.has(l.toCardId)).sort((a, b) => a.sortIndex - b.sortIndex);
  for (const kind of UNDER) for (const l of links) if (l.kindKey === kind && !parent.has(l.fromCardId)) parent.set(l.fromCardId, l.toCardId);
  for (const l of links) if (l.kindKey === 'frames' && !parent.has(l.toCardId)) parent.set(l.toCardId, l.fromCardId);
  const kids = new Map<string, Card[]>();
  for (const c of list) { const p = parent.get(c.id); if (p) kids.set(p, [...(kids.get(p) ?? []), c]); }
  const seen = new Set<string>();
  const build = (c: Card): WikiNode => { seen.add(c.id); return { id: c.id, card: c, children: (kids.get(c.id) ?? []).filter((k) => !seen.has(k.id)).map(build) }; };
  const roots = list.filter((c) => !parent.has(c.id)).map(build);
  return [...roots, ...list.filter((c) => !seen.has(c.id)).map(build)];
}

/** Values other entries already have for a field, for offering them again (an era, a climate…). */
export function usedValues(lore: Card[], key: string): string[] {
  const out = new Set<string>();
  for (const c of lore) { const v = c.fields?.[key]; if (typeof v === 'string' && v) out.add(v); }
  return [...out].sort();
}

// ---- URLs: /wiki/<project seq>/<entry key>, or /wiki/<seq>/$<code> for Lore that has no key yet. ----

export const wikiPath = (projectSeq: number) => `/wiki/${projectSeq}`;
export const kindPath = (projectSeq: number, typeKey: string) => `/wiki/${projectSeq}/kind/${typeKey}`;
export const newEntryPath = (projectSeq: number, typeKey: string, from = '') => `/wiki/${projectSeq}/new/${typeKey}${from}`;
export const wikiViewPath = (projectSeq: number, view: 'places' | 'timeline' | 'graph' | 'links') => `/wiki/${projectSeq}/view/${view}`;
/** The Wiki's Types page, with a type open when its key is given. */
export const typesPath = (projectSeq: number, typeKey?: string) => (typeKey ? `/wiki/${projectSeq}/types/${typeKey}` : `/wiki/${projectSeq}/view/types`);
/** The first line of an entry's text under its title, headings skipped; '' when nothing is written yet. */
export const entryExcerpt = (c: Pick<Card, 'content'>): string =>
  (c.content.split('\n').slice(1).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '').replace(/[*_`>]/g, '').slice(0, 160);
export const typeTablePath = (projectSeq: number, typeKey: string) => `/wiki/${projectSeq}/type/${typeKey}`;
export const entryPath = (projectSeq: number, c: Pick<Card, 'entryKey' | 'seq'>) =>
  `/wiki/${projectSeq}/${c.entryKey ?? `$${cardCode(c.seq)}`}`;

/** The entry a URL segment names: a key, or `$code`. */
export function entryBySegment(s: Pick<State, 'cards' | 'decks'>, projectId: string, segment: string): Card | undefined {
  if (!segment.startsWith('$')) return entryByKey(s, projectId, segment);
  const seq = seqFromCode(segment.slice(1));
  if (seq === null) return undefined;
  for (const c of s.cards.values()) {
    if (c.seq === seq) return c.isDoc && live(c) && projectIdOf(s.decks, c) === projectId ? c : undefined;
  }
  return undefined;
}

/** The $code of an in-app card link as MarkdownView renders it (`/card/<code>-slug`); null for any other href. */
export function cardCodeOfHref(href: string): string | null {
  const m = /^\/card\/([0-9a-z]+?)(?:-|$)/.exec(href);
  return m && seqFromCode(m[1]) !== null ? m[1] : null;
}

/** Entries per type (each counted for its type and every ancestor) and untyped Lore ("pages"), in one pass. */
export function typeCounts(lore: Card[], types: Map<string, EntryType>): { byType: Map<string, number>; pages: number } {
  const byType = new Map<string, number>();
  const chains = new Map<string, string[]>();
  let pages = 0;
  for (const c of lore) {
    if (!c.entryTypeId) { pages++; continue; }
    let ids = chains.get(c.entryTypeId);
    if (!ids) chains.set(c.entryTypeId, (ids = typeChain(types, c.entryTypeId).map((t) => t.id)));
    for (const id of ids) byType.set(id, (byType.get(id) ?? 0) + 1);
  }
  return { byType, pages };
}

// ---- Display helpers ----

const HEX = /^#[0-9a-fA-F]{6}$/;
/** A type colour fit for a style attribute: only #rrggbb, anything else is no colour. */
export const safeColor = (c: string | null | undefined): string | null => (typeof c === 'string' && HEX.test(c) ? c : null);

/** Lowest lightness a type's own colour is drawn with, so a dark colour still shows on the dark tiles. */
export const MIN_LIGHTNESS = 0.5;

/** `#rrggbb` lightened (in HSL) to at least MIN_LIGHTNESS; hue and saturation kept. */
export function visibleColor(hex: string): string {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(...v), min = Math.min(...v);
  const l = (max + min) / 2;
  if (l >= MIN_LIGHTNESS) return hex;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const [r, g, b] = v;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const c = (1 - Math.abs(2 * MIN_LIGHTNESS - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = MIN_LIGHTNESS - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r1, g1, b1].map((u) => Math.round((u + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Types of a project in their order. */
export const campaignTypes = (types: Map<string, EntryType>, projectId: string): EntryType[] =>
  [...types.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));

/** The fields an infobox shows: visible ones not switched off for the infobox. */
export const infoboxFields = (types: Map<string, EntryType>, typeId: string): FieldDef[] =>
  fieldsOf(types, typeId).filter((f) => !f.hidden && f.inInfobox !== false);

/** Link kinds of a project whose source side admits an entry of this type (untyped: kinds open to any source). */
export function kindsFrom(s: Pick<State, 'linkKinds' | 'entryTypes'>, projectId: string, typeId: string | null): LinkKind[] {
  return [...s.linkKinds.values()]
    .filter((k) => k.projectId === projectId && (typeId ? isTypeOrChild(s.entryTypes, typeId, k.fromTypes) : k.fromTypes.length === 0))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Entries that fit a type list ([] = any; untyped Lore only fits any). */
export const entriesOfTypes = (types: Map<string, EntryType>, list: Card[], allowed: string[]): Card[] =>
  list.filter((c) => (c.entryTypeId ? isTypeOrChild(types, c.entryTypeId, allowed) : allowed.length === 0));

/** Case-insensitive match on title or key. */
export function searchEntries(list: Card[], query: string): Card[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => titleOf(c.content).toLowerCase().includes(q) || titleNow(c).toLowerCase().includes(q) || (c.entryKey ?? '').includes(q));
}

const withUnit = (n: number | string, unit?: string) => (!unit ? `${n}` : unit === '%' ? `${n}%` : `${n} ${unit}`);

/** A table, rule or scenario in a few words ("3 × 2 table", "rule: 2 roles, 3 parts"), for lists and the infobox. */
export function balanceSummary(kind: 'table' | 'rule' | 'scenario', v: unknown): string {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const n = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  const count = (x: unknown, one: string) => `${n(x)} ${one}${n(x) === 1 ? '' : 's'}`;
  if (kind === 'table') {
    const keys = Array.isArray(o.keys) ? o.keys as { values?: unknown }[] : [];
    return `${keys.map((k) => n(k?.values)).join(' × ') || '0'} table`;
  }
  if (kind === 'rule') return `rule: ${count(o.roles, 'role')}, ${count(o.parts, 'part')}`;
  return `scenario: ${count(o.roles, 'role')}, ${count(o.clocks, 'clock')}, ${count(o.measures, 'measure')}`;
}

/** One value as text; entry keys become titles through `titleOfKey` when given. */
export function formatValue(def: FieldDef, v: unknown, titleOfKey?: (key: string) => string | null): string {
  if (v === undefined || v === null || v === '') return '';
  const ref = (k: unknown) => (typeof k === 'string' ? titleOfKey?.(k) ?? k : String(k));
  switch (def.kind) {
    case 'boolean': return v === true ? 'yes' : v === false ? 'no' : String(v);
    case 'number': case 'integer': return typeof v === 'number' ? withUnit(v, def.unit) : String(v);
    case 'range': {
      const r = v as { min?: unknown; max?: unknown };
      return typeof r === 'object' && r ? withUnit(`${r.min}–${r.max}`, def.unit) : String(v);
    }
    case 'entry': return ref(v);
    case 'entries': case 'multienum': return Array.isArray(v) ? v.map(def.kind === 'entries' ? ref : String).join(', ') : String(v);
    case 'image': return 'image';
    case 'table': case 'rule': case 'scenario': return balanceSummary(def.kind, v);
    default: return typeof v === 'string' ? v : JSON.stringify(v);
  }
}

/** works_on links by quest, built once per entryLinks collection (it is replaced on every link change). */
const worksOnIndex = new WeakMap<Map<string, EntryLink>, Map<string, EntryLink[]>>();
const NONE: EntryLink[] = [];
/** A quest's works_on links, by sortIndex. A quest view asks on every card change: this is a lookup, not a scan. */
export function worksOnOf(links: Map<string, EntryLink>, questId: string): EntryLink[] {
  let idx = worksOnIndex.get(links);
  if (!idx) {
    idx = new Map();
    for (const l of links.values()) {
      if (l.kindKey !== WORKS_ON) continue;
      const list = idx.get(l.fromCardId);
      if (list) list.push(l); else idx.set(l.fromCardId, [l]);
    }
    for (const list of idx.values()) list.sort((a, b) => a.sortIndex - b.sortIndex);
    worksOnIndex.set(links, idx);
  }
  return idx.get(questId) ?? NONE;
}

/**
 * What a link form sends: the set values of the kind's visible properties. A hidden (retired) property has no input,
 * so its stored value can't be shown or cleared; wiki/updateLink keeps it as stored.
 */
export function visibleProps(defs: FieldDef[], props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = props[d.key];
    if (!d.hidden && v !== null && v !== undefined && v !== '') out[d.key] = v;
  }
  return out;
}

/** Link properties in their defined order: "15%, 1–2". Values without a definition are left out. */
export const formatProps = (defs: FieldDef[], props: Record<string, unknown> | undefined, titleOfKey?: (key: string) => string | null): string =>
  defs.filter((d) => !d.hidden).map((d) => formatValue(d, props?.[d.key], titleOfKey)).filter(Boolean).join(', ');

// ---- Type tables ----

export type FilterOp = 'eq' | 'contains' | 'min' | 'max' | 'has' | 'missing';
export interface FieldFilter { key: string; op: FilterOp; value?: unknown }
export interface RowSort { key: string; dir: 'asc' | 'desc' }
/** Columns that are not fields of the entry: its title, its key and the name of its type. */
export const PSEUDO_KEYS: readonly string[] = ['title', 'key', 'type'];
/** More filters than this in a link are ignored. */
export const MAX_FILTERS = 20;

const collator = new Intl.Collator();

/** A row's value for a column key (title, key, type, or a field); undefined when it has none. Own properties only: a key from a link may be `constructor`. */
function cellValue(c: Card, key: string, types: Map<string, EntryType>, title: string): unknown {
  if (key === 'title') return title;
  if (key === 'key') return c.entryKey ?? undefined;
  if (key === 'type') return c.entryTypeId ? types.get(c.entryTypeId)?.name : undefined;
  return c.fields && Object.hasOwn(c.fields, key) ? c.fields[key] : undefined;
}
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rangeEnd = (v: unknown, end: 'min' | 'max'): number | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? asNum((v as Record<string, unknown>)[end]) : null;

function matches(c: Card, f: FieldFilter, types: Map<string, EntryType>, title: string): boolean {
  // The type column filters by type key, so a renamed type keeps its links; every other key compares the shown value.
  const v = f.key === 'type' ? (c.entryTypeId ? types.get(c.entryTypeId)?.key : undefined) : cellValue(c, f.key, types, title);
  switch (f.op) {
    case 'has': return !isEmpty(v);
    case 'missing': return isEmpty(v);
    case 'eq': {
      // A range equals a number it contains.
      const lo = rangeEnd(v, 'min'), hi = rangeEnd(v, 'max'), n = typeof f.value === 'string' && f.value.trim() !== '' ? asNum(Number(f.value)) : asNum(f.value); // links carry text
      if (lo !== null && hi !== null) return n !== null && lo <= n && n <= hi;
      return Array.isArray(v) ? v.some((x) => String(x) === String(f.value)) : !isEmpty(v) && String(v) === String(f.value);
    }
    case 'contains': {
      const hay = Array.isArray(v) ? v.join(' ') : typeof v === 'string' || typeof v === 'number' ? String(v) : '';
      return hay.toLowerCase().includes(String(f.value ?? '').toLowerCase());
    }
    case 'min': case 'max': {
      const limit = asNum(f.value);
      if (limit === null) return true; // no usable limit: the filter does nothing
      const n = typeof v === 'number' ? asNum(v) : rangeEnd(v, f.op);
      return n !== null && (f.op === 'min' ? n >= limit : n <= limit);
    }
  }
}

/** Sort key: numbers (a range by its min) numerically, everything else as text; null = no value, which sorts last. */
function sortValue(v: unknown): number | string | null {
  if (isEmpty(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return rangeEnd(v, 'min');
  return String(v);
}

/** Numbers before text (so mixed columns still sort transitively), then each by its own order. */
function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return collator.compare(a, b);
}

/** The live Lore of the project whose type is `typeId` or a child of it (unfiltered, unsorted). */
function entriesOfType(s: Pick<State, 'cards' | 'decks' | 'entryTypes'>, projectId: string, typeId: string): Card[] {
  const key = s.entryTypes.get(typeId)?.key;
  if (!key) return [];
  const fits = new Map<string, boolean>();
  const inType = (id: string) => {
    let ok = fits.get(id);
    if (ok === undefined) fits.set(id, (ok = isTypeOrChild(s.entryTypes, id, [key])));
    return ok;
  };
  const rows: Card[] = [];
  for (const c of s.cards.values()) {
    if (c.isDoc && live(c) && c.entryTypeId && projectIdOf(s.decks, c) === projectId && inType(c.entryTypeId)) rows.push(c);
  }
  return rows;
}

function filterAndSort(rows: Card[], types: Map<string, EntryType>, filters: FieldFilter[], sort: RowSort | null): Card[] {
  // Decorate once: each row's title is parsed one time, not on every comparison.
  const dec: { c: Card; title: string; v: number | string | null }[] = [];
  for (const c of rows) {
    const title = titleOf(c.content);
    if (filters.every((f) => matches(c, f, types, title))) dec.push({ c, title, v: sort ? sortValue(cellValue(c, sort.key, types, title)) : null });
  }
  const sign = sort?.dir === 'desc' ? -1 : 1;
  dec.sort((a, b) => {
    if (sort) {
      if (a.v === null || b.v === null) { if (a.v !== b.v) return a.v === null ? 1 : -1; }
      else { const d = compareValues(a.v, b.v); if (d) return d * sign; }
    }
    return collator.compare(a.title, b.title) || a.c.seq - b.c.seq;
  });
  return dec.map((x) => x.c);
}

/** Last results, so an unrelated store change does not redo filter and sort. A handful of tables, oldest dropped. */
interface RowsMemo { types: Map<string, EntryType>; entries: Card[]; query: string; rows: Card[] }
const rowsMemo = new Map<string, RowsMemo>();
const MEMO_MAX = 8;

/**
 * Live Lore of the project whose type is `typeId` or a child of it, narrowed by the filters (all must hold) and sorted
 * (default: by title). Entries without a value for the sort key come last, in either direction.
 * The result keeps its identity while the type's entries, the filters and the sort are unchanged.
 */
export function typeRows(s: Pick<State, 'cards' | 'decks' | 'entryTypes'>, projectId: string, typeId: string, filters: FieldFilter[], sort: RowSort | null): Card[] {
  const entries = entriesOfType(s, projectId, typeId);
  const query = JSON.stringify([filters, sort]);
  const id = `${projectId}\0${typeId}`;
  const hit = rowsMemo.get(id);
  if (hit && hit.types === s.entryTypes && hit.query === query && hit.entries.length === entries.length && hit.entries.every((c, i) => c === entries[i])) {
    rowsMemo.delete(id); rowsMemo.set(id, hit); // most recent last
    return hit.rows;
  }
  const rows = filterAndSort(entries, s.entryTypes, filters, sort);
  rowsMemo.delete(id);
  rowsMemo.set(id, { types: s.entryTypes, entries, query, rows });
  if (rowsMemo.size > MEMO_MAX) rowsMemo.delete(rowsMemo.keys().next().value!);
  return rows;
}

// ---- Table state in the URL: ?f=key:op:value (repeatable), ?sort=key:dir, ?cols=a,b, ?page=n ----

const OPS: readonly string[] = ['eq', 'contains', 'min', 'max', 'has', 'missing'];
export function filtersFromQuery(q: URLSearchParams): FieldFilter[] {
  const out: FieldFilter[] = [];
  for (const raw of q.getAll('f')) {
    if (out.length >= MAX_FILTERS) break;
    const [key, op, ...rest] = raw.split(':');
    if (!key || !OPS.includes(op)) continue;
    const text = rest.join(':');
    if (op === 'has' || op === 'missing') { out.push({ key, op }); continue; }
    if (op === 'min' || op === 'max') {
      if (text.trim() === '' || !Number.isFinite(Number(text))) continue; // no usable limit
      out.push({ key, op, value: Number(text) });
    } else out.push({ key, op: op as FilterOp, value: text });
  }
  return out;
}
export const filterToParam = (f: FieldFilter): string => `${f.key}:${f.op}${f.value === undefined ? '' : `:${String(f.value)}`}`;
export function sortFromQuery(q: URLSearchParams): RowSort | null {
  const [key, dir] = (q.get('sort') ?? '').split(':');
  return key ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : null;
}

// ---- Checks and type upkeep ----

/** The store collections the checks read; each is replaced (new identity) whenever it changes. */
export type ChecksInput = Pick<State, 'cards' | 'decks' | 'entryTypes' | 'linkKinds' | 'entryLinks' | 'files'>;
const CHECKS_INPUT: (keyof ChecksInput)[] = ['cards', 'decks', 'entryTypes', 'linkKinds', 'entryLinks', 'files'];
/**
 * One slot: the Wiki header and the checks panel ask for the same project, so the last answer is reused. A second caller
 * with another project on screen at once would make both recompute every time; give it a keyed cache of 2–3 then.
 */
let lastChecks: { in: ChecksInput; projectId: string; out: ChecksResult; balance: BalanceResult } | null = null;

/**
 * The checks the export lists for the project (its default, includePages off): runChecks over its types, link kinds,
 * live Lore, the links between live entries (the store holds no other) and attachments; works_on links are not game
 * data. Plus the Wiki's own ambiguous_name checks (names shared by two entries are not linked in text). Recomputed only when one of the store collections it reads (or the project) changes.
 */
export function campaignChecks(s: ChecksInput, projectId: string): ChecksResult {
  return checked(s, projectId).out;
}

/** The tables, rules (with golden samples) and scenarios of the project that passed the checks: what the export writes. */
export function campaignBalanceResult(s: ChecksInput, projectId: string): BalanceResult {
  return checked(s, projectId).balance;
}

function checked(s: ChecksInput, projectId: string): NonNullable<typeof lastChecks> {
  const l = lastChecks;
  if (l && l.projectId === projectId && CHECKS_INPUT.every((k) => l.in[k] === s[k])) return l;
  let balance: BalanceResult = { tables: [], rules: [], scenarios: [] };
  const out = runChecks({
    types: [...s.entryTypes.values()].filter((t) => t.projectId === projectId),
    kinds: [...s.linkKinds.values()].filter((k) => k.projectId === projectId),
    entries: campaignLore(s.cards.values(), projectId, s.decks),
    links: [...s.entryLinks.values()].filter((x) => x.projectId === projectId && x.kindKey !== WORKS_ON),
    includePages: false,
    names: true,
    isAttached: (fileId, cardId) => s.files.get(fileId)?.cardId === cardId,
    onBalance: (r) => { balance = r; },
  });
  lastChecks = { in: { cards: s.cards, decks: s.decks, entryTypes: s.entryTypes, linkKinds: s.linkKinds, entryLinks: s.entryLinks, files: s.files }, projectId, out, balance };
  return lastChecks;
}

const count = (n: number) => n.toLocaleString('en-US');
/** The badge text: "⚠ 1,234 checks"; every check counts, listed or not. */
export const checksBadgeText = (r: ChecksResult): string => `⚠ ${count(r.total)} ${r.total === 1 ? 'check' : 'checks'}`;
/** The panel's note when the list was cut at CHECKS_LIMIT ("1,000 of 1,234"), else null. */
export const checksTruncatedText = (r: ChecksResult): string | null =>
  (r.total > r.checks.length ? `Showing ${count(r.checks.length)} of ${count(r.total)} checks. Fix these and the rest will show.` : null);

export const PROBLEM_LABEL: Record<CheckProblem, string> = {
  missing_required: 'Missing required values',
  invalid_value: 'Invalid values',
  broken_ref: 'Broken links and references',
  wrong_type_ref: 'References to the wrong type',
  link_type_not_allowed: "Links that don't fit their kind",
  sum_exceeded: 'Totals over their limit',
  bad_key: 'Invalid keys',
  duplicate_key: 'Duplicate keys',
  formula_error: 'Formula problems',
  ambiguous_name: 'Names shared by several entries',
};

/** Checks grouped by problem, in PROBLEM_LABEL order; empty groups are left out. */
export function checkGroups(checks: Check[]): { problem: CheckProblem; label: string; items: Check[] }[] {
  const by = new Map<CheckProblem, Check[]>();
  for (const c of checks) {
    const l = by.get(c.problem);
    if (l) l.push(c); else by.set(c.problem, [c]);
  }
  return (Object.keys(PROBLEM_LABEL) as CheckProblem[]).filter((p) => by.has(p)).map((p) => ({ problem: p, label: PROBLEM_LABEL[p], items: by.get(p)! }));
}

/**
 * Entries of exactly this type (as wiki/pruneValues picks them) holding a value whose key is not a visible field of the
 * type: what "Remove unused values" would change. Trashed entries are not in the store, so the server may change a few more.
 */
export function unusedValueCount(s: Pick<State, 'cards' | 'entryTypes'>, typeId: string): number {
  const keep = new Set(fieldsOf(s.entryTypes, typeId).filter((f) => !f.hidden).map((f) => f.key));
  let n = 0;
  for (const c of s.cards.values()) {
    if (c.entryTypeId === typeId && c.fields && Object.keys(c.fields).some((k) => !keep.has(k))) n++;
  }
  return n;
}

/** What stops a type from being deleted, as far as the store shows it (wiki/deleteType counts the same, server side). */
export interface TypeUsage { entries: number; childTypes: number; fieldTargets: number; linkKinds: number }
export function typeUsage(s: Pick<State, 'cards' | 'entryTypes' | 'linkKinds'>, type: Pick<EntryType, 'id' | 'key' | 'projectId'>): TypeUsage {
  let entries = 0;
  for (const c of s.cards.values()) if (c.entryTypeId === type.id && live(c)) entries++;
  let childTypes = 0, fieldTargets = 0, linkKinds = 0;
  for (const t of s.entryTypes.values()) {
    if (t.projectId !== type.projectId || t.id === type.id) continue;
    if (t.parentTypeId === type.id) childTypes++;
    fieldTargets += t.fields.filter((f) => f.target === type.key).length;
  }
  for (const k of s.linkKinds.values()) {
    if (k.projectId !== type.projectId) continue;
    if (k.fromTypes.includes(type.key) || k.toTypes.includes(type.key) || k.props.some((p) => p.target === type.key)) linkKinds++;
  }
  return { entries, childTypes, fieldTargets, linkKinds };
}

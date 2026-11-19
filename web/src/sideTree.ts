/**
 * The sidebar's project trees, as flat rows: each project, its areas (only when it has several), its lists with their
 * ring and open count, then its wiki with the entries grouped by type. The search box filters as you type: a row stays
 * when it or a parent matches, and whatever leads to a match unfolds. Pure over the store, so it is unit tested
 * (tests/web-side-tree.test.ts); the sidebar only renders the rows.
 */
import type { Card, Deck, EntryType, Project } from '../../shared/types';
import { titleOf } from '../../shared/cards';
import { nameKey } from '../../shared/autolink';
import { deckPath } from './cards';
import { entryPath, kindPath, wikiPath } from './wiki';

export type RowKind = 'project' | 'area' | 'list' | 'wiki' | 'type' | 'entry' | 'more';
export interface SideRow {
  /** Stable id: also the key of its fold choice. */
  id: string;
  kind: RowKind;
  level: 1 | 2 | 3 | 4;
  label: string;
  /** Where a click goes; '' for projects and areas, which fold (and become where the quick actions put things). */
  href: string;
  /** Rows with something under them: whether that is shown. */
  open?: boolean;
  /** Lists: tasks left; wiki and types: entries. */
  count?: number;
  done?: number;
  total?: number;
  projectId: string;
  areaId?: number;
  deckId?: string;
  /** The part of the label the search matched: [start, end). */
  hit?: [number, number];
}
export type TreeState = { projects: Map<string, Project>; decks: Map<string, Deck>; entryTypes: Map<string, EntryType>; cards: Map<string, Card> };
export type ListStats = Map<string, { total: number; done: number }>;

/** Shown entries per type; the rest are one "N more" row that opens the type's page. */
export const ENTRIES_PER_TYPE = 50;
/** Fold choices kept per person (the newest). */
export const FOLDS_KEPT = 300;
/** Projects and areas start unfolded; the wiki and its types start folded. */
export const FOLD_DEFAULT = (kind: RowKind): boolean => kind === 'project' || kind === 'area';

/** Records one fold choice, newest last; the oldest go past FOLDS_KEPT. */
export function setFold(folds: Record<string, boolean>, id: string, open: boolean): Record<string, boolean> {
  const next = { ...folds };
  delete next[id];
  next[id] = open;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - FOLDS_KEPT))) delete next[k];
  return next;
}

/** A wiki entry with its title and search form worked out once per `cards` map (not on every keystroke). */
interface LoreItem { card: Card; title: string; key: string }
interface Lore { byType: Map<string | null, LoreItem[]>; total: number }
const loreCache = new WeakMap<Map<string, Card>, Map<string, Lore>>();
/** Live wiki entries by project and type, sorted by title: one pass over the cards, cached per `cards` map. */
function loreByProject(cards: Map<string, Card>, decks: Map<string, Deck>): Map<string, Lore> {
  const hit = loreCache.get(cards);
  if (hit) return hit;
  const out = new Map<string, Lore>();
  for (const c of cards.values()) {
    if (!c.isDoc || c.visibility === 'deleted' || !c.deckId) continue;
    const pid = decks.get(c.deckId)?.projectId;
    if (!pid) continue;
    let l = out.get(pid);
    if (!l) out.set(pid, (l = { byType: new Map(), total: 0 }));
    const type = c.entryTypeId ?? null;
    const list = l.byType.get(type) ?? [];
    const title = titleOf(c.content);
    list.push({ card: c, title, key: foldKey(title) });
    l.byType.set(type, list);
    l.total++;
  }
  for (const l of out.values()) for (const list of l.byType.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  loreCache.set(cards, out);
  return out;
}

const listCache = new WeakMap<Map<string, Deck>, Map<string, Deck[]>>();
/** Lists by project and area (`<projectId>|<spaceId>`), in their order: once per `decks` map. */
function listsByArea(decks: Map<string, Deck>): Map<string, Deck[]> {
  const hit = listCache.get(decks);
  if (hit) return hit;
  const out = new Map<string, Deck[]>();
  for (const d of [...decks.values()].sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)) {
    const k = `${d.projectId}|${d.spaceId}`;
    const list = out.get(k);
    if (list) list.push(d); else out.set(k, [d]);
  }
  listCache.set(decks, out);
  return out;
}

/** Search form: nameKey (case, spaces) without accents, so "asdis" finds "Ásdís". */
const foldKey = (label: string): string => nameKey(label).normalize('NFD').replace(/\p{M}/gu, '');
/** Memoised for the few short names (projects, areas, lists, types); the oldest go first past FOLDED_KEPT. */
const folded = new Map<string, string>();
const FOLDED_KEPT = 2000;
export function searchKey(label: string): string {
  let v = folded.get(label);
  if (v !== undefined) return v;
  v = foldKey(label);
  if (folded.size >= FOLDED_KEPT) folded.delete(folded.keys().next().value as string);
  folded.set(label, v);
  return v;
}

/** While searching, at most this many rows; the rest are one row that says how many (Enter searches everything). */
export const SEARCH_ROWS = 300;

/** `overrides`: folds clicked during this search; they win over the search's own unfolding and are not saved. */
export function sideRows(s: TreeState, stats: ListStats, query: string, folds: Record<string, boolean>, overrides: Record<string, boolean> = {}): SideRow[] {
  const q = query.trim();
  const fq = q ? searchKey(q) : '';
  const lq = q.toLowerCase();
  const match = (label: string) => !fq || searchKey(label).includes(fq);
  const hitOf = (label: string): [number, number] | undefined => {
    if (!q) return undefined;
    const i = label.toLowerCase().indexOf(lq);
    return i >= 0 ? [i, i + q.length] : undefined;
  };
  /** Folded or not: with a search, whatever leads to a match is open. */
  const isOpen = (id: string, kind: RowKind, leadsToMatch: boolean) =>
    overrides[id] ?? ((q && leadsToMatch) || (folds[id] ?? FOLD_DEFAULT(kind)));
  const row = (r: Omit<SideRow, 'hit'>, own: boolean): SideRow => (own && q ? { ...r, hit: hitOf(r.label) } : r);

  const lore = loreByProject(s.cards, s.decks);
  const byArea = listsByArea(s.decks);
  const out: SideRow[] = [];
  for (const p of [...s.projects.values()].filter((x) => !x.isArchived).sort((a, b) => a.seq - b.seq)) {
    const pm = !!fq && match(p.name);
    const under: SideRow[] = [];
    let leads = false;
    const several = p.spaces.length > 1;
    for (const sp of p.spaces) {
      const areaLabel = sp.name ?? 'General';
      const am = several && !!fq && match(areaLabel);
      const lists = byArea.get(`${p.id}|${sp.id}`) ?? [];
      const listRows: SideRow[] = [];
      let areaLeads = false;
      for (const d of lists) {
        const lm = !!fq && match(d.title);
        if (fq && !pm && !am && !lm) continue;
        if (lm) areaLeads = true;
        const st = stats.get(d.id) ?? { total: 0, done: 0 };
        listRows.push(row({ id: `${p.id}/l${d.id}`, kind: 'list', level: several ? 3 : 2, label: d.title, href: deckPath(d), count: st.total - st.done, done: st.done, total: st.total, projectId: p.id, areaId: sp.id, deckId: d.id }, lm));
      }
      if (!listRows.length && !am) continue;
      if (areaLeads || am) leads = true;
      if (!several) { under.push(...listRows); continue; }
      const id = `${p.id}/a${sp.id}`;
      const open = isOpen(id, 'area', areaLeads);
      under.push(row({ id, kind: 'area', level: 2, label: areaLabel, href: '', open, projectId: p.id, areaId: sp.id }, am));
      if (open) under.push(...listRows);
    }
    // The wiki: entries by type (in the types' order), untyped pages last.
    const l = lore.get(p.id);
    if (l) {
      const wm = !!fq && match('Wiki');
      const groups: SideRow[] = [];
      let wikiLeads = false;
      const types: { id: string; key: string | null; label: string; href: string }[] = [...s.entryTypes.values()]
        .filter((t) => t.projectId === p.id && l.byType.has(t.id))
        .sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name))
        .map((t) => ({ id: t.id, key: t.key, label: t.name, href: kindPath(p.seq, t.key) }));
      // Entries of a type of another project, or of a type no longer known, count as pages.
      const known = new Set(types.map((t) => t.id));
      const pages = [...l.byType].filter(([k]) => k === null || !known.has(k)).flatMap(([, v]) => v);
      if (pages.length) types.push({ id: 'pages', key: null, label: 'Pages', href: wikiPath(p.seq) });
      for (const t of types) {
        const tm = !!fq && match(t.label);
        const all = t.id === 'pages' ? pages : l.byType.get(t.id)!;
        const keepAll = !fq || pm || wm || tm;
        const kept = keepAll ? all : all.filter((e) => e.key.includes(fq));
        if (!kept.length) continue;
        const typeLeads = !keepAll || tm;
        if (typeLeads) wikiLeads = true;
        const id = `${p.id}/wiki/${t.id}`;
        const open = isOpen(id, 'type', !keepAll);
        groups.push(row({ id, kind: 'type', level: 3, label: t.label, href: t.href, open, count: all.length, projectId: p.id }, tm));
        if (!open) continue;
        for (const e of kept.slice(0, ENTRIES_PER_TYPE)) {
          groups.push(row({ id: `${p.id}/e${e.card.id}`, kind: 'entry', level: 4, label: e.title, href: entryPath(p.seq, e.card), projectId: p.id }, !keepAll || !!fq));
        }
        if (kept.length > ENTRIES_PER_TYPE) {
          groups.push({ id: `${p.id}/more/${t.id}`, kind: 'more', level: 4, label: `${kept.length - ENTRIES_PER_TYPE} more`, href: t.href, projectId: p.id });
        }
      }
      if (groups.length || wm) {
        if (wikiLeads || wm) leads = true;
        const id = `${p.id}/wiki`;
        const open = isOpen(id, 'wiki', wikiLeads);
        under.push(row({ id, kind: 'wiki', level: 2, label: 'Wiki', href: wikiPath(p.seq), open, count: l.total, projectId: p.id }, wm));
        if (open) under.push(...groups);
      }
    }
    if (fq && !pm && !leads) continue;
    const open = isOpen(p.id, 'project', leads);
    out.push(row({ id: p.id, kind: 'project', level: 1, label: p.name, href: '', open, projectId: p.id }, pm));
    if (open) out.push(...under);
    if (fq && out.length > SEARCH_ROWS) break;
  }
  if (fq && out.length > SEARCH_ROWS) {
    // Counted only up to the project that went past the cap: "more" is at least this many.
    const rest = out.length - SEARCH_ROWS;
    out.length = SEARCH_ROWS;
    out.push({ id: 'search-more', kind: 'more', level: 1, label: `${rest}+ more: press Enter to search everything`, href: '', projectId: '' });
  }
  return out;
}

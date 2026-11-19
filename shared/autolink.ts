// Names become links by themselves: wiki entry names and aliases are recognised in text at display time (the stored
// text never changes). buildNameIndex turns the campaign's names into an Aho-Corasick automaton once (rebuild it only
// when names or aliases change); findMentions then walks a text once, linear in its length.
import { TOKEN_BODY } from './content';
import { titleOf } from './cards';

/** Names shorter than this (in characters, after trimming) are never matched. */
export const MIN_NAME_CHARS = 3;
/** Names longer than this (in characters, after folding) are never indexed: no entry name is that long (entry names ≤ 200). */
export const MAX_NAME_CHARS = 200;
export const ALIAS_LIMITS = { perEntry: 50, chars: 80 } as const;
export const LINK_IGNORE_LIMITS = { perCard: 200, chars: 200 } as const;

export interface NameSource { id: string; name: string; aliases?: readonly string[] | null }
export interface AmbiguousName { name: string; cardIds: string[] }
export interface Mention { from: number; to: number; cardId: string; name: string }
export interface MatchOptions {
  /** Names (or aliases) not linked in this text; matched case-insensitively. */
  ignores?: readonly string[] | null;
  /** The page the text belongs to: its own names are never linked. */
  selfId?: string | null;
}

// ---- Folding: case-insensitive, Unicode-aware, one code point at a time so offsets map back to the text. ----

/** Folds toLowerCase gets wrong for matching: İ → i (not i + combining dot), final ς → σ. ı stays ı. */
const FOLD_SPECIAL = new Map<number, number>([[0x130, 0x69], [0x3c2, 0x3c3]]);
const foldCache = new Map<number, number[] | number>();
/** Fills once and then stays: past it, folds are computed without caching (scripts in use are far fewer). */
const FOLD_CACHE_MAX = 65_536;
function foldCp(cp: number): number[] | number {
  if (cp < 128) return cp >= 65 && cp <= 90 ? cp + 32 : cp;
  const special = FOLD_SPECIAL.get(cp);
  if (special !== undefined) return special;
  let f = foldCache.get(cp);
  if (f === undefined) {
    const s = String.fromCodePoint(cp).toLowerCase();
    const list: number[] = [];
    for (let i = 0; i < s.length; ) { const c = s.codePointAt(i)!; list.push(FOLD_SPECIAL.get(c) ?? c); i += c > 0xffff ? 2 : 1; }
    f = list.length === 1 ? list[0] : list;
    if (foldCache.size < FOLD_CACHE_MAX) foldCache.set(cp, f);
  }
  return f;
}
const WORD_RE = /[\p{L}\p{M}\p{N}_]/u;
/** The non-ASCII code points of JavaScript's \s. */
const SPACES = new Set([0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isSpace = (cp: number) => (cp < 128 ? cp === 32 || (cp >= 9 && cp <= 13) : SPACES.has(cp));
const isWord = (cp: number) =>
  cp < 128 ? (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95 : WORD_RE.test(String.fromCodePoint(cp));
/** The code point ending just before `i`, or -1 at the start. */
function cpBefore(t: string, i: number): number {
  if (i <= 0) return -1;
  const lo = t.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = t.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return t.codePointAt(i - 2)!;
  }
  return lo;
}

/**
 * The form names are compared in: trimmed, whitespace runs as one space, lower case (per code point, as the matcher
 * reads text). Control characters are dropped. Two names are the same name when their keys are equal.
 */
export function nameKey(name: string): string {
  return foldKey(name, Infinity)!;
}

/** nameKey, or null as soon as the key passes `max` code points (so a huge title costs no more than `max`). */
function foldKey(name: string, max: number): string | null {
  let out = '';
  let chunk: number[] = [];
  let count = 0;
  let space = false;
  const put = (c: number) => {
    chunk.push(c);
    count++;
    // String.fromCodePoint(...) takes a bounded argument list: flush in chunks.
    if (chunk.length >= 4096) { out += String.fromCodePoint(...chunk); chunk = []; }
  };
  for (let i = 0; i < name.length; ) {
    const cp = name.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (isSpace(cp)) { space = count > 0; continue; }
    if (cp < 32 || cp === 127) continue;
    if (space) { put(32); space = false; }
    const f = foldCp(cp);
    if (typeof f === 'number') put(f); else for (const c of f) put(c);
    if (count > max) return null;
  }
  return out + String.fromCodePoint(...chunk);
}

/** The key a name is indexed under, or null when it is never matched (shorter than MIN_NAME_CHARS or longer than MAX_NAME_CHARS). */
export function indexKey(name: string): string | null {
  const key = foldKey(name, MAX_NAME_CHARS);
  return key !== null && cpLength(key) >= MIN_NAME_CHARS ? key : null;
}

/**
 * Names and aliases held by more than one of the entries (indexKey rules), sorted by name: never linked. Only the
 * folded-key map, no automaton, so it is cheap enough for the checks.
 */
export function ambiguousNames(entries: Iterable<NameSource>): AmbiguousName[] {
  const out: AmbiguousName[] = [];
  for (const [, e] of namesByKey(entries)) if (e.ids.length > 1) out.push({ name: e.name, cardIds: e.ids });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function namesByKey(entries: Iterable<NameSource>): Map<string, { name: string; ids: string[] }> {
  const byKey = new Map<string, { name: string; ids: string[] }>();
  const add = (id: string, name: string) => {
    const key = indexKey(name);
    if (key === null) return;
    const e = byKey.get(key);
    if (!e) byKey.set(key, { name: cleanName(name), ids: [id] });
    else if (!e.ids.includes(id)) e.ids.push(id);
  };
  for (const e of entries) {
    if (e.name) add(e.id, e.name);
    for (const a of e.aliases ?? []) add(e.id, a);
  }
  return byKey;
}

/** A name as stored (alias, ignore): trimmed, whitespace runs (line breaks too) as one space. */
export const cleanName = (s: string): string => s.trim().replace(/\s+/gu, ' ');

const cpLength = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0xdc00 || c > 0xdfff) n++; } return n; };

/** An entry's names for the index: its title (none for a page without one) and its aliases. */
export function nameSourceOf(c: { id: string; content: string; aliases?: readonly string[] | null }): NameSource {
  const first = c.content.split('\n', 1)[0] ?? '';
  return { id: c.id, name: first.replace(/^[#\s]+/, '').trim() === '' ? '' : titleOf(c.content), aliases: c.aliases ?? [] };
}

// ---- The index ----

/** Built by buildNameIndex; immutable. */
export class NameIndex {
  /** Distinct names (keys) indexed. */
  readonly size: number;
  /** Names held by more than one entry: never linked. Sorted by name. */
  readonly ambiguous: readonly AmbiguousName[];
  /** @internal pattern id → display name, key, card id (null: ambiguous). */
  readonly names: string[];
  readonly keys: string[];
  readonly cards: (string | null)[];
  /** @internal trie in compact form: children of node n are childCp/childNode[childStart[n] .. childStart[n+1]), cp-sorted. */
  readonly childStart: Int32Array;
  readonly childCp: Int32Array;
  readonly childNode: Int32Array;
  /** @internal root transitions for ASCII (-1: none). */
  readonly rootAscii: Int32Array;
  readonly fail: Int32Array;
  /** @internal nearest terminal node on the fail chain (0: none); pattern id of a terminal node (-1: none); its length in folded code points. */
  readonly dict: Int32Array;
  readonly pattern: Int32Array;
  readonly depth: Int32Array;

  constructor(names: string[], keys: string[], cards: (string | null)[], ambiguous: AmbiguousName[]) {
    this.names = names; this.keys = keys; this.cards = cards; this.ambiguous = ambiguous; this.size = keys.length;
    // Build the trie with per-node maps, then compact it and let the maps go.
    let kids: Map<number, number>[] = [new Map()];
    const pattern: number[] = [-1];
    const depth: number[] = [0];
    keys.forEach((k, pid) => {
      let n = 0;
      for (let i = 0; i < k.length; ) {
        const cp = k.codePointAt(i)!;
        i += cp > 0xffff ? 2 : 1;
        let nx = kids[n].get(cp);
        if (nx === undefined) { nx = kids.length; kids.push(new Map()); pattern.push(-1); depth.push(depth[n] + 1); kids[n].set(cp, nx); }
        n = nx;
      }
      pattern[n] = pid;
    });
    const count = kids.length;
    this.childStart = new Int32Array(count + 1);
    this.childCp = new Int32Array(count - 1);
    this.childNode = new Int32Array(count - 1);
    let at = 0;
    for (let n = 0; n < count; n++) {
      this.childStart[n] = at;
      for (const [cp, nx] of [...kids[n]].sort((a, b) => a[0] - b[0])) { this.childCp[at] = cp; this.childNode[at] = nx; at++; }
    }
    this.childStart[count] = at;
    kids = [];
    this.pattern = Int32Array.from(pattern);
    this.depth = Int32Array.from(depth);
    this.rootAscii = new Int32Array(128).fill(-1);
    for (let j = this.childStart[0]; j < this.childStart[1]; j++) if (this.childCp[j] < 128) this.rootAscii[this.childCp[j]] = this.childNode[j];
    // Fail and dictionary links, breadth first.
    this.fail = new Int32Array(count);
    this.dict = new Int32Array(count);
    const queue = new Int32Array(count);
    let head = 0, tail = 0;
    for (let j = this.childStart[0]; j < this.childStart[1]; j++) queue[tail++] = this.childNode[j];
    while (head < tail) {
      const n = queue[head++];
      for (let j = this.childStart[n]; j < this.childStart[n + 1]; j++) {
        const cp = this.childCp[j], nx = this.childNode[j];
        let f = this.fail[n];
        let t = this.child(f, cp);
        while (t < 0 && f !== 0) { f = this.fail[f]; t = this.child(f, cp); }
        const fn = t < 0 ? 0 : t;
        this.fail[nx] = fn;
        this.dict[nx] = this.pattern[fn] >= 0 ? fn : this.dict[fn];
        queue[tail++] = nx;
      }
    }
  }

  /** @internal the child of `n` by `cp`, or -1. */
  child(n: number, cp: number): number {
    if (n === 0 && cp < 128) return this.rootAscii[cp];
    let lo = this.childStart[n], hi = this.childStart[n + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.childCp[mid];
      if (c === cp) return this.childNode[mid];
      if (c < cp) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
}

/**
 * The names and aliases of the given entries (pass the live wiki entries of one campaign). Names shorter than
 * MIN_NAME_CHARS are left out. A name (or alias) held by two entries is ambiguous: it is indexed, so it still claims its
 * text over shorter names inside it, but never linked, and listed in `ambiguous`.
 */
export function buildNameIndex(entries: Iterable<NameSource>): NameIndex {
  const byKey = namesByKey(entries);
  const names: string[] = [], keys: string[] = [], cards: (string | null)[] = [], ambiguous: AmbiguousName[] = [];
  for (const [key, e] of byKey) {
    names.push(e.name); keys.push(key); cards.push(e.ids.length === 1 ? e.ids[0] : null);
    if (e.ids.length > 1) ambiguous.push({ name: e.name, cardIds: e.ids });
  }
  ambiguous.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return new NameIndex(names, keys, cards, ambiguous);
}

/** Recently built indexes by signature (cachedNameIndex): a few campaigns at once, least recently used dropped. */
const indexCache = new Map<string, NameIndex>();
const INDEX_CACHE_MAX = 4;

/**
 * buildNameIndex, memoised on a signature of the entries' ids, names and aliases (in order): the automaton is rebuilt
 * only when a name or alias changes, not on every card edit. Keeps the last INDEX_CACHE_MAX indexes.
 */
export function cachedNameIndex(entries: readonly NameSource[]): NameIndex {
  // Every part is length-prefixed and each entry starts with its alias count, so no two different inputs share a
  // signature (whatever characters names hold).
  const parts: string[] = [];
  const put = (s: string) => { parts.push(`${s.length}:`, s); };
  for (const e of entries) {
    if (!e.name && !e.aliases?.length) continue;
    // A huge title is never indexed: a stand-in keeps it out of the signature (an empty name can't be confused with it: '0:').
    const huge = e.name.length > MAX_NAME_CHARS * 4 && indexKey(e.name) === null;
    put(e.id);
    if (huge) parts.push('H'); else put(e.name);
    parts.push(`${e.aliases?.length ?? 0}|`);
    for (const a of e.aliases ?? []) put(a);
  }
  const sig = parts.join('');
  const hit = indexCache.get(sig);
  if (hit) { indexCache.delete(sig); indexCache.set(sig, hit); return hit; }
  const index = buildNameIndex(entries);
  indexCache.set(sig, index);
  if (indexCache.size > INDEX_CACHE_MAX) indexCache.delete(indexCache.keys().next().value!);
  return index;
}

// ---- Where names are not looked for ----

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING_MARK = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const CODE_SPAN = /(`+)[^\n]*?\1/g;
const LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const ANGLE = /<[^<>\s][^<>\n]*>/g;
const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>]+/giu;
/** `$code`, `#tag` and `@mention` tokens (shared/content rules): already references. */
const TOKEN = new RegExp(`(^|\\s)([$](?:${TOKEN_BODY.code})|#(?:${TOKEN_BODY.tag})|@(?:${TOKEN_BODY.mention}))`, 'gu');

/**
 * Ranges [from, to) of the text that never hold a mention, sorted and merged: fenced blocks, code spans, Markdown and
 * HTML links, URLs, `$code` / `#tag` / `@mention` tokens and the `#` marks of headings (the heading's text is matched).
 * Fences and code spans follow shared/content's stripCode.
 */
export function unlinkableRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let fence: string | null = null;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end);
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push([start, end]);
    } else if (m) {
      fence = m[1];
      out.push([start, end]);
    } else {
      const h = HEADING_MARK.exec(line);
      if (h) out.push([start, start + h[0].length]);
      for (const re of [CODE_SPAN, LINK, ANGLE, URL]) {
        re.lastIndex = 0;
        for (let x = re.exec(line); x; x = re.exec(line)) out.push([start + x.index, start + x.index + x[0].length]);
      }
      TOKEN.lastIndex = 0;
      for (let x = TOKEN.exec(line); x; x = TOKEN.exec(line)) {
        const s = start + x.index + x[1].length;
        out.push([s, s + x[2].length]);
      }
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else if (r[1] > r[0]) merged.push([r[0], r[1]]);
  }
  return merged;
}

// ---- Matching ----

/**
 * The mentions of indexed names in `text` (Markdown), sorted by `from`: whole words, case-insensitive, outside the
 * unlinkableRanges. Where matches overlap the longest name wins (then the earliest); the winner claims its text even
 * when it is not linked (ambiguous, ignored here, or a name of `selfId`), so no shorter name inside it is linked.
 * A run of whitespace in the text matches the one space of a name unless it holds a blank line.
 */
export function findMentions(text: string, index: NameIndex, opts: MatchOptions = {}): Mention[] {
  if (index.size === 0 || text.length === 0) return [];
  const skip = unlinkableRanges(text);
  const ignored = new Set((opts.ignores ?? []).map(nameKey));
  // Folded code points of the scanned text: where each starts in the text and where its source character ends.
  let src = new Int32Array(text.length + 8);
  let srcEnd = new Int32Array(text.length + 8);
  let n = 0;
  const push = (s: number, e: number) => {
    if (n === src.length) {
      const a = new Int32Array(src.length * 2); a.set(src); src = a;
      const b = new Int32Array(srcEnd.length * 2); b.set(srcEnd); srcEnd = b;
    }
    src[n] = s; srcEnd[n] = e; n++;
  };
  // Candidates: whole-word matches, as parallel arrays.
  const cFrom: number[] = [], cTo: number[] = [], cPid: number[] = [];
  const { fail, dict, pattern, depth } = index;
  let state = 0;
  const feed = (cp: number, s: number, e: number, last: boolean) => {
    push(s, e);
    let st = state;
    let t = index.child(st, cp);
    while (t < 0 && st !== 0) { st = fail[st]; t = index.child(st, cp); }
    state = t < 0 ? 0 : t;
    if (!last) return;
    for (let node = pattern[state] >= 0 ? state : dict[state]; node !== 0; node = dict[node]) {
      const startAt = n - depth[node];
      const from = src[startAt];
      // The match must start on the first folded unit of a character and on a word boundary, and end on one.
      if (startAt > 0 && src[startAt - 1] === from) continue;
      if (isWord(cpBefore(text, from))) continue;
      const after = e < text.length ? text.codePointAt(e)! : -1;
      if (after >= 0 && isWord(after)) continue;
      cFrom.push(from); cTo.push(e); cPid.push(pattern[node]);
    }
  };
  let r = 0;
  for (let i = 0; i < text.length; ) {
    if (r < skip.length && i >= skip[r][0]) {
      i = Math.max(i, skip[r][1]);
      r++;
      state = 0;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    if (isSpace(cp)) {
      let j = i, lines = 0;
      const stop = r < skip.length ? skip[r][0] : text.length;
      while (j < stop) {
        const c = text.charCodeAt(j);
        if (c === 10) lines++;
        else if (!isSpace(c)) break;
        j++;
      }
      if (lines >= 2) state = 0;
      else feed(32, i, j, true);
      i = j;
      continue;
    }
    const f = foldCp(cp);
    if (typeof f === 'number') feed(f, i, i + w, true);
    else for (let k = 0; k < f.length; k++) feed(f[k], i, i + w, k === f.length - 1);
    i += w;
  }
  if (!cFrom.length) return [];
  // Longest first, then earliest; a candidate is kept when its text is still free.
  const order = cFrom.map((_, k) => k).sort((a, b) => (cTo[b] - cFrom[b]) - (cTo[a] - cFrom[a]) || cFrom[a] - cFrom[b]);
  const taken: [number, number][] = [];
  const free = (from: number, to: number) => {
    // `taken` stays sorted by from; binary search the first range ending after `from`.
    let lo = 0, hi = taken.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (taken[mid][1] <= from) lo = mid + 1; else hi = mid; }
    return lo === taken.length || taken[lo][0] >= to ? lo : -1;
  };
  const out: Mention[] = [];
  for (const k of order) {
    const at = free(cFrom[k], cTo[k]);
    if (at < 0) continue;
    taken.splice(at, 0, [cFrom[k], cTo[k]]);
    const pid = cPid[k];
    const cardId = index.cards[pid];
    if (cardId === null || cardId === opts.selfId || ignored.has(index.keys[pid])) continue;
    out.push({ from: cFrom[k], to: cTo[k], cardId, name: index.names[pid] });
  }
  return out.sort((a, b) => a.from - b.from);
}

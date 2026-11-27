export type Lang = 'en' | 'it';
export const LANGS: readonly Lang[] = ['en', 'it'];

/** A comment's version for its translations (comments keep no content version of their own): 32-bit FNV-1a of the text's UTF-16 units. */
export function textVersion(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// ---- Text pipeline (pure): Markdown in, Markdown out; only plain sentences ever reach the engine ----
import MarkdownIt from 'markdown-it';
import { ANGLE, CODE_SPAN, LINK, TOKEN, URL as URL_RE } from './autolink';

/** A term with an optional fixed target per language. No target for the output language: kept exactly as written. */
export type GlossaryEntry = { term: string; en?: string; it?: string };
export type RunFn = (texts: string[], from: Lang, to: Lang) => Promise<string[]>;
export interface TranslateOptions {
  glossary: readonly GlossaryEntry[];
  /** The language assumed for blocks too short to detect; null leaves them untranslated. */
  fallback: Lang | null;
  run: RunFn;
}

// ---- Language detection ----

const words = (s: string) => s.split(/\s+/u).filter(Boolean);
// Words found in both languages (a, in, no, me, come, per, con, ...) are left out on purpose.
const STOP: Record<Lang, ReadonlySet<string>> = {
  en: new Set(words(`the and of to is are was were be we you they it that this with for on how what when where which who will
    would can could should have has had do does not but or if from by as at an our your their there here then than so all my`)),
  it: new Set(words(`il lo la le gli un una uno di del della dei delle da dal dalla su tra fra che chi cui e è sono siamo non
    se si dove quando perché anche più molto questo questa questi queste quello nel nella nei al alla ai agli vogliamo ci
    essere fare o già cosa tutto tutti suo sua loro l dell all nell sull dall quest quell`)),
};
/** Italian elision stems: "d'acqua" is Italian, "I'd" is not. */
const ELISION = /(?<![\p{L}\p{M}])(?:l|d|un|dell|all|nell|sull|dall|quest|quell)['’](?=\p{L})/giu;

/** The language a text is in by stop-word count; null when it has fewer than 3 words or the languages tie. */
export function detectLang(text: string): Lang | null {
  let it = 0;
  const tokens = text.replace(ELISION, () => { it++; return ' '; }).toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  if (tokens.length + it < 3) return null;
  let en = 0;
  for (const w of tokens) {
    if (STOP.en.has(w)) en++;
    if (STOP.it.has(w)) it++;
    if (/[àèéìòù]$/u.test(w)) it++;
  }
  return en === it ? null : en > it ? 'en' : 'it';
}

// ---- Protecting what the engine must not see ----

const PH = (n: number) => `⟦${n}⟧`;
const PH_RE = /⟦(\d+)⟧/g;
const WIKI_LINK = /\[\[[^\]\n]+\]\]/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const all = (re: RegExp, s: string) => s.matchAll(new RegExp(re.source, re.flags));

interface Claim { from: number; to: number; text: string }

/** What in `body` is kept out of the engine: glossary terms, code, links, tokens and code-like words. */
function claims(body: string, glossary: readonly GlossaryEntry[], to: Lang): Claim[] {
  const out: Claim[] = [];
  const add = (from: number, end: number, text = body.slice(from, end)) => { if (end > from) out.push({ from, to: end, text }); };
  for (const g of glossary) {
    const term = g.term.trim().replace(/\s+/gu, ' ');
    if (!term) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRe(term).replace(/ /g, '\\s+')}(?![\\p{L}\\p{M}\\p{N}_])`, 'giu');
    for (const m of body.matchAll(re)) add(m.index, m.index + m[0].length, g[to] || m[0]);
  }
  for (const re of [CODE_SPAN, LINK, ANGLE, URL_RE, WIKI_LINK]) for (const m of all(re, body)) add(m.index, m.index + m[0].length);
  for (const m of all(TOKEN, body)) add(m.index + m[1].length, m.index + m[0].length);
  // Emphasis delimiters: the pair is masked, the words between them are still translated.
  for (const m of body.matchAll(/(\*{1,3}|~~)(?=\S)(.+?)(?<=\S)\1/gu)) {
    const n = m[1].length;
    add(m.index, m.index + n);
    add(m.index + m[0].length - n, m.index + m[0].length);
  }
  for (const m of body.matchAll(/\S+/gu)) {
    const lead = /^[("'“‘{*[]*/u.exec(m[0])![0].length;
    let inner = m[0].slice(lead).replace(/[.,;:!?)\]}"”’…]+$/u, '');
    if (!/[_/]/.test(inner)) inner = inner.replace(/\*{1,3}$/, '');
    if (isCodeLike(inner)) add(m.index + lead, m.index + lead + inner.length);
  }
  return out;
}

/** Tokens Bergamot would mangle: paths, snake_case, wildcards, file names, camelCase, ALLCAPS. */
function isCodeLike(t: string): boolean {
  return /[/_*]/.test(t) || /[\w-]\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z]{3,}$/.test(t);
}

/** `body` with each claimed span swapped for ⟦n⟧ (longest claim first, no overlaps), and what each stands for. */
function mask(body: string, glossary: readonly GlossaryEntry[], to: Lang): { masked: string; held: string[] } | null {
  if (body.includes('⟦')) return null;
  const cs = claims(body, glossary, to).sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const kept: Claim[] = [];
  for (const c of cs) if (!kept.some((k) => c.from < k.to && k.from < c.to)) kept.push(c);
  kept.sort((a, b) => a.from - b.from);
  let masked = '', at = 0;
  for (const c of kept) { masked += body.slice(at, c.from) + PH(masked.match(PH_RE)?.length ?? 0); at = c.to; }
  return { masked: masked + body.slice(at), held: kept.map((c) => c.text) };
}

/** The translation with placeholders restored, or null unless every placeholder came back exactly once. */
function unmask(out: string, held: readonly string[]): string | null {
  const seen = new Set<number>();
  let ok = true;
  const text = out.replace(PH_RE, (_, d: string) => {
    const n = Number(d);
    if (n >= held.length || seen.has(n)) { ok = false; return ''; }
    seen.add(n);
    return held[n];
  });
  return ok && seen.size === held.length && text.trim() !== '' ? text : null;
}

// ---- Finding the blocks ----

const md = new MarkdownIt({ html: true });
/** Quote, list, checkbox and heading marks at the start of a line. */
const LINE_PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)[ \t]*)*/;

/** Absolute [from, to) ranges of the text that is prose: lines of paragraphs, headings and items, and table cells. */
function proseRanges(text: string): [number, number][] {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i++].length + 1) starts.push(at);
  const out: [number, number][] = [];
  const range = (from: number, to: number) => {
    const s = text.slice(from, to);
    const a = from + (s.length - s.trimStart().length);
    const b = from + s.trimEnd().length;
    if (b > a) out.push([a, b]);
  };
  const line = (i: number) => {
    const p = LINE_PREFIX.exec(lines[i])![0].length;
    range(starts[i] + p, starts[i] + lines[i].length);
  };
  for (const t of md.parse(text, {})) {
    if (!t.map) continue;
    if (t.type === 'inline') for (let i = t.map[0]; i < t.map[1]; i++) line(i);
    else if (t.type === 'table_open') {
      for (let i = t.map[0]; i < t.map[1]; i++) {
        if (i === t.map[0] + 1) continue; // the |---|---| row
        let from = 0;
        const row = lines[i];
        for (const m of [...row.matchAll(/(?<!\\)\|/g), { index: row.length }]) {
          range(starts[i] + from, starts[i] + m.index);
          from = m.index + 1;
        }
      }
    }
  }
  return out;
}

interface Unit { from: number; to: number; masked: string; held: string[]; src: Lang }

/**
 * Translates Markdown text to `to`: prose lines, headings, list items and table cells go to `run` (one batch per source
 * language); code, links, mentions, tokens, glossary terms and code-like words never do. A block whose reply loses or
 * repeats a placeholder keeps its original text. `from` is the language most translated blocks were in.
 */
export async function translateMarkdown(text: string, to: Lang, opts: TranslateOptions): Promise<{ text: string; from: Lang | null }> {
  const units: Unit[] = [];
  for (const [from, end] of proseRanges(text)) {
    const m = mask(text.slice(from, end), opts.glossary, to);
    if (!m || !/\p{L}/u.test(m.masked.replace(PH_RE, ''))) continue;
    const src = detectLang(m.masked.replace(PH_RE, ' ')) ?? opts.fallback;
    if (src && src !== to) units.push({ from, to: end, ...m, src });
  }
  const done: { unit: Unit; text: string }[] = [];
  const counts: Record<Lang, number> = { en: 0, it: 0 };
  for (const src of LANGS) {
    const group = units.filter((u) => u.src === src);
    if (!group.length) continue;
    const outs = await opts.run(group.map((u) => u.masked), src, to);
    if (!Array.isArray(outs) || outs.length !== group.length) continue;
    group.forEach((u, i) => {
      const t = typeof outs[i] === 'string' ? unmask(outs[i], u.held) : null;
      if (t === null) return;
      done.push({ unit: u, text: t });
      counts[src]++;
    });
  }
  let result = text;
  for (const d of done.sort((a, b) => b.unit.from - a.unit.from)) result = result.slice(0, d.unit.from) + d.text + result.slice(d.unit.to);
  const from: Lang | null = counts.en === 0 && counts.it === 0 ? null : counts.it >= counts.en ? 'it' : 'en';
  return { text: result, from };
}

// ---- A Lore entry's text outside its body ----

/** Where a piece of an entry's text sits: a text field, a lines/steps item, or a table cell. */
export const pieceKey = {
  field: (key: string) => `f:${key}`,
  item: (blockId: string, i: number) => `b:${blockId}:${i}`,
  cell: (blockId: string, r: number, c: number) => `b:${blockId}:${r}:${c}`,
};
/** Pieces with no letters ("12", "1–3") or a number with a short unit ("3.5 kg") stay as written. */
const NUMBERISH = /^[^\p{L}]*$|^\s*[-+]?[\d.,]+\s*\p{L}{0,3}\s*$/u;

/**
 * The words of an entry kept outside its Markdown body, by pieceKey: its text and longtext field values (`textFields`:
 * those fields' keys) and the items and cells of its lines, steps and table blocks. Empty and number-like pieces are
 * left out. Translated as kind 'fields': the row's text is a JSON object of pieceKey -> [source, translation].
 */
export function entryPieces(
  fields: Record<string, unknown> | null | undefined, textFields: readonly string[],
  layout: { blocks: { id: string; kind: string }[]; data: Record<string, { items?: string[]; rows?: string[][] }> } | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (typeof v === 'string' && v.trim() && !NUMBERISH.test(v)) out[k] = v; };
  for (const k of textFields) put(pieceKey.field(k), fields?.[k]);
  for (const b of layout?.blocks ?? []) {
    const d = layout!.data[b.id];
    if (b.kind === 'lines' || b.kind === 'steps') d?.items?.forEach((v, i) => put(pieceKey.item(b.id, i), v));
    if (b.kind === 'table') d?.rows?.forEach((row, r) => row.forEach((v, c) => put(pieceKey.cell(b.id, r, c), v)));
  }
  return out;
}

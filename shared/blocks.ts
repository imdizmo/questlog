// Wiki blocks: a type's template is a page of blocks, and an entry's page is laid out by them (redesign decisions 9–11).
// Markdown stays the stored text: a text block is the entry's `## title` section; typed blocks (tables, lines, models...)
// keep their data in the entry's layout. Entries with no layout of their own follow their type's page at view time, so
// nothing is migrated. Pure functions, shared by server and web.
import type { Block, BlockData, BlockKind, Card, EntryLayout, EntryType, TypePage } from './types';
import { sectionsOf, typeChain } from './wiki';

export type { Block, BlockData, BlockKind, EntryLayout, TypePage };

export const BLOCK_KINDS: readonly BlockKind[] = ['text', 'facts', 'model', 'picture', 'map', 'lines', 'steps', 'table', 'links', 'gallery'];
/** The "+ Add block" menu's words (the redesign preview's BLOCK_KINDS). */
export const BLOCK_LABELS: Record<BlockKind, string> = {
  text: 'Text', facts: 'Facts (the fields)', model: 'Model from Asset Shelf', picture: 'Picture', map: 'Map from Groundwork',
  lines: 'Lines (barks)', steps: 'Steps', table: 'Table', links: 'Links to entries', gallery: 'Pictures in a row',
};
/** What a guided start asks about, one step per block. */
export const ASKED: ReadonlySet<BlockKind> = new Set(['text', 'lines', 'steps']);

/** Caps of a page and of an entry's block data (the server refuses more; they bound what is held and drawn). */
export const BLOCK_LIMITS = {
  blocksPerPage: 40, titleChars: 80, promptChars: 500, cols: 12, colChars: 80,
  items: 200, itemChars: 2000, rows: 200, cellChars: 2000, links: 50, pictures: 12, layoutBytes: 64 * 1024,
} as const;

/** Writing prompts of the starter pack's headings: grey text an empty block shows until someone writes over it. */
export const GAME_PROMPTS: Record<string, string> = {
  'Where the player meets them': 'The zone and the spot, and the moment they first show up.', 'What they do for the player': 'The quests, trades or training they offer, and what the player needs first.',
  Dialogue: 'Their first line, and how they talk after that.', Look: 'Silhouette and colours, so the player knows them from far away.',
  Attacks: 'Each attack: the wind-up, the damage, and how the player sees it coming.', 'How to beat it': 'The counter a new player should find on their own.',
  'Drops and taming': 'What it leaves behind, and whether it can be tamed, and with what.',
  'How to get it': 'Made, looted, bought or found: where, and how early in the game.', 'What it is for': 'Why a player wants it, and what it replaces.',
  Steps: 'Each step in a line, as the player does it.', 'What the player learns': 'The mechanic or the place this quest teaches.', 'Rewards and what opens next': 'Items, and the quests or zones it opens.',
  Layout: 'How the player gets in, the main paths, and where they lead.', 'What spawns here': 'Which creatures, how many, and when (day, night, fog).',
  Resources: 'What can be gathered here, and how much.', Landmarks: 'What the player sees from far away and steers by.',
  'How they treat the player': 'Friendly, wary or hostile, and what changes that.', 'Where they are': 'Their camps and the zones they hold.',
  Appearance: 'What someone notices first, and what they notice only later.', History: 'Where they come from, and the one event that shaped them.',
  'What they want': 'Right now, more than anything, they want…', Voice: 'How they talk: a phrase they always use.',
  Behaviour: 'What it does when it sees the player, and when it is hurt.', Lore: 'What the people of the world say about it.',
  'What happens': 'The steps of the quest, as the player lives them.', 'Why it matters': 'What changes in the world once it is done.',
  'Look and feel': 'Light, sound and weather: what the player feels on arrival.', 'Who lives here': 'Who you meet, and who you never see.',
  'How they treat outsiders': 'What happens to a stranger who walks in.', 'What happened': 'The event, told in a few lines.', 'What it changed': 'What is different since.',
  Premise: 'The story in two sentences.',
};
export const DEFAULT_PROMPT = 'A few lines.';

/** A new block id: short, lowercase letters and digits (the server's id rule). */
export const newBlockId = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/** A block as "+ Add block" makes it (the preview's defaults: prose and lists full width, pictures and facts half). */
export function newBlock(kind: BlockKind, id = newBlockId()): Block {
  const title = kind === 'text' ? 'New section' : BLOCK_LABELS[kind].replace(/ from .*| \(.*\)/, '');
  const width = kind === 'facts' || kind === 'model' || kind === 'picture' || kind === 'map' ? 'half' : 'full';
  const b: Block = { id, kind, title, width };
  if (kind === 'text') b.prompt = DEFAULT_PROMPT;
  if (kind === 'lines') b.prompt = 'One short line each.';
  if (kind === 'steps') b.prompt = 'One step each.';
  if (kind === 'table') b.cols = ['Name', 'Amount'];
  if (kind === 'links') b.to = '';
  return b;
}

// ---- Sections of the markdown ----

/** A `## heading` section of an entry's body: the heading, its raw line, its text (lines after it), where it is. */
export interface Section { heading: string; raw: string; text: string; /** Line of the heading in the body. */ line: number; /** Line after its last. */ end: number }
export interface Sections { intro: string; sections: Section[]; /** Lines of the body. */ lines: number }

const HEADING = /^ {0,3}##[ \t]+(.*?)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A closing fence is fence characters only (CommonMark): a line with an info string never closes one. */
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** The key a heading is matched by: any case, runs of spaces as one, closing #s dropped. */
export const headingKey = (h: string): string => h.replace(/[ \t]+#+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The body (the text after the title line) cut at its `##` headings; a `##` inside a fenced code block is no heading. */
export function splitSections(body: string): Sections {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence !== null) {
      const c = CLOSE.exec(lines[i]);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = FENCE.exec(lines[i]);
    if (f) { fence = f[1]; continue; }
    const h = HEADING.exec(lines[i]);
    if (!h || !h[1].replace(/#+$/, '').trim()) continue;
    if (sections.length) sections[sections.length - 1].end = i;
    sections.push({ heading: h[1].replace(/[ \t]+#+$|^#+$/, '').trim(), raw: lines[i], text: '', line: i, end: lines.length });
  }
  for (const s of sections) s.text = lines.slice(s.line + 1, s.end).join('\n');
  const introEnd = sections.length ? sections[0].line : lines.length;
  return { intro: lines.slice(0, introEnd).join('\n'), sections, lines: lines.length };
}

/** splitSections back into the body, exactly. */
export function joinSections(s: Sections): string {
  if (!s.sections.length) return s.intro;
  const out: string[] = s.sections[0].line > 0 ? s.intro.split('\n') : [];
  for (const x of s.sections) {
    out.push(x.raw);
    if (x.end - x.line - 1 > 0) out.push(...x.text.split('\n'));
  }
  return out.join('\n');
}

/** The body of a card's content: what follows the title line and the blank lines after it (web splitTitle's body). */
export function bodyOf(content: string): { body: string; bodyStart: number } {
  const lines = content.split('\n');
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  return { body: lines.slice(i).join('\n'), bodyStart: Math.min(i, lines.length) };
}

// ---- Pages and layouts ----

/**
 * The page of a type that has none in its chain: Facts and Picture side by side, then a text block per heading (its
 * ancestors' first), with the starter prompts. Its ids are stable, so the same type gives the same page.
 */
export function derivedPage(types: Map<string, EntryType>, typeId: string): TypePage {
  const blocks: Block[] = [{ id: 'dfacts', kind: 'facts', title: 'Facts', width: 'half' }, { id: 'dpicture', kind: 'picture', title: 'Picture', width: 'half' }];
  sectionsOf(types, typeId).forEach((h, i) => blocks.push({ id: `dtext${i}`, kind: 'text', title: h, width: 'full', prompt: GAME_PROMPTS[h] ?? DEFAULT_PROMPT }));
  return { version: 0, guided: false, blocks };
}

/** The page a type's entries follow: its own, else its nearest ancestor's, else derived (owner null). */
export function pageOf(types: Map<string, EntryType>, typeId: string): { page: TypePage; owner: EntryType | null } {
  const chain = typeChain(types, typeId);
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].page) return { page: chain[i].page!, owner: chain[i] };
  return { page: derivedPage(types, typeId), owner: null };
}

/** An entry's layout: its own, else its type's page with no data yet. Untyped pages have no blocks. */
export function layoutOf(card: Pick<Card, 'entryTypeId' | 'layout'>, types: Map<string, EntryType>): EntryLayout {
  if (card.layout) return card.layout;
  if (!card.entryTypeId || !types.has(card.entryTypeId)) return { version: 0, owner: '', blocks: [], data: {} };
  const { page, owner } = pageOf(types, card.entryTypeId);
  return { version: page.version, owner: owner?.id ?? '', blocks: page.blocks, data: {} };
}

/** Is a stored layout older than its type's page: from another owner (another type's page, or the headings), or an older version? */
export const isOutdated = (layout: EntryLayout, page: TypePage, ownerId: string): boolean =>
  (layout.owner ?? '') !== ownerId || layout.version < page.version;

/**
 * The layout as drawn: a Facts block is added at the end when it has none and the entry holds field values, so values
 * never vanish from the page (a template without Facts, or one an entry was brought up to).
 */
export function withFacts(layout: EntryLayout, hasValues: boolean): EntryLayout {
  if (!hasValues || layout.blocks.some((b) => b.kind === 'facts')) return layout;
  return { ...layout, blocks: [...layout.blocks, { id: 'xfacts', kind: 'facts', title: 'Facts', width: 'full' }] };
}

/** Does a block hold something written (text blocks: see their section)? */
export function hasData(kind: BlockKind, d: BlockData | undefined): boolean {
  if (!d) return false;
  switch (kind) {
    case 'lines': case 'steps': return !!d.items?.length;
    case 'table': return !!d.rows?.length;
    case 'links': return !!d.cardIds?.length;
    case 'gallery': return !!d.assetIds?.length;
    case 'model': case 'picture': case 'map': return !!d.assetId;
    default: return false;
  }
}

export interface Placed { block: Block; section: Section | null; /** A section no text block names: shown after the blocks. */ extra: boolean }

/**
 * The entry's blocks with their text: each text block takes the first section of the same heading that is still free;
 * sections no block takes (unnamed ones, second copies) follow as extra text blocks, in their order. Nothing written is
 * left out: the intro (text before the first `##`) comes back too.
 */
export function placeBlocks(layout: EntryLayout, body: string): { intro: string; placed: Placed[] } {
  const { intro, sections } = splitSections(body);
  const free = sections.map(() => true);
  const placed: Placed[] = layout.blocks.map((block) => {
    if (block.kind !== 'text') return { block, section: null, extra: false };
    const key = headingKey(block.title);
    const i = sections.findIndex((s, j) => free[j] && headingKey(s.heading) === key);
    if (i < 0) return { block, section: null, extra: false };
    free[i] = false;
    return { block, section: sections[i], extra: false };
  });
  sections.forEach((s, i) => {
    if (free[i]) placed.push({ block: { id: `extra${i}`, kind: 'text', title: s.heading, width: 'full' }, section: s, extra: true });
  });
  return { intro, placed };
}

/** A table's columns as the rows use them: its own, then "Column n" for cells past them. */
function rowColumns(cols: string[], rows: string[][] | undefined): string[] {
  const need = Math.max(0, ...(rows ?? []).map((r) => r.length));
  const out = [...cols];
  for (let i = out.length; i < need; i++) out.push(`Column ${i + 1}`);
  return out;
}
const colKey = (c: string) => c.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A table's rows under new columns: each cell goes to the column of the same name (any case), whatever its place. Old
 * columns the new ones lack are added at the end, under their old names, when a row holds something in them; empty
 * cells there are let go. Nothing written is dropped.
 */
function remapTable(newCols: string[], oldCols: string[], rows: string[][]): { cols: string[]; rows: string[][] } {
  const old = rowColumns(oldCols, rows);
  const cols = [...newCols];
  const taken = new Set<number>();
  const from: number[] = cols.map((c) => {
    const i = old.findIndex((o, j) => !taken.has(j) && colKey(o) === colKey(c));
    if (i >= 0) taken.add(i);
    return i;
  });
  old.forEach((o, j) => {
    if (taken.has(j) || !rows.some((r) => (r[j] ?? '').trim())) return;
    cols.push(o);
    from.push(j);
  });
  return { cols, rows: rows.map((r) => from.map((j) => (j < 0 ? '' : r[j] ?? ''))) };
}

/**
 * "Bring up to date": the template's blocks in its order and widths (titles, prompts and columns too), each keeping
 * the entry's data by block id; then the entry's blocks the template no longer has, when they hold something (data, a
 * written section, or Facts when the template has none: its values are the entry's fields). Never removes written
 * content: the markdown is not touched, no kept block loses data, and a table's cells move with their column's name.
 * `owner`: the type whose page it is ('' for one made from headings).
 */
export function bringUpToDate(layout: EntryLayout, page: TypePage, body: string, owner: string): EntryLayout {
  const oldById = new Map(layout.blocks.map((b) => [b.id, b]));
  const written = new Set(splitSections(body).sections.filter((s) => s.text.trim()).map((s) => headingKey(s.heading)));
  const inPage = new Set(page.blocks.map((b) => b.id));
  const pageFacts = page.blocks.some((b) => b.kind === 'facts');
  const blocks: Block[] = page.blocks.map((b) => ({ ...b }));
  for (const b of layout.blocks) {
    if (inPage.has(b.id)) continue;
    if (hasData(b.kind, layout.data[b.id]) || (b.kind === 'facts' && !pageFacts) || (b.kind === 'text' && written.has(headingKey(b.title)))) blocks.push({ ...b });
  }
  const data: Record<string, BlockData> = {};
  for (const b of blocks) {
    const d = layout.data[b.id];
    if (b.kind === 'table') {
      const was = oldById.get(b.id);
      const rows = d?.rows && was?.kind === 'table' ? d.rows : undefined;
      const t = remapTable(b.cols ?? [], was?.cols ?? b.cols ?? [], rows ?? []);
      b.cols = t.cols;
      if (rows) data[b.id] = { ...d, rows: t.rows };
      else if (d) data[b.id] = d;
    } else if (d) data[b.id] = d;
  }
  return { version: page.version, owner, blocks, data };
}

/**
 * A new entry's text and block data from its page: `# name`, then a `## title` per text block (with its answer under
 * it), and the lines and steps answered, one item per non-empty line. `answers` are by block id (a guided start).
 */
export function newEntryContent(name: string, page: TypePage, answers: Record<string, string> = {}): { content: string; data: Record<string, BlockData> } {
  const parts = [`# ${name}`];
  const data: Record<string, BlockData> = {};
  for (const b of page.blocks) {
    const a = (answers[b.id] ?? '').trim();
    if (b.kind === 'text') { parts.push(`## ${b.title}`); if (a) parts.push(a); }
    if (b.kind === 'lines' || b.kind === 'steps') {
      const items = a.split('\n').map((l) => l.trim()).filter(Boolean);
      if (items.length) data[b.id] = { items };
    }
  }
  return { content: parts.join('\n\n'), data };
}

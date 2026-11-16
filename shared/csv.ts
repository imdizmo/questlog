/** CSV import helpers: an RFC 4180 parser and the guesses that pre-fill the mapping screen. Pure; used by the browser and the server. */

/** The preview parses at most this many rows (header included), so a huge file cannot fill memory. */
export const MAX_PREVIEW_ROWS = 50001;

const DELIMITERS = [',', ';', '\t'] as const;

/** The delimiter used most on the first record (quoted text ignored); a comma when none appears. */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Parses CSV text into rows of fields. The delimiter (comma, semicolon or tab) is detected from the first line;
 * quoted fields may hold the delimiter, newlines and doubled quotes; a leading BOM is dropped; blank lines are
 * skipped. Stops after MAX_PREVIEW_ROWS rows.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false; // inside quotes
  let wasQuoted = false; // this field started with a quote
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && field === '' && !wasQuoted)) rows.push(row);
    row = []; field = ''; wasQuoted = false;
  };
  for (let i = 0; i < text.length && rows.length < MAX_PREVIEW_ROWS; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\r') { if (text[i + 1] !== '\n') field += '\n'; } // CRLF inside a field becomes LF
      else if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (ch === '"' && field === '' && !wasQuoted) { quoted = true; wasQuoted = true; }
    else if (ch === delim) { row.push(field); field = ''; wasQuoted = false; }
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else field += ch;
  }
  if (rows.length < MAX_PREVIEW_ROWS && (field !== '' || wasQuoted || row.length > 0)) endRow();
  return rows;
}

/** Splits parsed rows into headers and data rows, dropping every column that is empty in all rows. */
export function columnsOf(rows: string[][]): { headers: string[]; rows: string[][] } {
  if (rows.length === 0) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  const keep: number[] = [];
  for (let c = 0; c < width; c++) if (rows.some((r) => (r[c] ?? '').trim() !== '')) keep.push(c);
  return { headers: keep.map((c) => rows[0][c] ?? ''), rows: rows.slice(1).map((r) => keep.map((c) => r[c] ?? '')) };
}

export type CsvField = 'title' | 'content' | 'status' | 'priority' | 'effort' | 'tags' | 'owner';
export type CsvMapping = Record<CsvField, number | null>;

const HEADER_NAMES: Record<CsvField, string[]> = {
  title: ['title', 'name', 'summary', 'card', 'card title', 'quest', 'quest title'],
  content: ['content', 'description', 'body', 'details', 'text', 'notes'],
  status: ['status', 'state', 'stage'],
  priority: ['priority', 'prio', 'importance'],
  effort: ['effort', 'xp', 'estimate', 'points', 'story points', 'size'],
  tags: ['tags', 'tag', 'labels', 'label'],
  owner: ['owner', 'assignee', 'assigned to', 'assigned', 'user'],
};

/** Matches each field to the first column whose header names it (case and punctuation ignored); a column is used once. */
export function autoMap(headers: string[]): CsvMapping {
  const norm = headers.map((h) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  const out: CsvMapping = { title: null, content: null, status: null, priority: null, effort: null, tags: null, owner: null };
  const taken = new Set<number>();
  for (const f of Object.keys(HEADER_NAMES) as CsvField[]) {
    const i = norm.findIndex((h, k) => !taken.has(k) && HEADER_NAMES[f].includes(h));
    if (i >= 0) { out[f] = i; taken.add(i); }
  }
  return out;
}

/** What an imported card's status column value becomes. */
export type StatusChoice = 'default' | 'started' | 'done' | 'doc' | 'archived';
const lc = (v: string) => v.trim().toLowerCase();

export function guessStatus(value: string): StatusChoice {
  const v = lc(value);
  if (['done', 'complete', 'completed', 'closed', 'finished', 'resolved'].includes(v)) return 'done';
  if (['started', 'in progress', 'in-progress', 'doing', 'wip', 'active'].includes(v)) return 'started';
  if (['archived', 'archive'].includes(v)) return 'archived';
  if (['doc', 'document', 'docs', 'lore'].includes(v)) return 'doc';
  return 'default';
}

/** 'a' is the highest priority; null means none. */
export function guessPriority(value: string): 'a' | 'b' | 'c' | null {
  const v = lc(value);
  if (['high', 'highest', 'urgent', 'critical', 'a', '1'].includes(v)) return 'a';
  if (['medium', 'normal', 'mid', 'b', '2'].includes(v)) return 'b';
  if (['low', 'lowest', 'minor', 'c', '3'].includes(v)) return 'c';
  return null;
}

/** The effort in the cell times the scale factor; null when it is not a non-negative number. */
export function parseEffort(value: string, factor: number): number | null {
  const t = value.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  const r = Math.round(n * factor * 10000) / 10000;
  return Number.isFinite(r) && r >= 0 ? r : null;
}

/** Project tag names are lowercase letters, digits, `_` and `-`, up to 32. Returns null when nothing is left. */
export function normalizeTagName(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 32);
  return n === '' ? null : n;
}

/** The tag names in one cell (comma, semicolon or pipe separated), as written. */
export const splitTags = (cell: string): string[] => cell.split(/[,;|]/).map((t) => t.trim()).filter((t) => t !== '');

export interface CsvMember { id: string; name: string; email: string }

/** The member an owner cell most likely means: email, full name, then a unique first name or name prefix. */
export function guessOwner(value: string, members: CsvMember[]): string | null {
  const v = lc(value);
  if (v === '') return null;
  const byEmail = members.find((m) => lc(m.email) === v);
  if (byEmail) return byEmail.id;
  const byName = members.find((m) => lc(m.name) === v);
  if (byName) return byName.id;
  const loose = members.filter((m) => lc(m.name).startsWith(v) || lc(m.name).split(/\s+/).includes(v) || lc(m.email).startsWith(v + '@'));
  return loose.length === 1 ? loose[0].id : null;
}

/** Card content from the mapped title and content cells (null: column not mapped). Both: `# title`, blank line, content. */
export function buildContent(title: string | null, content: string | null): string {
  if (title === null) return content ?? '';
  if (content === null) return title;
  return content.trim() === '' ? `# ${title}` : `# ${title}\n\n${content}`;
}

/** Mirrors the server's assignee rule: enabled, non-observer, and able to view the project (admins always; members when it is fully visible or they have access). */
export function assignableFor(
  users: { id: string; name: string; email: string; disabled: boolean; role: string | null; hasAccess: boolean }[],
  visibility: 'full' | 'limited' | null,
): CsvMember[] {
  return users.filter((u) => {
    if (u.disabled || !u.role || u.role === 'observer') return false;
    if (visibility === null || u.role === 'owner' || u.role === 'admin') return true;
    return visibility === 'full' || u.hasAccess;
  }).map(({ id, name, email }) => ({ id, name, email }));
}

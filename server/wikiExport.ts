/**
 * The game-data export of a campaign's wiki (`GET /api/wiki/:projectId/export`, spec "JSON export"):
 * `{format, version, campaign, exportedAt, types, linkKinds, entries, links, checks}`, in that key order, then
 * `checksTotal` and `checksTruncated: true` when the checks list was cut at CHECKS_LIMIT.
 *
 * What the game can rely on: every value, reference and link present is valid. Values that fail validateValue, image
 * values that are not an attachment of their owner, links to missing, wrong-type or (without includePages) plain
 * entries, and invalid link props are left out. `checks` is runChecks, the definition the Wiki's badge uses, so each
 * such omission is listed there. Links that touch a trashed entry are left out silently (spec), and are not checked.
 * Ruling: hidden and unknown values, and a parent page that is not exported, are left out without a check (a hidden
 * field is retired on purpose). `works_on` links tie quests to entries: dev-task data, not game data, so they are
 * neither exported nor checked here.
 *
 * Memory: EXPORT_LIMITS caps rows and bytes before anything is parsed. One light pass holds the keys, types and field
 * values of the exported entries (no text) plus the links, for the checks; the links are then released. Entries are
 * written per type, their text read row by row, and links source by source, row by row. Nothing is held
 * as a whole document: `out` gets the JSON in pieces.
 */
import type { Db } from './db';
import { AppError } from './errors';
import { fieldsOf, isTypeOrChild, refContext, runChecks, validateValue, WORKS_ON, type ChecksResult, type RefContext, type WikiData } from '../shared/wiki';
import { titleOf } from '../shared/cards';
import type { EntryLink, EntryType, FieldDef, LinkKind } from '../shared/types';
import { toCamel } from './db';

/** Caps of one export (413 too_large over them). Mutable for tests only. */
export const EXPORT_LIMITS = {
  maxEntries: 50_000,
  maxLinks: 200_000,
  /** Bytes of the typed entries' field values + exported text + link props (128 MB): bounds the parse, the heap and the file. */
  maxBytes: 128 * 1024 * 1024,
};

export interface ExportOptions { strict: boolean; includePages: boolean }

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** A field or link property definition as the game sees it: the spec's keys, null where unset. */
const fieldOut = (f: FieldDef) => ({
  key: f.key, kind: f.kind, required: !!f.required, min: f.min ?? null, max: f.max ?? null, options: f.options ?? null, target: f.target ?? null,
});

/** The entry's free text: its content after the title line. */
function textOf(content: string): string {
  const nl = content.indexOf('\n');
  return nl < 0 ? '' : content.slice(nl + 1).replace(/^(\s*\n)+/, '').trimEnd();
}

/** A campaign's live (not deleted) Lore cards, as `FROM … WHERE` over alias c, bound to the project id. */
const LORE = "FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.is_doc=1 AND c.visibility!='deleted'";

/** `,"checksTotal":N,"checksTruncated":true` when the list was cut at CHECKS_LIMIT, else nothing. */
export const checksTail = (r: ChecksResult): string => (r.total > r.checks.length ? `,"checksTotal":${r.total},"checksTruncated":true` : '');

export function writeWikiExport(db: Db, projectId: string, opts: ExportOptions, out: (chunk: string) => void): ChecksResult {
  const project = db.prepare('SELECT id, name FROM projects WHERE id=?').get(projectId) as { id: string; name: string } | undefined;
  if (!project) throw new AppError(404, 'not_found');

  const types = (db.prepare('SELECT * FROM entry_types WHERE project_id=? ORDER BY sort_index, created_at, id').all(projectId) as Record<string, unknown>[])
    .map((r) => toCamel<EntryType>(r));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const kinds = (db.prepare('SELECT * FROM link_kinds WHERE project_id=? ORDER BY created_at, key').all(projectId) as Record<string, unknown>[])
    .map((r) => toCamel<LinkKind>(r));
  const kindByKey = new Map(kinds.map((k) => [k.key, k]));

  // Caps first, before anything is loaded or parsed: rows, and bytes (field values parsed for the checks, link props,
  // and the exported text). An entry whose type is gone counts as a plain page.
  const typedSql = 'c.entry_type_id IN (SELECT id FROM entry_types WHERE project_id=?)';
  const size = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${typedSql} THEN length(CAST(c.fields_json AS BLOB)) END), 0)
      + COALESCE(SUM(length(CAST(c.content AS BLOB))), 0) bytes ${LORE}${opts.includePages ? '' : ` AND ${typedSql}`}`)
    .get(...(opts.includePages ? [projectId, projectId] : [projectId, projectId, projectId])) as { n: number; bytes: number };
  const links0 = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(length(CAST(props_json AS BLOB))), 0) bytes FROM entry_links WHERE project_id=? AND kind_key!=?')
    .get(projectId, WORKS_ON) as { n: number; bytes: number };
  if (size.n > EXPORT_LIMITS.maxEntries || links0.n > EXPORT_LIMITS.maxLinks || size.bytes + links0.bytes > EXPORT_LIMITS.maxBytes) {
    throw new AppError(413, 'too_large', { maxEntries: EXPORT_LIMITS.maxEntries, maxLinks: EXPORT_LIMITS.maxLinks, maxBytes: EXPORT_LIMITS.maxBytes });
  }

  // ---- The light pass: keys, types and values of the exported entries, and the links, for runChecks and refContext. ----
  // runChecks gets includePages as given: without it a link or reference to a plain page is a broken_ref, left out and
  // listed, like any other target missing from the file. Plain pages are then read only when a link touches them (id
  // and key), so the checks can name them; their count is bounded by the links cap.
  type Light = WikiData['entries'][number];
  const lore: Light[] = [];
  const fileOf = db.prepare('SELECT id, name FROM files WHERE id=? AND card_id=?');
  const linkEnds = `c.id IN (SELECT from_card_id FROM entry_links WHERE project_id=? AND kind_key!=? UNION SELECT to_card_id FROM entry_links WHERE project_id=? AND kind_key!=?)`;
  const lightSql = opts.includePages ? LORE : `${LORE} AND (${typedSql} OR ${linkEnds})`;
  const lightArgs = opts.includePages ? [projectId] : [projectId, projectId, projectId, WORKS_ON, projectId, WORKS_ON];
  for (const r of db.prepare(`SELECT c.id, c.entry_type_id t, c.entry_key k, c.fields_json f ${lightSql}`).iterate(...lightArgs) as Iterable<{ id: string; t: string | null; k: string | null; f: string }>) {
    const typed = !!r.t && typeById.has(r.t);
    lore.push({ id: r.id, entryTypeId: r.t, entryKey: r.k, fields: typed ? JSON.parse(r.f) as Record<string, unknown> : {}, visibility: 'default', content: '' });
  }
  // Links whose two ends are live, as the snapshot holds them: a link to a trashed entry is left out silently (spec),
  // so the export lists the same checks as the Wiki's badge.
  let links: EntryLink[] | null = (db.prepare(`SELECT l.* FROM entry_links l JOIN cards a ON a.id=l.from_card_id JOIN cards b ON b.id=l.to_card_id
    WHERE l.project_id=? AND l.kind_key!=? AND a.visibility!='deleted' AND b.visibility!='deleted'`).all(projectId, WORKS_ON) as Record<string, unknown>[])
    .map((r) => toCamel<EntryLink>(r));
  const result = runChecks({ types, kinds, entries: lore, links, includePages: opts.includePages, isAttached: (file, card) => !!fileOf.get(file, card) });
  links = null;
  if (opts.strict && result.total > 0) return result;

  const inFile = (e: Light) => (!!e.entryTypeId && typeById.has(e.entryTypeId)) || opts.includePages;
  const ctx: RefContext = refContext(typeById, lore.filter(inFile));
  /** Exported entries that can be referenced (they have a key): id → key and type id. */
  const index = new Map<string, { key: string; typeId: string | null }>();
  const valuesOf = new Map<string, Record<string, unknown>>();
  for (const e of lore) {
    const typed = !!e.entryTypeId && typeById.has(e.entryTypeId);
    if (typed) valuesOf.set(e.id, e.fields);
    if (inFile(e) && e.entryKey) index.set(e.id, { key: e.entryKey, typeId: typed ? e.entryTypeId : null });
  }
  lore.length = 0;

  /** The value as the game gets it, or undefined when it is empty or invalid (the checks list the invalid ones). */
  const valueOut = (def: FieldDef, v: unknown, cardId: string): unknown => {
    if (isEmpty(v) || validateValue(def, v, ctx) !== null) return undefined;
    if (def.kind === 'image') {
      const f = fileOf.get(v as string, cardId) as { id: string; name: string } | undefined;
      return f ? { file: f.name, url: `/api/files/${encodeURIComponent(f.id)}` } : undefined;
    }
    if (def.kind === 'range') { const r = v as { min: number; max: number }; return { min: r.min, max: r.max }; }
    return v;
  };
  const valuesOut = (defs: FieldDef[], values: Record<string, unknown> | undefined, cardId: string) => {
    const o: Record<string, unknown> = {};
    for (const def of defs) {
      const v = valueOut(def, values?.[def.key], cardId);
      if (v !== undefined) o[def.key] = v;
    }
    return o;
  };

  // ---- Header, types, link kinds ----
  out(`{"format":"questlog-gamedata","version":1,"campaign":${JSON.stringify({ id: project.id, name: project.name })},"exportedAt":${JSON.stringify(new Date().toISOString())}`);
  out(`,"types":${JSON.stringify(types.map((t) => ({
    key: t.key, name: t.name, parent: t.parentTypeId ? typeById.get(t.parentTypeId)?.key ?? null : null,
    fields: t.fields.filter((f) => !f.hidden).map(fieldOut),
  })))}`);
  out(`,"linkKinds":${JSON.stringify(kinds.map((k) => ({
    key: k.key, label: k.label, reverseLabel: k.reverseLabel, from: k.fromTypes, to: k.toTypes, props: k.props.filter((p) => !p.hidden).map(fieldOut),
  })))}`);

  // ---- Entries, per type (then plain pages), text read row by row ----
  out(',"entries":[');
  let first = true;
  const writeEntries = (sql: string, args: unknown[], type: EntryType | null) => {
    const defs = type ? fieldsOf(typeById, type.id).filter((f) => !f.hidden) : [];
    const rows = db.prepare(`SELECT c.id, c.entry_key k, c.content, c.tags_json tags, c.wiki_parent_id p ${LORE} AND ${sql} ORDER BY c.entry_key, c.seq`)
      .iterate(projectId, ...(args as string[])) as Iterable<{ id: string; k: string | null; content: string; tags: string; p: string | null }>;
    for (const r of rows) {
      const e = {
        id: r.id, key: r.k, type: type?.key ?? null, name: titleOf(r.content), parent: r.p ? index.get(r.p)?.key ?? null : null,
        tags: JSON.parse(r.tags) as string[], fields: type ? valuesOut(defs, valuesOf.get(r.id), r.id) : {}, text: textOf(r.content),
      };
      valuesOf.delete(r.id);
      out(`${first ? '' : ','}\n${JSON.stringify(e)}`);
      first = false;
    }
  };
  for (const t of types) writeEntries('c.entry_type_id=?', [t.id], t);
  if (opts.includePages) writeEntries(`(c.entry_type_id IS NULL OR NOT ${typedSql})`, [projectId], null);
  valuesOf.clear();
  out('],"links":[');

  // ---- Links, source by source (idx_links_from), grouped by kind so `order` counts within each group ----
  // One indexed lookup per exported source, rows streamed: linear in the links. The unary + keeps SQLite on
  // idx_links_from: on idx_links_kind (project_id) every lookup would scan the whole campaign's links.
  first = true;
  const fromSource = db.prepare(`SELECT id, kind_key, from_card_id, to_card_id, props_json, sort_index FROM entry_links
    WHERE from_card_id=? AND +project_id=? AND +kind_key!=? ORDER BY kind_key, sort_index, id`);
  const fits = (typeId: string | null, allowed: string[]) => (typeId ? isTypeOrChild(typeById, typeId, allowed) : allowed.length === 0);
  for (const fromId of [...index.keys()].sort()) {
    const from = index.get(fromId)!;
    let kindKey = '';
    let order = 0;
    for (const r of fromSource.iterate(fromId, projectId, WORKS_ON) as Iterable<Record<string, unknown>>) {
      const l = toCamel<EntryLink>(r);
      const kind = kindByKey.get(l.kindKey);
      const to = index.get(l.toCardId);
      if (!kind || !to || !fits(from.typeId, kind.fromTypes) || !fits(to.typeId, kind.toTypes)) continue;
      order = l.kindKey === kindKey ? order + 1 : 0;
      kindKey = l.kindKey;
      const o = { kind: kind.key, from: from.key, to: to.key, props: valuesOut(kind.props.filter((p) => !p.hidden), l.props, l.fromCardId), order };
      out(`${first ? '' : ','}\n${JSON.stringify(o)}`);
      first = false;
    }
  }
  out(`],"checks":${JSON.stringify(result.checks)}${checksTail(result)}}\n`);
  return result;
}

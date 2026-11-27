// Game wiki, Part 1: entry types and link kinds of a project (project). Editing them is a project setting
// (project.manage); keys are set on creation and never change; fields and link properties are hidden, never removed.
import { z } from 'zod';
import { newId, toCamel, type Db } from '../db';
import { AppError } from '../errors';
import { assertCan } from '../permissions';
import type { Command, Ctx } from '../dispatch';
import { entryChange, recordHistory } from '../history';
import { assertNotDeleted, createCard, emitCard, loadCard } from './cards';
import { deckCommands } from './decks';
import { cardRow, deckRow, entryLinkRow } from './rows';
import { canSeeCard } from '../access';
import { titleOf } from '../../shared/cards';
import { ALIAS_LIMITS, MIN_NAME_CHARS, cleanName, nameKey } from '../../shared/autolink';
import { KEY_RE, WORKS_ON, fieldsOf, hasCycle, isTypeOrChild, keyFromName, refContext, typeChain, validateValue, type RefContext } from '../../shared/wiki';
import type { EntryFamily, EntryLink, EntryType, FieldDef, FieldKind, LinkKind, TypePicture } from '../../shared/types';
import { CORE_FIELDS, STARTER_FAMILIES, STARTER_KINDS, STARTER_PAGES, STARTER_TYPES, isPreviousCore, keysUnder } from '../../shared/templates/gameStarterPack';
import { coverRow, releaseCover } from '../covers';
import { touchTranslation } from '../translate/queue';
import { BLOCK_KINDS, BLOCK_LIMITS, DEFAULT_PROMPT, hasData, GAME_PROMPTS, bodyOf, bringUpToDate, headingKey, isOutdated, newEntryContent, pageOf } from '../../shared/blocks';
import type { Block, BlockData, EntryLayout, TypePage } from '../../shared/types';

export const WIKI_LIMITS = {
  typesPerProject: 200, familiesPerProject: 50, fieldsPerType: 100, linkKindsPerProject: 200, propsPerLinkKind: 20, linksPerEntry: 500, linkPropsBytes: 4 * 1024, listBytes: 64 * 1024, entryFieldsBytes: 64 * 1024, pruneBatch: 500,
} as const;

const FIELD_KINDS = ['text', 'longtext', 'number', 'integer', 'boolean', 'enum', 'multienum', 'entry', 'entries', 'image', 'color', 'range', 'table', 'rule', 'scenario'] as const satisfies readonly FieldKind[];
/** Fails to compile when FieldKind gains a kind this list lacks. */
type AllKindsListed<T extends never> = T;
export type _FieldKindsComplete = AllKindsListed<Exclude<FieldKind, (typeof FIELD_KINDS)[number]>>;

const keySchema = z.string().regex(KEY_RE);
const nameSchema = z.string().trim().min(1).max(200);
const fieldSchema = z.object({
  key: keySchema,
  label: nameSchema,
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  unit: z.string().max(32).optional(),
  options: z.array(z.string().min(1).max(200)).max(500).optional(),
  target: keySchema.optional(),
  help: z.string().max(2000).optional(),
  inTable: z.boolean().optional(),
  inInfobox: z.boolean().optional(),
  hidden: z.boolean().optional(),
}).refine((f) => f.min === undefined || f.max === undefined || f.min <= f.max, 'min above max');
/** Over-cap lists still parse, so the cap answers 409 limit; this bound only stops absurd payloads. */
const fieldListSchema = z.array(fieldSchema).max(1000);
/** Link properties: tables, rules and scenarios are entry fields only. */
const propListSchema = fieldListSchema.refine((l) => l.every((f) => f.kind !== 'table' && f.kind !== 'rule' && f.kind !== 'scenario'), 'tables, rules and scenarios are entry fields only');
const typeKeysSchema = z.array(keySchema).max(WIKI_LIMITS.typesPerProject);
const sumRuleSchema = z.object({ prop: keySchema, max: z.number().finite() });
const iconSchema = z.string().max(64).nullable();
const colorSchema = z.string().max(32).nullable();
const familyNameSchema = z.string().trim().min(1).max(80);
const familyColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** A type's picture: one of the painted styles, or an uploaded cover of the project (POST /api/covers). */
const pictureSchema = z.union([
  z.strictObject({ kind: z.literal('painted'), style: z.enum(['dusk', 'dawn', 'night', 'flat']) }),
  z.strictObject({ kind: z.literal('file'), fileId: z.string().min(1).max(100) }),
]).nullable();
/** Keys are immutable: an update that sends one is refused (400 invalid_payload) rather than silently ignored. */
const noKey = z.never().optional();

type Row<T> = T & { createdAt: number; updatedAt: number };
export const entryTypeRow = (db: Db, id: string): Row<EntryType> | undefined => {
  const r = db.prepare('SELECT * FROM entry_types WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r && toCamel(r);
};
export const linkKindRow = (db: Db, id: string): Row<LinkKind> | undefined => {
  const r = db.prepare('SELECT * FROM link_kinds WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r && toCamel(r);
};
export const entryFamilyRow = (db: Db, id: string): Row<EntryFamily> | undefined => {
  const r = db.prepare('SELECT * FROM entry_families WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return r && toCamel(r);
};
const projectFamilies = (db: Db, projectId: string): EntryFamily[] =>
  (db.prepare('SELECT * FROM entry_families WHERE project_id=? ORDER BY sort_index, created_at, id').all(projectId) as Record<string, unknown>[]).map((r) => toCamel<EntryFamily>(r));
const projectTypes = (db: Db, projectId: string): EntryType[] =>
  (db.prepare('SELECT * FROM entry_types WHERE project_id=?').all(projectId) as Record<string, unknown>[]).map((r) => toCamel<EntryType>(r));
const kindKeys = (db: Db, projectId: string): Set<string> =>
  new Set((db.prepare('SELECT key FROM link_kinds WHERE project_id=?').all(projectId) as { key: string }[]).map((r) => r.key));

function loadType(ctx: Ctx, id: string): Row<EntryType> {
  const t = entryTypeRow(ctx.db, id);
  if (!t) throw new AppError(404, 'not_found');
  assertCan(ctx.db, ctx.actor, 'project.manage', t.projectId);
  return t;
}
function loadFamily(ctx: Ctx, id: string): Row<EntryFamily> {
  const f = entryFamilyRow(ctx.db, id);
  if (!f) throw new AppError(404, 'not_found');
  assertCan(ctx.db, ctx.actor, 'project.manage', f.projectId);
  return f;
}

/** 400 unknown_family unless the family belongs to the project; 400 not_root when the type is a kind of another. */
function assertFamily(db: Db, familyId: string | null, projectId: string, parentTypeId: string | null): void {
  if (familyId === null) return;
  if (entryFamilyRow(db, familyId)?.projectId !== projectId) throw new AppError(400, 'unknown_family', { id: familyId });
  if (parentTypeId !== null) throw new AppError(400, 'not_root');
}

/** 400 bad_picture unless an uploaded picture is a cover of the same project. */
function assertPicture(db: Db, projectId: string, picture: TypePicture | null): void {
  if (picture?.kind === 'file' && coverRow(db, picture.fileId)?.projectId !== projectId) throw new AppError(400, 'bad_picture');
}
/** After a type's picture changed or the type went: its old upload goes once nothing points at it. */
function releasePicture(ctx: Ctx, old: TypePicture | null, next: TypePicture | null = null): void {
  if (old?.kind === 'file' && !(next?.kind === 'file' && next.fileId === old.fileId)) releaseCover(ctx, { kind: 'file', fileId: old.fileId });
}

/** 409 duplicate_name when another family of the project has this name (any case). */
function assertFamilyName(db: Db, projectId: string, name: string, exceptId = ''): void {
  if (db.prepare('SELECT 1 FROM entry_families WHERE project_id=? AND lower(name)=lower(?) AND id!=?').get(projectId, name, exceptId)) {
    throw new AppError(409, 'duplicate_name', { name });
  }
}

/** A new family at the end of the project's list, with every check. Returns its id. */
function insertFamily(ctx: Ctx, projectId: string, name: string, color: string): string {
  const { db } = ctx;
  assertCan(db, ctx.actor, 'project.manage', projectId);
  const list = projectFamilies(db, projectId);
  if (list.length >= WIKI_LIMITS.familiesPerProject) throw new AppError(409, 'limit', { max: WIKI_LIMITS.familiesPerProject });
  assertFamilyName(db, projectId, name);
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO entry_families (id,project_id,name,color,sort_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, projectId, name, color, (list.at(-1)?.sortIndex ?? 0) + 1, now, now);
  ctx.emit('entryFamily', 'upsert', entryFamilyRow(db, id)!);
  return id;
}

/**
 * Files the given root types (by key) into the starter pack's families, making a family (by name, any case) only when
 * it gets a type and the project is below the family cap (else those types stay in No family). A type that is a
 * kind, already has a family, or is not in the pack's families is left as it is.
 */
function fileStarterTypes(ctx: Ctx, projectId: string, keys: Set<string>): { familiesAdded: number; typesFiled: number } {
  const { db } = ctx;
  const types = projectTypes(db, projectId).filter((t) => keys.has(t.key) && t.parentTypeId === null && t.familyId === null);
  let familiesAdded = 0, typesFiled = 0;
  for (const sf of STARTER_FAMILIES) {
    const members = types.filter((t) => sf.types.includes(t.key));
    if (!members.length) continue;
    const list = projectFamilies(db, projectId);
    let fid = list.find((f) => f.name.toLowerCase() === sf.name.toLowerCase())?.id;
    if (!fid) {
      // At the cap the types stay in No family: filing is a convenience and never blocks adding the pack.
      if (list.length >= WIKI_LIMITS.familiesPerProject) continue;
      fid = insertFamily(ctx, projectId, sf.name, sf.color);
      familiesAdded++;
    }
    for (const t of members) {
      db.prepare('UPDATE entry_types SET family_id=?, updated_at=? WHERE id=?').run(fid, Date.now(), t.id);
      ctx.emit('entryType', 'upsert', entryTypeRow(db, t.id)!);
      typesFiled++;
    }
  }
  return { familiesAdded, typesFiled };
}

function loadKind(ctx: Ctx, id: string): Row<LinkKind> {
  const k = linkKindRow(ctx.db, id);
  if (!k) throw new AppError(404, 'not_found');
  assertCan(ctx.db, ctx.actor, 'project.manage', k.projectId);
  return k;
}

/**
 * 400 unknown_type unless every key names a type of the project. Keys in `before` (the stored value) pass unchecked:
 * a key left dangling by older data never blocks an unrelated save.
 */
function assertKnownTypes(known: Set<string>, keys: Iterable<string>, before: Iterable<string> = []): void {
  const kept = new Set(before);
  for (const key of keys) if (!known.has(key) && !kept.has(key)) throw new AppError(400, 'unknown_type', { key });
}

/** 413 too_large when a fields or props list would be stored above WIKI_LIMITS.listBytes. */
function assertListSize(list: FieldDef[]): void {
  if (Buffer.byteLength(JSON.stringify(list)) > WIKI_LIMITS.listBytes) throw new AppError(413, 'too_large', { maxBytes: WIKI_LIMITS.listBytes });
}

/**
 * A new field (or property) list against the old one: within the cap and size, keys unique, every old key still present
 * (hide it instead), entry targets known (a field that keeps its stored target is not re-checked).
 */
function checkFieldList(next: FieldDef[], old: FieldDef[], cap: number, typeKeys: Set<string>): void {
  if (next.length > cap) throw new AppError(409, 'limit', { max: cap });
  assertListSize(next);
  const keys = new Set<string>();
  for (const f of next) {
    if (keys.has(f.key)) throw new AppError(409, 'duplicate_key', { field: f.key });
    keys.add(f.key);
  }
  for (const f of old) if (!keys.has(f.key)) throw new AppError(409, 'field_removed', { field: f.key });
  const oldTarget = new Map(old.map((f) => [f.key, f.target]));
  assertKnownTypes(typeKeys, next.flatMap((f) => (f.target && f.target !== oldTarget.get(f.key) ? [f.target] : [])));
}

/** 409 duplicate_key when a type that inherits from `changedId` (or is it) would list a field key twice. */
function assertInheritedUnique(types: Map<string, EntryType>, changedId: string): void {
  for (const t of types.values()) {
    const chain = typeChain(types, t.id);
    if (!chain.some((c) => c.id === changedId)) continue;
    const seen = new Set<string>();
    for (const c of chain) {
      for (const f of c.fields) {
        if (seen.has(f.key)) throw new AppError(409, 'duplicate_key', { field: f.key, type: t.key });
        seen.add(f.key);
      }
    }
  }
}

/** The sum rule must name a visible number property of the kind. */
function checkSumRule(rule: LinkKind['sumRule'], props: FieldDef[]): void {
  if (!rule) return;
  const p = props.find((x) => x.key === rule.prop);
  if (!p || p.hidden || (p.kind !== 'number' && p.kind !== 'integer')) throw new AppError(400, 'invalid_payload', { field: 'sumRule' });
}

// ---- Entries: Lore cards of a project with a type, a key, field values and a parent page. ----

/** A field value: a JSON scalar, a list of scalars, or a {min,max} range. Whether it fits the type is for the checks. */
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const valueSchema = z.union([scalar, z.array(scalar), z.object({ min: z.number().finite(), max: z.number().finite() }).strict()]);
// Tables, rules and scenarios (entry fields only, not link props): the JSON shapes; limits, names and formulas are for
// the checks (shared/balance.ts), like every other value. The entry's fields byte cap bounds them.
const formulaText = z.string().max(100_000);
const namedSchema = z.strictObject({ name: z.string().max(200), formula: formulaText });
const rolesSchema = z.array(z.strictObject({ name: z.string().max(200), type: z.string().max(200) })).max(1000);
const tableSchema = z.strictObject({
  keys: z.array(z.strictObject({ field: z.string().max(200).optional(), values: z.union([z.array(z.string().max(200)), z.array(z.number().finite())]) })).min(1).max(2),
  mode: z.enum(['exact', 'step', 'linear']), cells: z.array(z.number().finite()),
});
const ruleSchema = z.strictObject({
  roles: rolesSchema, parts: z.array(namedSchema).max(1000), result: formulaText,
  examples: z.array(z.strictObject({ roles: z.record(z.string().max(200), z.string().max(200)), seed: z.number().int().min(0).max(0xffffffff) })).max(1000),
});
const scenarioSchema = z.strictObject({
  roles: rolesSchema, state: z.array(z.strictObject({ name: z.string().max(200), start: formulaText })).max(1000),
  clocks: z.array(z.strictObject({ name: z.string().max(200), every: formulaText, first: formulaText.optional(), do: z.array(namedSchema).max(1000) })).max(1000),
  end: formulaText, cap: z.number().finite(), measures: z.array(namedSchema).max(1000),
});
/** An entry field value: a link prop value, or a table, rule or scenario. */
const fieldValueSchema = z.union([valueSchema, tableSchema, ruleSchema, scenarioSchema]);
/** One line: it becomes the card's `# title`. */
const entryNameSchema = nameSchema.refine((s) => !/[\r\n]/.test(s), 'one line');

type Card = Record<string, any>;
/** The project of a card, or null when it has no deck. */
const projectOf = (db: Db, card: Card): string | null => (card.deckId ? (deckRow(db, card.deckId)?.projectId as string | undefined) ?? null : null);

/** A Lore card the actor may edit (as in cards/update), with its project. 409 not_lore on a quest or a card outside any project. */
function loadEntry(ctx: Ctx, id: string): { card: Card; projectId: string } {
  const card = loadCard(ctx, id);
  assertNotDeleted(card);
  const projectId = projectOf(ctx.db, card);
  if (!card.isDoc || !projectId) throw new AppError(409, 'not_lore', { id });
  return { card, projectId };
}

const entryKeyTaken = (db: Db, projectId: string, key: string, exceptId: string): boolean =>
  !!db.prepare('SELECT 1 FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.entry_key=? AND c.id!=?').get(projectId, key, exceptId);
export const entryKeys = (db: Db, projectId: string): Set<string> =>
  new Set((db.prepare('SELECT c.entry_key k FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.entry_key IS NOT NULL').all(projectId) as { k: string }[]).map((r) => r.k));

/** 400 unknown_type unless the type belongs to the project. */
function assertProjectType(db: Db, typeId: string, projectId: string): void {
  if (entryTypeRow(db, typeId)?.projectId !== projectId) throw new AppError(400, 'unknown_type', { id: typeId });
}

/**
 * The parent page must be live (archived is fine) Lore of the same project, and not the entry itself or one of its
 * descendants. A card the actor can't see is 404, like a missing one, before anything else is said about it.
 */
function assertParent(ctx: Ctx, cardId: string | null, parentId: string, projectId: string): void {
  const { db } = ctx;
  const parent = cardRow(db, parentId);
  const parentProject = parent ? projectOf(db, parent) : null;
  if (!parent || !canSeeCard(db, ctx.actor, parent as any, parentProject)) throw new AppError(404, 'not_found');
  if (parentProject !== projectId) throw new AppError(409, 'other_campaign', { id: parentId });
  assertNotDeleted(parent);
  if (!parent.isDoc) throw new AppError(409, 'not_lore', { id: parentId });
  if (cardId === null) return;
  const parentOf = (id: string) => (db.prepare('SELECT wiki_parent_id p FROM cards WHERE id=?').get(id) as { p: string | null } | undefined)?.p ?? null;
  if (hasCycle(parentOf, cardId, parentId)) throw new AppError(409, 'cycle');
}

/** The project's first doc deck; a "Lore" one is made (through the deck commands) when it has none. */
function loreDeckOf(ctx: Ctx, projectId: string): string {
  const { db } = ctx;
  const d = db.prepare("SELECT id FROM decks WHERE project_id=? AND deck_type='doc' ORDER BY sort_index, seq LIMIT 1").get(projectId) as { id: string } | undefined;
  if (d) return d.id;
  const { id } = deckCommands['decks/create'].run(ctx, { title: 'Lore', projectId }) as { id: string };
  if (deckRow(db, id)!.deckType !== 'doc') deckCommands['decks/update'].run(ctx, { id, deckType: 'doc' });
  return id;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- Links: typed edges from an entry (or, for works_on, a quest) to an entry of the same project. ----

const propsSchema = z.record(keySchema, valueSchema);

/** A card the actor can see, else 404 as for a missing one (a hidden card's existence is never told). */
function visibleCard(ctx: Ctx, id: string): { card: Card; projectId: string | null } {
  const card = cardRow(ctx.db, id);
  const projectId = card ? projectOf(ctx.db, card) : null;
  if (!card || !canSeeCard(ctx.db, ctx.actor, card as any, projectId)) throw new AppError(404, 'not_found');
  return { card, projectId };
}

/**
 * 413 too_large above WIKI_LIMITS.linkPropsBytes; 400 invalid_props unless every value names a visible property of the kind and passes validateValue; data.problems
 * maps each bad key to its code (unknown_prop for a key the kind lacks). Missing required values are for the checks.
 */
function checkProps(db: Db, projectId: string, defs: FieldDef[], props: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(props)) > WIKI_LIMITS.linkPropsBytes) throw new AppError(413, 'too_large', { maxBytes: WIKI_LIMITS.linkPropsBytes });
  // The project's live entry keys, read only when an entry reference is to be resolved.
  let ref: RefContext | undefined;
  const refs = (): RefContext => ref ??= refContext(new Map(projectTypes(db, projectId).map((t) => [t.id, t])), db.prepare(
    "SELECT c.entry_type_id entryTypeId, c.entry_key entryKey FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.entry_key IS NOT NULL AND c.visibility!='deleted'",
  ).all(projectId) as { entryTypeId: string | null; entryKey: string | null }[]);
  const lazy: RefContext = { typeOfKey: (k) => refs().typeOfKey(k), fits: (t, target) => refs().fits(t, target) };
  const problems: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    const def = defs.find((d) => d.key === k && !d.hidden);
    const p = def ? validateValue(def, v, lazy) : 'unknown_prop';
    if (p) problems[k] = p;
  }
  if (Object.keys(problems).length) throw new AppError(400, 'invalid_props', { problems });
}

/** The kind's property definitions, for a link of the project (works_on has none). */
const kindProps = (db: Db, projectId: string, kindKey: string): FieldDef[] => (kindKey === WORKS_ON ? [] :
  JSON.parse((db.prepare('SELECT props_json p FROM link_kinds WHERE project_id=? AND key=?').get(projectId, kindKey) as { p: string } | undefined)?.p ?? '[]'));

/**
 * A link the actor may edit: edit rights on its source card. A link the actor can't see (either end hidden or
 * deleted) is 404, as for a missing one.
 */
function loadLink(ctx: Ctx, id: string): EntryLink {
  const l = entryLinkRow(ctx.db, id) as EntryLink | undefined;
  if (!l) throw new AppError(404, 'not_found');
  const ends = [visibleCard(ctx, l.fromCardId).card, visibleCard(ctx, l.toCardId).card];
  if (ends.some((c) => c.visibility === 'deleted')) throw new AppError(404, 'not_found');
  loadCard(ctx, l.fromCardId);
  return l;
}

const nextTypeSort = (db: Db, projectId: string) =>
  ((db.prepare('SELECT MAX(sort_index) m FROM entry_types WHERE project_id=?').get(projectId) as { m: number | null }).m ?? 0) + 1;

const sectionsSchema = z.array(z.string().trim().min(1).max(80)).max(12);
const templatesSchema = z.array(z.strictObject({
  name: nameSchema, fields: z.record(keySchema, fieldValueSchema),
  links: z.array(z.strictObject({ kindKey: keySchema, toKey: keySchema, props: propsSchema })).max(50),
})).max(30);
const createTypeSchema = z.object({
  projectId: z.string(), name: nameSchema, key: keySchema.optional(), icon: iconSchema.optional(), color: colorSchema.optional(),
  parentTypeId: z.string().nullable().optional(), fields: fieldListSchema.optional(), sections: sectionsSchema.optional(),
  familyId: z.string().nullable().optional(), picture: pictureSchema.optional(),
});
/** wiki/createType and the starter pack: a new type of the project, with every check (rights, cap, keys, fields). Returns its id. */
function insertType(ctx: Ctx, input: z.infer<typeof createTypeSchema>): string {
  const { db } = ctx;
  assertCan(db, ctx.actor, 'project.manage', input.projectId);
  const existing = projectTypes(db, input.projectId);
  if (existing.length >= WIKI_LIMITS.typesPerProject) throw new AppError(409, 'limit', { max: WIKI_LIMITS.typesPerProject });
  const taken = new Set(existing.map((t) => t.key));
  if (input.key !== undefined && taken.has(input.key)) throw new AppError(409, 'duplicate_key', { key: input.key });
  const key = input.key ?? keyFromName(input.name, taken);
  const types = new Map(existing.map((t) => [t.id, t]));
  const parentTypeId = input.parentTypeId ?? null;
  if (parentTypeId !== null && !types.has(parentTypeId)) throw new AppError(400, 'unknown_type', { id: parentTypeId });
  const familyId = input.familyId ?? null;
  assertFamily(db, familyId, input.projectId, parentTypeId);
  const picture = (input.picture ?? null) as TypePicture | null;
  assertPicture(db, input.projectId, picture);
  const fields = (input.fields ?? []) as FieldDef[];
  // A field may reference the type being created.
  checkFieldList(fields, [], WIKI_LIMITS.fieldsPerType, new Set([...taken, key]));
  const id = newId();
  types.set(id, { id, projectId: input.projectId, key, name: input.name, icon: null, color: null, parentTypeId, fields, sortIndex: 0, sections: [], templates: [], familyId, picture });
  assertInheritedUnique(types, id);
  const now = Date.now();
  db.prepare('INSERT INTO entry_types (id,project_id,key,name,icon,color,parent_type_id,fields_json,sections_json,sort_index,created_at,updated_at,family_id,picture_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.projectId, key, input.name, input.icon ?? null, input.color ?? null, parentTypeId, JSON.stringify(fields), JSON.stringify(input.sections ?? []),
      nextTypeSort(db, input.projectId), now, now, familyId, picture && JSON.stringify(picture));
  ctx.emit('entryType', 'upsert', entryTypeRow(db, id)!);
  return id;
}

const createKindSchema = z.object({
  projectId: z.string(), key: keySchema.optional(), label: nameSchema, reverseLabel: nameSchema,
  fromTypes: typeKeysSchema, toTypes: typeKeysSchema, props: propListSchema.optional(), sumRule: sumRuleSchema.nullable().optional(),
});
/** wiki/createLinkKind and the starter pack: a new link kind of the project, with every check. Returns its id. */
function insertLinkKind(ctx: Ctx, input: z.infer<typeof createKindSchema>): string {
  const { db } = ctx;
  assertCan(db, ctx.actor, 'project.manage', input.projectId);
  if (input.key === WORKS_ON) throw new AppError(409, 'reserved_key', { key: input.key });
  const taken = kindKeys(db, input.projectId);
  if (taken.size >= WIKI_LIMITS.linkKindsPerProject) throw new AppError(409, 'limit', { max: WIKI_LIMITS.linkKindsPerProject });
  if (input.key !== undefined && taken.has(input.key)) throw new AppError(409, 'duplicate_key', { key: input.key });
  const key = input.key ?? keyFromName(input.label, new Set([...taken, WORKS_ON]));
  const typeKeys = new Set(projectTypes(db, input.projectId).map((t) => t.key));
  assertKnownTypes(typeKeys, [...input.fromTypes, ...input.toTypes]);
  const props = (input.props ?? []) as FieldDef[];
  checkFieldList(props, [], WIKI_LIMITS.propsPerLinkKind, typeKeys);
  const sumRule = input.sumRule ?? null;
  checkSumRule(sumRule, props);
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO link_kinds (id,project_id,key,label,reverse_label,from_types_json,to_types_json,props_json,sum_rule_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.projectId, key, input.label, input.reverseLabel, JSON.stringify(input.fromTypes), JSON.stringify(input.toTypes),
      JSON.stringify(props), sumRule && JSON.stringify(sumRule), now, now);
  ctx.emit('linkKind', 'upsert', linkKindRow(db, id)!);
  return id;
}

// ---- Blocks: a type's template page, and an entry's layout with its typed blocks' data (shared/blocks.ts). ----

const blockTitle = z.string().trim().min(1).max(BLOCK_LIMITS.titleChars).refine((s) => !/[\r\n]/.test(s), 'one line');
const blockSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{1,24}$/), kind: z.enum(BLOCK_KINDS as [Block['kind'], ...Block['kind'][]]), title: blockTitle,
  width: z.enum(['full', 'half']), prompt: z.string().max(BLOCK_LIMITS.promptChars).optional(),
  cols: z.array(z.string().trim().min(1).max(BLOCK_LIMITS.colChars)).min(1).max(BLOCK_LIMITS.cols).optional(),
  to: z.union([keySchema, z.literal('')]).optional(),
});
const pageSchema = z.strictObject({ guided: z.boolean(), blocks: z.array(blockSchema).max(BLOCK_LIMITS.blocksPerPage) });
const itemsSchema = z.array(z.string().max(BLOCK_LIMITS.itemChars)).max(BLOCK_LIMITS.items);
/** The data each typed block kind holds; text and facts hold none (their content is the markdown and the fields). */
const DATA_SCHEMAS: Partial<Record<Block['kind'], z.ZodType<BlockData>>> = {
  lines: z.strictObject({ items: itemsSchema }),
  steps: z.strictObject({ items: itemsSchema }),
  table: z.strictObject({ rows: z.array(z.array(z.string().max(BLOCK_LIMITS.cellChars)).max(BLOCK_LIMITS.cols)).max(BLOCK_LIMITS.rows) }),
  links: z.strictObject({ cardIds: z.array(z.string().min(1).max(100)).max(BLOCK_LIMITS.links) }),
  gallery: z.strictObject({ assetIds: z.array(z.string().min(1).max(100)).max(BLOCK_LIMITS.pictures) }),
  model: z.strictObject({ assetId: z.string().min(1).max(100) }),
  picture: z.strictObject({ assetId: z.string().min(1).max(100) }),
  map: z.strictObject({ assetId: z.string().min(1).max(100) }),
};
/** The asset kind a block needs (any kind for pictures: every asset has a picture). */
const ASSET_KIND: Partial<Record<Block['kind'], string>> = { model: 'model', map: 'map' };

/** 409 duplicate_key on a block id twice; 400 unknown_type on a links block pointing at a type the project lacks; a table needs columns. */
function checkPage(page: { blocks: Block[] }, typeKeys: Set<string>): void {
  const ids = new Set<string>();
  for (const b of page.blocks) {
    if (ids.has(b.id)) throw new AppError(409, 'duplicate_key', { block: b.id });
    ids.add(b.id);
    if (b.kind === 'table' && !b.cols?.length) throw new AppError(400, 'invalid_payload', { block: b.id, field: 'cols' });
    if (b.kind === 'links' && b.to) assertKnownTypes(typeKeys, [b.to]);
  }
}

/**
 * Gives a type the starter pack's page (version one past what it followed). A links block pointing at a type the
 * project lacks points at any type instead.
 */
function setStarterPage(ctx: Ctx, typeId: string, typeKeys: Set<string>): void {
  const { db } = ctx;
  const t = entryTypeRow(db, typeId)!;
  const blocks = STARTER_PAGES[t.key].map((b) => (b.kind === 'links' && b.to && !typeKeys.has(b.to) ? { ...b, to: '' } : { ...b }));
  // The type's own page headings stay: a text block for each one the game page lacks.
  const titles = new Set(blocks.filter((b) => b.kind === 'text').map((b) => headingKey(b.title)));
  (t.sections ?? []).forEach((h, i) => {
    if (titles.has(headingKey(h)) || blocks.length >= BLOCK_LIMITS.blocksPerPage) return;
    titles.add(headingKey(h));
    blocks.push({ id: `heading${i}`, kind: 'text', title: h.slice(0, BLOCK_LIMITS.titleChars), width: 'full', prompt: GAME_PROMPTS[h] ?? DEFAULT_PROMPT });
  });
  const types = new Map(projectTypes(db, t.projectId).map((x) => [x.id, x]));
  const page: TypePage = { version: pageOf(types, typeId).page.version + 1, guided: false, blocks };
  db.prepare('UPDATE entry_types SET page_json=?, updated_at=? WHERE id=?').run(JSON.stringify(page), Date.now(), typeId);
  ctx.emit('entryType', 'upsert', entryTypeRow(db, typeId)!);
}

export const wikiCommands: Record<string, Command> = {
  'wiki/createType': {
    schema: createTypeSchema,
    run: (ctx, input) => ({ id: insertType(ctx, input) }),
  },
  /**
   * The game starter pack (shared/templates/gameStarterPack.ts), through the same checks as createType and
   * createLinkKind, in this one transaction: all of it or nothing. A type or kind whose key the project already has is
   * skipped and left as it is; a pack child type under such a type drops the fields it would inherit twice. Returns
   * {typesAdded, kindsAdded}; a second run adds nothing.
   */
  'wiki/addStarterPack': {
    schema: z.object({ projectId: z.string(), core: z.boolean().optional() }),
    run(ctx, { projectId, core }) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'project.manage', projectId);
      const types = new Map(projectTypes(db, projectId).map((t) => [t.id, t]));
      const idByKey = new Map([...types.values()].map((t) => [t.key, t.id]));
      let typesAdded = 0;
      const added = new Set<string>();
      for (const t of STARTER_TYPES) {
        if (idByKey.has(t.key) || (core && !t.core)) continue;
        const parentTypeId = t.parent ? idByKey.get(t.parent) ?? null : null;
        const inherited = new Set(parentTypeId ? fieldsOf(types, parentTypeId).map((f) => f.key) : []);
        // Parsed like a createType payload, so the pack passes exactly the checks a person's input does.
        const id = insertType(ctx, createTypeSchema.parse({ projectId, key: t.key, name: t.name, icon: t.icon, parentTypeId, fields: t.fields.filter((f) => !inherited.has(f.key)), sections: t.sections }));
        types.set(id, entryTypeRow(db, id)!);
        idByKey.set(t.key, id);
        added.add(t.key);
        typesAdded++;
      }
      // Only the types added here go into the pack's families; types the project had keep theirs (or none).
      fileStarterTypes(ctx, projectId, added);
      // The core types added here get their page of blocks.
      for (const key of added) if (STARTER_PAGES[key]) setStarterPage(ctx, idByKey.get(key)!, new Set(idByKey.keys()));
      const taken = kindKeys(db, projectId);
      let kindsAdded = 0;
      for (const k of STARTER_KINDS) {
        if (taken.has(k.key) || (core && !k.core)) continue;
        // The small set has no dungeons or currencies: a kind keeps the ends that exist here. One that would lose a
        // whole side is left for the full pack. (A kind added this way keeps its shorter lists when the rest arrives.)
        const here = (keys: string[]) => keys.filter((x) => idByKey.has(x));
        const fromTypes = here(k.fromTypes), toTypes = here(k.toTypes);
        if ((k.fromTypes.length && !fromTypes.length) || (k.toTypes.length && !toTypes.length)) continue;
        const { core: _core, ...kind } = k;
        insertLinkKind(ctx, createKindSchema.parse({ projectId, ...kind, fromTypes, toTypes, sumRule: k.sumRule ?? null }));
        kindsAdded++;
      }
      return { typesAdded, kindsAdded };
    },
  },
  'wiki/updateType': {
    schema: z.object({
      id: z.string(), key: noKey, name: nameSchema.optional(), icon: iconSchema.optional(), color: colorSchema.optional(),
      parentTypeId: z.string().nullable().optional(), fields: fieldListSchema.optional(),
      sections: sectionsSchema.optional(), templates: templatesSchema.optional(),
      familyId: z.string().nullable().optional(), picture: pictureSchema.optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const old = loadType(ctx, input.id);
      const next: EntryType = {
        ...old,
        name: input.name ?? old.name,
        icon: input.icon !== undefined ? input.icon : old.icon,
        color: input.color !== undefined ? input.color : old.color,
        parentTypeId: input.parentTypeId !== undefined ? input.parentTypeId : old.parentTypeId,
        fields: (input.fields ?? old.fields) as FieldDef[],
        sections: input.sections ?? old.sections,
        templates: (input.templates ?? old.templates) as EntryType['templates'],
        // A kind sits in its root's family: becoming a kind of another type drops its own.
        familyId: input.familyId !== undefined ? input.familyId : old.familyId,
        picture: (input.picture !== undefined ? input.picture : old.picture) as TypePicture | null,
      };
      if (next.parentTypeId !== null && input.familyId === undefined) next.familyId = null;
      if (input.familyId !== undefined) assertFamily(db, next.familyId, old.projectId, next.parentTypeId);
      if (input.picture !== undefined) assertPicture(db, old.projectId, next.picture);
      if (input.parentTypeId !== undefined || input.fields !== undefined) {
        const types = new Map(projectTypes(db, old.projectId).map((t) => [t.id, t]));
        if (next.parentTypeId !== null) {
          if (!types.has(next.parentTypeId)) throw new AppError(400, 'unknown_type', { id: next.parentTypeId });
          const parentOf = (id: string) => types.get(id)?.parentTypeId ?? null;
          if (hasCycle(parentOf, old.id, next.parentTypeId)) throw new AppError(409, 'cycle');
        }
        if (input.fields !== undefined) checkFieldList(next.fields, old.fields, WIKI_LIMITS.fieldsPerType, new Set([...types.values()].map((t) => t.key)));
        types.set(old.id, next);
        assertInheritedUnique(types, old.id);
      }
      db.prepare('UPDATE entry_types SET name=?, icon=?, color=?, parent_type_id=?, fields_json=?, sections_json=?, templates_json=?, family_id=?, picture_json=?, updated_at=? WHERE id=?')
        .run(next.name, next.icon, next.color, next.parentTypeId, JSON.stringify(next.fields), JSON.stringify(next.sections), JSON.stringify(next.templates),
          next.familyId, next.picture && JSON.stringify(next.picture), Date.now(), old.id);
      if (input.picture !== undefined) releasePicture(ctx, old.picture, next.picture);
      ctx.emit('entryType', 'upsert', entryTypeRow(db, old.id)!);
    },
  },
  'wiki/deleteType': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const t = loadType(ctx, id);
      const count = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n;
      // Live entries only: trashed ones are let go below.
      const entries = count("SELECT COUNT(*) n FROM cards WHERE entry_type_id=? AND visibility!='deleted'", id);
      const childTypes = count('SELECT COUNT(*) n FROM entry_types WHERE parent_type_id=?', id);
      // References by key that would dangle: other types' field targets (its own self-references go with it), and link kinds.
      const fieldTargets = count(`SELECT COUNT(*) n FROM entry_types t, json_each(t.fields_json) f
        WHERE t.project_id=? AND t.id!=? AND json_extract(f.value, '$.target')=?`, t.projectId, id, t.key);
      const linkKinds = count(`SELECT COUNT(*) n FROM link_kinds k WHERE k.project_id=?
        AND (EXISTS (SELECT 1 FROM json_each(k.from_types_json) WHERE value=?) OR EXISTS (SELECT 1 FROM json_each(k.to_types_json) WHERE value=?)
          OR EXISTS (SELECT 1 FROM json_each(k.props_json) p WHERE json_extract(p.value, '$.target')=?))`, t.projectId, t.key, t.key, t.key);
      if (entries || childTypes || fieldTargets || linkKinds) throw new AppError(409, 'type_in_use', { entries, childTypes, fieldTargets, linkKinds });
      // Trashed entries become untyped lore and keep their values; a restore brings them back as plain pages.
      db.prepare('UPDATE cards SET entry_type_id=NULL WHERE entry_type_id=?').run(id);
      db.prepare('DELETE FROM entry_types WHERE id=?').run(id);
      releasePicture(ctx, t.picture);
      ctx.emit('entryType', 'remove', t);
    },
  },
  /**
   * A type's template page, replaced as a whole (version: one past the page it followed, or its own last one), or null:
   * the type follows its parent's page again (else the one made from its headings). Entries keep their own layouts.
   */
  'wiki/setPage': {
    schema: z.object({ typeId: z.string(), page: pageSchema.nullable() }),
    run(ctx, { typeId, page }) {
      const { db } = ctx;
      const t = loadType(ctx, typeId);
      let next: TypePage | null = null;
      if (page) {
        const types = new Map(projectTypes(db, t.projectId).map((x) => [x.id, x]));
        checkPage(page as TypePage, new Set([...types.values()].map((x) => x.key)));
        const version = Math.max(pageOf(types, typeId).page.version, t.page?.version ?? 0) + 1;
        next = { version, guided: page.guided, blocks: page.blocks as Block[] };
      } else if (!t.page) return;
      db.prepare('UPDATE entry_types SET page_json=?, updated_at=? WHERE id=?').run(next && JSON.stringify(next), Date.now(), t.id);
      ctx.emit('entryType', 'upsert', entryTypeRow(db, t.id)!);
    },
  },
  // ---- Families: named, coloured folds of root types. Deleting one never deletes a type. ----
  'wiki/createFamily': {
    schema: z.object({ projectId: z.string(), name: familyNameSchema, color: familyColorSchema }),
    run: (ctx, { projectId, name, color }) => ({ id: insertFamily(ctx, projectId, name, color) }),
  },
  'wiki/updateFamily': {
    schema: z.object({ id: z.string(), name: familyNameSchema.optional(), color: familyColorSchema.optional() }),
    run(ctx, input) {
      const { db } = ctx;
      const f = loadFamily(ctx, input.id);
      const name = input.name ?? f.name;
      if (name !== f.name) assertFamilyName(db, f.projectId, name, f.id);
      db.prepare('UPDATE entry_families SET name=?, color=?, updated_at=? WHERE id=?').run(name, input.color ?? f.color, Date.now(), f.id);
      ctx.emit('entryFamily', 'upsert', entryFamilyRow(db, f.id)!);
    },
  },
  /** Moves a family before another one of the project, or to the end (before: null). */
  'wiki/moveFamily': {
    schema: z.object({ id: z.string(), before: z.string().nullable() }),
    run(ctx, { id, before }) {
      const { db } = ctx;
      const f = loadFamily(ctx, id);
      const list = projectFamilies(db, f.projectId).filter((x) => x.id !== id);
      const at = before === null ? list.length : list.findIndex((x) => x.id === before);
      if (at < 0) throw new AppError(400, 'unknown_family', { id: before });
      list.splice(at, 0, f);
      list.forEach((x, i) => {
        if (x.sortIndex === i + 1) return;
        db.prepare('UPDATE entry_families SET sort_index=?, updated_at=? WHERE id=?').run(i + 1, Date.now(), x.id);
        ctx.emit('entryFamily', 'upsert', entryFamilyRow(db, x.id)!);
      });
    },
  },
  /** Deletes a family; its types move to "No family" and keep everything else. Returns {typesMoved}. */
  'wiki/deleteFamily': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const f = loadFamily(ctx, id);
      const moved = db.prepare('SELECT id FROM entry_types WHERE family_id=?').all(id) as { id: string }[];
      db.prepare('UPDATE entry_types SET family_id=NULL, updated_at=? WHERE family_id=?').run(Date.now(), id);
      for (const t of moved) ctx.emit('entryType', 'upsert', entryTypeRow(db, t.id)!);
      db.prepare('DELETE FROM entry_families WHERE id=?').run(id);
      ctx.emit('entryFamily', 'remove', f);
      return { typesMoved: moved.length };
    },
  },
  /**
   * The starter pack's families, offered to a project whose types came before families: root types with a pack key and
   * no family are filed (making the families they need). Types with a family, kinds and other types are left alone.
   */
  'wiki/addStarterFamilies': {
    schema: z.object({ projectId: z.string() }),
    run(ctx, { projectId }) {
      assertCan(ctx.db, ctx.actor, 'project.manage', projectId);
      return fileStarterTypes(ctx, projectId, new Set(STARTER_FAMILIES.flatMap((f) => f.types)));
    },
  },
  /**
   * "Update the starter types" (redesign decision 12), offered to projects that took the pack before: each type that
   * came from the previous pack (shared isPreviousCore: its key and every field the pack gave it) gets the game fields it
   * lacks (unless a kind under it holds the key, or the field points at a type the project lacks) and, when it has no
   * page of its own, the game page with a text block for each of its own headings. Nothing is hidden, removed or shown
   * again: the old fields stay as they are, and no entry's text or values change. A second run changes nothing.
   */
  'wiki/updateStarterTypes': {
    schema: z.object({ projectId: z.string() }),
    run(ctx, { projectId }) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'project.manage', projectId);
      let typesUpdated = 0, fieldsAdded = 0, pagesAdded = 0;
      for (const key of Object.keys(CORE_FIELDS)) {
        const list = projectTypes(db, projectId);
        const t = list.find((x) => x.key === key && isPreviousCore(x));
        if (!t) continue;
        const typeKeys = new Set(list.map((x) => x.key));
        const held = keysUnder(list, t.id);
        for (const f of fieldsOf(new Map(list.map((x) => [x.id, x])), t.id)) held.add(f.key);
        const added = CORE_FIELDS[key].filter((f) => !held.has(f.key) && !(f.target && !typeKeys.has(f.target)));
        let changed = false;
        if (added.length) {
          const fields = [...t.fields, ...added];
          checkFieldList(fields, t.fields, WIKI_LIMITS.fieldsPerType, typeKeys);
          const types = new Map(list.map((x) => [x.id, x]));
          types.set(t.id, { ...t, fields });
          assertInheritedUnique(types, t.id);
          db.prepare('UPDATE entry_types SET fields_json=?, updated_at=? WHERE id=?').run(JSON.stringify(fields), Date.now(), t.id);
          ctx.emit('entryType', 'upsert', entryTypeRow(db, t.id)!);
          fieldsAdded += added.length;
          changed = true;
        }
        if (!t.page && STARTER_PAGES[key]) { setStarterPage(ctx, t.id, typeKeys); pagesAdded++; changed = true; }
        if (changed) typesUpdated++;
      }
      return { typesUpdated, fieldsAdded, pagesAdded };
    },
  },
  'wiki/createLinkKind': {
    schema: createKindSchema,
    run: (ctx, input) => ({ id: insertLinkKind(ctx, input) }),
  },
  'wiki/updateLinkKind': {
    schema: z.object({
      id: z.string(), key: noKey, label: nameSchema.optional(), reverseLabel: nameSchema.optional(),
      fromTypes: typeKeysSchema.optional(), toTypes: typeKeysSchema.optional(), props: propListSchema.optional(), sumRule: sumRuleSchema.nullable().optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const old = loadKind(ctx, input.id);
      const typeKeys = new Set(projectTypes(db, old.projectId).map((t) => t.key));
      assertKnownTypes(typeKeys, input.fromTypes ?? [], old.fromTypes);
      assertKnownTypes(typeKeys, input.toTypes ?? [], old.toTypes);
      const props = (input.props ?? old.props) as FieldDef[];
      if (input.props !== undefined) checkFieldList(props, old.props, WIKI_LIMITS.propsPerLinkKind, typeKeys);
      const sumRule = input.sumRule !== undefined ? input.sumRule : old.sumRule;
      checkSumRule(sumRule, props);
      db.prepare('UPDATE link_kinds SET label=?, reverse_label=?, from_types_json=?, to_types_json=?, props_json=?, sum_rule_json=?, updated_at=? WHERE id=?')
        .run(input.label ?? old.label, input.reverseLabel ?? old.reverseLabel, JSON.stringify(input.fromTypes ?? old.fromTypes),
          JSON.stringify(input.toTypes ?? old.toTypes), JSON.stringify(props), sumRule && JSON.stringify(sumRule), Date.now(), old.id);
      ctx.emit('linkKind', 'upsert', linkKindRow(db, old.id)!);
    },
  },
  'wiki/deleteLinkKind': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      const k = loadKind(ctx, id);
      const links = db.prepare('SELECT id FROM entry_links WHERE project_id=? AND kind_key=?').all(k.projectId, k.key) as { id: string }[];
      db.prepare('DELETE FROM entry_links WHERE project_id=? AND kind_key=?').run(k.projectId, k.key);
      for (const l of links) ctx.emit('entryLink', 'remove', { id: l.id, projectId: k.projectId });
      db.prepare('DELETE FROM link_kinds WHERE id=?').run(id);
      ctx.emit('linkKind', 'remove', k);
      return { linksDeleted: links.length };
    },
  },

  /** A new Lore card `# name` through cards/create (access, history, events), typed and keyed. Returns {id, key}. */
  'wiki/createEntry': {
    schema: z.object({
      projectId: z.string(), typeId: z.string().nullable(), name: entryNameSchema, parentId: z.string().optional(),
      /** A guided start's answers by block id: a text block's text, or a lines/steps block's lines. */
      answers: z.record(z.string().max(24), z.string().max(100_000)).optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'content.edit', input.projectId);
      if (input.typeId !== null) assertProjectType(db, input.typeId, input.projectId);
      if (input.parentId !== undefined) assertParent(ctx, null, input.parentId, input.projectId);
      const deckId = loreDeckOf(ctx, input.projectId);
      // The page starts with a heading per text block of its type's page (its headings when it has no page), so there
      // is something to fill in. A stored page also gives the entry its layout, at that page's version.
      const types = new Map(projectTypes(db, input.projectId).map((t) => [t.id, t]));
      const { page, owner } = input.typeId === null ? { page: { version: 0, guided: false, blocks: [] }, owner: null } : pageOf(types, input.typeId);
      const made = newEntryContent(input.name, page, input.answers);
      const layout: EntryLayout | null = owner ? { version: page.version, owner: owner.id, blocks: page.blocks, data: made.data } : null;
      // Answers keep the limits block data has anywhere (setBlock).
      for (const [id, d] of Object.entries(made.data)) {
        const kind = page.blocks.find((b) => b.id === id)!.kind;
        if (!DATA_SCHEMAS[kind]?.safeParse(d).success) throw new AppError(400, 'invalid_payload', { field: 'answers', block: id });
      }
      if (layout && Buffer.byteLength(JSON.stringify(layout)) > BLOCK_LIMITS.layoutBytes) throw new AppError(413, 'too_large', { maxBytes: BLOCK_LIMITS.layoutBytes });
      const { id } = createCard(ctx, { content: made.content, deckId, isDoc: true });
      const key = keyFromName(input.name, entryKeys(db, input.projectId));
      db.prepare('UPDATE cards SET entry_type_id=?, entry_key=?, wiki_parent_id=?, layout_json=? WHERE id=?')
        .run(input.typeId, key, input.parentId ?? null, layout && JSON.stringify(layout), id);
      emitCard(ctx, id);
      if (input.typeId !== null) touchTranslation(ctx, 'fields', id);
      return { id, key };
    },
  },
  /**
   * Type, field values and key of an entry. `fields` is a patch: null removes a key, unsent keys stay. Values are not
   * checked against the type (wiki checks do that), and a new type keeps every value.
   */
  'wiki/setEntry': {
    schema: z.object({
      cardId: z.string(), typeId: z.string().nullable().optional(),
      fields: z.record(keySchema, fieldValueSchema.nullable()).optional(), key: keySchema.optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const { card, projectId } = loadEntry(ctx, input.cardId);
      const typeId: string | null = input.typeId !== undefined ? input.typeId : card.entryTypeId;
      if (typeId !== card.entryTypeId && typeId !== null) assertProjectType(db, typeId, projectId);
      let key: string | null = input.key ?? card.entryKey;
      if (key !== card.entryKey && key !== null && entryKeyTaken(db, projectId, key, card.id)) throw new AppError(409, 'duplicate_key', { key });
      // Lore made as a plain page has no key: it gets one, from its title, when it is first typed.
      if (key === null && typeId !== null) key = keyFromName(titleOf(card.content), entryKeys(db, projectId));
      const old = card.fields as Record<string, unknown>;
      const fields = { ...old };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(input.fields ?? {})) {
        if (v === null) delete fields[k]; else fields[k] = v;
        if (!sameValue(old[k], fields[k])) changed.push(k);
      }
      const json = JSON.stringify(fields);
      if (Buffer.byteLength(json) > WIKI_LIMITS.entryFieldsBytes) throw new AppError(413, 'too_large', { maxBytes: WIKI_LIMITS.entryFieldsBytes });
      const changes = entryChange(changed, { type: { from: card.entryTypeId, to: typeId }, key: { from: card.entryKey, to: key } });
      if (!changes.length) return;
      // A new type: the entry's own layout takes that type's page, keeping the blocks that hold something.
      let layout = card.layout as EntryLayout | null;
      if (layout && typeId !== null && typeId !== card.entryTypeId) {
        const { page, owner } = pageOf(new Map(projectTypes(db, projectId).map((t) => [t.id, t])), typeId);
        layout = bringUpToDate(layout, page, bodyOf(card.content).body, owner?.id ?? '');
      }
      db.prepare('UPDATE cards SET entry_type_id=?, entry_key=?, fields_json=?, layout_json=? WHERE id=?').run(typeId, key, json, layout && JSON.stringify(layout), card.id);
      recordHistory(db, card.id, ctx.actor.id, changes);
      emitCard(ctx, card.id);
      touchTranslation(ctx, 'fields', card.id);
    },
  },
  /**
   * One typed block's data of an entry (null clears it). An entry with no layout of its own first gets its type's page.
   * The data must fit the block's kind; assets and linked entries must be the project's. Text and fields are untouched.
   */
  'wiki/setBlock': {
    schema: z.object({
      cardId: z.string(), blockId: z.string().max(24), data: z.record(z.string(), z.unknown()).nullable(),
      /** The block's data as the writer last saw it (null: none). Given and different from what is stored: 409 conflict. */
      expected: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const { card, projectId } = loadEntry(ctx, input.cardId);
      const types = new Map(projectTypes(db, projectId).map((t) => [t.id, t]));
      let layout = card.layout as EntryLayout | null;
      if (!layout) {
        if (!card.entryTypeId || !types.has(card.entryTypeId)) throw new AppError(400, 'unknown_block', { id: input.blockId });
        const { page, owner } = pageOf(types, card.entryTypeId);
        layout = { version: page.version, owner: owner?.id ?? '', blocks: page.blocks, data: {} };
      }
      const block = layout.blocks.find((b) => b.id === input.blockId);
      if (!block) throw new AppError(400, 'unknown_block', { id: input.blockId });
      const prior = layout.data[block.id] ?? null;
      // As cards/update does: the 409 carries the card as it is, so the page shows the newer data.
      if (input.expected !== undefined && !sameValue(prior, input.expected)) throw new AppError(409, 'conflict', card);
      let next: BlockData | null = null;
      if (input.data !== null) {
        const parsed = DATA_SCHEMAS[block.kind]?.safeParse(input.data);
        if (!parsed?.success) throw new AppError(400, 'invalid_payload', { field: 'data', kind: block.kind });
        next = parsed.data;
        // Ids new to this block must be the project's; ids it already held that have since gone (a deleted asset, a
        // trashed or moved entry) are dropped quietly, so they never lock the block.
        const had = new Set([...(prior?.assetIds ?? []), ...(prior?.assetId ? [prior.assetId] : []), ...(prior?.cardIds ?? [])]);
        const need = ASSET_KIND[block.kind];
        const assetOk = (a: string) => {
          const row = db.prepare('SELECT kind FROM assets WHERE id=? AND project_id=?').get(a, projectId) as { kind: string } | undefined;
          return !!row && (!need || row.kind === need);
        };
        const cardOk = (c: string) => {
          const other = cardRow(db, c);
          return !!other && !!other.isDoc && other.visibility !== 'deleted' && projectOf(db, other) === projectId && canSeeCard(db, ctx.actor, other as any, projectId);
        };
        const keep = (id: string, ok: (x: string) => boolean, code: string) => {
          if (ok(id)) return true;
          if (had.has(id)) return false;
          throw new AppError(400, code, { id });
        };
        if (next.assetIds) next = { assetIds: next.assetIds.filter((a) => keep(a, assetOk, 'unknown_asset')) };
        if (next.assetId) next = keep(next.assetId, assetOk, 'unknown_asset') ? next : {};
        if (next.cardIds) next = { cardIds: next.cardIds.filter((c) => keep(c, cardOk, 'unknown_entry')) };
        if (!hasData(block.kind, next) && block.kind !== 'lines' && block.kind !== 'steps' && block.kind !== 'table') next = null;
      }
      const data = { ...layout.data };
      if (next === null) delete data[block.id]; else data[block.id] = next;
      const updated: EntryLayout = { ...layout, data };
      const json = JSON.stringify(updated);
      if (Buffer.byteLength(json) > BLOCK_LIMITS.layoutBytes) throw new AppError(413, 'too_large', { maxBytes: BLOCK_LIMITS.layoutBytes });
      if (card.layout && sameValue(card.layout, updated)) return;
      db.prepare('UPDATE cards SET layout_json=? WHERE id=?').run(json, card.id);
      if (!sameValue(prior, next)) recordHistory(db, card.id, ctx.actor.id, [{ kind: 'block', title: block.title, from: prior, to: next }]);
      emitCard(ctx, card.id);
      touchTranslation(ctx, 'fields', card.id);
    },
  },
  /**
   * "Bring entries up to date": the given entries of the type whose own layout is older than the type's page take the
   * page's blocks, order and widths (shared/blocks bringUpToDate). Their text, field values and block data are kept.
   * Entries with no layout of their own already follow the page. Returns {updated}.
   */
  'wiki/bringUpToDate': {
    schema: z.object({ typeId: z.string(), cardIds: z.array(z.string()).max(WIKI_LIMITS.pruneBatch) }),
    run(ctx, { typeId, cardIds }) {
      const { db } = ctx;
      const t = loadType(ctx, typeId);
      const { page, owner } = pageOf(new Map(projectTypes(db, t.projectId).map((x) => [x.id, x])), typeId);
      const ownerId = owner?.id ?? '';
      let updated = 0;
      for (const id of new Set<string>(cardIds as string[])) {
        const c = cardRow(db, id);
        const layout = c?.layout as EntryLayout | null | undefined;
        if (!c || c.entryTypeId !== typeId || c.visibility === 'deleted' || !layout || !isOutdated(layout, page, ownerId)) continue;
        const next = bringUpToDate(layout, page, bodyOf(c.content).body, ownerId);
        db.prepare('UPDATE cards SET layout_json=? WHERE id=?').run(JSON.stringify(next), id);
        emitCard(ctx, id);
        updated++;
      }
      return { updated };
    },
  },
  /**
   * The entry's aliases, replaced as a whole: trimmed (whitespace runs as one space), empty ones and the entry's own
   * name dropped, deduplicated case-insensitively (the first spelling stays). 400 under MIN_NAME_CHARS or over ALIAS_LIMITS.chars, 409 limit
   * over ALIAS_LIMITS.perEntry.
   */
  'wiki/setAliases': {
    schema: z.object({ cardId: z.string(), aliases: z.array(z.string().max(1000)).max(500) }),
    run(ctx, input) {
      const { db } = ctx;
      const { card } = loadEntry(ctx, input.cardId);
      const own = nameKey(titleOf(card.content));
      const seen = new Set<string>([own]);
      const next: string[] = [];
      for (const raw of input.aliases) {
        const a = cleanName(raw);
        if (!a) continue;
        if ([...a].length > ALIAS_LIMITS.chars) throw new AppError(400, 'invalid_payload', { field: 'aliases', maxChars: ALIAS_LIMITS.chars });
        const k = nameKey(a);
        if ([...k].length < MIN_NAME_CHARS) {
          throw new AppError(400, 'invalid_payload', { field: 'aliases', message: `An alias needs at least ${MIN_NAME_CHARS} characters: "${a}" is too short to be recognised in text.` });
        }
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(a);
      }
      if (next.length > ALIAS_LIMITS.perEntry) throw new AppError(409, 'limit', { max: ALIAS_LIMITS.perEntry });
      const old = card.aliases as string[];
      if (old.length === next.length && old.every((a, i) => a === next[i])) return { aliases: old };
      db.prepare('UPDATE cards SET aliases_json=? WHERE id=?').run(JSON.stringify(next), card.id);
      recordHistory(db, card.id, ctx.actor.id, [{ kind: 'aliases', from: old, to: next }]);
      emitCard(ctx, card.id);
      return { aliases: next };
    },
  },
  /** Files an entry under another Lore page of its project (null: top level). */
  'wiki/setParent': {
    schema: z.object({ cardId: z.string(), parentId: z.string().nullable() }),
    run(ctx, input) {
      const { db } = ctx;
      const { card, projectId } = loadEntry(ctx, input.cardId);
      if (input.parentId === card.wikiParentId) return;
      if (input.parentId !== null) assertParent(ctx, card.id, input.parentId, projectId);
      db.prepare('UPDATE cards SET wiki_parent_id=? WHERE id=?').run(input.parentId, card.id);
      recordHistory(db, card.id, ctx.actor.id, entryChange([], { parent: { from: card.wikiParentId, to: input.parentId } }));
      emitCard(ctx, card.id);
    },
  },
  /**
   * Drops, from the entries of the type, the values whose key is not a visible field of it. At most
   * WIKI_LIMITS.pruneBatch entries per call, since every changed entry is an event held until commit: the client calls
   * again until `done`. Returns {entriesChanged, done}.
   */
  'wiki/pruneValues': {
    schema: z.object({ typeId: z.string() }),
    // Hidden fields' stored values are dropped for good.
    deletes: true,
    run(ctx, { typeId }) {
      const { db } = ctx;
      const t = loadType(ctx, typeId);
      const types = new Map(projectTypes(db, t.projectId).map((x) => [x.id, x]));
      const keep = JSON.stringify(fieldsOf(types, typeId).filter((f) => !f.hidden).map((f) => f.key));
      const batch = WIKI_LIMITS.pruneBatch;
      // Only entries that still hold a value to drop, so each call picks up where the last one stopped.
      const rows = db.prepare(`SELECT id, fields_json f FROM cards WHERE entry_type_id=?
        AND EXISTS (SELECT 1 FROM json_each(cards.fields_json) j WHERE j.key NOT IN (SELECT value FROM json_each(?)))
        ORDER BY id LIMIT ?`).all(typeId, keep, batch + 1) as { id: string; f: string }[];
      const kept = new Set(JSON.parse(keep) as string[]);
      const write = db.prepare('UPDATE cards SET fields_json=? WHERE id=?');
      for (const r of rows.slice(0, batch)) {
        const fields = JSON.parse(r.f) as Record<string, unknown>;
        const dropped = Object.keys(fields).filter((k) => !kept.has(k));
        for (const k of dropped) delete fields[k];
        write.run(JSON.stringify(fields), r.id);
        recordHistory(db, r.id, ctx.actor.id, entryChange(dropped));
        emitCard(ctx, r.id);
      }
      return { entriesChanged: Math.min(rows.length, batch), done: rows.length <= batch };
    },
  },

  /**
   * A link of kind `kindKey` from one card to another of the same project. Needs edit rights on the source; a target
   * the actor can't see is 404. Typed kinds go Lore → Lore with fromTypes/toTypes (children included); works_on goes
   * quest → Lore. The sum rule is a check, not enforced here. Returns {id}.
   */
  'wiki/addLink': {
    schema: z.object({ kindKey: keySchema, fromCardId: z.string(), toCardId: z.string(), props: propsSchema.optional() }),
    run(ctx, input) {
      const { db } = ctx;
      const from = loadCard(ctx, input.fromCardId);
      const to = visibleCard(ctx, input.toCardId);
      assertNotDeleted(from);
      assertNotDeleted(to.card);
      const projectId = projectOf(db, from);
      if (!projectId || to.projectId !== projectId) throw new AppError(409, 'other_campaign', { id: input.toCardId });
      const notAllowed = () => new AppError(409, 'type_not_allowed', { kindKey: input.kindKey });
      let defs: FieldDef[] = [];
      if (input.kindKey === WORKS_ON) {
        if (from.isDoc || !to.card.isDoc) throw notAllowed();
      } else {
        const kind = db.prepare('SELECT id FROM link_kinds WHERE project_id=? AND key=?').get(projectId, input.kindKey) as { id: string } | undefined;
        if (!kind) throw new AppError(400, 'unknown_kind', { key: input.kindKey });
        const k = linkKindRow(db, kind.id)!;
        const types = new Map(projectTypes(db, projectId).map((t) => [t.id, t]));
        // An untyped page fits only a side that allows any type.
        const fits = (c: Card, allowed: string[]) => c.isDoc && (c.entryTypeId ? isTypeOrChild(types, c.entryTypeId, allowed) : allowed.length === 0);
        if (!fits(from, k.fromTypes) || !fits(to.card, k.toTypes)) throw notAllowed();
        defs = k.props;
      }
      const props = input.props ?? {};
      checkProps(db, projectId, defs, props);
      const out = db.prepare('SELECT COUNT(*) n, MAX(sort_index) m FROM entry_links WHERE from_card_id=?').get(from.id) as { n: number; m: number | null };
      if (out.n >= WIKI_LIMITS.linksPerEntry) throw new AppError(409, 'limit', { max: WIKI_LIMITS.linksPerEntry });
      // The export names link ends by key: Lore made as a plain page (cards/create) gets one, from its title, when first linked.
      if (input.kindKey !== WORKS_ON) {
        for (const c of from.id === to.card.id ? [from] : [from, to.card]) {
          if (c.entryKey) continue;
          const key = keyFromName(titleOf(c.content), entryKeys(db, projectId));
          db.prepare('UPDATE cards SET entry_key=? WHERE id=?').run(key, c.id);
          recordHistory(db, c.id, ctx.actor.id, entryChange([], { key: { from: null, to: key } }));
          emitCard(ctx, c.id);
        }
      }
      const id = newId();
      db.prepare('INSERT INTO entry_links (id,project_id,kind_key,from_card_id,to_card_id,props_json,sort_index,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, projectId, input.kindKey, from.id, to.card.id, JSON.stringify(props), (out.m ?? 0) + 1, Date.now());
      ctx.emit('entryLink', 'upsert', entryLinkRow(db, id)!);
      return { id };
    },
  },
  /**
   * New property values and/or order of a link. The visible properties are replaced by those sent; stored values of
   * hidden (retired) properties, which the edit form can't show, are kept as they are, whatever is sent for them.
   */
  'wiki/updateLink': {
    schema: z.object({ id: z.string(), props: propsSchema.optional(), sortIndex: z.number().finite().optional() }),
    run(ctx, input) {
      const { db } = ctx;
      const l = loadLink(ctx, input.id);
      let props = l.props;
      if (input.props !== undefined) {
        const defs = kindProps(db, l.projectId, l.kindKey);
        const hidden = new Set(defs.filter((d) => d.hidden).map((d) => d.key));
        const kept = Object.fromEntries(Object.entries(l.props ?? {}).filter(([k]) => hidden.has(k)));
        const sent = Object.fromEntries(Object.entries(input.props).filter(([k]) => !hidden.has(k)));
        checkProps(db, l.projectId, defs, sent);
        props = { ...sent, ...kept };
        if (Buffer.byteLength(JSON.stringify(props)) > WIKI_LIMITS.linkPropsBytes) throw new AppError(413, 'too_large', { maxBytes: WIKI_LIMITS.linkPropsBytes });
      }
      db.prepare('UPDATE entry_links SET props_json=?, sort_index=? WHERE id=?')
        .run(JSON.stringify(props), input.sortIndex ?? l.sortIndex, l.id);
      ctx.emit('entryLink', 'upsert', entryLinkRow(db, l.id)!);
    },
  },
  'wiki/removeLink': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const l = loadLink(ctx, id);
      ctx.db.prepare('DELETE FROM entry_links WHERE id=?').run(l.id);
      ctx.emit('entryLink', 'remove', { id: l.id, projectId: l.projectId });
    },
  },
};

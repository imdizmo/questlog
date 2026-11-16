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
import { KEY_RE, WORKS_ON, fieldsOf, hasCycle, isTypeOrChild, keyFromName, refContext, sectionsOf, typeChain, validateValue, type RefContext } from '../../shared/wiki';
import type { EntryLink, EntryType, FieldDef, FieldKind, LinkKind } from '../../shared/types';
import { STARTER_KINDS, STARTER_TYPES } from '../../shared/templates/gameStarterPack';

export const WIKI_LIMITS = {
  typesPerProject: 200, fieldsPerType: 100, linkKindsPerProject: 200, propsPerLinkKind: 20, linksPerEntry: 500, linkPropsBytes: 4 * 1024, listBytes: 64 * 1024, entryFieldsBytes: 64 * 1024, pruneBatch: 500,
} as const;

const FIELD_KINDS = ['text', 'longtext', 'number', 'integer', 'boolean', 'enum', 'multienum', 'entry', 'entries', 'image', 'color', 'range'] as const satisfies readonly FieldKind[];
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
const typeKeysSchema = z.array(keySchema).max(WIKI_LIMITS.typesPerProject);
const sumRuleSchema = z.object({ prop: keySchema, max: z.number().finite() });
const iconSchema = z.string().max(64).nullable();
const colorSchema = z.string().max(32).nullable();
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
  name: nameSchema, fields: z.record(keySchema, valueSchema),
  links: z.array(z.strictObject({ kindKey: keySchema, toKey: keySchema, props: propsSchema })).max(50),
})).max(30);
const createTypeSchema = z.object({
  projectId: z.string(), name: nameSchema, key: keySchema.optional(), icon: iconSchema.optional(), color: colorSchema.optional(),
  parentTypeId: z.string().nullable().optional(), fields: fieldListSchema.optional(), sections: sectionsSchema.optional(),
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
  const fields = (input.fields ?? []) as FieldDef[];
  // A field may reference the type being created.
  checkFieldList(fields, [], WIKI_LIMITS.fieldsPerType, new Set([...taken, key]));
  const id = newId();
  types.set(id, { id, projectId: input.projectId, key, name: input.name, icon: null, color: null, parentTypeId, fields, sortIndex: 0, sections: [], templates: [] });
  assertInheritedUnique(types, id);
  const now = Date.now();
  db.prepare('INSERT INTO entry_types (id,project_id,key,name,icon,color,parent_type_id,fields_json,sections_json,sort_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, input.projectId, key, input.name, input.icon ?? null, input.color ?? null, parentTypeId, JSON.stringify(fields), JSON.stringify(input.sections ?? []), nextTypeSort(db, input.projectId), now, now);
  ctx.emit('entryType', 'upsert', entryTypeRow(db, id)!);
  return id;
}

const createKindSchema = z.object({
  projectId: z.string(), key: keySchema.optional(), label: nameSchema, reverseLabel: nameSchema,
  fromTypes: typeKeysSchema, toTypes: typeKeysSchema, props: fieldListSchema.optional(), sumRule: sumRuleSchema.nullable().optional(),
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
      for (const t of STARTER_TYPES) {
        if (idByKey.has(t.key) || (core && !t.core)) continue;
        const parentTypeId = t.parent ? idByKey.get(t.parent) ?? null : null;
        const inherited = new Set(parentTypeId ? fieldsOf(types, parentTypeId).map((f) => f.key) : []);
        // Parsed like a createType payload, so the pack passes exactly the checks a person's input does.
        const id = insertType(ctx, createTypeSchema.parse({ projectId, key: t.key, name: t.name, icon: t.icon, parentTypeId, fields: t.fields.filter((f) => !inherited.has(f.key)), sections: t.sections }));
        types.set(id, entryTypeRow(db, id)!);
        idByKey.set(t.key, id);
        typesAdded++;
      }
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
      };
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
      db.prepare('UPDATE entry_types SET name=?, icon=?, color=?, parent_type_id=?, fields_json=?, sections_json=?, templates_json=?, updated_at=? WHERE id=?')
        .run(next.name, next.icon, next.color, next.parentTypeId, JSON.stringify(next.fields), JSON.stringify(next.sections), JSON.stringify(next.templates), Date.now(), old.id);
      ctx.emit('entryType', 'upsert', entryTypeRow(db, old.id)!);
    },
  },
  'wiki/deleteType': {
    schema: z.object({ id: z.string() }),
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
      ctx.emit('entryType', 'remove', t);
    },
  },
  'wiki/createLinkKind': {
    schema: createKindSchema,
    run: (ctx, input) => ({ id: insertLinkKind(ctx, input) }),
  },
  'wiki/updateLinkKind': {
    schema: z.object({
      id: z.string(), key: noKey, label: nameSchema.optional(), reverseLabel: nameSchema.optional(),
      fromTypes: typeKeysSchema.optional(), toTypes: typeKeysSchema.optional(), props: fieldListSchema.optional(), sumRule: sumRuleSchema.nullable().optional(),
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
    schema: z.object({ projectId: z.string(), typeId: z.string().nullable(), name: entryNameSchema, parentId: z.string().optional() }),
    run(ctx, input) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'content.edit', input.projectId);
      if (input.typeId !== null) assertProjectType(db, input.typeId, input.projectId);
      if (input.parentId !== undefined) assertParent(ctx, null, input.parentId, input.projectId);
      const deckId = loreDeckOf(ctx, input.projectId);
      // The page starts with the headings of its type, so there is something to fill in.
      const sections = input.typeId === null ? [] : sectionsOf(new Map(projectTypes(db, input.projectId).map((t) => [t.id, t])), input.typeId);
      const { id } = createCard(ctx, { content: [`# ${input.name}`, ...sections.map((s) => `## ${s}`)].join('\n\n'), deckId, isDoc: true });
      const key = keyFromName(input.name, entryKeys(db, input.projectId));
      db.prepare('UPDATE cards SET entry_type_id=?, entry_key=?, wiki_parent_id=? WHERE id=?').run(input.typeId, key, input.parentId ?? null, id);
      emitCard(ctx, id);
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
      fields: z.record(keySchema, valueSchema.nullable()).optional(), key: keySchema.optional(),
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
      db.prepare('UPDATE cards SET entry_type_id=?, entry_key=?, fields_json=? WHERE id=?').run(typeId, key, json, card.id);
      recordHistory(db, card.id, ctx.actor.id, changes);
      emitCard(ctx, card.id);
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
    run(ctx, { id }) {
      const l = loadLink(ctx, id);
      ctx.db.prepare('DELETE FROM entry_links WHERE id=?').run(l.id);
      ctx.emit('entryLink', 'remove', { id: l.id, projectId: l.projectId });
    },
  },
};

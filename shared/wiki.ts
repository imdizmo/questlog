// Game wiki model: keys, type inheritance, value validation and consistency checks.
// Pure functions, shared by server and web.
import type { Card, EntryLink, EntryType, FieldDef, FieldKind, LinkKind } from './types';

export type { EntryLink, EntryType, FieldDef, FieldKind, LinkKind };

export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Link kind that ties a (non-wiki) card to the entry it works on. */
export const WORKS_ON = 'works_on';

/** "Fire Sword!" -> fire_sword; a taken key gets _2, _3...; keys start with a letter. */
export function keyFromName(name: string, taken: Set<string>): string {
  let base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'entry';
  else if (!/^[a-z]/.test(base)) base = `e_${base}`;
  base = base.slice(0, 56).replace(/_+$/, '');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}_${n}`;
    if (!taken.has(k)) return k;
  }
}

/** root ... self. Stops (without repeating a type) if the parent links form a cycle. */
export function typeChain(types: Map<string, EntryType>, typeId: string): EntryType[] {
  const chain: EntryType[] = [];
  const seen = new Set<string>();
  for (let id: string | null = typeId; id && !seen.has(id); ) {
    const t = types.get(id);
    if (!t) break;
    seen.add(id);
    chain.push(t);
    id = t.parentTypeId;
  }
  return chain.reverse();
}

/** Inherited fields, root's first; a child's field with the same key replaces the inherited one in place. */
export function fieldsOf(types: Map<string, EntryType>, typeId: string): FieldDef[] {
  const out: FieldDef[] = [];
  const at = new Map<string, number>();
  for (const t of typeChain(types, typeId)) {
    for (const f of t.fields) {
      const i = at.get(f.key);
      if (i === undefined) { at.set(f.key, out.length); out.push(f); } else out[i] = f;
    }
  }
  return out;
}

/** Page headings of a type: its ancestors' first, each once. */
export const sectionsOf = (types: Map<string, EntryType>, typeId: string): string[] =>
  [...new Set(typeChain(types, typeId).flatMap((t) => t.sections ?? []))];

/** True when the type, or one of its ancestors, has a key in allowedKeys. [] allows any type. */
export function isTypeOrChild(types: Map<string, EntryType>, typeId: string, allowedKeys: string[]): boolean {
  if (allowedKeys.length === 0) return true;
  return typeChain(types, typeId).some((t) => allowedKeys.includes(t.key));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const HEX = /^#[0-9a-fA-F]{6}$/;

function checkBounds(def: FieldDef, n: number): string | null {
  if (def.min !== undefined && n < def.min) return 'below_min';
  if (def.max !== undefined && n > def.max) return 'above_max';
  return null;
}

/** How validateValue resolves entry references. */
export interface RefContext {
  /** Type key of the entry with this key; null when there is no such entry ('' for an untyped one). */
  typeOfKey(key: string): string | null;
  /** Does an entry of type `typeKey` satisfy a field whose target is `target` (the type itself or a child)? */
  fits(typeKey: string, target: string): boolean;
}

/** The ref context for a set of live entries and the type tree; use it wherever fields are validated. */
export function refContext(types: Map<string, EntryType>, entries: Pick<Card, 'entryTypeId' | 'entryKey'>[]): RefContext {
  const typeKeyById = new Map<string, string>();
  const idByKey = new Map<string, string>();
  for (const t of types.values()) { typeKeyById.set(t.id, t.key); idByKey.set(t.key, t.id); }
  const byKey = new Map<string, string>();
  for (const e of entries) {
    if (e.entryKey && !byKey.has(e.entryKey)) byKey.set(e.entryKey, e.entryTypeId ? typeKeyById.get(e.entryTypeId) ?? '' : '');
  }
  return {
    typeOfKey: (k) => byKey.get(k) ?? null,
    fits: (tk, target) => { const id = idByKey.get(tk); return !!id && isTypeOrChild(types, id, [target]); },
  };
}

/** null = ok, else a problem code: wrong_kind, below_min, above_max, not_an_option, broken_ref, wrong_type_ref. */
export function validateValue(def: FieldDef, v: unknown, ctx: RefContext): string | null {
  const keyToType = ctx.typeOfKey;
  const typeFits = ctx.fits;
  const ref = (key: unknown): string | null => {
    if (!isStr(key)) return 'wrong_kind';
    const t = keyToType(key);
    if (t === null) return 'broken_ref';
    return def.target && !typeFits(t, def.target) ? 'wrong_type_ref' : null;
  };
  switch (def.kind) {
    case 'text': case 'longtext': case 'image':
      return isStr(v) ? null : 'wrong_kind';
    case 'number': return isNum(v) ? checkBounds(def, v) : 'wrong_kind';
    case 'integer': return isNum(v) && Number.isInteger(v) ? checkBounds(def, v) : 'wrong_kind';
    case 'boolean': return typeof v === 'boolean' ? null : 'wrong_kind';
    case 'color': return isStr(v) && HEX.test(v) ? null : 'wrong_kind';
    case 'enum':
      if (!isStr(v)) return 'wrong_kind';
      return (def.options ?? []).includes(v) ? null : 'not_an_option';
    case 'multienum':
      if (!Array.isArray(v) || !v.every(isStr)) return 'wrong_kind';
      return v.every((o) => (def.options ?? []).includes(o)) ? null : 'not_an_option';
    case 'entry': return ref(v);
    case 'entries': {
      if (!Array.isArray(v)) return 'wrong_kind';
      for (const k of v) { const p = ref(k); if (p) return p; }
      return null;
    }
    case 'range': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'wrong_kind';
      const { min, max } = v as { min?: unknown; max?: unknown };
      if (!isNum(min) || !isNum(max) || min > max) return 'wrong_kind';
      return checkBounds(def, min) ?? checkBounds(def, max);
    }
    default: return 'wrong_kind';
  }
}

export type CheckProblem = 'missing_required' | 'invalid_value' | 'broken_ref' | 'wrong_type_ref' | 'link_type_not_allowed' | 'sum_exceeded' | 'bad_key' | 'duplicate_key';
export interface Check { entry: string /* key or id */; problem: CheckProblem; detail: string }
export interface WikiData {
  types: EntryType[]; kinds: LinkKind[];
  entries: Pick<Card, 'id' | 'entryTypeId' | 'entryKey' | 'fields' | 'visibility' | 'content'>[];
  links: EntryLink[];
  /**
   * The export's option of the same name. Off, plain pages (untyped lore, or lore whose type is gone) are not in the
   * file: links and references to them are broken_ref, like any other target missing from the file.
   */
  includePages: boolean;
  /** Is the file an attachment of the card? Given, an image value (field or link property) must name an attachment of its owner (a link's source). */
  isAttached?: (fileId: string, cardId: string) => boolean;
}
/** At most this many checks are listed (the export, its 422 body, the panel); `total` counts them all. */
export const CHECKS_LIMIT = 1000;
export interface ChecksResult { checks: Check[]; total: number }

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The checks of a project, as the export lists them (the badge and panel run the same): one pass over the live
 * entries and the links given. Plain pages are never checked themselves. The first `limit` checks are kept, `total`
 * counts every one.
 */
export function runChecks(d: WikiData, limit = CHECKS_LIMIT): ChecksResult {
  const out: Check[] = [];
  let total = 0;
  const add = (c: Check) => { total++; if (out.length < limit) out.push(c); };
  const types = new Map(d.types.map((t) => [t.id, t]));
  const kinds = new Map(d.kinds.map((k) => [k.key, k]));
  const isTyped = (e: { entryTypeId: string | null }) => !!e.entryTypeId && types.has(e.entryTypeId);
  const live = d.entries.filter((e) => e.visibility !== 'deleted' && (d.includePages || isTyped(e)));
  /** Live plain pages left out of the file (includePages off): links to or from them are named as such. */
  const leftOut = new Map(d.includePages ? [] : d.entries.filter((e) => e.visibility !== 'deleted' && !isTyped(e)).map((e) => [e.id, e]));
  const byId = new Map(live.map((e) => [e.id, e]));
  const byKey = new Map<string, typeof live>();
  for (const e of live) {
    if (!e.entryKey) continue;
    const list = byKey.get(e.entryKey);
    if (list) list.push(e); else byKey.set(e.entryKey, [e]);
  }
  const ctx = refContext(types, live);
  const fieldsByType = new Map<string, FieldDef[]>();
  /** Empty/required/validateValue (and attachment) over a set of defs; `owner` holds the images, `where` names the owner in detail. */
  const checkValues = (defs: FieldDef[], values: Record<string, unknown> | undefined, owner: string, entry: string, where: string) => {
    for (const f of defs) {
      if (f.hidden) continue;
      const v = values?.[f.key];
      if (isEmpty(v)) {
        if (f.required) add({ entry, problem: 'missing_required', detail: `${where}${f.key}` });
        continue;
      }
      const p = validateValue(f, v, ctx);
      if (p) add({ entry, problem: p === 'broken_ref' || p === 'wrong_type_ref' ? p : 'invalid_value', detail: `${where}${f.key}: ${p}` });
      else if (f.kind === 'image' && d.isAttached && !d.isAttached(v as string, owner)) add({ entry, problem: 'invalid_value', detail: `${where}${f.key}: image not attached` });
    }
  };
  const label = (e: { id: string; entryKey: string | null }) => e.entryKey ?? e.id;

  for (const e of live) {
    if (!isTyped(e)) continue;
    if (!e.entryKey || !KEY_RE.test(e.entryKey)) add({ entry: label(e), problem: 'bad_key', detail: `invalid key ${JSON.stringify(e.entryKey)}` });
    let defs = fieldsByType.get(e.entryTypeId!);
    if (!defs) { defs = fieldsOf(types, e.entryTypeId!); fieldsByType.set(e.entryTypeId!, defs); }
    checkValues(defs, e.fields, e.id, label(e), '');
  }
  for (const [key, list] of byKey) {
    const typed = list.filter(isTyped);
    if (list.length > 1 && typed.length > 0) add({ entry: key, problem: 'duplicate_key', detail: list.slice(0, 5).map((e) => e.id).join(', ') + (list.length > 5 ? `, +${list.length - 5} more` : '') });
  }

  const sums = new Map<string, { kind: LinkKind; from: string; total: number }>();
  const missing = (id: string) => (leftOut.has(id) ? `${label(leftOut.get(id)!)} is a plain page (not exported without pages)` : `${id} missing or deleted`);
  for (const l of d.links) {
    const to = byId.get(l.toCardId);
    const tag = `${l.kindKey} link ${l.id}`;
    if (l.kindKey === WORKS_ON) {
      // The source is a quest, not a wiki entry: only the target is checked.
      if (!to) add({ entry: l.fromCardId, problem: 'broken_ref', detail: `${tag}: target ${missing(l.toCardId)}` });
      continue;
    }
    const kind = kinds.get(l.kindKey);
    if (!kind) continue;
    const from = byId.get(l.fromCardId);
    if (!from) {
      const page = leftOut.get(l.fromCardId);
      add({ entry: page ? label(page) : l.fromCardId, problem: 'broken_ref', detail: `${tag}: source ${page ? missing(l.fromCardId) : 'missing or deleted'}` });
      continue;
    }
    if (!to) { add({ entry: label(from), problem: 'broken_ref', detail: `${tag}: target ${missing(l.toCardId)}` }); continue; }
    const fromOk = !isTyped(from) ? kind.fromTypes.length === 0 : isTypeOrChild(types, from.entryTypeId!, kind.fromTypes);
    const toOk = !isTyped(to) ? kind.toTypes.length === 0 : isTypeOrChild(types, to.entryTypeId!, kind.toTypes);
    if (!fromOk || !toOk) add({ entry: label(from), problem: 'link_type_not_allowed', detail: `${tag}: ${label(from)} -> ${label(to)}` });
    checkValues(kind.props, l.props, from.id, label(from), `${tag}: `);
    if (kind.sumRule) {
      const n = l.props?.[kind.sumRule.prop];
      if (isNum(n)) {
        const k = `${kind.key}\0${from.id}`;
        const s = sums.get(k) ?? { kind, from: label(from), total: 0 };
        s.total += n;
        sums.set(k, s);
      } else if (!isEmpty(n) && !kind.props.some((p) => p.key === kind.sumRule!.prop)) {
        add({ entry: label(from), problem: 'invalid_value', detail: `${tag}: ${kind.sumRule.prop}: wrong_kind` });
      }
    }
  }
  for (const s of sums.values()) {
    if (s.total > s.kind.sumRule!.max + 1e-9) add({ entry: s.from, problem: 'sum_exceeded', detail: `${s.kind.key}.${s.kind.sumRule!.prop} adds up to ${s.total}, max ${s.kind.sumRule!.max}` });
  }
  return { checks: out, total };
}

/** Would giving `start` the parent `newParent` create a cycle? (newParent's ancestors, or newParent itself, include start.) */
export function hasCycle(parentOf: (id: string) => string | null, start: string, newParent: string): boolean {
  const seen = new Set<string>();
  for (let id: string | null = newParent; id !== null && !seen.has(id); id = parentOf(id)) {
    if (id === start) return true;
    seen.add(id);
  }
  return false;
}

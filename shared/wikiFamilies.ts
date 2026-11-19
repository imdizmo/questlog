// Wiki families and type pictures: the Types tree (families that fold, kinds under their root) and the painted
// stand-in picture of a type. Pure functions, shared by server and web.
import type { EntryFamily, EntryType, TypePicture } from './types';
import { typeChain } from './wiki';

export type PictureStyle = Extract<TypePicture, { kind: 'painted' }>['style'];
export const PICTURE_STYLES: readonly PictureStyle[] = ['dusk', 'dawn', 'night', 'flat'];
/** The painted colour of a type with no family and no colour of its own. */
export const NO_FAMILY_COLOR = '#8a7f72';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The family of a type: its root's (a kind sits in its root's family); null when the root has none or it is gone. */
export function familyOf(types: Map<string, EntryType>, families: Map<string, EntryFamily>, typeId: string): EntryFamily | null {
  const root = typeChain(types, typeId)[0];
  return (root?.familyId && families.get(root.familyId)) || null;
}

/** The colour a painted picture uses: the family's, else the type's own, else a quiet neutral. */
export const pictureColor = (type: Pick<EntryType, 'color'>, family: Pick<EntryFamily, 'color'> | null): string =>
  family && HEX.test(family.color) ? family.color : type.color && HEX.test(type.color) ? type.color : NO_FAMILY_COLOR;

/** A CSS `background` for a painted style in a #rrggbb colour (the redesign preview's PIC_STYLES). */
export function paintedBackground(style: PictureStyle, c: string): string {
  switch (style) {
    case 'dawn': return `linear-gradient(160deg, #f4d7a8 0%, ${c}aa 55%, #1b130d 100%)`;
    case 'night': return `radial-gradient(90% 70% at 70% 30%, ${c}99, #0d0b16 75%)`;
    case 'flat': return `${c}55`;
    default: return `radial-gradient(120% 90% at 30% 20%, ${c}cc, ${c}44 55%, #120e0a 100%)`;
  }
}

export interface FamilyRoot { type: EntryType; /** Every type under it, depth first (kinds of kinds included). */ kinds: EntryType[] }
export interface FamilyGroup { family: EntryFamily | null; roots: FamilyRoot[]; /** Rows shown: roots and kinds. */ count: number }

/**
 * The Types tree: families in their order, then "No family" (family null) when it has roots. Without a search every
 * family is listed, empty ones too. With one (any case, trimmed), a root stays when its name or a kind's matches; its
 * kinds are all shown when the root matches, else only the matching ones; families left empty are dropped.
 */
export function familyGroups(types: EntryType[], families: EntryFamily[], q: string): FamilyGroup[] {
  const needle = q.trim().toLowerCase();
  const ids = new Set(types.map((t) => t.id));
  const kidsOf = new Map<string, EntryType[]>();
  const roots: EntryType[] = [];
  for (const t of types) {
    if (t.parentTypeId && ids.has(t.parentTypeId)) {
      const list = kidsOf.get(t.parentTypeId);
      if (list) list.push(t); else kidsOf.set(t.parentTypeId, [t]);
    } else roots.push(t);
  }
  const under = (id: string, seen = new Set<string>([id])): EntryType[] => (kidsOf.get(id) ?? [])
    .filter((k) => !seen.has(k.id) && seen.add(k.id))
    .flatMap((k) => [k, ...under(k.id, seen)]);
  const matches = (t: EntryType) => t.name.toLowerCase().includes(needle);
  const shown = (t: EntryType): FamilyRoot | null => {
    const kinds = under(t.id);
    if (!needle || matches(t)) return { type: t, kinds };
    const hit = kinds.filter(matches);
    return hit.length ? { type: t, kinds: hit } : null;
  };
  const famIds = new Set(families.map((f) => f.id));
  const ordered = [...families].sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
  const groups: FamilyGroup[] = [];
  const add = (family: EntryFamily | null, list: EntryType[]) => {
    const rs = list.map(shown).filter((r): r is FamilyRoot => !!r);
    if (rs.length || (!needle && family)) groups.push({ family, roots: rs, count: rs.reduce((n, r) => n + 1 + r.kinds.length, 0) });
  };
  for (const f of ordered) add(f, roots.filter((t) => t.familyId === f.id));
  add(null, roots.filter((t) => !t.familyId || !famIds.has(t.familyId)));
  return groups;
}

import { describe, it, expect } from 'vitest';
import type { EntryFamily, EntryType } from '../shared/types';
import { NO_FAMILY_COLOR, PICTURE_STYLES, familyGroups, familyOf, paintedBackground, pictureColor } from '../shared/wikiFamilies';
import { STARTER_FAMILIES, STARTER_TYPES } from '../shared/templates/gameStarterPack';

const T = (id: string, name: string, parentTypeId: string | null = null, familyId: string | null = null, color: string | null = null): EntryType =>
  ({ id, projectId: 'p', key: id, name, icon: null, color, parentTypeId, fields: [], sortIndex: 0, sections: [], templates: [], familyId, picture: null });
const F = (id: string, name: string, sortIndex: number, color = '#b8862f'): EntryFamily => ({ id, projectId: 'p', name, color, sortIndex });

const fams = [F('f2', 'Items', 2), F('f1', 'Characters', 1, '#c9733a'), F('f3', 'Empty', 3)];
const types = [
  T('npc', 'Character', null, 'f1'), T('item', 'Item', null, 'f2'), T('weapon', 'Weapon', 'item'), T('sword', 'Sword', 'weapon'),
  T('armor', 'Armor', 'item'), T('spell', 'Spell'),
];
const typeMap = new Map(types.map((t) => [t.id, t]));
const famMap = new Map(fams.map((f) => [f.id, f]));
const shape = (q: string) => familyGroups(types, fams, q).map((g) => [g.family?.name ?? null, g.count, g.roots.map((r) => [r.type.name, r.kinds.map((k) => k.name)])]);

describe('familyGroups', () => {
  it('lists families in order, empty ones too, kinds under their root, No family last', () => {
    expect(shape('')).toEqual([
      ['Characters', 1, [['Character', []]]],
      ['Items', 4, [['Item', ['Weapon', 'Sword', 'Armor']]]],
      ['Empty', 0, []],
      [null, 1, [['Spell', []]]],
    ]);
  });
  it('a search keeps matching families only, and shows a matching kind under its root', () => {
    expect(shape('swo')).toEqual([['Items', 2, [['Item', ['Sword']]]]]);
  });
  it('a root that matches shows all its kinds', () => {
    expect(shape('item')).toEqual([['Items', 4, [['Item', ['Weapon', 'Sword', 'Armor']]]]]);
  });
  it('ignores case and leading/trailing spaces; no match gives no groups', () => {
    expect(shape('  SPELL ')).toEqual([[null, 1, [['Spell', []]]]]);
    expect(shape('dragon')).toEqual([]);
  });
  it('a type pointing at a missing family counts as No family', () => {
    const g = familyGroups([T('x', 'X', null, 'gone')], [], '');
    expect(g.map((x) => x.family)).toEqual([null]);
  });
});

describe('pictures', () => {
  it('a kind takes its root family colour; no family: type colour, else the neutral one', () => {
    expect(familyOf(typeMap, famMap, 'sword')?.name).toBe('Items');
    expect(pictureColor(typeMap.get('sword')!, familyOf(typeMap, famMap, 'sword'))).toBe('#b8862f');
    expect(pictureColor(T('a', 'A', null, null, '#123456'), null)).toBe('#123456');
    expect(pictureColor(T('a', 'A'), null)).toBe(NO_FAMILY_COLOR);
    expect(pictureColor(T('a', 'A', null, null, 'red'), null)).toBe(NO_FAMILY_COLOR);
  });
  it('paints four styles as CSS backgrounds in the colour', () => {
    expect(PICTURE_STYLES).toEqual(['dusk', 'dawn', 'night', 'flat']);
    for (const s of PICTURE_STYLES) expect(paintedBackground(s, '#b8862f')).toContain('#b8862f');
    expect(paintedBackground('flat', '#b8862f')).toBe('#b8862f55');
  });
});

describe('starter families', () => {
  it('cover every root type of the pack exactly once, and name only pack root types', () => {
    const roots = STARTER_TYPES.filter((t) => !t.parent).map((t) => t.key).sort();
    const filed = STARTER_FAMILIES.flatMap((f) => f.types).sort();
    expect(filed).toEqual(roots);
  });
});

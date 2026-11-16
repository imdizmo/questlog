import { describe, expect, it } from 'vitest';
import type { Card } from '../shared/types';
import {
  fieldsOf, hasCycle, isTypeOrChild, keyFromName, refContext, runChecks as runChecksFull, validateValue, CHECKS_LIMIT,
  type EntryLink, type EntryType, type FieldDef, type LinkKind, type WikiData,
} from '../shared/wiki';

const type = (id: string, key: string, parentTypeId: string | null, fields: FieldDef[] = []): EntryType =>
  ({ id, projectId: 'p', key, name: key, icon: null, color: null, parentTypeId, fields, sortIndex: 0, sections: [], templates: [] });
const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, kind, ...extra });
const entry = (id: string, entryTypeId: string | null, entryKey: string | null, fields: Record<string, unknown> = {}, visibility: Card['visibility'] = 'default') =>
  ({ id, entryTypeId, entryKey, fields, visibility, content: '' });
const link = (id: string, kindKey: string, fromCardId: string, toCardId: string, props: Record<string, unknown> = {}): EntryLink =>
  ({ id, projectId: 'p', kindKey, fromCardId, toCardId, props, sortIndex: 0 });
const kind = (key: string, extra: Partial<LinkKind> = {}): LinkKind =>
  ({ id: key, projectId: 'p', key, label: key, reverseLabel: key, fromTypes: [], toTypes: [], props: [], sumRule: null, ...extra });
const data = (d: Partial<WikiData>): WikiData => ({ types: [], kinds: [], entries: [], links: [], includePages: true, ...d });
/** The listed checks (most tests stay far below the cap). */
const runChecks = (d: WikiData) => runChecksFull(d).checks;

const item = type('t-item', 'item', null, [f('rarity', 'text')]);
const weapon = type('t-weapon', 'weapon', 't-item', [f('damage', 'number')]);
const types = new Map([item, weapon].map((t) => [t.id, t]));

describe('keyFromName', () => {
  it('slugifies, de-duplicates and starts with a letter', () => {
    expect(keyFromName('Fire Sword!', new Set())).toBe('fire_sword');
    expect(keyFromName('Fire Sword!', new Set(['fire_sword']))).toBe('fire_sword_2');
    expect(keyFromName('Fire Sword!', new Set(['fire_sword', 'fire_sword_2']))).toBe('fire_sword_3');
    expect(keyFromName('3 Crowns', new Set())).toBe('e_3_crowns');
    expect(keyFromName('Épée', new Set())).toBe('epee');
    expect(keyFromName('', new Set())).toBe('entry');
    expect(keyFromName('!!!', new Set(['entry']))).toBe('entry_2');
  });
});

describe('type tree', () => {
  it('fieldsOf lists inherited fields root first', () => {
    expect(fieldsOf(types, 't-weapon').map((x) => x.key)).toEqual(['rarity', 'damage']);
  });
  it('a child field with the same key overrides the inherited one', () => {
    const w2 = type('t-w2', 'w2', 't-item', [f('rarity', 'enum', { options: ['a'] }), f('damage', 'number')]);
    const out = fieldsOf(new Map([...types, ['t-w2', w2]]), 't-w2');
    expect(out.map((x) => x.key)).toEqual(['rarity', 'damage']);
    expect(out[0].kind).toBe('enum');
  });
  it('typeChain stops on a cycle', () => {
    const a = type('a', 'a', 'b', [f('x', 'text')]);
    const b = type('b', 'b', 'a', [f('y', 'text')]);
    expect(fieldsOf(new Map([['a', a], ['b', b]]), 'a').map((x) => x.key)).toEqual(['y', 'x']);
  });
  it('isTypeOrChild', () => {
    expect(isTypeOrChild(types, 't-weapon', ['item'])).toBe(true);
    expect(isTypeOrChild(types, 't-item', ['weapon'])).toBe(false);
    expect(isTypeOrChild(types, 't-item', [])).toBe(true);
  });
});

describe('validateValue', () => {
  const none = { typeOfKey: () => null, fits: () => false };
  const ctxOf = (m: Record<string, string>) => refContext(types, Object.entries(m).map(([entryKey, tk]) => ({ entryKey, entryTypeId: tk })));
  it('numbers', () => {
    const d = f('n', 'number', { min: 0, max: 10 });
    expect(validateValue(d, 5, none)).toBeNull();
    expect(validateValue(d, 11, none)).toBe('above_max');
    expect(validateValue(d, -1, none)).toBe('below_min');
    expect(validateValue(d, '5', none)).toBe('wrong_kind');
    expect(validateValue(f('i', 'integer'), 1.5, none)).toBe('wrong_kind');
  });
  it('enum, multienum, color, boolean, range', () => {
    const e = f('e', 'enum', { options: ['a', 'b'] });
    expect(validateValue(e, 'a', none)).toBeNull();
    expect(validateValue(e, 'z', none)).toBe('not_an_option');
    expect(validateValue({ ...e, kind: 'multienum' }, ['a', 'z'], none)).toBe('not_an_option');
    expect(validateValue(f('c', 'color'), '#a1B2c3', none)).toBeNull();
    expect(validateValue(f('c', 'color'), 'red', none)).toBe('wrong_kind');
    expect(validateValue(f('b', 'boolean'), 'yes', none)).toBe('wrong_kind');
    const r = f('r', 'range');
    expect(validateValue(r, { min: 2, max: 5 }, none)).toBeNull();
    expect(validateValue(r, { min: 5, max: 2 }, none)).toBe('wrong_kind');
  });
  it('entry refs', () => {
    const d = f('r', 'entry', { target: 'item' });
    const ctx = ctxOf({ sword: 't-item', bob: 't-npc' });
    expect(validateValue(d, 'sword', ctx)).toBeNull();
    expect(validateValue(d, 'ghost', ctx)).toBe('broken_ref');
    expect(validateValue(d, 'bob', ctx)).toBe('wrong_type_ref');
    expect(validateValue({ ...d, kind: 'entries' }, ['sword', 'ghost'], ctx)).toBe('broken_ref');
  });
  it('a ref to a child type fits the parent target, not the reverse', () => {
    const ctx = ctxOf({ blade: 't-weapon', thing: 't-item' });
    expect(validateValue(f('r', 'entry', { target: 'item' }), 'blade', ctx)).toBeNull();
    expect(validateValue(f('r', 'entries', { target: 'item' }), ['blade', 'thing'], ctx)).toBeNull();
    expect(validateValue(f('r', 'entry', { target: 'weapon' }), 'thing', ctx)).toBe('wrong_type_ref');
  });
  it('range bounds apply to both ends', () => {
    const r = f('r', 'range', { min: 0, max: 10 });
    expect(validateValue(r, { min: -1, max: 5 }, none)).toBe('below_min');
    expect(validateValue(r, { min: 1, max: 11 }, none)).toBe('above_max');
  });
});

describe('runChecks', () => {
  it('missing required', () => {
    const t = type('t', 'thing', null, [f('name', 'text', { required: true })]);
    const out = runChecks(data({ types: [t], entries: [entry('e1', 't', 'a', {})] }));
    expect(out).toEqual([{ entry: 'a', problem: 'missing_required', detail: 'name' }]);
  });
  it('a field whose kind changed leaves an invalid value', () => {
    const t = type('t', 'thing', null, [f('slot', 'enum', { options: ['head'] })]);
    const out = runChecks(data({ types: [t], entries: [entry('e1', 't', 'a', { slot: 3 })] }));
    expect(out.map((c) => c.problem)).toEqual(['invalid_value']);
  });
  it('field refs: broken, deleted target, wrong type, child type accepted', () => {
    const t = type('t', 'item', null, [f('r', 'entry', { target: 'item' })]);
    const w = type('w', 'weapon', 't');
    const npc = type('n', 'npc', null);
    const out = runChecks(data({
      types: [t, w, npc],
      entries: [
        entry('e1', 't', 'a', { r: 'sword' }), entry('e2', 'w', 'sword'),
        entry('e3', 't', 'b', { r: 'ghost' }), entry('e4', 't', 'c', { r: 'bob' }), entry('e5', 'n', 'bob'),
        entry('e6', 't', 'd', { r: 'gone' }), entry('e7', 't', 'gone', {}, 'deleted'),
      ],
    }));
    expect(out.map((c) => `${c.entry}:${c.problem}`)).toEqual(['b:broken_ref', 'c:wrong_type_ref', 'd:broken_ref']);
  });
  it('untyped lore is never checked, deleted entries are skipped', () => {
    const t = type('t', 'thing', null, [f('name', 'text', { required: true })]);
    expect(runChecks(data({ types: [t], entries: [entry('e1', null, null), entry('e2', 't', 'x', {}, 'deleted')] }))).toEqual([]);
  });
  it('bad key', () => {
    const t = type('t', 'thing', null);
    const out = runChecks(data({ types: [t], entries: [entry('e1', 't', 'Bad Key'), entry('e2', 't', null)] }));
    expect(out.map((c) => c.problem)).toEqual(['bad_key', 'bad_key']);
  });
  it('duplicate keys', () => {
    const t = type('t', 'thing', null);
    const out = runChecks(data({ types: [t], entries: [entry('e1', 't', 'fire_sword'), entry('e2', 't', 'fire_sword')] }));
    expect(out).toEqual([{ entry: 'fire_sword', problem: 'duplicate_key', detail: 'e1, e2' }]);
  });
  it('loot sums, deleted targets and type rules on links', () => {
    const mob = type('m', 'mob', null);
    const it = type('i', 'item', null);
    const drops = kind('drops', { fromTypes: ['mob'], toTypes: ['item'], sumRule: { prop: 'chance', max: 100 } });
    const entries = [entry('m1', 'm', 'wolf'), entry('i1', 'i', 'pelt'), entry('i2', 'i', 'fang'), entry('i3', 'i', 'old', {}, 'deleted')];
    const base = { types: [mob, it], kinds: [drops], entries };
    const sum = runChecks(data({ ...base, links: [link('l1', 'drops', 'm1', 'i1', { chance: 60 }), link('l2', 'drops', 'm1', 'i2', { chance: 50 })] }));
    expect(sum.map((c) => c.problem)).toEqual(['sum_exceeded']);
    expect(sum[0].entry).toBe('wolf');
    const ok = runChecks(data({ ...base, links: [link('l1', 'drops', 'm1', 'i1', { chance: 60 }), link('l2', 'drops', 'm1', 'i2', { chance: 40 })] }));
    expect(ok).toEqual([]);
    const gone = runChecks(data({ ...base, links: [link('l3', 'drops', 'm1', 'i3', { chance: 5 })] }));
    expect(gone.map((c) => c.problem)).toEqual(['broken_ref']);
    const bad = runChecks(data({ ...base, links: [link('l4', 'drops', 'i1', 'i2', { chance: 5 })] }));
    expect(bad.map((c) => c.problem)).toEqual(['link_type_not_allowed']);
  });
  it('link props: invalid, out of range, missing required, entry refs', () => {
    const mob = type('m', 'mob', null);
    const it = type('i', 'item', null);
    const cur = type('c', 'currency', null);
    const drops = kind('drops', {
      props: [f('chance', 'number', { min: 0, max: 100 }), f('qty', 'integer', { required: true }), f('coin', 'entry', { target: 'currency' })],
      sumRule: { prop: 'chance', max: 100 },
    });
    const entries = [entry('m1', 'm', 'wolf'), entry('i1', 'i', 'pelt'), entry('c1', 'c', 'gold')];
    const run = (props: Record<string, unknown>) => runChecks(data({ types: [mob, it, cur], kinds: [drops], entries, links: [link('l1', 'drops', 'm1', 'i1', props)] }));
    expect(run({ chance: 50, qty: 1, coin: 'gold' })).toEqual([]);
    const abc = run({ chance: 'abc', qty: 1 });
    expect(abc).toEqual([{ entry: 'wolf', problem: 'invalid_value', detail: 'drops link l1: chance: wrong_kind' }]);
    expect(run({ chance: 250, qty: 1 }).map((c) => c.problem)).toEqual(['invalid_value', 'sum_exceeded']);
    expect(run({ chance: 5 })).toEqual([{ entry: 'wolf', problem: 'missing_required', detail: 'drops link l1: qty' }]);
    expect(run({ qty: 1, coin: 'ghost' }).map((c) => c.problem)).toEqual(['broken_ref']);
    expect(run({ qty: 1, coin: 'pelt' }).map((c) => c.problem)).toEqual(['wrong_type_ref']);
  });
  it('a non-number in the sum prop is invalid_value even when the kind does not declare the prop', () => {
    const mob = type('m', 'mob', null);
    const drops = kind('drops', { sumRule: { prop: 'chance', max: 100 } });
    const entries = [entry('m1', 'm', 'wolf'), entry('m2', 'm', 'bear')];
    const out = runChecks(data({ types: [mob], kinds: [drops], entries, links: [link('l1', 'drops', 'm1', 'm2', { chance: 'abc' })] }));
    expect(out.map((c) => c.problem)).toEqual(['invalid_value']);
  });
  it('a link kind accepts child types of its allowed types', () => {
    const k = kind('uses', { fromTypes: ['item'], toTypes: ['item'] });
    const out = runChecks(data({ types: [item, weapon], kinds: [k], entries: [entry('a', 't-weapon', 'blade'), entry('b', 't-item', 'gem')], links: [link('l1', 'uses', 'a', 'b')] }));
    expect(out).toEqual([]);
  });
  it('works_on: a quest source is not checked or reported, a deleted target is', () => {
    const k = kind('works_on', { fromTypes: ['mob'], toTypes: ['item'], props: [f('need', 'text', { required: true })] });
    const base = { types: [item], kinds: [k], entries: [entry('i1', 't-item', 'gem'), entry('i2', 't-item', 'old', {}, 'deleted')] };
    expect(runChecks(data({ ...base, links: [link('l1', 'works_on', 'quest-1', 'i1')] }))).toEqual([]);
    const gone = runChecks(data({ ...base, links: [link('l2', 'works_on', 'quest-1', 'i2')] }));
    expect(gone.map((c) => c.problem)).toEqual(['broken_ref']);
  });
  it('hidden fields are not checked; the sum tolerates float noise', () => {
    const t = type('t', 'thing', null, [f('old', 'text', { required: true, hidden: true })]);
    expect(runChecks(data({ types: [t], entries: [entry('e1', 't', 'a')] }))).toEqual([]);
    const mob = type('m', 'mob', null);
    const drops = kind('drops', { sumRule: { prop: 'chance', max: 100 } });
    const entries = [entry('m1', 'm', 'a'), entry('m2', 'm', 'b'), entry('m3', 'm', 'c')];
    const links = [0.1, 0.2, 99.7].map((c, i) => link(`l${i}`, 'drops', 'm1', i === 0 ? 'm2' : 'm3', { chance: c }));
    expect(runChecks(data({ types: [mob], kinds: [drops], entries, links }))).toEqual([]);
  });
});

describe('runChecks: as the export sees the project', () => {
  const mob = type('m', 'mob', null, [f('origin', 'entry')]);
  const about = kind('about');
  const entries = [entry('m1', 'm', 'wolf', { origin: 'isles' }), entry('p1', null, 'isles'), entry('p2', null, null)];
  const links = [link('l1', 'about', 'm1', 'p1'), link('l2', 'about', 'p1', 'm1')];
  it('without includePages, links and references to plain pages are broken_ref, named as plain pages', () => {
    const out = runChecks(data({ types: [mob], kinds: [about], entries, links, includePages: false }));
    expect(out).toEqual([
      { entry: 'wolf', problem: 'broken_ref', detail: 'origin: broken_ref' },
      { entry: 'wolf', problem: 'broken_ref', detail: 'about link l1: target isles is a plain page (not exported without pages)' },
      { entry: 'isles', problem: 'broken_ref', detail: 'about link l2: source isles is a plain page (not exported without pages)' },
    ]);
    expect(runChecks(data({ types: [mob], kinds: [about], entries, links, includePages: true }))).toEqual([]);
  });
  it('an entry whose type is gone counts as a plain page', () => {
    const out = runChecks(data({ types: [mob], kinds: [about], entries: [entry('m1', 'm', 'wolf'), entry('x', 'gone-type', 'orphan')], links: [link('l1', 'about', 'm1', 'x')], includePages: false }));
    expect(out.map((c) => c.detail)).toEqual(['about link l1: target orphan is a plain page (not exported without pages)']);
  });
  it('image values must name an attachment of the entry, or of the link source for a link property', () => {
    const t = type('t', 'item', null, [f('icon', 'image')]);
    const k = kind('shows', { props: [f('pic', 'image')] });
    const attached = new Set(['a1:f1', 'a2:f2']);
    const d = data({
      types: [t], kinds: [k],
      entries: [entry('a1', 't', 'sword', { icon: 'f1' }), entry('a2', 't', 'axe', { icon: 'f1' })],
      links: [link('l1', 'shows', 'a1', 'a2', { pic: 'f1' }), link('l2', 'shows', 'a2', 'a1', { pic: 'f1' })],
      isAttached: (file, card) => attached.has(`${card}:${file}`),
    });
    expect(runChecks(d)).toEqual([
      { entry: 'axe', problem: 'invalid_value', detail: 'icon: image not attached' },
      { entry: 'axe', problem: 'invalid_value', detail: 'shows link l2: pic: image not attached' },
    ]);
    // Without isAttached (no attachment data), images are not checked.
    expect(runChecks({ ...d, isAttached: undefined })).toEqual([]);
  });
  it('lists at most the limit, and counts every check', () => {
    const t = type('t', 'thing', null, [f('name', 'text', { required: true })]);
    const many = Array.from({ length: CHECKS_LIMIT + 7 }, (_, i) => entry(`e${i}`, 't', `k${i}`));
    const r = runChecksFull(data({ types: [t], entries: many }));
    expect(CHECKS_LIMIT).toBe(1000);
    expect(r.checks).toHaveLength(1000);
    expect(r.total).toBe(1007);
    expect(r.checks[0]).toEqual({ entry: 'k0', problem: 'missing_required', detail: 'name' });
    const small = runChecksFull(data({ types: [t], entries: many.slice(0, 5) }), 2);
    expect([small.checks.length, small.total]).toEqual([2, 5]);
  });
});

describe('hasCycle', () => {
  const parents: Record<string, string | null> = { A: null, B: 'A', C: 'B' };
  const parentOf = (id: string) => parents[id] ?? null;
  it('detects a cycle', () => {
    expect(hasCycle(parentOf, 'A', 'B')).toBe(true);
    expect(hasCycle(parentOf, 'A', 'C')).toBe(true);
    expect(hasCycle(parentOf, 'A', 'A')).toBe(true);
  });
  it('allows a clean move', () => {
    expect(hasCycle(parentOf, 'C', 'A')).toBe(false);
  });
});

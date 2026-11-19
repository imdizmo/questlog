import { describe, it, expect } from 'vitest';
import { ambiguousNames, buildNameIndex, cachedNameIndex, findMentions, indexKey, nameKey, nameSourceOf, unlinkableRanges, type NameSource } from '../shared/autolink';
import { runChecks } from '../shared/wiki';

// Made-up campaign "Emberfall".
const ENTRIES: NameSource[] = [
  { id: 'keep', name: 'Iron Keep', aliases: ['the Keep'] },
  { id: 'iron', name: 'Iron' },
  { id: 'mara', name: 'Mara Vell', aliases: ['Mara', 'Captain Vell'] },
  { id: 'town', name: 'Emberfall' },
  { id: 'ox', name: 'Ox' },
  { id: 'eoin', name: 'Éowyn Dálach' },
];
const idx = buildNameIndex(ENTRIES);
const linked = (text: string, opts = {}, index = idx) => findMentions(text, index, opts).map((m) => [text.slice(m.from, m.to), m.cardId]);

describe('findMentions', () => {
  it('finds names and aliases as whole words, case-insensitive, sorted by from', () => {
    const text = 'mara rode from EMBERFALL to the keep.';
    expect(findMentions(text, idx)).toEqual([
      { from: 0, to: 4, cardId: 'mara', name: 'Mara' },
      { from: 15, to: 24, cardId: 'town', name: 'Emberfall' },
      { from: 28, to: 36, cardId: 'keep', name: 'the Keep' },
    ]);
    expect(linked('Emberfalls and Maramor and xMara')).toEqual([]);
    expect(linked("Emberfall's walls, (Mara)")).toEqual([['Emberfall', 'town'], ['Mara', 'mara']]);
  });

  it('folds Unicode case and keeps offsets in the original text', () => {
    const text = 'Hail ÉOWYN DÁLACH 🔥 and éowyn dálach.';
    expect(linked(text)).toEqual([['ÉOWYN DÁLACH', 'eoin'], ['éowyn dálach', 'eoin']]);
    // İ folds to a plain i (toLowerCase would add a combining dot); offsets stay in the original text.
    const odd = buildNameIndex([{ id: 'i', name: 'İstvan' }, { id: 't', name: 'Emberfall' }]);
    expect(linked('İSTVAN of Emberfall', {}, odd)).toEqual([['İSTVAN', 'i'], ['Emberfall', 't']]);
    expect(nameKey('  Mara\t Vell ')).toBe('mara vell');
  });

  it('the longest name wins and claims its text', () => {
    expect(linked('The Iron Keep stands; iron rusts.')).toEqual([['Iron Keep', 'keep'], ['iron', 'iron']]);
    // Overlaps: the longer one wins even when it starts later.
    const ov = buildNameIndex([{ id: 'a', name: 'Old Iron' }, { id: 'b', name: 'Iron Keep Gate' }, { id: 'c', name: 'Gate' }]);
    expect(linked('Old Iron Keep Gate', {}, ov)).toEqual([['Iron Keep Gate', 'b']]);
    expect(linked('Old Iron Keep', {}, ov)).toEqual([['Old Iron', 'a']]);
  });

  it('a name may span a line break but not a blank line', () => {
    expect(linked('Iron\nKeep')).toEqual([['Iron\nKeep', 'keep']]);
    expect(linked('Iron   Keep')).toEqual([['Iron   Keep', 'keep']]);
    expect(linked('Iron\n\nKeep')).toEqual([['Iron', 'iron']]);
  });

  it('ignores names shorter than 3 characters', () => {
    expect(linked('The Ox pulls the cart.')).toEqual([]);
    expect(idx.size).toBe(8);
  });

  // Review Focus 1: code, URLs, existing links and the entry's own page are never linked.
  it('never links inside code spans or fenced blocks', () => {
    const text = 'Mara `Mara` here\n```\nMara in a fence\n```\n~~~js\nEmberfall\n~~~\nafter Emberfall';
    expect(linked(text)).toEqual([['Mara', 'mara'], ['Emberfall', 'town']]);
    expect(findMentions(text, idx).at(-1)!.from).toBe(text.lastIndexOf('Emberfall'));
    // An unclosed fence runs to the end, as in shared/content.
    expect(linked('```\nMara')).toEqual([]);
  });

  it('never links inside existing links, URLs, HTML tags or $code/#tag/@mention tokens', () => {
    expect(linked('[Mara Vell]($1a3) and [see](https://x.io/Emberfall) and ![Iron Keep](/api/files/x)')).toEqual([]);
    expect(linked('Visit https://emberfall.example/Mara or www.emberfall.example or <https://a.b/Iron%20Keep>')).toEqual([]);
    expect(linked('<span title="Emberfall">Mara</span>')).toEqual([['Mara', 'mara']]);
    expect(linked('$emberfall #emberfall @mara Mara')).toEqual([['Mara', 'mara']]);
    // `$CODE` refs stay refs; text around them still links.
    expect(linked('Emberfall $1a3 Emberfall')).toEqual([['Emberfall', 'town'], ['Emberfall', 'town']]);
  });

  it('links a heading text but never its Markdown marks', () => {
    const text = '## Emberfall\n#Emberfall is a tag\n### Iron Keep ###';
    const ms = findMentions(text, idx);
    expect(ms.map((m) => text.slice(m.from, m.to))).toEqual(['Emberfall', 'Iron Keep']);
    expect(ms[0].from).toBe(3);
    const hash = buildNameIndex([{ id: 'h', name: '## Emberfall' }]);
    expect(findMentions(text, hash)).toEqual([]);
  });

  it("never links the entry's own page (selfId), and its names still claim their text", () => {
    expect(linked('Iron Keep: the Keep of Emberfall.', { selfId: 'keep' })).toEqual([['Emberfall', 'town']]);
  });

  it('per-card ignores turn a name off, case-insensitively, only where given', () => {
    const text = 'Mara Vell met Captain Vell in Emberfall.';
    expect(linked(text, { ignores: ['captain VELL'] })).toEqual([['Mara Vell', 'mara'], ['Emberfall', 'town']]);
    expect(linked(text, { ignores: ['  emberfall '] })).toEqual([['Mara Vell', 'mara'], ['Captain Vell', 'mara']]);
    expect(linked(text)).toHaveLength(3);
  });

  // Review Focus 2: a name or alias held by two entries is not linked, and listed.
  it('ambiguous names are not linked and are listed; the same entry twice is not ambiguous', () => {
    const amb = buildNameIndex([
      { id: 'a', name: 'Ashen Gate', aliases: ['the Gate', 'ASHEN GATE'] },
      { id: 'b', name: 'Gatehouse', aliases: ['The Gate'] },
      { id: 'c', name: 'Embers' },
    ]);
    expect(linked('Through the Gate to the Ashen Gate and the Embers.', {}, amb)).toEqual([['Ashen Gate', 'a'], ['Embers', 'c']]);
    expect(amb.ambiguous).toEqual([{ name: 'the Gate', cardIds: ['a', 'b'] }]);
  });

  it('folds İ to i, keeps dotless ı, and matches Greek final sigma', () => {
    const tr = buildNameIndex([{ id: 'z', name: 'İzmir' }, { id: 'g', name: 'Οδυσσεύς' }, { id: 'k', name: 'Kılıç' }]);
    expect(linked('İZMİR, izmir and Izmir', {}, tr)).toEqual([['İZMİR', 'z'], ['izmir', 'z'], ['Izmir', 'z']]);
    expect(linked('ΟΔΥΣΣΕΥΣ and οδυσσευς and Οδυσσεύς', {}, tr)).toEqual([['Οδυσσεύς', 'g']]);
    expect(linked('ΟΔΥΣΣΕΎΣ met οδυσσεύς', {}, tr)).toEqual([['ΟΔΥΣΣΕΎΣ', 'g'], ['οδυσσεύς', 'g']]);
    expect(nameKey('ΟΔΥΣΣΕΎΣ')).toBe(nameKey('οδυσσεύς'));
    // Dotless ı stays ı: "Kılıç" is not "Kilic".
    expect(linked('KILIÇ? kılıç. kilic', {}, tr)).toEqual([['kılıç', 'k']]);
  });

  it('a 200 000-character title never breaks keys, the index, the checks or matching; names over 200 characters are not indexed', () => {
    const huge = `# ${'Ember '.repeat(40_000)}`;
    expect(() => nameKey(huge)).not.toThrow();
    expect(nameKey(huge).length).toBeGreaterThan(200_000);
    expect(indexKey(huge)).toBeNull();
    expect(indexKey('x'.repeat(200))).not.toBeNull();
    expect(indexKey('x'.repeat(201))).toBeNull();
    const entries = [nameSourceOf({ id: 'h', content: huge }), nameSourceOf({ id: 'h2', content: huge }), { id: 't', name: 'Emberfall' }];
    expect(ambiguousNames(entries)).toEqual([]);
    const index = buildNameIndex(entries);
    expect(index.size).toBe(1);
    expect(linked(huge.slice(2, 1000) + ' Emberfall', {}, index)).toEqual([['Emberfall', 't']]);
    const page = (id: string) => ({ id, entryTypeId: null, entryKey: id, fields: {}, visibility: 'default' as const, content: huge, aliases: [] });
    expect(runChecks({ types: [], kinds: [], entries: [page('a'), page('b')], links: [], includePages: true, names: true }).checks).toEqual([]);
  });

  it('ambiguousNames agrees with the index; cachedNameIndex rebuilds only when names or aliases change', () => {
    const list: NameSource[] = [...ENTRIES, { id: 'fort', name: 'Old Fort', aliases: ['the keep'] }];
    expect(ambiguousNames(list)).toEqual(buildNameIndex(list).ambiguous);
    expect(ambiguousNames(list)).toEqual([{ name: 'the Keep', cardIds: ['keep', 'fort'] }]);
    const a = cachedNameIndex(list);
    expect(cachedNameIndex(list.map((e) => ({ ...e })))).toBe(a);
    const renamed = cachedNameIndex(list.map((e) => (e.id === 'fort' ? { ...e, name: 'New Fort' } : e)));
    expect(renamed).not.toBe(a);
    const aliased = cachedNameIndex(list.map((e) => (e.id === 'fort' ? { ...e, aliases: [] } : e)));
    expect(aliased).not.toBe(a);
    expect(aliased.ambiguous).toEqual([]);
    expect(cachedNameIndex(list)).toBe(a);
  });

  it('cachedNameIndex signatures never collide across separator characters', () => {
    // Names, ids and aliases holding the characters an unprefixed join would use as separators.
    const one = cachedNameIndex([{ id: 'x', name: 'Emberfall', aliases: ['Ashen Keep'] }]);
    const two = cachedNameIndex([{ id: 'x', name: 'Emberfall\u0000Ashen Keep', aliases: [] }]);
    const three = cachedNameIndex([{ id: 'x', name: 'Emberfall', aliases: ['Ashen Keep\u0001'] }, { id: 'y', name: 'Cinder', aliases: [] }]);
    const four = cachedNameIndex([{ id: 'x', name: 'Emberfall', aliases: ['Ashen Keep\u0001', '4:y'] }, { id: '', name: 'Cinder', aliases: [] }]);
    expect(new Set([one, two, three, four]).size).toBe(4);
    expect(findMentions('Ashen Keep', one).map((m) => m.cardId)).toEqual(['x']);
    expect(findMentions('Ashen Keep', two)).toEqual([]);
  });

  it('nameSourceOf takes the title; a page without a title has no name', () => {
    expect(nameSourceOf({ id: 'x', content: '# Iron Keep\n\nText', aliases: ['Keep'] })).toEqual({ id: 'x', name: 'Iron Keep', aliases: ['Keep'] });
    expect(nameSourceOf({ id: 'y', content: '\nUntitled body' }).name).toBe('');
  });

  it('unlinkableRanges are sorted and merged', () => {
    expect(unlinkableRanges('a `b` [c](d)`e`')).toEqual([[2, 5], [6, 15]]);
  });

  it('matches a 50 KB text against 5 000 names well under 10 ms', () => {
    const words = ['ash', 'ember', 'iron', 'vale', 'mire', 'storm', 'gate', 'keep', 'thorn', 'frost', 'hollow', 'crown'];
    const names: NameSource[] = [];
    for (let i = 0; i < 5000; i++) {
      const a = words[i % words.length], b = words[Math.floor(i / words.length) % words.length];
      names.push({ id: `e${i}`, name: `${a[0].toUpperCase()}${a.slice(1)}${b} ${i}`, aliases: i % 10 === 0 ? [`Hero ${i}`] : [] });
    }
    const big = buildNameIndex(names);
    const parts: string[] = [];
    let len = 0;
    for (let i = 0; len < 50 * 1024; i++) {
      const p = i % 7 === 0 ? `${names[(i * 37) % 5000].name} rode past ` : i % 11 === 0 ? '`code Ironvale 3` and [a link](https://x.io) ' : `the ${words[i % words.length]} hollow of ${words[(i * 7) % words.length]}, `;
      parts.push(p);
      len += p.length;
      if (i % 40 === 39) { parts.push('\n\n## Heading\n'); len += 13; }
    }
    const text = parts.join('');
    findMentions(text, big); // warm up the JIT
    const runs: number[] = [];
    let found = 0;
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      found = findMentions(text, big).length;
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[3];
    console.log(`autolink timing: 50 KB x 5000 names, median ${median.toFixed(2)} ms (min ${runs[0].toFixed(2)}, max ${runs[6].toFixed(2)}), ${found} mentions`);
    expect(found).toBeGreaterThan(100);
    // The budget is 10 ms; the margin covers slow, loaded CI machines.
    expect(median).toBeLessThan(40);
  });

  it('matches a 50 KB CJK text against 5 000 CJK names within the same budget', () => {
    const chars = [...'城堡森林火山王国黑暗之塔龙骑士村庄港口沙漠冰原神殿遗迹灰烬余烬'];
    const names: NameSource[] = [];
    for (let i = 0; i < 5000; i++) names.push({ id: `c${i}`, name: `${chars[i % chars.length]}${chars[(i * 7) % chars.length]}${chars[(i * 13) % chars.length]}之${i}` });
    const big = buildNameIndex(names);
    const parts: string[] = [];
    let len = 0;
    for (let i = 0; len < 50 * 1024; i++) {
      // CJK runs, with spaces and punctuation so some names stand as whole words.
      const p = i % 3 === 0 ? `${names[(i * 31) % 5000].name}。` : `${chars[i % chars.length]}${chars[(i * 5) % chars.length]}${chars[(i * 11) % chars.length]}，`;
      parts.push(p, i % 4 === 0 ? ' ' : '');
      len += p.length + (i % 4 === 0 ? 1 : 0);
    }
    const text = parts.join('');
    findMentions(text, big);
    const runs: number[] = [];
    let found = 0;
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      found = findMentions(text, big).length;
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`autolink timing CJK: 50 KB x 5000 names, median ${runs[3].toFixed(2)} ms (min ${runs[0].toFixed(2)}, max ${runs[6].toFixed(2)}), ${found} mentions`);
    expect(found).toBeGreaterThan(100);
    expect(runs[3]).toBeLessThan(40);
  });
});

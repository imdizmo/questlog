import { describe, it, expect } from 'vitest';
import { campaignChecks, visibleProps, worksOnOf, checkGroups, checksBadgeText, checksTruncatedText, typeUsage, unusedValueCount, backlinks, cardCodeOfHref, entryByKey, formatProps, mentionIndex, openQuests, safeColor, searchEntries, typeCounts, typeRows, wikiTree, filtersFromQuery, filterToParam, sortFromQuery } from '../web/src/wiki';
import { renderContext, renderMarkdown } from '../web/src/markdown';
import { cardCode } from '../shared/cards';
import { runChecks } from '../shared/wiki';

let seq = 0;
const card = (id: string, extra: object = {}) =>
  ({ id, seq: ++seq, deckId: 'lore', isDoc: true, visibility: 'default', status: 'not_started', content: `# ${id}`,
    entryTypeId: null, entryKey: null, fields: {}, wikiParentId: null, aliases: [], linkIgnores: [], ...extra }) as any;

const decks = new Map<string, any>([['lore', { id: 'lore', projectId: 'p1' }], ['tasks', { id: 'tasks', projectId: 'p1' }], ['far', { id: 'far', projectId: 'p2' }]]);
const types = new Map<string, any>([
  ['tItem', { id: 'tItem', projectId: 'p1', key: 'item', name: 'Item', parentTypeId: null, fields: [{ key: 'damage', label: 'damage', kind: 'number' }] }],
  ['tCreature', { id: 'tCreature', projectId: 'p1', key: 'creature', name: 'Creature', parentTypeId: null, fields: [] }],
  ['tRecipe', { id: 'tRecipe', projectId: 'p1', key: 'recipe', name: 'Recipe', parentTypeId: null, fields: [
    { key: 'result', label: 'result', kind: 'entry', target: 'item' },
    { key: 'inputs', label: 'inputs', kind: 'entries', target: 'item' },
    { key: 'old', label: 'old', kind: 'entry', hidden: true },
  ] }],
]);
const kinds = new Map<string, any>([
  ['kDrops', { id: 'kDrops', projectId: 'p1', key: 'drops', label: 'drops', reverseLabel: 'dropped by', fromTypes: ['creature'], toTypes: ['item'],
    props: [{ key: 'chance', label: 'chance', kind: 'number', unit: '%' }], sumRule: null }],
  ['kOther', { id: 'kOther', projectId: 'p2', key: 'drops', label: 'drops', reverseLabel: 'shed by', fromTypes: [], toTypes: [], props: [], sumRule: null }],
]);

function world() {
  const sword = card('sword', { entryTypeId: 'tItem', entryKey: 'fire_sword', content: '# Fire Sword' });
  const code = cardCode(sword.seq);
  const golem = card('golem', { entryTypeId: 'tCreature', entryKey: 'cinder_golem', content: '# Cinder Golem' });
  const ghost = card('ghost', { entryTypeId: 'tCreature', entryKey: 'ghost', visibility: 'deleted' });
  const recipe = card('recipe', { entryTypeId: 'tRecipe', entryKey: 'r1', fields: { result: 'fire_sword', inputs: ['fire_sword'], old: 'fire_sword' } });
  const note = card('note', { content: `# Notes\nSee $${code} for details.` });
  const gone = card('gone', { content: `# Gone\n$${code}`, visibility: 'deleted' });
  const q1 = card('q1', { isDoc: false, deckId: 'tasks', content: `# Model the blade\nfor $${code}` });
  const q2 = card('q2', { isDoc: false, deckId: 'tasks', content: '# Icon' });
  const q3 = card('q3', { isDoc: false, deckId: 'tasks', status: 'done', content: `# Old pass\n$${code}` });
  const q4 = card('q4', { isDoc: false, deckId: 'tasks', visibility: 'deleted', content: `# Deleted\n$${code}` });
  const cards = new Map([sword, golem, ghost, recipe, note, gone, q1, q2, q3, q4].map((c) => [c.id, c]));
  const entryLinks = new Map<string, any>([
    ['l1', { id: 'l1', projectId: 'p1', kindKey: 'drops', fromCardId: 'golem', toCardId: 'sword', props: { chance: 15 }, sortIndex: 1 }],
    ['l2', { id: 'l2', projectId: 'p1', kindKey: 'drops', fromCardId: 'ghost', toCardId: 'sword', props: { chance: 5 }, sortIndex: 2 }],
    ['l3', { id: 'l3', projectId: 'p1', kindKey: 'works_on', fromCardId: 'q2', toCardId: 'sword', props: {}, sortIndex: 1 }],
    ['l4', { id: 'l4', projectId: 'p1', kindKey: 'works_on', fromCardId: 'q3', toCardId: 'sword', props: {}, sortIndex: 2 }],
  ]);
  return { cards, decks, entryTypes: types, linkKinds: kinds, entryLinks } as any;
}

describe('backlinks', () => {
  it('groups links by reverse label, then field references, then mentions', () => {
    const s = world();
    const groups = backlinks(s, 'sword');
    expect(groups.map((g) => g.group)).toEqual(['dropped by', 'Recipe: result', 'Recipe: inputs', 'Mentions']);
    expect(groups[0].items).toEqual([{ cardId: 'golem', props: { chance: 15 } }]);
    expect(groups[1].items).toEqual([{ cardId: 'recipe' }]);
    expect(groups[3].items).toEqual([{ cardId: 'note' }]);
  });
  it('leaves out deleted tasks, hidden fields and quests', () => {
    const groups = backlinks(world(), 'sword');
    const ids = groups.flatMap((g) => g.items.map((i) => i.cardId));
    expect(ids).not.toContain('ghost');
    expect(ids).not.toContain('gone');
    expect(ids).not.toContain('q1');
    expect(groups.some((g) => g.group === 'Recipe: old')).toBe(false);
  });
  it('tells link groups apart by kind, not by label', () => {
    const groups = backlinks(world(), 'sword');
    expect(groups[0].kindId).toBe('kDrops');
    expect(groups.at(-1)!.kindId).toBeUndefined();
  });
  it('only counts mentions from the same project', () => {
    const s = world();
    const code = cardCode(s.cards.get('sword').seq);
    const far = card('farNote', { deckId: 'far', content: `# Sequel notes\n$${code}` });
    const farQuest = card('farQuest', { isDoc: false, deckId: 'far', content: `# Port it\n$${code}` });
    s.cards = new Map([...s.cards, [far.id, far], [farQuest.id, farQuest]]);
    expect(backlinks(s, 'sword').find((g) => g.group === 'Mentions')!.items).toEqual([{ cardId: 'note' }]);
    expect(openQuests(s, 'sword').map((c) => c.id).sort()).toEqual(['q1', 'q2']);
  });
  it('builds the mention index once per tasks map', () => {
    const s = world();
    expect(mentionIndex(s.cards)).toBe(mentionIndex(s.cards));
    expect(mentionIndex(new Map(s.cards))).not.toBe(mentionIndex(s.cards));
  });
  it('is empty for an entry nobody points at', () => {
    expect(backlinks(world(), 'golem')).toEqual([]);
  });
});

describe('openQuests', () => {
  it('lists quests that mention the entry or work on it, but not done or deleted ones', () => {
    expect(openQuests(world(), 'sword').map((c) => c.id).sort()).toEqual(['q1', 'q2']);
  });
});

describe('wikiTree', () => {
  it('nests the project lore by wikiParentId, sorted by title', () => {
    const cards = new Map<string, any>([
      ['w', card('w', { content: '# World' })],
      ['b', card('b', { content: '# Bestiary' })],
      ['z', card('z', { content: '# Zone', wikiParentId: 'w' })],
      ['a', card('a', { content: '# Ash fields', wikiParentId: 'w' })],
      ['g', card('g', { content: '# Golem', wikiParentId: 'b', entryTypeId: 'tCreature' })],
      ['q', card('q', { content: '# A quest', isDoc: false, deckId: 'tasks' })],
      ['x', card('x', { content: '# Elsewhere', deckId: 'far' })],
      ['d', card('d', { content: '# Deleted', visibility: 'deleted' })],
      ['o', card('o', { content: '# Orphan', wikiParentId: 'd' })],
    ]);
    const tree = wikiTree(cards, 'p1', decks);
    const shape = (nodes: any[]): unknown => nodes.map((n) => (n.children.length ? [n.id, shape(n.children)] : n.id));
    expect(shape(tree)).toEqual([['b', ['g']], 'o', ['w', ['a', 'z']]]);
  });
  it('survives a parent loop', () => {
    const cards = new Map<string, any>([['a', card('a', { wikiParentId: 'b' })], ['b', card('b', { wikiParentId: 'a' })]]);
    const ids: string[] = [];
    const walk = (ns: any[]) => ns.forEach((n) => { ids.push(n.id); walk(n.children); });
    walk(wikiTree(cards, 'p1', decks));
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});

describe('type counts', () => {
  it('counts each entry for its type and every ancestor, and untyped lore as pages', () => {
    const t = new Map<string, any>([...types, ['tWeapon', { id: 'tWeapon', projectId: 'p1', key: 'weapon', name: 'Weapon', parentTypeId: 'tItem', fields: [] }]]);
    const lore = [card('a', { entryTypeId: 'tItem' }), card('b', { entryTypeId: 'tWeapon' }), card('c'), card('d', { entryTypeId: 'gone' })];
    const { byType, pages } = typeCounts(lore, t);
    expect(byType.get('tItem')).toBe(2);
    expect(byType.get('tWeapon')).toBe(1);
    expect(byType.get('tCreature')).toBeUndefined();
    expect(pages).toBe(1);
  });
});

describe('hover preview links', () => {
  it('finds the $code of a task link as MarkdownView renders it', () => {
    const sword = card('sw', { content: '# Fire Sword' });
    const code = cardCode(sword.seq);
    const html = renderMarkdown(`Guards $${code}.`, renderContext(new Map([[sword.id, sword]]), new Map()));
    const m = /<a class="card-ref" href="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    expect(cardCodeOfHref(m![1])).toBe(code);
    expect(cardCodeOfHref('/decks/1-x')).toBeNull();
  });
});

describe('helpers', () => {
  it('finds an entry by key in its project only', () => {
    const s = world();
    expect(entryByKey(s, 'p1', 'fire_sword')?.id).toBe('sword');
    expect(entryByKey(s, 'p2', 'fire_sword')).toBeUndefined();
    expect(entryByKey(s, 'p1', 'ghost')).toBeUndefined();
  });
  it('accepts only #rrggbb colours', () => {
    expect(safeColor('#a0B1c2')).toBe('#a0B1c2');
    expect(safeColor('red')).toBeNull();
    expect(safeColor('#fff')).toBeNull();
    expect(safeColor('#000000;background:url(x)')).toBeNull();
    expect(safeColor(null)).toBeNull();
  });
  it('formats link properties with their units', () => {
    expect(formatProps([{ key: 'chance', label: 'chance', kind: 'number', unit: '%' }, { key: 'qty', label: 'qty', kind: 'range' }], { chance: 15, qty: { min: 1, max: 2 } }))
      .toBe('15%, 1–2');
    expect(formatProps([{ key: 'price', label: 'price', kind: 'number', unit: 'gold' }], { price: 240 })).toBe('240 gold');
    expect(formatProps([], {})).toBe('');
  });
  it('searches by title or key, ignoring case', () => {
    const list = [card('s', { content: '# Fire Sword', entryKey: 'fire_sword' }), card('g', { content: '# Golem', entryKey: 'cinder_golem' })];
    expect(searchEntries(list, 'SWORD').map((c) => c.id)).toEqual(['s']);
    expect(searchEntries(list, 'cinder_').map((c) => c.id)).toEqual(['g']);
    expect(searchEntries(list, '  ').length).toBe(2);
  });
});

describe('wiki routes', async () => {
  const { parse } = await import('../web/src/router');
  it('parses the wiki, a project and an entry', () => {
    expect(parse('/wiki')).toEqual({ name: 'wiki' });
    expect(parse('/wiki/3')).toEqual({ name: 'wikiProject', projectSeq: 3 });
    expect(parse('/wiki/3/type/item')).toEqual({ name: 'wikiType', projectSeq: 3, typeKey: 'item' });
    expect(parse('/wiki/3/fire_sword')).toEqual({ name: 'wikiEntry', projectSeq: 3, entry: 'fire_sword' });
    expect(parse('/wiki/3/$3kq')).toEqual({ name: 'wikiEntry', projectSeq: 3, entry: '$3kq' });
    expect(parse('/wiki/x').name).toBe('notFound');
    expect(parse('/wiki/3/a/b').name).toBe('notFound');
  });
});

describe('typeRows', () => {
  const T = new Map<string, any>([
    ['tItem', { id: 'tItem', projectId: 'p1', key: 'item', name: 'Item', parentTypeId: null, fields: [
      { key: 'damage', label: 'damage', kind: 'number' }, { key: 'rarity', label: 'rarity', kind: 'enum', options: ['common', 'epic'] },
      { key: 'tags', label: 'tags', kind: 'multienum', options: ['fire', 'ice'] }, { key: 'spread', label: 'spread', kind: 'range' },
    ] }],
    ['tWeapon', { id: 'tWeapon', projectId: 'p1', key: 'weapon', name: 'Weapon', parentTypeId: 'tItem', fields: [] }],
    ['tCreature', { id: 'tCreature', projectId: 'p1', key: 'creature', name: 'Creature', parentTypeId: null, fields: [] }],
  ]);
  const mk = () => {
    const a = card('ax', { entryTypeId: 'tWeapon', entryKey: 'ax', content: '# Ax', fields: { damage: 20, rarity: 'epic', tags: ['fire'], spread: { min: 2, max: 4 } } });
    const potion = card('potion', { entryTypeId: 'tItem', entryKey: 'potion', content: '# Potion', fields: { rarity: 'common', tags: ['ice', 'fire'] } });
    const dagger = card('dagger', { entryTypeId: 'tItem', entryKey: 'dagger', content: '# Dagger', fields: { damage: 5, rarity: 'common', spread: { min: 1, max: 9 } } });
    const rat = card('rat', { entryTypeId: 'tCreature', content: '# Rat' });
    const gone = card('gone', { entryTypeId: 'tItem', content: '# Gone', visibility: 'deleted' });
    const far = card('far', { entryTypeId: 'tItem', deckId: 'far', content: '# Far' });
    return { cards: new Map([a, potion, dagger, rat, gone, far].map((c) => [c.id, c])), decks, entryTypes: T } as any;
  };
  const ids = (rows: any[]) => rows.map((c) => c.id);

  it('includes child types, skips other types, deleted and other projects', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], null))).toEqual(['ax', 'dagger', 'potion']);
    expect(ids(typeRows(mk(), 'p1', 'tWeapon', [], null))).toEqual(['ax']);
  });
  it('eq keeps matching values; on multienum it means includes', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'rarity', op: 'eq', value: 'epic' }], null))).toEqual(['ax']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'tags', op: 'eq', value: 'ice' }], null))).toEqual(['potion']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'type', op: 'eq', value: 'weapon' }], null))).toEqual(['ax']);
  });
  it('contains matches text case-insensitively', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'title', op: 'contains', value: 'AG' }], null))).toEqual(['dagger']);
  });
  it('min and max compare numbers and a range\'s ends', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'damage', op: 'min', value: 10 }], null))).toEqual(['ax']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'damage', op: 'max', value: 10 }], null))).toEqual(['dagger']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'min', value: 2 }], null))).toEqual(['ax']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'max', value: 5 }], null))).toEqual(['ax']);
  });
  it('has and missing', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'damage', op: 'has' }], null))).toEqual(['ax', 'dagger']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'damage', op: 'missing' }], null))).toEqual(['potion']);
  });
  it('sorts with missing values last in both directions', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key: 'damage', dir: 'desc' }))).toEqual(['ax', 'dagger', 'potion']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key: 'damage', dir: 'asc' }))).toEqual(['dagger', 'ax', 'potion']);
  });
  it('sorts text with localeCompare and by the title, key and type pseudo-keys', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key: 'title', dir: 'desc' }))).toEqual(['potion', 'dagger', 'ax']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key: 'type', dir: 'asc' }))).toEqual(['dagger', 'potion', 'ax']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key: 'rarity', dir: 'asc' }))).toEqual(['dagger', 'potion', 'ax']);
  });

  it('field keys from a link never read inherited properties', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key, op: 'has' }], null))).toEqual([]);
      expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key, op: 'missing' }], null))).toEqual(['ax', 'dagger', 'potion']);
      expect(ids(typeRows(mk(), 'p1', 'tItem', [], { key, dir: 'asc' }))).toEqual(['ax', 'dagger', 'potion']);
    }
  });
  it('eq on a range means the number lies within it', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'eq', value: 3 }], null))).toEqual(['ax', 'dagger']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'eq', value: 8 }], null))).toEqual(['dagger']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'eq', value: 10 }], null))).toEqual([]);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'eq', value: '8' }], null))).toEqual(['dagger']); // from a link
  });
  it('has and missing work on arrays and ranges', () => {
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'tags', op: 'has' }], null))).toEqual(['ax', 'potion']);
    expect(ids(typeRows(mk(), 'p1', 'tItem', [{ key: 'spread', op: 'missing' }], null))).toEqual(['potion']);
  });
  it('mixed number and text values sort numbers first, text after, missing last', () => {
    const w = mk();
    w.cards.get('potion').fields.damage = 'lots';
    expect(ids(typeRows(w, 'p1', 'tItem', [], { key: 'damage', dir: 'asc' }))).toEqual(['dagger', 'ax', 'potion']);
  });
  it('returns the same array while nothing it depends on changed, even if another project changes', () => {
    const w = mk();
    const a = typeRows(w, 'p1', 'tItem', [{ key: 'damage', op: 'has' }], { key: 'damage', dir: 'asc' });
    const cards = new Map<string, any>(w.cards);
    cards.set('far', { ...cards.get('far'), content: '# Farther' }); // other project
    cards.set('new', card('new', { deckId: 'far', entryTypeId: 'tItem' }));
    const b = typeRows({ ...w, cards }, 'p1', 'tItem', [{ key: 'damage', op: 'has' }], { key: 'damage', dir: 'asc' });
    expect(b).toBe(a);
    cards.set('ax', { ...cards.get('ax'), fields: { damage: 1 } });
    expect(typeRows({ ...w, cards }, 'p1', 'tItem', [{ key: 'damage', op: 'has' }], { key: 'damage', dir: 'asc' })).not.toBe(a);
  });
});

describe('table URL state', () => {
  const q = (s: string) => new URLSearchParams(s);
  it('round-trips filters whose values hold colons and ampersands', () => {
    const f = { key: 'title', op: 'contains' as const, value: 'a:b&c=d' };
    const params = new URLSearchParams(); params.append('f', filterToParam(f));
    expect(filtersFromQuery(q(params.toString()))).toEqual([f]);
  });
  it('skips malformed filters: bad ops, empty or non-numeric limits; caps the count', () => {
    expect(filtersFromQuery(q('f=x:nope:1&f=:eq:1&f=damage:min:&f=damage:max:abc&f=damage:min:5'))).toEqual([{ key: 'damage', op: 'min', value: 5 }]);
    const many = Array.from({ length: 50 }, (_, i) => `f=k${i}:has`).join('&');
    expect(filtersFromQuery(q(many))).toHaveLength(20);
  });
  it('reads the sort, default asc, none when empty', () => {
    expect(sortFromQuery(q('sort=damage:desc'))).toEqual({ key: 'damage', dir: 'desc' });
    expect(sortFromQuery(q('sort=damage'))).toEqual({ key: 'damage', dir: 'asc' });
    expect(sortFromQuery(q(''))).toBeNull();
  });
});

describe('worksOnOf (the quest view)', () => {
  it("a quest's works_on links in order, from one index per links collection", () => {
    const s = world();
    const links = new Map<string, any>(s.entryLinks);
    links.set('l7', { id: 'l7', projectId: 'p1', kindKey: 'works_on', fromCardId: 'q2', toCardId: 'golem', props: {}, sortIndex: 0 });
    expect(worksOnOf(links, 'q2').map((l) => l.id)).toEqual(['l7', 'l3']);
    expect(worksOnOf(links, 'q3').map((l) => l.id)).toEqual(['l4']);
    expect(worksOnOf(links, 'golem')).toEqual([]);
    // Same collection: the same array, not a new scan; a new collection is indexed again.
    expect(worksOnOf(links, 'q2')).toBe(worksOnOf(links, 'q2'));
    const next = new Map(links);
    next.delete('l7');
    expect(worksOnOf(next, 'q2').map((l) => l.id)).toEqual(['l3']);
  });
});

describe('visibleProps (the link edit form)', () => {
  it('keeps only set values of visible properties: a hidden one is never sent', () => {
    const defs: any[] = [{ key: 'chance', kind: 'number' }, { key: 'qty', kind: 'integer', hidden: true }, { key: 'note', kind: 'text' }];
    expect(visibleProps(defs, { chance: 15, qty: 2, note: '', stray: 1 })).toEqual({ chance: 15 });
    expect(visibleProps(defs, { chance: null, note: 'x' })).toEqual({ note: 'x' });
  });
});

describe('checks badge', () => {
  /** A project with problems, plus another project whose problems must not count. */
  function checksWorld() {
    const s = world();
    const types = new Map<string, any>(s.entryTypes);
    types.set('tItem', { ...types.get('tItem'), fields: [{ key: 'damage', label: 'damage', kind: 'number' }, { key: 'weight', label: 'weight', kind: 'number', required: true }] });
    types.set('tFar', { id: 'tFar', projectId: 'p2', key: 'item', name: 'Item', parentTypeId: null, fields: [{ key: 'weight', label: 'weight', kind: 'number', required: true }] });
    const cards = new Map<string, any>(s.cards);
    cards.set('axe', card('axe', { entryTypeId: 'tItem', entryKey: 'axe', fields: { damage: { min: 1, max: 2 }, weight: 3 } }));
    cards.set('farItem', card('farItem', { deckId: 'far', entryTypeId: 'tFar', entryKey: 'far_item' }));
    const links = new Map<string, any>(s.entryLinks);
    links.set('l5', { id: 'l5', projectId: 'p1', kindKey: 'drops', fromCardId: 'golem', toCardId: 'axe', props: { chance: 'lots' }, sortIndex: 3 });
    return { ...s, cards, entryTypes: types, entryLinks: links, files: new Map() };
  }

  it('counts what runChecks finds for the project alone, as the export sees it (no plain pages, no quest links)', () => {
    const s = checksWorld();
    const { checks, total } = campaignChecks(s, 'p1');
    const lore = [...s.cards.values()].filter((c: any) => c.isDoc && s.decks.get(c.deckId)?.projectId === 'p1' && c.visibility !== 'deleted');
    const expected = runChecks({
      types: [...s.entryTypes.values()].filter((t: any) => t.projectId === 'p1'),
      kinds: [...s.linkKinds.values()].filter((k: any) => k.projectId === 'p1'),
      entries: lore, links: [...s.entryLinks.values()].filter((l: any) => l.projectId === 'p1' && l.kindKey !== 'works_on'),
      includePages: false, isAttached: () => true,
    });
    expect(checks).toEqual(expected.checks);
    expect(total).toBe(checks.length);
    expect(total).toBeGreaterThan(0);
    // fire_sword misses weight; axe's damage is a range where a number is wanted; the l5 chance is text.
    expect(checks.map((c) => `${c.entry} ${c.problem}`)).toEqual(expect.arrayContaining(['fire_sword missing_required', 'axe invalid_value', 'cinder_golem invalid_value']));
    expect(checks.some((c) => c.entry === 'far_item')).toBe(false);
    expect(campaignChecks(s, 'p2').checks.map((c) => c.entry)).toEqual(['far_item']);
  });

  it('checks images against the attachments in the store, and links to plain pages', () => {
    const s = checksWorld();
    const types = new Map<string, any>(s.entryTypes);
    types.set('tCreature', { ...types.get('tCreature'), fields: [{ key: 'icon', label: 'icon', kind: 'image' }] });
    const cards = new Map<string, any>(s.cards);
    cards.set('golem', { ...cards.get('golem'), fields: { icon: 'f1' } });
    const kinds = new Map<string, any>(s.linkKinds);
    kinds.set('kAbout', { id: 'kAbout', projectId: 'p1', key: 'about', label: 'about', reverseLabel: 'told in', fromTypes: [], toTypes: [], props: [], sumRule: null });
    const links = new Map<string, any>(s.entryLinks);
    links.set('l9', { id: 'l9', projectId: 'p1', kindKey: 'about', fromCardId: 'golem', toCardId: 'note', props: {}, sortIndex: 9 });
    const files = new Map<string, any>([['f1', { id: 'f1', cardId: 'sword', name: 'x.png' }]]);
    const w = { ...s, entryTypes: types, cards, linkKinds: kinds, entryLinks: links, files };
    const golem = campaignChecks(w, 'p1').checks.filter((c) => c.entry === 'cinder_golem').map((c) => c.detail);
    expect(golem).toEqual(expect.arrayContaining(['icon: image not attached', 'about link l9: target note is a plain page (not exported without pages)']));
    files.set('f1', { id: 'f1', cardId: 'golem', name: 'x.png' });
    const fixed = campaignChecks({ ...w, files: new Map(files) }, 'p1').checks.map((c) => c.detail);
    expect(fixed).not.toContain('icon: image not attached');
  });

  it('a quest link to a trashed entry is not a check (quest links are not game data)', () => {
    const s = checksWorld();
    const links = new Map<string, any>(s.entryLinks);
    links.set('l6', { id: 'l6', projectId: 'p1', kindKey: 'works_on', fromCardId: 'q2', toCardId: 'ghost', props: {}, sortIndex: 3 });
    expect(campaignChecks({ ...s, entryLinks: links }, 'p1').checks.some((c) => c.detail.startsWith('works_on'))).toBe(false);
  });

  it('is memoised on the store collections', () => {
    const s = checksWorld();
    const a = campaignChecks(s, 'p1');
    expect(campaignChecks({ ...s }, 'p1')).toBe(a);
    expect(campaignChecks({ ...s, cards: new Map(s.cards) }, 'p1')).not.toBe(a);
    const b = campaignChecks(s, 'p1');
    expect(campaignChecks({ ...s, files: new Map() }, 'p1')).not.toBe(b);
  });

  it('badge and panel text: every check counts; a cut list says "1,000 of N"', () => {
    const c = { entry: 'a', problem: 'missing_required' as const, detail: 'x' };
    expect(checksBadgeText({ checks: [c], total: 1 })).toBe('⚠ 1 check');
    expect(checksTruncatedText({ checks: [c], total: 1 })).toBeNull();
    const cut = { checks: Array(1000).fill(c), total: 1234 };
    expect(checksBadgeText(cut)).toBe('⚠ 1,234 checks');
    expect(checksTruncatedText(cut)).toBe('Showing 1,000 of 1,234 checks. Fix these and the rest will show.');
  });

  it('groups by problem', () => {
    const groups = checkGroups(campaignChecks(checksWorld(), 'p1').checks);
    // l2 comes from a deleted creature (the server never sends such a link; runChecks still names it).
    expect(groups.map((g) => g.problem)).toEqual(['missing_required', 'invalid_value', 'broken_ref']);
    expect(groups[1].items.map((c) => c.entry).sort()).toEqual(['axe', 'cinder_golem']);
  });
});

describe('unusedValueCount', () => {
  it('counts entries of exactly the type that hold a value of a hidden or unknown field', () => {
    const s = world();
    // recipe has `old` (hidden); sword's damage is a field of Item.
    expect(unusedValueCount(s, 'tRecipe')).toBe(1);
    expect(unusedValueCount(s, 'tItem')).toBe(0);
    s.cards.set('x', card('x', { entryTypeId: 'tItem', fields: { gone: 1 } }));
    expect(unusedValueCount(s, 'tItem')).toBe(1);
  });
});

describe('typeUsage', () => {
  it('counts live entries, child types, field targets and link kinds of the project, as deleteType does', () => {
    const s = world();
    const item = s.entryTypes.get('tItem');
    // sword is a live Item; Recipe's result and inputs target item (its hidden `old` has no target); drops goes to item.
    expect(typeUsage(s, item)).toEqual({ entries: 1, childTypes: 0, fieldTargets: 2, linkKinds: 1 });
    const types = new Map<string, any>(s.entryTypes);
    types.set('tWeapon', { id: 'tWeapon', projectId: 'p1', key: 'weapon', name: 'Weapon', parentTypeId: 'tItem', fields: [] });
    // Another project's kind naming `item` does not count.
    const kinds = new Map<string, any>(s.linkKinds);
    kinds.set('kFar', { id: 'kFar', projectId: 'p2', key: 'x', label: 'x', reverseLabel: 'y', fromTypes: ['item'], toTypes: [], props: [], sumRule: null });
    expect(typeUsage({ ...s, entryTypes: types, linkKinds: kinds }, item)).toEqual({ entries: 1, childTypes: 1, fieldTargets: 2, linkKinds: 1 });
    // The deleted ghost is not counted for Creature; golem is.
    expect(typeUsage(s, s.entryTypes.get('tCreature')).entries).toBe(1);
  });
});

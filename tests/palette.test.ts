import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError } from '../web/src/api';
import {
  createErrorText, createLabel, createOptions, isPaletteKey, resolveActive, guessOption, hitView, optionKey, paletteContext, PER_GROUP, readLastType, readRecent, pushRecent,
  recentHits, search, writeLastType, type CreateOption,
} from '../web/src/palette';

// A tiny localStorage for the per-device bits (node has none).
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};
beforeEach(() => mem.clear());

let seq = 1;
const card = (id: string, content: string, extra: object = {}) =>
  ({ id, seq: ++seq, deckId: 'tasks', isDoc: false, visibility: 'default', content, entryTypeId: null, entryKey: null, aliases: [], ...extra }) as any;
const type = (id: string, name: string, extra: object = {}) =>
  ({ id, projectId: 'p1', key: name.toLowerCase().replace(/\W+/g, '_'), name, icon: null, sortIndex: 0, templates: [], ...extra }) as any;

const project = { id: 'p1', seq: 3, name: 'Emberfall', isArchived: false } as any;
const decks = new Map<string, any>([
  ['tasks', { id: 'tasks', seq: 10, projectId: 'p1', title: 'Quests', deckType: 'task', sortIndex: 2 }],
  ['todo', { id: 'todo', seq: 11, projectId: 'p1', title: 'Todo', deckType: 'task', sortIndex: 1 }],
  ['lore', { id: 'lore', seq: 12, projectId: 'p1', title: 'Lore', deckType: 'doc', sortIndex: 0 }],
]);
const place = type('tPlace', 'Place', { icon: '🏰', sortIndex: 1, templates: [{ name: 'Keep', fields: {}, links: [] }, { name: 'Market town', fields: {}, links: [] }] });
const npc = type('tNpc', 'Character', { icon: '🧙', sortIndex: 2, templates: [{ name: 'Blacksmith', fields: {}, links: [] }] });
const quest = type('tQuest', 'Side quest', { sortIndex: 3 });

function world(list: any[] = []) {
  return {
    cards: new Map(list.map((c) => [c.id, c])), decks, projects: new Map([['p1', project]]),
    entryTypes: new Map([[place.id, place], [npc.id, npc], [quest.id, quest]]),
    me: { id: 'u1' }, accountRoles: new Map([['u1', 'owner']]), projectAccess: new Map(),
  } as any;
}

describe('search: ranking and grouping', () => {
  const list = [
    card('t1', '# Forge the Emberfall key'),
    card('t2', '# Emberfall'),
    card('t3', '# Visit theemberfall'),
    card('t4', '# The Emberfall gate', { visibility: 'deleted' }),
    card('e1', '# Emberfall Keep', { isDoc: true, deckId: 'lore', entryTypeId: 'tPlace', entryKey: 'emberfall_keep' }),
    card('e2', '# Ashen Keep', { isDoc: true, deckId: 'lore', entryTypeId: 'tPlace', entryKey: 'ashen_keep', aliases: ['Emberfall Ruins'] }),
    card('l1', '# Chronicle of Emberfall', { isDoc: true, deckId: 'lore' }),
  ];

  it('groups in a fixed order, best match first, deleted cards left out', () => {
    const g = search(world(list), 'emberfall');
    expect(g.map((x) => x.kind)).toEqual(['entry', 'task', 'lore', 'project']);
    expect(g.map((x) => x.label)).toEqual(['Wiki entries', 'Tasks', 'Lore', 'Projects']);
    // Exact, then a word start, then inside a word; the gate is deleted.
    expect(g[1].hits.map((h) => h.id)).toEqual(['t2', 't1', 't3']);
    // A title prefix beats an alias.
    expect(g[0].hits.map((h) => h.id)).toEqual(['e1', 'e2']);
  });

  it('is case- and accent-insensitive by the name folding; every word may match apart', () => {
    expect(search(world(list), 'EMBERFALL KEEP')[0].hits.map((h) => h.id)).toEqual(['e1']);
    expect(search(world(list), 'keep forge')).toEqual([]);
    expect(search(world(list), 'key forge')[0].hits.map((h) => h.id)).toEqual(['t1']);
  });

  it('finds lists and projects, and a task by its id', () => {
    const g = search(world(list), 'quests');
    expect(g.find((x) => x.kind === 'list')!.hits.map((h) => h.id)).toEqual(['tasks']);
    const t1 = list[0];
    const byId = search(world(list), `EM-${t1.seq + 1}`);
    expect(byId[0].hits[0].id).toBe('t1');
  });

  it('caps each group and breaks ties by recency', () => {
    const many = Array.from({ length: 30 }, (_, i) => card(`m${i}`, `# Ember task ${i}`));
    const g = search(world(many), 'ember', ['m29']);
    expect(g[0].hits).toHaveLength(PER_GROUP);
    expect(g[0].hits[0].id).toBe('m29');
  });

  it('an empty query finds nothing (recents are shown instead)', () => {
    expect(search(world(list), '   ')).toEqual([]);
  });

  it('where a hit goes and what it says', () => {
    const s = world(list);
    expect(hitView(s, { kind: 'entry', id: 'e1' })).toEqual({ href: '/wiki/3/emberfall_keep', sub: 'Place · Emberfall', icon: '🏰' });
    expect(hitView(s, { kind: 'task', id: 't2' })!.href).toMatch(/^\/decks\/10-quests\/card\/[0-9a-z]+-emberfall$/);
    expect(hitView(s, { kind: 'task', id: 't2' })!.sub).toBe('Quests · Emberfall');
    expect(hitView(s, { kind: 'lore', id: 'l1' })!.href).toMatch(/^\/wiki\/3\/\$[0-9a-z]+$/);
    expect(hitView(s, { kind: 'project', id: 'p1' })!.href).toBe('/wiki/3');
    expect(hitView(s, { kind: 'task', id: 't4' })).toBeNull();
  });

  it('recents: kept per device, newest first, gone ones skipped', () => {
    pushRecent({ kind: 'card', id: 't1' });
    pushRecent({ kind: 'list', id: 'tasks' });
    pushRecent({ kind: 'card', id: 'gone' });
    pushRecent({ kind: 'card', id: 't1' });
    expect(readRecent().map((r) => r.id)).toEqual(['t1', 'gone', 'tasks']);
    expect(recentHits(world(list), readRecent()).map((h) => `${h.kind}:${h.id}`)).toEqual(['task:t1', 'list:tasks']);
    mem.set('jt:paletteRecent', '{broken');
    expect(readRecent()).toEqual([]);
  });

  it('takes a few ms per keystroke over 10 000 cards', () => {
    const big = Array.from({ length: 10_000 }, (_, i) => card(`b${i}`, `# Quest ${i} of the ${['ashen', 'ember', 'grey', 'iron'][i % 4]} road`, i % 3 ? {} : { isDoc: true, deckId: 'lore', entryTypeId: 'tPlace', aliases: ['Old way'] }));
    const s = world(big);
    search(s, 'x'); // builds the index once
    let ms = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (const q of ['e', 'em', 'emb', 'ember', 'ember r', 'ember ro']) search(s, q);
      ms = Math.min(ms, (performance.now() - t0) / 6);
    }
    expect(search(s, 'ember')[0].hits).toHaveLength(PER_GROUP);
    expect(ms).toBeLessThan(8);
  });
});

describe('the New row', () => {
  const ctx = (s: any, deck: string | null = null) => ({ project, deck: deck ? s.decks.get(deck) : null });
  const keys = (o: CreateOption[]) => o.map(optionKey);

  it('offers the project’s types in order, a page, and a task in the current (or first) list', () => {
    const s = world();
    expect(keys(createOptions(s, ctx(s)))).toEqual(['entry:tPlace', 'entry:tNpc', 'entry:tQuest', 'page', 'task']);
    const first = createOptions(s, ctx(s)).at(-1) as any;
    expect(first.deck.id).toBe('todo'); // the first list that takes tasks
    expect((createOptions(s, ctx(s, 'tasks')).at(-1) as any).deck.id).toBe('tasks');
    expect((createOptions(s, ctx(s, 'lore')).at(-1) as any).deck.id).toBe('todo'); // a lore list takes no tasks
  });

  it('nothing to create without the right to edit the project', () => {
    const s = { ...world(), accountRoles: new Map([['u1', 'guest']]) };
    expect(createOptions(s, ctx(s))).toEqual([]);
    expect(createOptions(world(), { project: null, deck: null })).toEqual([]);
  });

  it('guesses the type from its name, then a template word, else the last created, else a sensible default', () => {
    const s = world();
    const o = createOptions(s, ctx(s));
    const at = (q: string, last: any = null, inList = false) => optionKey(o[guessOption(o, q, last, inList)]);
    expect(at('Ashen Keep')).toBe('entry:tPlace'); // template "Keep"
    expect(at('Grim the blacksmith')).toBe('entry:tNpc'); // template "Blacksmith", any case
    expect(at('A side quest for Mara')).toBe('entry:tQuest'); // a two-word type name
    expect(at('Questing beast')).toBe('entry:tPlace'); // "quest" inside a word is no match: no guess → first type
    expect(at('Character of the keep')).toBe('entry:tNpc'); // a type name beats a template word
    expect(at('Town hall')).toBe('entry:tPlace'); // "Market town": a template's words count one by one
    expect(at('Mara', { kind: 'entry', id: 'tNpc', key: 'x' })).toBe('entry:tNpc');
    expect(at('Mara', { kind: 'entry', id: 'other', key: 'character' })).toBe('entry:tNpc'); // same key, another project
    expect(at('Mara', { kind: 'task' })).toBe('task');
    expect(at('Mara', { kind: 'entry', id: 'gone', key: 'gone' }, true)).toBe('task'); // in a list: a task
    expect(at('Mara', null, false)).toBe('entry:tPlace');
    expect(guessOption([], 'x', null)).toBe(-1);
  });

  it('remembers the last created type per device', () => {
    const s = world();
    const o = createOptions(s, ctx(s));
    expect(readLastType()).toBeNull();
    writeLastType(o[1]);
    expect(readLastType()).toEqual({ kind: 'entry', id: 'tNpc', key: 'character' });
    writeLastType(o.at(-1)!);
    expect(readLastType()).toEqual({ kind: 'task' });
    mem.set('jt:paletteLastType', '"nonsense"');
    expect(readLastType()).toBeNull();
  });

  it('labels', () => {
    const s = world();
    const o = createOptions(s, ctx(s));
    expect(createLabel(o[0], '  Ashen Keep ')).toBe('New Place called “Ashen Keep”');
    expect(createLabel(o.at(-1)!, 'Fix the gate')).toBe('New task called “Fix the gate”');
  });

  it('context: the list and project of the page, else the last wiki project', () => {
    const s = world();
    expect(paletteContext(s, { name: 'deck', deckSeq: 10, slug: '' }).deck?.id).toBe('tasks');
    expect(paletteContext(s, { name: 'wikiProject', projectSeq: 3 }).project?.id).toBe('p1');
    expect(paletteContext(s, { name: 'decks' })).toEqual({ project, deck: null });
  });
});

describe('fix round', () => {
  it('small words in a template name never guess a type', () => {
    const wanderer = type('tW', 'Character', { sortIndex: 1, templates: [{ name: 'The Wanderer', fields: {}, links: [] }] });
    const keep = type('tK', 'Place', { sortIndex: 2, templates: [{ name: 'Keep', fields: {}, links: [] }] });
    const o: CreateOption[] = [wanderer, keep].map((t) => ({ kind: 'entry', type: t, project }));
    expect(optionKey(o[guessOption(o, 'The Ashen Keep', null)])).toBe('entry:tK');
    expect(optionKey(o[guessOption(o, 'The old road', { kind: 'entry', id: 'tK', key: 'place' })])).toBe('entry:tK'); // no guess: the last made
  });

  it('a vanished highlighted hit falls back to a result, never to the New row', () => {
    expect(resolveActive(['task:a', 'task:b', 'new'], 'task:b', 2)).toBe('task:b');
    expect(resolveActive(['task:a', 'new'], 'task:b', 1)).toBe('task:a');
    expect(resolveActive(['new'], 'task:b', 0)).toBeNull();
    expect(resolveActive(['new'], null, 0)).toBeNull();
    expect(resolveActive(['task:a', 'new'], 'new', 1)).toBe('new'); // only when chosen
  });

  it('Ctrl+K, or ⌘K on a Mac; KeyK on a non-Latin layout', () => {
    const k = (o: object) => ({ key: 'k', code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(isPaletteKey(k({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteKey(k({ metaKey: true }), false)).toBe(false);
    expect(isPaletteKey(k({ metaKey: true }), true)).toBe(true);
    expect(isPaletteKey(k({ ctrlKey: true }), true)).toBe(false); // Ctrl+K deletes to the line end on macOS
    expect(isPaletteKey(k({ ctrlKey: true, key: 'л' }), false)).toBe(true);
    expect(isPaletteKey(k({ ctrlKey: true, key: 'v', code: 'KeyK' }), false)).toBe(false); // Dvorak: the key that says v
    expect(isPaletteKey(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it('a failed create says why in plain words', () => {
    expect(createErrorText(new ApiError(403, 'forbidden'))).toBe("You don't have permission to do that.");
    expect(createErrorText(new Error('x'))).toBe('Something went wrong. Try again.');
  });
});

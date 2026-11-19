import { describe, it, expect } from 'vitest';
import { backlinks, campaignNameIndex, nameLinks, namedIn } from '../web/src/wiki';
import { renderContext, renderMarkdown } from '../web/src/markdown';
import { cardCode } from '../shared/cards';

let seq = 100;
const card = (id: string, extra: object = {}) =>
  ({ id, seq: ++seq, deckId: 'lore', isDoc: true, visibility: 'default', status: 'not_started', content: `# ${id}`,
    entryTypeId: null, entryKey: null, fields: {}, wikiParentId: null, aliases: [], linkIgnores: [], ...extra }) as any;

const decks = new Map<string, any>([['lore', { id: 'lore', projectId: 'p1' }], ['tasks', { id: 'tasks', projectId: 'p1' }], ['far', { id: 'far', projectId: 'p2' }]]);
const projects = new Map<string, any>([['p1', { id: 'p1', seq: 7 }], ['p2', { id: 'p2', seq: 8 }]]);

function world(extra: any[] = []) {
  const keep = card('keep', { entryTypeId: 'tPlace', entryKey: 'ashen_keep', content: '# Ashen Keep\nA fort.', aliases: ['the Keep'] });
  const ember = card('ember', { entryTypeId: 'tPlace', entryKey: 'emberfall', content: '# Emberfall' });
  const page = card('page', { content: '# Old Roads' });
  const far = card('far', { deckId: 'far', entryTypeId: 'tPlace', entryKey: 'cinder', content: '# Cinder Vale' });
  const list = [keep, ember, page, far, ...extra];
  return { cards: new Map(list.map((c) => [c.id, c])), decks, projects, entryTypes: new Map(), linkKinds: new Map(), entryLinks: new Map() } as any;
}

/** Renders `text` as the text of card `ownerId` (or of a text of project p1 with no card). */
function render(s: any, text: string, ownerId: string | null = null) {
  const owner = ownerId ? s.cards.get(ownerId) : null;
  const names = nameLinks(s, owner ? decks.get(owner.deckId).projectId : 'p1', owner);
  return renderMarkdown(text, renderContext(s.cards, new Map(), { decks, projects, names }));
}

describe('names as links when reading', () => {
  it('links names and aliases of the same project to the entry pages', () => {
    const out = render(world(), 'We rode from Emberfall to the keep, past Cinder Vale and the Old Roads.');
    expect(out).toContain('<a class="entry-link" href="/wiki/7/emberfall" title="Emberfall" data-name="Emberfall">Emberfall</a>');
    expect(out).toContain('<a class="entry-link" href="/wiki/7/ashen_keep" title="Ashen Keep" data-name="the Keep">the keep</a>');
    // An untyped page links too (by its $code segment); another project's names never do.
    expect(out).toMatch(/<a class="entry-link" href="\/wiki\/7\/\$[0-9a-z]+" title="Old Roads" data-name="Old Roads">Old Roads<\/a>/);
    expect(out).not.toContain('Cinder Vale</a>');
  });

  it('never inside code, fences, links, URLs or $code tokens, nor on the entry’s own page', () => {
    const s = world();
    const out = render(s, [
      'Code `Emberfall` here.',
      '```\nEmberfall\n```',
      '[Emberfall](https://example.com/x) and https://example.com/Emberfall and <https://emberfall.example>',
      '# Emberfall heading',
    ].join('\n\n'));
    expect(out).toContain('<code>Emberfall</code>');
    expect(out).toContain('<pre><code>Emberfall\n</code></pre>');
    expect(out).toContain('>Emberfall</a> and');
    expect(out).not.toMatch(/entry-link[^>]*>Emberfall<\/a> and/);
    expect(out.match(/class="entry-link"/g)).toHaveLength(1); // only the heading's text
    expect(out).toMatch(/<h1><a class="entry-link" href="\/wiki\/7\/emberfall"[^>]*>Emberfall<\/a> heading<\/h1>/);
    // Its own page: its names stay text, others still link.
    const own = render(s, 'The Ashen Keep (the Keep) watches Emberfall.', 'keep');
    expect(own).not.toContain('Ashen Keep</a>');
    expect(own).not.toContain('the Keep</a>');
    expect(own).toContain('>Emberfall</a>');
  });

  it('links a name hard-wrapped over a line break, keeping the break', () => {
    const out = render(world(), 'They reached Ashen\nKeep at dusk.\nThen\nEmberfall.');
    expect(out).toContain('<a class="entry-link" href="/wiki/7/ashen_keep" title="Ashen Keep" data-name="Ashen Keep">Ashen\nKeep</a> at dusk.\nThen\n<a class="entry-link" href="/wiki/7/emberfall"');
    // A blank line ends the paragraph: no link across it.
    expect(render(world(), 'Ashen\n\nKeep')).not.toContain('entry-link');
  });

  it("respects the card's Not a link here names", () => {
    const s = world([card('note', { content: '# Note', linkIgnores: ['emberfall'] })]);
    const out = render(s, 'Emberfall and Ashen Keep.', 'note');
    expect(out).not.toContain('Emberfall</a>');
    expect(out).toContain('>Ashen Keep</a>');
  });

  it('escapes names and keeps the text around them', () => {
    const s = world([card('odd', { content: '# Fire & "Ice"' })]);
    const out = render(s, 'Before fire & "ice" after *Emberfall*.');
    expect(out).toMatch(/Before <a class="entry-link" href="[^"]+" title="Fire &amp; &quot;Ice&quot;" data-name="Fire &amp; &quot;Ice&quot;">fire &amp; &quot;ice&quot;<\/a> after <em><a class="entry-link"[^>]*>Emberfall<\/a><\/em>\./);
  });

  it('renders [shown text]($code) as a link: the wiki page of Lore, else the card; plain $code unchanged', () => {
    const s = world([card('task', { isDoc: false, deckId: 'tasks', content: '# Forge the gate' })]);
    const page = cardCode(s.cards.get('page').seq);
    const keep = cardCode(s.cards.get('keep').seq);
    const task = cardCode(s.cards.get('task').seq);
    const out = render(s, `[the old fort]($${keep}) and [this job]($${task}) and [nothing]($zzzzzzzz) and $${keep} and [roads]($${page}).`);
    expect(out).toContain(`<a href="/wiki/7/$${page}" class="card-link">roads</a>`);
    expect(out).toContain('<a href="/wiki/7/ashen_keep" class="card-link">the old fort</a>');
    expect(out).toContain(`<a href="/card/${task}-forge-the-gate" class="card-link">this job</a>`);
    expect(out).toContain(`<a class="card-ref" href="/card/${keep}-ashen-keep" title="$${keep}">Ashen Keep</a>`);
    // The shown text is a link label: no name link nests inside it, and it opens in this tab.
    expect(out).not.toMatch(/card-link">[^<]*<a/);
    expect(out).not.toMatch(/class="card-link"[^>]*target/);
  });

  it('renders as before without names (no project, no entries)', () => {
    const s = world();
    expect(renderMarkdown('Emberfall', renderContext(s.cards, new Map()))).toBe('<p>Emberfall</p>\n');
    expect(nameLinks({ ...s, cards: new Map() }, 'p1')).toBeNull();
    expect(nameLinks(s, null)).toBeNull();
  });
});

describe('Mentioned in', () => {
  it('groups other texts of the project that name the entry, keeping each card’s ignores', () => {
    const s = world([
      card('chronicle', { content: '# Chronicle\nThe Keep fell.' }),
      card('quest', { isDoc: false, deckId: 'tasks', content: '# Scout\nRide to Ashen Keep.' }),
      card('quiet', { content: '# Quiet\nAshen Keep again.', linkIgnores: ['Ashen Keep'] }),
      card('coded', { content: '# Coded\nAshen Keep, $CODE.' }),
      card('elsewhere', { deckId: 'far', content: '# Elsewhere\nAshen Keep.' }),
      card('gone', { content: '# Gone\nAshen Keep.', visibility: 'deleted' }),
    ]);
    const code = cardCode(s.cards.get('keep').seq);
    s.cards.get('coded').content = `# Coded\nAshen Keep, $${code}.`;
    const groups = backlinks(s, 'keep');
    expect(groups.map((g) => g.group)).toEqual(['Mentions', 'Mentioned in']);
    expect(groups[0].items).toEqual([{ cardId: 'coded' }]);
    expect(groups[1].items).toEqual([{ cardId: 'chronicle' }, { cardId: 'quest' }]);
    // Nothing names Emberfall; a title line naming it does not count either.
    expect(backlinks(s, 'ember')).toEqual([]);
    const titled = world([card('t', { isDoc: false, deckId: 'tasks', content: 'Emberfall gate\nfix the hinge' })]);
    expect(backlinks(titled, 'ember')).toEqual([]);
  });

  it('reuses the index and per-card results until a name or the card changes', () => {
    const s = world([card('chronicle', { content: '# Chronicle\nEmberfall by the Ford.' })]);
    const index = campaignNameIndex(s, 'p1');
    expect(campaignNameIndex(s, 'p1')).toBe(index);
    // A new cards map with the same names keeps the same automaton.
    const s2 = { ...s, cards: new Map(s.cards) };
    expect(campaignNameIndex(s2, 'p1')).toBe(index);
    const chronicle = s.cards.get('chronicle');
    expect(namedIn(chronicle, index)).toBe(namedIn(chronicle, index));
    expect([...namedIn(chronicle, index)]).toEqual(['ember']);
    // A new alias: a new index, and the old text links it at once.
    const s3 = { ...s, cards: new Map(s.cards) };
    expect(backlinks(s, 'page')).toEqual([]);
    s3.cards.set('page', { ...s.cards.get('page'), aliases: ['the Ford'] });
    const index3 = campaignNameIndex(s3, 'p1');
    expect(index3).not.toBe(index);
    expect(backlinks(s3, 'page')).toEqual([{ group: 'Mentioned in', items: [{ cardId: 'chronicle' }] }]);
  });
});

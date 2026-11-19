import { describe, it, expect } from 'vitest';
import { campaignGraphData, visibleColor } from '../web/src/wiki';
import { neighbours } from '../shared/graph';
import { cardCode } from '../shared/cards';

let seq = 500;
const card = (id: string, extra: object = {}) =>
  ({ id, seq: ++seq, deckId: 'lore', isDoc: true, visibility: 'default', status: 'not_started', content: `# ${id}`,
    entryTypeId: null, entryKey: null, fields: {}, wikiParentId: null, aliases: [], linkIgnores: [], ...extra }) as any;

const decks = new Map<string, any>([['lore', { id: 'lore', projectId: 'p1' }], ['tasks', { id: 'tasks', projectId: 'p1' }], ['far', { id: 'far', projectId: 'p2' }]]);
const types = new Map<string, any>([
  ['tPlace', { id: 'tPlace', projectId: 'p1', key: 'place', name: 'Place', parentTypeId: null, fields: [], sortIndex: 0 }],
  ['tNpc', { id: 'tNpc', projectId: 'p1', key: 'npc', name: 'Character', parentTypeId: null, sortIndex: 1, fields: [{ key: 'home', label: 'Home', kind: 'entry', target: 'place' }] }],
]);
const kinds = new Map<string, any>([['k1', { id: 'k1', projectId: 'p1', key: 'located_in', label: 'located in', reverseLabel: 'has' }]]);

function world() {
  const ember = card('ember', { entryTypeId: 'tPlace', entryKey: 'emberfall', content: '# Emberfall\nA town.' });
  const keep = card('keep', { entryTypeId: 'tPlace', entryKey: 'ashen_keep', content: '# Ashen Keep\nAbove Emberfall.' });
  const mira = card('mira', { entryTypeId: 'tNpc', entryKey: 'mira', content: '# Mira', fields: { home: 'emberfall' } });
  const roads = card('roads', { content: `# Old Roads\nSee $${cardCode(keep.seq)}.` });
  const task = card('task', { deckId: 'tasks', isDoc: false, content: '# Fix Emberfall art' });
  const host = card('host', { content: '# Board page\nEmberfall' });
  const far = card('far', { deckId: 'far', entryTypeId: 'tPlace', entryKey: 'cinder', content: '# Cinder Vale\nEmberfall' });
  const gone = card('gone', { visibility: 'deleted', content: '# Gone\nEmberfall' });
  const list = [ember, keep, mira, roads, task, host, far, gone];
  return {
    cards: new Map(list.map((c) => [c.id, c])), decks, entryTypes: types, linkKinds: kinds,
    entryLinks: new Map<string, any>([
      ['l1', { id: 'l1', projectId: 'p1', kindKey: 'located_in', fromCardId: 'keep', toCardId: 'ember', props: {}, sortIndex: 0 }],
      ['l2', { id: 'l2', projectId: 'p1', kindKey: 'works_on', fromCardId: 'task', toCardId: 'ember', props: {}, sortIndex: 0 }],
    ]),
    visionBoards: new Map<string, any>([['b1', { id: 'b1', cardId: 'host' }]]),
  } as any;
}

describe('campaignGraphData', () => {
  it('entries of the campaign as nodes; links, field references, $code mentions and names as edges', () => {
    const s = world();
    const data = campaignGraphData(s, 'p1');
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['ember', 'keep', 'mira', 'roads']); // no task, board host, other project, deleted
    expect(data.nodes.find((n) => n.id === 'ember')).toEqual({ id: 'ember', label: 'Emberfall', typeId: 'tPlace' });
    const rel = data.edges.map((e) => `${e.from}>${e.to}:${e.kind}:${e.label}`).sort();
    expect(rel).toEqual([
      'keep>ember:link:located in',
      'keep>ember:mention:mentions', // the name "Emberfall" in its text
      'mira>ember:field:Character: Home',
      'roads>keep:mention:mentions', // $code
    ]);
    const g = neighbours('ember', data, 1);
    expect(g.edges.find((e) => e.target === 'keep' || e.source === 'keep')!.relations.map((r) => r.kind)).toEqual(['link', 'mention']);
  });

  it('is reused while the maps stay the same and rebuilt when one changes', () => {
    const s = world();
    const a = campaignGraphData(s, 'p1');
    expect(campaignGraphData(s, 'p1')).toBe(a);
    const links = new Map(s.entryLinks);
    links.set('l3', { id: 'l3', projectId: 'p1', kindKey: 'located_in', fromCardId: 'roads', toCardId: 'ember', props: {}, sortIndex: 1 });
    const b = campaignGraphData({ ...s, entryLinks: links }, 'p1');
    expect(b).not.toBe(a);
    expect(b.edges).toHaveLength(a.edges.length + 1);
  });
});

describe('visibleColor', () => {
  const lightness = (hex: string) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); return (Math.max(...v) + Math.min(...v)) / 2; };
  it('keeps light colours and lifts dark ones to half lightness, hue kept', () => {
    expect(visibleColor('#4f8cff')).toBe('#4f8cff');
    expect(visibleColor('#ec8219')).toBe('#ec8219');
    for (const c of ['#000000', '#101010', '#14142a', '#3a0000', '#002200']) expect(lightness(visibleColor(c))).toBeGreaterThanOrEqual(0.49);
    expect(visibleColor('#3a0000')).toBe('#ff0000');
    expect(visibleColor('#000000')).toBe('#808080');
  });
});

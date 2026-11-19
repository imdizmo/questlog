import { describe, it, expect } from 'vitest';
import {
  bringUpToDate, derivedPage, hasData, isOutdated, joinSections, layoutOf, newEntryContent, pageOf, placeBlocks, splitSections, withFacts,
  type Block, type BlockData, type EntryLayout, type TypePage,
} from '../shared/blocks';
import type { EntryType } from '../shared/types';

const type = (id: string, extra: Partial<EntryType> = {}): EntryType => ({
  id, projectId: 'p', key: id, name: id.toUpperCase(), icon: null, color: null, parentTypeId: null, fields: [], sortIndex: 0,
  sections: [], templates: [], familyId: null, picture: null, ...extra,
});
const tmap = (...ts: EntryType[]) => new Map(ts.map((t) => [t.id, t]));
const blk = (id: string, kind: Block['kind'], title: string, extra: Partial<Block> = {}): Block => ({ id, kind, title, width: 'full', ...extra });

/** A small seeded generator, so a failing case can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('splitSections', () => {
  it('splits a body at its ## headings, intro first', () => {
    const body = 'Intro line\n\n## Look\n\nTall.\n\n## History\nOld.';
    const r = splitSections(body);
    expect(r.intro).toBe('Intro line\n');
    expect(r.sections.map((s) => [s.heading, s.text])).toEqual([['Look', '\nTall.\n'], ['History', 'Old.']]);
    expect(r.sections.map((s) => s.line)).toEqual([2, 6]);
  });
  it('does not split at a ## inside a fenced code block', () => {
    const body = '## Code\n```\n## not a heading\n```\nafter\n~~~md\n## nor this\n~~~';
    expect(splitSections(body).sections.map((s) => s.heading)).toEqual(['Code']);
  });
  it('a fence line with an info string does not close a fence', () => {
    expect(splitSections('```\n```js\n## inside\n```\n## real').sections.map((s) => s.heading)).toEqual(['real']);
    expect(splitSections('~~~~\n~~~\n## inside\n~~~~  \n## real').sections.map((s) => s.heading)).toEqual(['real']);
  });
  it('leaves ### and #### inside their section', () => {
    expect(splitSections('## A\n### a1\ntext\n#### a2').sections).toHaveLength(1);
  });
  it('joins back to exactly the same text, over generated bodies', () => {
    const r = rng(7);
    const pieces = ['', 'text', '## Look', '##   Spaced  ##', '### sub', '```', '~~~', '  ## indented', '##no space', '- [ ] item', '## Look', '   ', '#'];
    for (let n = 0; n < 500; n++) {
      const lines = Array.from({ length: Math.floor(r() * 14) }, () => pieces[Math.floor(r() * pieces.length)]);
      const body = lines.join('\n');
      expect(joinSections(splitSections(body))).toBe(body);
    }
  });
});

describe('pageOf', () => {
  const page: TypePage = { version: 3, guided: true, blocks: [blk('a', 'facts', 'Facts')] };
  it('derives a page from the headings when no type in the chain has one', () => {
    const types = tmap(type('item', { sections: ['Look'] }), type('weapon', { parentTypeId: 'item', sections: ['Use'] }));
    const r = pageOf(types, 'weapon');
    expect(r.owner).toBeNull();
    expect(r.page.version).toBe(0);
    expect(r.page.blocks.map((b) => [b.kind, b.title, b.width])).toEqual([
      ['facts', 'Facts', 'half'], ['picture', 'Picture', 'half'], ['text', 'Look', 'full'], ['text', 'Use', 'full']]);
    expect(r).toEqual(pageOf(types, 'weapon')); // stable ids: the same page twice
  });
  it('a sub-type follows its parent until it has its own', () => {
    const types = tmap(type('item', { page }), type('weapon', { parentTypeId: 'item' }));
    expect(pageOf(types, 'weapon')).toEqual({ page, owner: types.get('item') });
    const own: TypePage = { ...page, version: 4, blocks: [] };
    types.set('weapon', type('weapon', { parentTypeId: 'item', page: own }));
    expect(pageOf(types, 'weapon')).toEqual({ page: own, owner: types.get('weapon') });
  });
  it('gives the known starter headings their writing prompts', () => {
    const p = derivedPage(tmap(type('npc', { sections: ['Voice', 'Something new'] })), 'npc');
    expect(p.blocks.filter((b) => b.kind === 'text').map((b) => b.prompt)).toEqual(['How they talk: a phrase they always use.', 'A few lines.']);
  });
});

describe('layoutOf', () => {
  it('uses the stored layout, else the type page with no data', () => {
    const page: TypePage = { version: 2, guided: false, blocks: [blk('a', 'lines', 'Barks')] };
    const types = tmap(type('npc', { page }));
    expect(layoutOf({ entryTypeId: 'npc', layout: null }, types)).toEqual({ version: 2, owner: 'npc', blocks: page.blocks, data: {} });
    const own: EntryLayout = { version: 1, blocks: [], data: {} };
    expect(layoutOf({ entryTypeId: 'npc', layout: own }, types)).toBe(own);
  });
});

describe('placeBlocks', () => {
  const layout = (blocks: Block[]): EntryLayout => ({ version: 1, blocks, data: {} });
  it('puts each section in the text block of the same heading, any case and spacing', () => {
    const r = placeBlocks(layout([blk('f', 'facts', 'Facts'), blk('l', 'text', 'look  and FEEL')]), 'top\n## Look and feel\nfoggy');
    expect(r.intro).toBe('top');
    expect(r.placed.map((p) => [p.block.title, p.section?.text ?? null, p.extra])).toEqual([['Facts', null, false], ['look  and FEEL', 'foggy', false]]);
  });
  it('keeps sections no block names, and second copies of a heading, as extra text blocks', () => {
    const r = placeBlocks(layout([blk('l', 'text', 'Look')]), '## Look\none\n## Notes\nn\n## Look\ntwo');
    expect(r.placed.map((p) => [p.block.title, p.section?.text, p.extra])).toEqual([['Look', 'one', false], ['Notes', 'n', true], ['Look', 'two', true]]);
  });
  it('an empty text block has no section', () => {
    expect(placeBlocks(layout([blk('l', 'text', 'Look')]), '').placed[0].section).toBeNull();
  });
});

describe('bringUpToDate', () => {
  it('takes the template order, widths and new blocks, keeping data by block id', () => {
    const page: TypePage = { version: 5, guided: false, blocks: [blk('t', 'table', 'Drops', { cols: ['Item', 'Chance'] }), blk('b', 'lines', 'Barks', { width: 'half' }), blk('n', 'steps', 'New')] };
    const old: EntryLayout = { version: 2, blocks: [blk('b', 'lines', 'Barks'), blk('t', 'table', 'Drops', { cols: ['Item'] })], data: { b: { items: ['Hey'] }, t: { rows: [['Bone', '50', 'x']] } } };
    const r = bringUpToDate(old, page, '', 'creature');
    expect(r.version).toBe(5);
    expect(r.owner).toBe('creature');
    expect(r.blocks.map((b) => [b.id, b.width])).toEqual([['t', 'full'], ['b', 'half'], ['n', 'full']]);
    expect(r.data.b).toEqual(old.data.b);
    // The row's cells by column name: Item stays Item, the two cells past the old columns keep theirs. No cell is dropped.
    expect(r.blocks[0].cols).toEqual(['Item', 'Chance', 'Column 2', 'Column 3']);
    expect(r.data.t).toEqual({ rows: [['Bone', '', '50', 'x']] });
  });
  it('keeps blocks the template dropped when they hold something, and lets empty ones go', () => {
    const page: TypePage = { version: 2, guided: false, blocks: [] };
    const old: EntryLayout = { version: 1, blocks: [blk('x', 'lines', 'Kept'), blk('y', 'lines', 'Empty'), blk('z', 'text', 'Story'), blk('w', 'text', 'Blank')], data: { x: { items: ['a'] }, y: { items: [] } } };
    const r = bringUpToDate(old, page, '## Story\nOnce.\n## Blank\n\n', 'creature');
    expect(r.blocks.map((b) => b.id)).toEqual(['x', 'z']);
    expect(r.data).toEqual({ x: { items: ['a'] } });
  });
  it('never loses data or table cells, over random layouts and templates', () => {
    const r = rng(42);
    const kinds: Block['kind'][] = ['text', 'facts', 'model', 'picture', 'map', 'lines', 'steps', 'table', 'links', 'gallery'];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const pick = <T>(l: T[]) => l[Math.floor(r() * l.length)];
    const someData = (k: Block['kind']): BlockData => {
      if (k === 'lines' || k === 'steps') return { items: r() < 0.3 ? [] : ['x', 'y'].slice(0, 1 + Math.floor(r() * 2)) };
      if (k === 'table') return { rows: Array.from({ length: Math.floor(r() * 3) }, () => Array.from({ length: 1 + Math.floor(r() * 5) }, () => pick(['1', '', 'z']))) };
      if (k === 'links') return { cardIds: r() < 0.5 ? [] : ['c1'] };
      if (k === 'gallery') return { assetIds: ['a1'] };
      if (k === 'model' || k === 'picture' || k === 'map') return { assetId: 'a2' };
      return {};
    };
    for (let n = 0; n < 300; n++) {
      // A block id means one block: the template keeps its kind, as the editor does.
      const kindOf = new Map(ids.map((id) => [id, pick(kinds)]));
      const mk = (id: string) => blk(id, kindOf.get(id)!, `T${id}`, { width: r() < 0.5 ? 'half' : 'full', cols: ['A', 'B'].slice(0, 1 + Math.floor(r() * 2)) });
      const oldBlocks = ids.filter(() => r() < 0.6).map(mk);
      const data: Record<string, BlockData> = {};
      for (const b of oldBlocks) if (r() < 0.7) data[b.id] = someData(b.kind);
      const page: TypePage = { version: 9, guided: false, blocks: ids.filter(() => r() < 0.5).map(mk) };
      const body = oldBlocks.filter((b) => b.kind === 'text' && r() < 0.5).map((b) => `## ${b.title}\nwritten`).join('\n');
      const old: EntryLayout = { version: 1, blocks: oldBlocks, data };
      const res = bringUpToDate(old, page, body, 't');
      expect(res.blocks.slice(0, page.blocks.length).map((b) => [b.id, b.width])).toEqual(page.blocks.map((b) => [b.id, b.width]));
      for (const b of oldBlocks) {
        const d = data[b.id];
        if (d && hasData(b.kind, d)) {
          expect(res.blocks.some((x) => x.id === b.id), `block ${b.id} kept`).toBe(true);
          if (b.kind !== 'table') expect(res.data[b.id]).toEqual(d);
        }
        if (b.kind === 'table' && d?.rows?.length) {
          // Every written cell is still there, under a column of the same name.
          const kept = res.blocks.find((x) => x.id === b.id)!;
          const oldCols = d.rows.reduce((c, row) => (row.length > c.length ? [...c, ...Array.from({ length: row.length - c.length }, (_, i) => `Column ${c.length + i + 1}`)] : c), [...b.cols!]);
          d.rows.forEach((row, i) => row.forEach((cell, j) => {
            if (!cell) return;
            const at = kept.cols!.indexOf(oldCols[j]);
            expect(at, `column ${oldCols[j]}`).toBeGreaterThanOrEqual(0);
            expect(res.data[b.id].rows![i][at]).toBe(cell);
          }));
        }
      }
      // Every written section still has a text block of its heading.
      const placed = placeBlocks(res, body);
      expect(placed.placed.filter((p) => p.section && !p.extra).length + placed.placed.filter((p) => p.extra).length).toBe(splitSections(body).sections.length);
    }
  });
});

describe('newEntryContent', () => {
  const page: TypePage = { version: 1, guided: true, blocks: [
    blk('f', 'facts', 'Facts'), blk('w', 'text', 'Where they are'), blk('b', 'lines', 'Barks'), blk('s', 'steps', 'Steps'), blk('h', 'text', 'History')] };
  it('writes the title and one heading per text block', () => {
    expect(newEntryContent('Ásdís', page)).toEqual({ content: '# Ásdís\n\n## Where they are\n\n## History', data: {} });
  });
  it('puts the answers in place: text under its heading, lines and steps one per line', () => {
    const r = newEntryContent('Ásdís', page, { w: 'On the beach.', b: 'Hey!\n\n  Over here ', s: 'Find fish\nCook it', h: '   ' });
    expect(r.content).toBe('# Ásdís\n\n## Where they are\n\nOn the beach.\n\n## History');
    expect(r.data).toEqual({ b: { items: ['Hey!', 'Over here'] }, s: { items: ['Find fish', 'Cook it'] } });
  });
});

describe('bringUpToDate: tables and Facts', () => {
  const tbl = (cols: string[]) => blk('t', 'table', 'Drops', { cols });
  it('moves cells with their column when columns are reordered or removed, keeping dropped ones that hold data', () => {
    const old: EntryLayout = { version: 1, blocks: [tbl(['Item', 'Chance', 'Amount', 'Note'])], data: { t: { rows: [['Bone', '50', '2', '']] } } };
    const r = bringUpToDate(old, { version: 2, guided: false, blocks: [tbl(['Amount', 'Item'])] }, '', 'x');
    expect(r.blocks[0].cols).toEqual(['Amount', 'Item', 'Chance']);
    expect(r.data.t.rows).toEqual([['2', 'Bone', '50']]);
  });
  it('matches column names in any case', () => {
    const old: EntryLayout = { version: 1, blocks: [tbl(['item'])], data: { t: { rows: [['Bone']] } } };
    expect(bringUpToDate(old, { version: 2, guided: false, blocks: [tbl(['Item'])] }, '', 'x').data.t.rows).toEqual([['Bone']]);
  });
  it('keeps one Facts block: the page\'s, when it has one', () => {
    const old: EntryLayout = { version: 1, blocks: [blk('f1', 'facts', 'Facts')], data: {} };
    const r = bringUpToDate(old, { version: 2, guided: false, blocks: [blk('f2', 'facts', 'Facts')] }, '', 'x');
    expect(r.blocks.map((b) => b.id)).toEqual(['f2']);
    expect(bringUpToDate(old, { version: 2, guided: false, blocks: [] }, '', 'x').blocks.map((b) => b.id)).toEqual(['f1']);
  });
});

describe('withFacts and isOutdated', () => {
  const l = (blocks: Block[], extra: Partial<EntryLayout> = {}): EntryLayout => ({ version: 2, owner: 'npc', blocks, data: {}, ...extra });
  it('adds a Facts block when the layout has none and the entry holds values', () => {
    expect(withFacts(l([blk('a', 'lines', 'Barks')]), true).blocks.map((b) => b.kind)).toEqual(['lines', 'facts']);
    expect(withFacts(l([blk('a', 'lines', 'Barks')]), false).blocks.map((b) => b.kind)).toEqual(['lines']);
    const has = l([blk('f', 'facts', 'Facts')]);
    expect(withFacts(has, true)).toBe(has);
  });
  it('an entry is out of date when its page came from another owner, or an older version', () => {
    const page: TypePage = { version: 2, guided: false, blocks: [] };
    expect(isOutdated(l([]), page, 'npc')).toBe(false);
    expect(isOutdated(l([], { version: 1 }), page, 'npc')).toBe(true);
    expect(isOutdated(l([], { version: 5 }), page, 'creature')).toBe(true);
    expect(isOutdated(l([], { version: 5, owner: 'npc' }), { ...page, version: 0 }, '')).toBe(true);
  });
});

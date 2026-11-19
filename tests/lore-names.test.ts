import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { loreDecorations, loreMarkdown, loreNamesField, nameAt, setLoreNames, type LoreNames } from '../web/src/lore/decorations';
import { buildNameIndex, type NameSource } from '../shared/autolink';

const ENTRIES: NameSource[] = [
  { id: 'keep', name: 'Ashen Keep', aliases: ['the Keep'] },
  { id: 'ember', name: 'Emberfall' },
];

const names = (entries: NameSource[] = ENTRIES, extra: Partial<LoreNames> = {}): LoreNames => ({
  index: buildNameIndex(entries), selfId: null, ignores: [], title: (id) => id, open: () => {}, ignore: () => {}, ...extra,
});

function state(doc: string, n: LoreNames | null = names()): EditorState {
  const s = EditorState.create({ doc, extensions: [loreMarkdown(doc), loreNamesField.init(() => n)] });
  return s.update({ selection: EditorSelection.cursor(0) }).state;
}

const marked = (s: EditorState) => loreDecorations(s).filter((d) => d.kind === 'name').map((d) => `${s.sliceDoc(d.from, d.to)}=${d.ref}`);

describe('names in the lore editor', () => {
  it('marks names and aliases, outside code, fences, links, URLs and $code', () => {
    const doc = [
      'Chronicle',
      'From Emberfall to the keep.',
      'Code `Emberfall` and [Emberfall](https://example.com) and https://example.com/Emberfall',
      '```',
      'Emberfall',
      '```',
      '## Ashen Keep',
      '<span>Emberfall</span>',
    ].join('\n');
    // Text between inline HTML tags is text (the reader shows it as text too); only the tags are skipped.
    expect(marked(state(doc))).toEqual(['Emberfall=ember', 'the keep=keep', 'Ashen Keep=keep', 'Emberfall=ember']);
  });

  it("leaves the card's own names and its ignores unmarked", () => {
    const doc = 'Ashen Keep\nThe Keep stands over Emberfall.';
    expect(marked(state(doc, names(ENTRIES, { selfId: 'keep' })))).toEqual(['Emberfall=ember']);
    // The title line is never marked (the card's own name; the reader shows it unlinked too).
    expect(marked(state(doc, names(ENTRIES, { ignores: ['EMBERFALL'] })))).toEqual(['The Keep=keep']);
    expect(nameAt(state(doc, names(ENTRIES, { ignores: ['EMBERFALL'] })), 3)).toBeNull();
    expect(marked(state(doc, null))).toEqual([]);
  });

  it('follows a new index without a text change (another client made an entry)', () => {
    const s = state('Notes\nCinder Vale lies east.');
    expect(marked(s)).toEqual([]);
    const next = s.update({ effects: setLoreNames.of(names([...ENTRIES, { id: 'vale', name: 'Cinder Vale' }])) }).state;
    expect(marked(next)).toEqual(['Cinder Vale=vale']);
  });

  it('only matches the visible ranges (widened to whole lines)', () => {
    const lines = ['Title', ...Array.from({ length: 200 }, (_, i) => `Line ${i} near Emberfall.`)];
    const s = state(lines.join('\n'));
    const at = s.doc.line(100);
    const visible = loreDecorations(s, [{ from: at.from + 3, to: at.from + 5 }]).filter((d) => d.kind === 'name');
    expect(visible.map((d) => s.doc.lineAt(d.from).number)).toEqual([100]);
  });

  it('nameAt finds the name under a position, with its indexed spelling', () => {
    const s = state('Notes\nWe saw the KEEP burn.\n`Emberfall`');
    const pos = s.doc.toString().indexOf('KEEP') + 1;
    expect(nameAt(s, pos)).toMatchObject({ cardId: 'keep', name: 'the Keep', from: pos - 5, to: pos + 3 });
    expect(nameAt(s, 2)).toBeNull();
    expect(nameAt(s, s.doc.length - 3)).toBeNull(); // inside inline code
    // A name that only partly overlaps a link is not offered, as it is not marked.
    const t = state('Notes\nAshen [Keep](https://example.com) and Ashen Keep.', names([{ id: 'keep', name: 'Ashen Keep' }]));
    expect(nameAt(t, 8)).toBeNull();
    expect(marked(t)).toEqual(['Ashen Keep=keep']);
  });

  it('timing: a 20 KB lore text with 2 000 names, decorations per keystroke', () => {
    const entries: NameSource[] = Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, name: `Place ${(i * 7919).toString(36)} Vale` }));
    const words = ['the', 'road', 'to', 'river', 'north', 'of', 'a', 'hill'];
    let text = 'Chronicle\n';
    for (let i = 0; text.length < 20_000; i++) {
      text += `${words[i % words.length]} ${i % 5 === 0 ? entries[(i * 13) % entries.length].name : words[(i + 3) % words.length]}${i % 12 === 11 ? '.\n\n' : ' '}`;
    }
    let s = state(text, names(entries));
    expect(s.doc.length).toBeGreaterThanOrEqual(20_000);
    // About a screen of text visible around the caret, as the view plugin passes it.
    const visible = () => { const c = s.selection.main.head; return [{ from: Math.max(0, c - 1500), to: Math.min(s.doc.length, c + 1500) }]; };
    s = s.update({ selection: EditorSelection.cursor(10_000) }).state;
    loreDecorations(s, visible()); // warm up (parse, fold caches)
    const times: number[] = [];
    let marks = 0;
    for (let k = 0; k < 60; k++) {
      s = s.update({ changes: { from: s.selection.main.head, insert: k % 10 === 9 ? ' ' : 'x' }, selection: EditorSelection.cursor(s.selection.main.head + 1) }).state;
      const t0 = performance.now();
      marks = loreDecorations(s, visible()).filter((d) => d.kind === 'name').length;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    const t0 = performance.now();
    const whole = loreDecorations(s).filter((d) => d.kind === 'name').length;
    const wholeMs = performance.now() - t0;
    console.log(`lore names: 20 KB, 2 000 names: per keystroke median ${median.toFixed(2)} ms, max ${times[times.length - 1].toFixed(2)} ms (${marks} names visible); whole text ${wholeMs.toFixed(2)} ms (${whole} names)`);
    expect(marks).toBeGreaterThan(10);
    expect(median).toBeLessThan(16);
  });
});

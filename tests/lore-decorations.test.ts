import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { lineBreakFilter, lineBreakOf, loreDecorations, loreDecorationsExtension, loreMarkdown, type LoreDecoration } from '../web/src/lore/decorations';
import { cardCode } from '../shared/cards';

/** A state over `doc`; `carets` are cursor positions (none: one caret at the very end). */
function state(doc: string, ...carets: number[]): EditorState {
  const s = EditorState.create({ doc, extensions: [loreMarkdown(doc), EditorState.allowMultipleSelections.of(true)] });
  const at = carets.length ? carets : [s.doc.length];
  return s.update({ selection: EditorSelection.create(at.map((c) => EditorSelection.cursor(c))) }).state;
}

/** Decorations as `kind "text it covers"` strings, easy to read in a failing test. */
function show(s: EditorState, decos: LoreDecoration[] = loreDecorations(s)): string[] {
  return decos.map((d) => {
    let out = `${d.kind} ${JSON.stringify(s.sliceDoc(d.from, d.to))}`;
    if (d.checked !== undefined) out += ` checked=${d.checked}`;
    if (d.ref !== undefined) out += ` ref=${d.ref}`;
    return out;
  });
}

/** Only the decorations below line 1 (the title). */
const body = (s: EditorState) => show(s, loreDecorations(s).filter((d) => d.from > s.doc.line(1).to));

describe('loreDecorations', () => {
  it('styles h1–h3 and hides their marks unless the caret is on the heading', () => {
    const doc = 'Title\n# One\n## Two\n### Three\n#### Four';
    const s = state(doc, 0);
    expect(body(s)).toEqual([
      'h1 "# One"',
      'hide "# "',
      'h2 "## Two"',
      'hide "## "',
      'h3 "### Three"',
      'hide "### "',
    ]);
    // Caret at the end of "## Two": that heading shows its marks, the others stay hidden.
    const t = state(doc, doc.indexOf('Two') + 3);
    expect(body(t)).toEqual(['h1 "# One"', 'hide "# "', 'h2 "## Two"', 'h3 "### Three"', 'hide "### "']);
  });

  it('a selection reaching into a heading reveals it too', () => {
    const doc = 'T\n# One\ntext';
    const s = EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length, doc.indexOf('One') + 1),
      extensions: loreMarkdown(doc),
    });
    expect(body(s)).toEqual(['h1 "# One"']);
  });

  it('line 1 is the title and hides its leading #', () => {
    const s = state('# The fog\nbody');
    expect(show(s)).toEqual(['title "# The fog"', 'hide "# "']);
    expect(show(state('Plain title\nbody'))).toEqual(['title "Plain title"']);
    expect(show(state('## Two marks\nbody'))).toEqual(['title "## Two marks"', 'hide "## "']);
    // Caret on line 1: its marks show.
    expect(show(state('# The fog\nbody', 3))).toEqual(['title "# The fog"']);
  });

  it('bold, italic and inline code hide their marks; the caret inside reveals them', () => {
    const doc = 'T\n**bold** and __b2__, *it* and _i2_, `code`';
    expect(body(state(doc, 0))).toEqual([
      'bold "**bold**"',
      'hide "**"',
      'hide "**"',
      'bold "__b2__"',
      'hide "__"',
      'hide "__"',
      'italic "*it*"',
      'hide "*"',
      'hide "*"',
      'italic "_i2_"',
      'hide "_"',
      'hide "_"',
      'code "`code`"',
      'hide "`"',
      'hide "`"',
    ]);
    const caret = doc.indexOf('bold') + 2;
    expect(body(state(doc, caret)).slice(0, 2)).toEqual(['bold "**bold**"', 'bold "__b2__"']);
  });

  it('- bullets become a bullet, * and + bullets stay raw', () => {
    const s = state('T\n- one\n  - nested\n\n* star\n+ plus', 0);
    expect(body(s)).toEqual(['bullet "- "', 'bullet "- "']);
    // The caret on a bullet's mark shows it raw.
    const t = state('T\n- one\n- two', 'T\n- '.length);
    expect(body(t)).toEqual(['bullet "- "']);
  });

  it('- [ ] / - [x] become checkboxes with their state', () => {
    const s = state('T\n- [ ] open\n- [x] done\n- [X] DONE\n* [ ] star', 0);
    expect(body(s)).toEqual([
      'checkbox "- [ ] " checked=false',
      'checkbox "- [x] " checked=true',
      'checkbox "- [X] " checked=true',
    ]);
  });

  it('> quotes style the line and hide the mark', () => {
    const s = state('T\n> said\n> > twice', 0);
    expect(body(s)).toEqual(['quote "> said"', 'hide "> "', 'quote "> > twice"', 'hide "> "', 'hide "> "']);
    const t = state('T\n> said', 'T\n>'.length);
    expect(body(t)).toEqual(['quote "> said"']);
  });

  it('$code, @mention and #tag become chips by the readers rules', () => {
    const code = cardCode(115);
    const doc = `T\nsee $${code} with @ada about #lore, not a$${code} nor x#y nor $abc!`;
    expect(body(state(doc, 0))).toEqual([`chip-code "$${code}" ref=${code}`, 'chip-mention "@ada" ref=ada', 'chip-tag "#lore" ref=lore']);
    // Unicode mentions and tags, as shared/content counts them.
    expect(body(state('T\n@María #fög', 0))).toEqual(['chip-mention "@María" ref=María', 'chip-tag "#fög" ref=fög']);
    // A chip right after a block mark starts the line's text, as in the reader.
    expect(body(state('T\n- #lore', 0))).toEqual(['bullet "- "', 'chip-tag "#lore" ref=lore']);
    expect(body(state('T\n# Fog #lore', 0))).toEqual(['h1 "# Fog #lore"', 'hide "# "', 'chip-tag "#lore" ref=lore']);
    // The caret on a chip shows it raw.
    expect(body(state('T\nhi @ada', 'T\nhi @a'.length))).toEqual([]);
  });

  it('own-file images become an image; other images stay raw', () => {
    const s = state('T\n![map](/api/files/abc_1-Z) and ![x](https://example.com/a.png)', 0);
    expect(body(s)).toEqual(['image "![map](/api/files/abc_1-Z)" ref=/api/files/abc_1-Z']);
  });

  it('ignores # and chips inside fenced and inline code', () => {
    const s = state('T\n```\n# not a heading\n#tag @ada\n```\n`#tag` ~~~', 0);
    expect(body(s)).toEqual(['code "`#tag`"', 'hide "`"', 'hide "`"']);
    expect(body(state('T\n\n    # indented code #tag', 0))).toEqual([]);
  });

  it('leaves tables, HTML and everything else raw', () => {
    const doc = 'T\n| a | b |\n| - | - |\n| **x** | #tag |\n\n<div>#tag **y**</div>\n\n1. one\n~~gone~~ [link](http://x) ---';
    expect(body(state(doc, 0))).toEqual([]);
  });

  it('returns decorations ordered by from', () => {
    const s = state('# T\n**a** `b` - c\n- [ ] d @e #f\n> g', 0);
    const d = loreDecorations(s);
    for (let i = 1; i < d.length; i++) expect(d[i].from).toBeGreaterThanOrEqual(d[i - 1].from);
  });

  it('only covers the visible ranges asked for', () => {
    const doc = 'T\n# One\n\nmiddle\n\n# Two';
    const s = state(doc, 0);
    const from = doc.indexOf('# Two');
    expect(show(s, loreDecorations(s, [{ from, to: doc.length }]))).toEqual(['h1 "# Two"', 'hide "# "']);
  });

  it('round trip leaves every byte: LF, CRLF and mixed text', () => {
    const lf = '# Title  \n\nbody with trailing   \n- [ ] item\n\tTabbed **b** \n\n\nlast line no newline  ';
    const crlf = '# Title  \r\n\r\nbody with trailing   \r\n- [ ] item\r\n\tTabbed **b** \r\n\r\n';
    const mixed = '# Title\r\nlf line\nold\rmac\r\n\r\nend  ';
    expect([lineBreakOf(lf), lineBreakOf(crlf), lineBreakOf(mixed)]).toEqual(['\n', '\r\n', '\n']);
    for (const text of [lf, crlf, mixed]) {
      const s = state(text);
      loreDecorations(s);
      expect(s.sliceDoc()).toBe(text);
    }
    // CRLF lines never hold the \r: the title and checkbox parse as in an LF text.
    const s = state(crlf);
    expect(s.doc.line(1).text).toBe('# Title  ');
    expect(show(s).slice(0, 2)).toEqual(['title "# Title  "', 'hide "# "']);
    expect(show(s)).toContain('checkbox "- [ ] " checked=false');
    // Mixed text keeps a stray \r as an ordinary character; no line holds a \n.
    const m = state(mixed);
    expect(m.doc.line(1).text).toBe('# Title\r');
    for (let n = 1; n <= m.doc.lines; n++) expect(m.doc.line(n).text).not.toContain('\n');
  });

  it('edits in a CRLF document keep CRLF', () => {
    const s = state('abc\r\ndef\r\n');
    // Inserting at a line's end goes before its line break.
    const typed = s.update({ changes: { from: s.doc.line(1).to, insert: 'XYZ' }, userEvent: 'input.type' }).state;
    expect(typed.sliceDoc()).toBe('abcXYZ\r\ndef\r\n');
    // Deleting the line break (Delete at the line end, Backspace at the next line's start) joins the lines.
    const joined = s.update({ changes: { from: s.doc.line(1).to, to: s.doc.line(2).from }, userEvent: 'delete.forward' }).state;
    expect(joined.sliceDoc()).toBe('abcdef\r\n');
    // Backspace at a line end deletes the last character, never half of the break.
    const back = s.update({ changes: { from: s.doc.line(1).to - 1, to: s.doc.line(1).to }, userEvent: 'delete.backward' }).state;
    expect(back.sliceDoc()).toBe('ab\r\ndef\r\n');
    // A new line is CRLF.
    const nl = s.update({ changes: { from: 1, insert: s.lineBreak }, userEvent: 'input' }).state;
    expect(s.lineBreak).toBe('\r\n');
    expect(nl.sliceDoc()).toBe('a\r\nbc\r\ndef\r\n');
    // So is a "\n" a command inserts (no user event): no line ever holds a bare "\n".
    const cmd = s.update(s.replaceSelection('- [ ] \n')).state;
    expect(cmd.sliceDoc()).toBe('abc\r\ndef\r\n- [ ] \r\n');
    for (let n = 1; n <= cmd.doc.lines; n++) expect(cmd.doc.line(n).text).not.toContain('\n');
  });

  it('the line-break fix keeps the caller selection, effects and annotations', () => {
    const s = state('abc\r\ndef', 0);
    // Insert "\n- \n" after "abc" and put the caret after "- " (position 3 + 3 = 6), as a list command would.
    const tr = s.update({ changes: { from: 3, insert: '\n- \n' }, selection: EditorSelection.cursor(6) });
    expect(tr.state.sliceDoc()).toBe('abc\r\n- \r\n\r\ndef');
    expect(tr.state.selection.main.head).toBe(6);
    // In the text that is after "abc\r\n- ": the caller's spot, one byte later for the added "\r".
    expect(tr.state.sliceDoc(0, tr.state.selection.main.head)).toBe('abc\r\n- ');
    expect(tr.state.doc.lineAt(6)).toMatchObject({ number: 2, text: '- ' });
    // Position-carrying effects are mapped through the fix too.
    const mark = StateEffect.define<number>({ map: (v, m) => m.mapPos(v) });
    const withEffect = s.update({ changes: { from: 3, insert: '\n\n' }, effects: mark.of(5) });
    expect(withEffect.effects.find((e) => e.is(mark))?.value).toBe(5);
  });

  it('a change kept out of history stays out of history after the fix', () => {
    const s = EditorState.create({ doc: 'abc\r\ndef', extensions: [loreMarkdown('abc\r\ndef'), history()] });
    const tr = s.update({ changes: { from: 3, insert: 'x\ny' }, annotations: Transaction.addToHistory.of(false), userEvent: 'input.paste' });
    expect(tr.annotation(Transaction.addToHistory)).toBe(false);
    expect(tr.annotation(Transaction.userEvent)).toBe('input.paste');
    expect(tr.state.sliceDoc()).toBe('abcx\r\ny\r\ndef');
    expect(undoDepth(tr.state)).toBe(0);
    // An ordinary change is undoable, as a control.
    expect(undoDepth(s.update({ changes: { from: 3, insert: 'x\ny' } }).state)).toBe(1);
  });

  it('a lone \\r inside an all-CRLF document round-trips', () => {
    const text = '# T\r\nold\rmac line\r\nend\r';
    expect(lineBreakOf(text)).toBe('\r\n');
    const s = state(text);
    loreDecorations(s);
    expect(s.sliceDoc()).toBe(text);
    expect(s.doc.line(2).text).toBe('old\rmac line');
    expect(s.doc.line(3).text).toBe('end\r');
  });

  it('pasted text takes the document line break', () => {
    const crlf = state('a\r\nb', 1);
    const intoCrlf = crlf.update(crlf.replaceSelection('x\ny\r\nz'), { userEvent: 'input.paste' }).state;
    expect(intoCrlf.sliceDoc()).toBe('ax\r\ny\r\nz\r\nb');
    expect(intoCrlf.sliceDoc(0, intoCrlf.selection.main.head)).toBe('ax\r\ny\r\nz');
    const lf = state('a\nb', 1);
    const pasted = lf.update(lf.replaceSelection('x\r\ny'), { userEvent: 'input.paste' });
    expect(pasted.state.sliceDoc()).toBe('ax\ny\nb');
    expect(pasted.state.selection.main.head).toBe('ax\ny'.length);
    // In an LF document a change that isn't user input keeps its bytes.
    expect(lf.update({ changes: { from: 1, insert: 'x\r\ny' } }).state.sliceDoc()).toBe('ax\r\ny\nb');
  });

  it('replaces never cross a line break: a multi-line own-file image stays raw', () => {
    const s = state('T\n![two\nlines](/api/files/abc) and ![one](/api/files/def)', 0);
    expect(body(s)).toEqual(['image "![one](/api/files/def)" ref=/api/files/def']);
    const replaces = new Set(['hide', 'bullet', 'checkbox', 'chip-code', 'chip-mention', 'chip-tag', 'image']);
    const s2 = state('# T\r\n- [ ] a @b #c $' + cardCode(3) + ' **d**\r\n> e\r\n![x\ny](/api/files/z)', 0);
    for (const d of loreDecorations(s2)) if (replaces.has(d.kind)) expect(s2.doc.lineAt(d.from).to).toBeGreaterThanOrEqual(d.to);
  });

  it('a node spanning a gap between visible ranges is decorated once', () => {
    const doc = 'T\n**a\nmid\nb**';
    const s = state(doc, 0);
    const l2 = s.doc.line(2);
    const l4 = s.doc.line(4);
    expect(show(s, loreDecorations(s, [{ from: l2.from, to: l2.to }, { from: l4.from, to: l4.to }]))).toEqual([
      'bold "**a\\nmid\\nb**"',
      'hide "**"',
      'hide "**"',
    ]);
  });

  it('recomputes 20 KB in under 20 ms', () => {
    const para = '## Heading\nSome **bold** and *italic* text with `code`, @ada, #lore and $' + cardCode(7) + '.\n- [ ] a task\n- bullet\n> quote\n\n';
    const doc = '# Big lore\n' + para.repeat(Math.ceil(20_000 / para.length));
    expect(doc.length).toBeGreaterThanOrEqual(20_000);
    const s = state(doc, 0);
    let d = loreDecorations(s); // parses the document once
    // The best of five, so a busy machine (the whole suite runs in parallel) doesn't fail it.
    let ms = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      d = loreDecorations(s);
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(d.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(20);
  });
});

describe('only the person edits the text', () => {
  // Input handlers and transaction filters can add text the person didn't type (lang-html's
  // auto-closing `</div>` was one). The lore state has none but the line-break filter.
  const s = EditorState.create({ doc: 'T\n<div>', extensions: [loreMarkdown('T\n'), loreDecorationsExtension(), history()] });
  it('has no input handlers', () => {
    expect(s.facet(EditorView.inputHandler)).toEqual([]);
  });
  it('has no transaction filter but the line-break one', () => {
    expect(s.facet(EditorState.transactionFilter)).toEqual([lineBreakFilter]);
  });
});

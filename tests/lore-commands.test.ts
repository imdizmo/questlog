import { describe, it, expect } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { loreMarkdown } from '../web/src/lore/decorations';
import {
  backspaceHeading, insertLink, onCaretLine, setHeading, toggleBold, toggleCheckbox, toggleChecklist, toggleItalic, toggleList, toggleQuote,
} from '../web/src/lore/commands';

/**
 * A state over `doc` where `|` marks the caret and `«`…`»` a selection (anchor at `«`, head at `»`).
 * The markers are removed from the text.
 */
function state(marked: string): EditorState {
  let doc = '';
  let anchor = -1;
  let head = -1;
  for (const ch of marked) {
    if (ch === '|') anchor = head = doc.length;
    else if (ch === '«') anchor = doc.length;
    else if (ch === '»') head = doc.length;
    else doc += ch;
  }
  const s = EditorState.create({ doc, extensions: [loreMarkdown(doc)] });
  // A CRLF line break is one position in CodeMirror but two characters in the text.
  const pos = (off: number) => (s.lineBreak === '\r\n' ? off - (doc.slice(0, off).match(/\r\n/g)?.length ?? 0) : off);
  const a = anchor < 0 ? s.doc.length : pos(anchor);
  return s.update({ selection: EditorSelection.single(a, head < 0 ? a : pos(head)) }).state;
}

/** Applies a command's spec and shows the text with the selection marked as in `state()`. */
function apply(s: EditorState, spec: TransactionSpec | null): string {
  const next = spec ? s.update(spec).state : s;
  const { from, to, empty } = next.selection.main;
  const text = next.sliceDoc();
  if (empty) return text.slice(0, from) + '|' + text.slice(from);
  return text.slice(0, from) + '«' + text.slice(from, to) + '»' + text.slice(to);
}
const run = (marked: string, cmd: (s: EditorState) => TransactionSpec | null) => apply(state(marked), cmd(state(marked)));

describe('toggleBold / toggleItalic', () => {
  it('wraps the selection and keeps the inner text selected', () => {
    expect(run('Title\nsay «hello» there', toggleBold)).toBe('Title\nsay **«hello»** there');
    expect(run('Title\nsay «hello» there', toggleItalic)).toBe('Title\nsay *«hello»* there');
  });
  it('leaves surrounding spaces out of the marks', () => {
    expect(run('Title\nsay« hello »there', toggleBold)).toBe('Title\nsay **«hello»** there');
  });
  it('unwraps when the selection is the inner text, the whole span, or a caret inside', () => {
    expect(run('Title\nsay **«hello»** there', toggleBold)).toBe('Title\nsay «hello» there');
    expect(run('Title\nsay «**hello**» there', toggleBold)).toBe('Title\nsay «hello» there');
    expect(run('Title\nsay **hel|lo** there', toggleBold)).toBe('Title\nsay hel|lo there');
    expect(run('Title\nsay *«hello»* there', toggleItalic)).toBe('Title\nsay «hello» there');
    expect(run('Title\nsay _hel|lo_ there', toggleItalic)).toBe('Title\nsay hel|lo there');
  });
  it('italic inside bold adds a mark rather than removing the bold', () => {
    expect(run('Title\n**«hello»**', toggleItalic)).toBe('Title\n***«hello»***');
    expect(run('Title\n***«hello»***', toggleItalic)).toBe('Title\n**«hello»**');
    expect(run('Title\n***«hello»***', toggleBold)).toBe('Title\n*«hello»*');
  });
  it('an empty selection inserts a pair of marks around the caret', () => {
    expect(run('Title\nsay |', toggleBold)).toBe('Title\nsay **|**');
    expect(run('Title\nsay |', toggleItalic)).toBe('Title\nsay *|*');
  });
});

describe('setHeading', () => {
  it('adds, changes and removes a line-start mark, keeping the caret in the text', () => {
    expect(run('Title\nFo|g', setHeading(2))).toBe('Title\n## Fo|g');
    expect(run('Title\n|Fog', setHeading(2))).toBe('Title\n## |Fog');
    expect(run('Title\n# Fo|g', setHeading(3))).toBe('Title\n### Fo|g');
    expect(run('Title\n## Fo|g', setHeading(2))).toBe('Title\nFo|g');
  });
  it('applies to every line of the selection', () => {
    expect(run('Title\n«a\nb»', setHeading(1))).toBe('Title\n«# a\n# b»');
  });
  it('does nothing on line 1, the title', () => {
    expect(run('Ti|tle\nbody', setHeading(2))).toBe('Ti|tle\nbody');
    expect(run('# Ti|tle\nbody', setHeading(1))).toBe('# Ti|tle\nbody');
    const s = state('Ti|tle');
    expect(setHeading(2)(s).changes).toBeUndefined();
  });
  it('a selection reaching into line 1 changes only the other lines', () => {
    expect(run('Ti«tle\nbo»dy', setHeading(2))).toBe('Ti«tle\n## bo»dy');
  });
});

describe('backspaceHeading', () => {
  it('removes the whole mark when the caret is at the start of the heading text', () => {
    expect(run('Title\n## |Fog', (s) => backspaceHeading(s))).toBe('Title\n|Fog');
    expect(run('# |Title', (s) => backspaceHeading(s))).toBe('|Title');
  });
  it('leaves other Backspaces to the default commands', () => {
    expect(backspaceHeading(state('Title\n## F|og'))).toBeNull();
    expect(backspaceHeading(state('Title\n#|# Fog'))).toBeNull();
    expect(backspaceHeading(state('Title\n«## »Fog'))).toBeNull();
  });
});

describe('line marks', () => {
  it('toggleList adds and removes "- "', () => {
    expect(run('Title\nfo|g', toggleList)).toBe('Title\n- fo|g');
    expect(run('Title\n|fog', toggleList)).toBe('Title\n- |fog');
    expect(run('Title\n- fo|g', toggleList)).toBe('Title\nfo|g');
    expect(run('Title\n«a\n\nb»', toggleList)).toBe('Title\n«- a\n\n- b»');
    expect(run('Title\n- [ ] fo|g', toggleList)).toBe('Title\n- fo|g');
    expect(run('Title\n  - fo|g', toggleList)).toBe('Title\n  fo|g');
  });
  it('toggleChecklist turns lines and bullets into tasks and back', () => {
    expect(run('Title\nfo|g', toggleChecklist)).toBe('Title\n- [ ] fo|g');
    expect(run('Title\n- fo|g', toggleChecklist)).toBe('Title\n- [ ] fo|g');
    expect(run('Title\n- [x] fo|g', toggleChecklist)).toBe('Title\nfo|g');
    expect(run('Title\n«- [ ] a\nb»', toggleChecklist)).toBe('Title\n«- [ ] a\n- [ ] b»');
  });
  it('toggleQuote adds and removes "> "', () => {
    expect(run('Title\nfo|g', toggleQuote)).toBe('Title\n> fo|g');
    expect(run('Title\n> fo|g', toggleQuote)).toBe('Title\nfo|g');
    expect(run('Title\n>fo|g', toggleQuote)).toBe('Title\nfo|g');
  });
  it('a selection ending at a line start leaves that line alone', () => {
    expect(run('Title\n«a\n»b', toggleQuote)).toBe('Title\n«> a\n»b');
  });
  it('keeps CRLF line breaks', () => {
    const s = state('Title\r\n«a\r\nb»');
    expect(s.update(toggleList(s)).state.sliceDoc()).toBe('Title\r\n- a\r\n- b');
  });
});

describe('insertLink', () => {
  it('wraps the selection and selects the URL to type over', () => {
    expect(run('Title\nsee «docs»', insertLink)).toBe('Title\nsee [docs](«https://»)');
  });
  it('an empty selection inserts a template with "link text" selected', () => {
    expect(run('Title\nsee |', insertLink)).toBe('Title\nsee [«link text»](https://)');
  });
});

describe('toggleCheckbox', () => {
  it('swaps only the box character', () => {
    const s = state('Title\n- [ ] a\n- [x] b|');
    const line2 = s.doc.line(2).from;
    const line3 = s.doc.line(3).from;
    expect(s.update(toggleCheckbox(s, line2)).state.sliceDoc()).toBe('Title\n- [x] a\n- [x] b');
    expect(s.update(toggleCheckbox(s, line3)).state.sliceDoc()).toBe('Title\n- [ ] a\n- [ ] b');
    const spec = toggleCheckbox(s, line2);
    expect(s.changes(spec.changes!).length).toBe(s.doc.length);
  });
  it('does nothing on a line without a box', () => {
    const s = state('Title\n- a|');
    expect(toggleCheckbox(s, s.doc.line(2).from).changes).toBeUndefined();
  });
  it('an uppercase X unticks', () => {
    const s = state('Title\n  - [X] a|');
    expect(s.update(toggleCheckbox(s, s.doc.line(2).from + 2)).state.sliceDoc()).toBe('Title\n  - [ ] a');
  });
});

describe('onCaretLine (Enter and Backspace continuation)', () => {
  const enter = (marked: string) => {
    const s = state(marked);
    const tr = onCaretLine(s, insertNewlineContinueMarkup);
    return tr ? apply(s, tr) : null;
  };
  it('continues bullets, checklists and quotes on the caret line', () => {
    expect(enter('Title\n- one|')).toBe('Title\n- one\n- |');
    expect(enter('Title\n- [x] one|')).toBe('Title\n- [x] one\n- [ ] |');
    expect(enter('Title\n> one|')).toBe('Title\n> one\n> |');
  });
  it('a CRLF document continues with CRLF', () => {
    const s = state('Title\r\n- one|');
    expect(s.update(onCaretLine(s, insertNewlineContinueMarkup)!).state.sliceDoc()).toBe('Title\r\n- one\r\n- ');
  });
  it('never renumbers the rest of a numbered list: the plain key runs instead', () => {
    const s = state('Title\n1. one|\n2. two\n3. three');
    // lang-markdown on its own would renumber the following items.
    let raw = '';
    insertNewlineContinueMarkup({ state: s, dispatch: (t) => { raw = t.state.sliceDoc(); } });
    expect(raw).toContain('3. two');
    expect(onCaretLine(s, insertNewlineContinueMarkup)).toBeNull();
  });
  it('outside markup it does nothing', () => {
    expect(enter('Title\nplain|')).toBeNull();
  });
  it('Backspace after a bullet removes its mark on that line only', () => {
    const s = state('Title\n- one\n- |');
    const tr = onCaretLine(s, deleteMarkupBackward);
    expect(tr).not.toBeNull();
    expect(apply(s, tr)).not.toContain('- |');
    expect(onCaretLine(state('Title\nplain|'), deleteMarkupBackward)).toBeNull();
  });
});

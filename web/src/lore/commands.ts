import { type ChangeSet, EditorSelection, type EditorState, type Line, type SelectionRange, type StateCommand, type Transaction, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { CHECKBOX } from '../../../shared/content';

/**
 * The lore editor's formatting commands: pure functions from a state to the transaction that
 * applies them. They only add or remove Markdown marks around the selection or at line starts;
 * the text in between is never touched. A command with nothing to do returns `{}`.
 */

/** The selection after `changes`: carets and range ends move past text inserted at them, range starts stay before it. */
function mapSelection(state: EditorState, changes: ChangeSet): EditorSelection {
  return EditorSelection.create(
    state.selection.ranges.map((r) => {
      if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head, 1));
      const forward = r.head > r.anchor;
      return EditorSelection.range(changes.mapPos(r.anchor, forward ? -1 : 1), changes.mapPos(r.head, forward ? 1 : -1));
    }),
    state.selection.mainIndex,
  );
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** The innermost `name` node containing [from, to] (strictly inside it for a caret). */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  let found: SyntaxNode | null = null;
  tree.iterate({
    from,
    to,
    enter: (n) => {
      const inside = from === to ? n.from < from && to < n.to : n.from <= from && to <= n.to;
      if (n.name === name && inside) found = n.node;
    },
  });
  return found;
}

function toggleInline(state: EditorState, node: 'StrongEmphasis' | 'Emphasis', mark: string): TransactionSpec {
  return state.changeByRange((r: SelectionRange) => {
    const span = enclosing(state, r.from, r.to, node);
    if (span) {
      // Unwrap: drop this span's own marks; the selection keeps covering the same text.
      const marks = span.getChildren('EmphasisMark').map((m) => ({ from: m.from, to: m.to }));
      const changes = state.changes(marks);
      return { changes, range: EditorSelection.range(changes.mapPos(r.from, -1), changes.mapPos(r.to, -1)) };
    }
    if (r.empty) {
      return { changes: { from: r.from, insert: mark + mark }, range: EditorSelection.cursor(r.from + mark.length) };
    }
    // Wrap, leaving spaces at the selection's ends outside (`** a**` would not be bold).
    const text = state.sliceDoc(r.from, r.to);
    const from = r.from + (text.length - text.trimStart().length);
    const to = Math.max(from, r.to - (text.length - text.trimEnd().length));
    return {
      changes: [
        { from, insert: mark },
        { from: to, insert: mark },
      ],
      range: EditorSelection.range(from + mark.length, to + mark.length),
    };
  });
}

/** Bold on or off: wraps the selection in `**`, or removes the marks of the bold span it is in. */
export const toggleBold = (state: EditorState): TransactionSpec => toggleInline(state, 'StrongEmphasis', '**');
/** Italic on or off: wraps the selection in `*`, or removes the marks of the italic span it is in. */
export const toggleItalic = (state: EditorState): TransactionSpec => toggleInline(state, 'Emphasis', '*');

/** The lines the selection covers, in order; a range ending at a line start leaves that line out. */
function selectedLines(state: EditorState): Line[] {
  const seen = new Map<number, Line>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (last.number > first.number && last.from === r.to) last = state.doc.line(last.number - 1);
    for (let n = first.number; n <= last.number; n++) if (!seen.has(n)) seen.set(n, state.doc.line(n));
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

/** Line-start edits for the given lines (null: leave that line), with the selection kept on the same text. */
function editLines(state: EditorState, lines: Line[], edit: (line: Line) => { from: number; to: number; insert: string } | null): TransactionSpec {
  const specs = lines.map(edit).filter((c): c is { from: number; to: number; insert: string } => !!c && (c.to > c.from || c.insert !== ''));
  const real = specs.filter((c) => state.sliceDoc(c.from, c.to) !== c.insert);
  if (real.length === 0) return {};
  const changes = state.changes(real);
  return { changes, selection: mapSelection(state, changes), scrollIntoView: true };
}

/** The lines a line-mark command works on: blank lines are skipped when there are others. */
function markLines(state: EditorState, skipTitle = false): Line[] {
  let lines = selectedLines(state);
  if (skipTitle) lines = lines.filter((l) => l.number > 1);
  const filled = lines.filter((l) => l.text.trim() !== '');
  return filled.length ? filled : lines;
}

const HEADING = /^(#{1,6})(?:[ \t]+|$)/;

/**
 * Heading `level` on the selected lines (`#`, `##`, `###`), replacing another level's mark; when
 * every line already has this level, the marks are removed. Line 1 is the title and is left alone.
 */
export function setHeading(level: 1 | 2 | 3) {
  return (state: EditorState): TransactionSpec => {
    const lines = markLines(state, true);
    const mark = '#'.repeat(level) + ' ';
    const all = lines.length > 0 && lines.every((l) => HEADING.exec(l.text)?.[1].length === level);
    return editLines(state, lines, (l) => {
      const m = HEADING.exec(l.text);
      return { from: l.from, to: l.from + (m ? m[0].length : 0), insert: all ? '' : mark };
    });
  };
}

/**
 * Backspace with the caret right after a heading's `## ` removes the whole mark (null otherwise,
 * so Backspace falls through to the default commands).
 */
export function backspaceHeading(state: EditorState): TransactionSpec | null {
  const r = state.selection.main;
  if (state.selection.ranges.length > 1 || !r.empty) return null;
  const line = state.doc.lineAt(r.head);
  const m = /^#{1,6}[ \t]+/.exec(line.text);
  if (!m || r.head !== line.from + m[0].length) return null;
  return { changes: { from: line.from, to: r.head }, selection: EditorSelection.cursor(line.from), userEvent: 'delete.backward', scrollIntoView: true };
}

/** Indentation, then any list mark (task, bullet or number). */
const LIST = /^(\s*)((?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?)/;
const TASK = /^\s*[-*+] \[[ xX]\] /;
const BULLET = /^\s*[-*+] /;

function setListMark(state: EditorState, isMarked: (text: string) => boolean, mark: string): TransactionSpec {
  const lines = markLines(state);
  const all = lines.length > 0 && lines.every((l) => isMarked(l.text));
  return editLines(state, lines, (l) => {
    const m = LIST.exec(l.text)!;
    return { from: l.from + m[1].length, to: l.from + m[0].length, insert: all ? '' : mark };
  });
}

/** Bullets (`- `) on or off for the selected lines; tasks and numbered items become bullets. */
export const toggleList = (state: EditorState): TransactionSpec =>
  setListMark(state, (t) => BULLET.test(t) && !TASK.test(t), '- ');
/** Checklist items (`- [ ] `) on or off for the selected lines; bullets become items. */
export const toggleChecklist = (state: EditorState): TransactionSpec => setListMark(state, (t) => TASK.test(t), '- [ ] ');

/** Quote marks (`> `) on or off for the selected lines. */
export function toggleQuote(state: EditorState): TransactionSpec {
  const lines = markLines(state);
  const all = lines.length > 0 && lines.every((l) => l.text.startsWith('>'));
  return editLines(state, lines, (l) =>
    all ? { from: l.from, to: l.from + (/^> ?/.exec(l.text)?.[0].length ?? 0), insert: '' } : { from: l.from, to: l.from, insert: '> ' },
  );
}

/** A link around the selection with the URL selected to type over, or `[link text](https://)` with "link text" selected. */
export function insertLink(state: EditorState): TransactionSpec {
  return state.changeByRange((r) => {
    if (r.empty) return { changes: { from: r.from, insert: '[link text](https://)' }, range: EditorSelection.range(r.from + 1, r.from + 10) };
    return {
      changes: [
        { from: r.from, insert: '[' },
        { from: r.to, insert: '](https://)' },
      ],
      range: EditorSelection.range(r.to + 3, r.to + 11),
    };
  });
}

/** Ticks or unticks the checklist item on the line at `pos`, changing only the character in `[ ]`. */
export function toggleCheckbox(state: EditorState, pos: number): TransactionSpec {
  const line = state.doc.lineAt(pos);
  const m = CHECKBOX.exec(line.text);
  if (!m) return {};
  const at = line.from + m[0].length - 3;
  return { changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.check' };
}

/**
 * Runs a Markdown state command (list/quote continuation on Enter, markup removal on Backspace)
 * without letting it touch other lines: lang-markdown's versions may renumber the rest of a
 * numbered list or rewrite a neighbouring blank line. The result is kept only when every change
 * stays on the caret's line; null otherwise (and when the command does nothing), so the plain key
 * runs instead.
 */
export function onCaretLine(state: EditorState, command: StateCommand): Transaction | null {
  if (state.selection.ranges.length > 1) return null;
  let tr: Transaction | null = null;
  if (!command({ state, dispatch: (t) => { tr = t; } }) || !tr) return null;
  const line = state.doc.lineAt(state.selection.main.head);
  let inside = true;
  (tr as Transaction).changes.iterChangedRanges((fromA, toA) => {
    if (fromA < line.from || toA > line.to) inside = false;
  });
  return inside ? tr : null;
}

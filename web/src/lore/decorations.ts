import { ChangeSet, EditorState, type Extension, type Range, type Transaction, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { seqFromCode } from '../../../shared/cards';
import { CHECKBOX, TOKEN_BODY, tokenBoundary } from '../../../shared/content';
import { OWN_FILE } from '../markdown';
import { toggleCheckbox } from './commands';

/**
 * The lore editor's view of a Markdown document: which ranges to style, hide or show as a widget.
 * Decorations never change the text; they only decide how it looks.
 */
export interface LoreDecoration {
  from: number;
  to: number;
  kind:
    | 'hide'
    | 'title'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'bold'
    | 'italic'
    | 'code'
    | 'bullet'
    | 'checkbox'
    | 'quote'
    | 'chip-code'
    | 'chip-mention'
    | 'chip-tag'
    | 'image';
  /** checkbox: ticked. */
  checked?: boolean;
  /** chip-*: the token's name without its sigil; image: the file URL. */
  ref?: string;
}

/**
 * The line break a document is edited with: "\r\n" when every line break in `text` is CRLF,
 * otherwise "\n". Mixed text keeps "\n", so a stray "\r" stays an ordinary character (shown raw)
 * and no line ever holds a "\n".
 */
export function lineBreakOf(text: string): '\n' | '\r\n' {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/**
 * Inserted text takes the document's line break. In a CRLF document every change does (a bare
 * "\n" would otherwise sit inside a line, which the view can't show), including commands that
 * insert "\n" templates. In an LF document only user input does (typing, paste, drop), so a stray
 * "\r" isn't left at a line end; a programmatic change there keeps its bytes.
 */
export const lineBreakFilter = (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
  const sep = tr.startState.lineBreak;
  if (!tr.docChanged || (sep === '\n' && !tr.isUserEvent('input'))) return tr;
  // Positions in the transaction's new document that need fixing. In a CRLF document a bare "\n"
  // inside an inserted line becomes a line break (same length: CodeMirror counts any break as one
  // position). In an LF document an inserted line ending in "\r" loses the "\r".
  const fix: { from: number; to: number; insert?: string }[] = [];
  tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
    let pos = fromB;
    let n = 0;
    for (const line of inserted.iterLines()) {
      n++;
      if (sep === '\r\n') {
        for (let i = line.indexOf('\n'); i >= 0; i = line.indexOf('\n', i + 1)) fix.push({ from: pos + i, to: pos + i + 1, insert: sep });
      } else if (n < inserted.lines && line.endsWith('\r')) {
        fix.push({ from: pos + line.length - 1, to: pos + line.length });
      }
      pos += line.length + 1;
    }
  });
  if (fix.length === 0) return tr;
  // Applied after the transaction: CodeMirror maps its selection and effects through the fix and
  // keeps all its annotations (user event, addToHistory, remote, isolateHistory…) and scrollIntoView.
  return [tr, { changes: ChangeSet.of(fix, tr.newDoc.length, sep), sequential: true }];
};
const inputLineBreaks = EditorState.transactionFilter.of(lineBreakFilter);

/** HTML inside Markdown, highlighted only: no closing tags are added or matched as the person types. */
const htmlTags = html({ matchClosingTags: false, autoCloseTags: false });

/**
 * Markdown (GFM, so `- [ ]` parses as a task) with the line break taken from `text` (the document
 * the editor opens with). Read the text back with `state.sliceDoc()`, which joins lines with that
 * break, so an unedited document comes back byte for byte (`state.doc.toString()` always uses "\n").
 * lang-markdown's extras that change text the person didn't type are off: closing HTML tags (its
 * HTML support auto-closes `<div>` on `>` unless told not to),
 * pasting a URL over a selection as a link, and its Enter/Backspace keymap (which can renumber a
 * whole list; the editor binds guarded versions instead).
 */
export function loreMarkdown(text = ''): Extension {
  return [EditorState.lineSeparator.of(lineBreakOf(text)), inputLineBreaks, markdown({ base: markdownLanguage, htmlTagLanguage: htmlTags, completeHTMLTags: false, pasteURLAsLink: false, addKeymap: false })];
}

const HEADING: Record<string, 'h1' | 'h2' | 'h3'> = { ATXHeading1: 'h1', ATXHeading2: 'h2', ATXHeading3: 'h3' };
/** Nodes whose text is shown raw: nothing inside is styled and no chip starts there. */
const RAW = new Set([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'ProcessingInstruction',
  'Table',
  'LinkReference',
  'URL',
  'Autolink',
]);
/** Block marks after which a line's inline text starts (a chip may follow them directly, as in the reader). */
const BLOCK_MARKS = new Set(['QuoteMark', 'ListMark', 'HeaderMark', 'TaskMarker']);

type ChipKind = 'chip-code' | 'chip-mention' | 'chip-tag';
const SIGIL: Record<string, ChipKind> = { '#': 'chip-tag', '@': 'chip-mention', $: 'chip-code' };
const BODY: Record<ChipKind, RegExp> = {
  'chip-tag': new RegExp(TOKEN_BODY.tag, 'uy'),
  'chip-mention': new RegExp(TOKEN_BODY.mention, 'uy'),
  'chip-code': new RegExp(TOKEN_BODY.code, 'uy'),
};
const SIGILS = /[#@$]/g;
const TASK = /^- \[([ xX])\] /;

/** Sorted, merged copies of the ranges, clipped to the document. */
function mergeRanges(ranges: readonly { from: number; to: number }[], length: number) {
  const sorted = ranges
    .map((r) => ({ from: Math.max(0, r.from), to: Math.min(length, r.to) }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/**
 * What to decorate in `visible` (default: the whole document), ordered by `from` (then outer before
 * inner). A mark the selection touches is left out, so it shows raw while being edited: a heading's
 * or the title's marks while any selection range is on that line, bold/italic/code marks while one
 * is on the span, bullets, checkboxes, quote marks, chips and images while one touches them.
 * Nothing that replaces text (hide, bullet, checkbox, chip, image) crosses a line break, which
 * CodeMirror refuses to replace from a plugin.
 */
export function loreDecorations(state: EditorState, visible?: readonly { from: number; to: number }[]): LoreDecoration[] {
  const doc = state.doc;
  const ranges = mergeRanges(visible ?? [{ from: 0, to: doc.length }], doc.length);
  if (ranges.length === 0) return [];
  // CodeMirror's default budget; a longer parse falls back to the tree so far, and the view plugin
  // recomputes when the background parse moves on.
  const tree = ensureSyntaxTree(state, ranges[ranges.length - 1].to, 50) ?? syntaxTree(state);
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);

  const out: LoreDecoration[] = [];
  const add = (d: LoreDecoration) => {
    out.push(d);
  };
  /** Hides a mark and the spaces after it. */
  const hideMark = (from: number, to: number) => {
    let end = to;
    const line = doc.lineAt(from);
    while (end < line.to && (doc.sliceString(end, end + 1) === ' ' || doc.sliceString(end, end + 1) === '\t')) end++;
    add({ from, to: end, kind: 'hide' });
  };

  const firstLine = doc.line(1);
  if (firstLine.length > 0 && ranges[0].from <= firstLine.to) add({ from: 0, to: firstLine.to, kind: 'title' });

  const raw: { from: number; to: number }[] = [];
  const links: { from: number; to: number }[] = [];
  const markEnds = new Set<number>();
  let quoteLine = -1;

  // Ranges are merged, so a node is entered twice only when it spans a gap between two of them;
  // such a node starts at or before the previous range's end and was handled there.
  let prevTo = -1;
  for (const range of ranges) {
    const handledTo = prevTo;
    prevTo = range.to;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const { name, from, to } = node;
        if (RAW.has(name)) {
          raw.push({ from, to });
          return false;
        }
        if (from <= handledTo) return name === 'Image' || name === 'InlineCode' ? false : undefined;
        if (BLOCK_MARKS.has(name)) markEnds.add(to);

        if (name.startsWith('ATXHeading')) {
          const line = doc.lineAt(from);
          const mark = node.node.getChild('HeaderMark');
          const isTitle = line.number === 1;
          const kind = HEADING[name];
          if (!isTitle && !kind) return; // h4–h6 show raw
          if (!isTitle) add({ from: line.from, to: line.to, kind });
          if (mark && mark.from === from && !touched(line.from, line.to)) hideMark(mark.from, mark.to);
          return;
        }

        if (name === 'StrongEmphasis' || name === 'Emphasis') {
          add({ from, to, kind: name === 'StrongEmphasis' ? 'bold' : 'italic' });
          if (!touched(from, to)) for (const m of node.node.getChildren('EmphasisMark')) add({ from: m.from, to: m.to, kind: 'hide' });
          return;
        }

        if (name === 'InlineCode') {
          add({ from, to, kind: 'code' });
          if (!touched(from, to)) for (const m of node.node.getChildren('CodeMark')) add({ from: m.from, to: m.to, kind: 'hide' });
          raw.push({ from, to });
          return false;
        }

        if (name === 'ListMark') {
          if (node.node.parent?.parent?.name !== 'BulletList' || doc.sliceString(from, to + 1) !== '- ') return;
          const line = doc.lineAt(from);
          const task = TASK.exec(doc.sliceString(from, Math.min(line.to, from + 6)));
          const atStart = line.text.slice(0, from - line.from).trim() === '';
          if (task && atStart && CHECKBOX.test(line.text)) {
            const end = from + task[0].length;
            if (!touched(from, end)) add({ from, to: end, kind: 'checkbox', checked: task[1] !== ' ' });
          } else if (!touched(from, to + 1)) {
            add({ from, to: to + 1, kind: 'bullet' });
          }
          return;
        }

        if (name === 'QuoteMark') {
          const line = doc.lineAt(from);
          if (line.number !== quoteLine) {
            quoteLine = line.number;
            add({ from: line.from, to: line.to, kind: 'quote' });
          }
          const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
          if (!touched(from, end)) add({ from, to: end, kind: 'hide' });
          return;
        }

        if (name === 'Image') {
          raw.push({ from, to });
          const url = node.node.getChild('URL');
          const src = url ? doc.sliceString(url.from, url.to) : '';
          if (OWN_FILE.test(src) && doc.lineAt(from).to >= to && !touched(from, to)) add({ from, to, kind: 'image', ref: src });
          return false;
        }

        if (name === 'Link') links.push({ from, to });
        return;
      },
    });
  }

  raw.sort((a, b) => a.from - b.from);
  const inside = (list: { from: number; to: number }[], pos: number) => list.some((r) => r.from <= pos && pos < r.to);

  for (const range of ranges) {
    const text = doc.sliceString(range.from, range.to);
    SIGILS.lastIndex = 0;
    for (let m = SIGILS.exec(text); m; m = SIGILS.exec(text)) {
      const pos = range.from + m.index;
      const prev = pos === 0 ? undefined : m.index > 0 ? text[m.index - 1] : doc.sliceString(pos - 1, pos);
      if (!tokenBoundary(prev) && !markEnds.has(pos)) continue;
      const kind = SIGIL[m[0]];
      const re = BODY[kind];
      re.lastIndex = m.index + 1;
      const body = re.exec(text)?.[0];
      if (!body) continue;
      if (kind === 'chip-code' && (seqFromCode(body) === null || inside(links, pos))) continue;
      if (inside(raw, pos)) continue;
      const end = pos + 1 + body.length;
      SIGILS.lastIndex = m.index + 1 + body.length;
      if (!touched(pos, end)) add({ from: pos, to: end, kind, ref: body });
    }
  }

  return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'lore-bullet';
    el.textContent = '•';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly item: string,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.item === this.item;
  }
  /** A button showing the box; a click swaps `[ ]` and `[x]` in the text and nothing else. */
  toDOM(view: EditorView) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = this.checked ? 'lore-check is-checked' : 'lore-check';
    el.setAttribute('aria-label', `${this.checked ? 'Done' : 'Not done'}${this.item ? `: ${this.item}` : ''}`);
    el.tabIndex = -1;
    // Keep the caret and focus where they are; the click itself does the tick.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch(toggleCheckbox(view.state, view.posAtDOM(el)));
    });
    return el;
  }
}

class ChipWidget extends WidgetType {
  constructor(
    readonly kind: ChipKind,
    readonly text: string,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.kind === this.kind && other.text === this.text;
  }
  toDOM() {
    const el = document.createElement('span');
    const cls = { 'chip-tag': 'md-tag', 'chip-mention': 'md-mention', 'chip-code': 'card-ref' }[this.kind];
    el.className = `md-chip ${cls} lore-chip`;
    el.textContent = this.text;
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('img');
    el.className = 'lore-image';
    // The image's height is known only once it loads; the view measures its lines again then.
    el.onload = () => view.requestMeasure();
    el.src = this.src;
    el.alt = this.alt;
    return el;
  }
}

const LINE_CLASS = { title: 'lore-title', h1: 'lore-h1', h2: 'lore-h2', h3: 'lore-h3', quote: 'lore-quote' } as const;
const MARK_CLASS = { bold: 'lore-bold', italic: 'lore-italic', code: 'lore-code' } as const;
const hidden = Decoration.replace({});
const REPLACES = { hide: 1, bullet: 1, checkbox: 1, 'chip-code': 1, 'chip-mention': 1, 'chip-tag': 1, image: 1 };
const bullet = Decoration.replace({ widget: new BulletWidget() });

function toDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  for (const d of loreDecorations(state, view.visibleRanges)) {
    // A plugin may not replace a line break; loreDecorations never asks to, this keeps it so.
    if (d.kind in REPLACES && state.doc.lineAt(d.from).to < d.to) continue;
    switch (d.kind) {
      case 'title':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'quote':
        out.push(Decoration.line({ class: LINE_CLASS[d.kind] }).range(d.from));
        break;
      case 'bold':
      case 'italic':
      case 'code':
        if (d.to > d.from) out.push(Decoration.mark({ class: MARK_CLASS[d.kind] }).range(d.from, d.to));
        break;
      case 'hide':
        if (d.to > d.from) out.push(hidden.range(d.from, d.to));
        break;
      case 'bullet':
        out.push(bullet.range(d.from, d.to));
        break;
      case 'checkbox':
        out.push(Decoration.replace({ widget: new CheckboxWidget(!!d.checked, state.sliceDoc(d.to, state.doc.lineAt(d.to).to).trim()) }).range(d.from, d.to));
        break;
      case 'chip-code':
      case 'chip-mention':
      case 'chip-tag':
        out.push(Decoration.replace({ widget: new ChipWidget(d.kind, state.sliceDoc(d.from, d.to)) }).range(d.from, d.to));
        break;
      case 'image': {
        const alt = /^!\[([^\]]*)\]/.exec(state.sliceDoc(d.from, d.to))?.[1] ?? '';
        out.push(Decoration.replace({ widget: new ImageWidget(d.ref ?? '', alt) }).range(d.from, d.to));
        break;
      }
    }
  }
  return Decoration.set(out, true);
}

/** The decorations as CodeMirror sees them, recomputed when the text, selection, viewport or parse changes. */
export function loreDecorationsExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = toDecorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = toDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

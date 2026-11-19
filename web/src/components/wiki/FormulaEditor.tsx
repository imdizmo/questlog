import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { completions, type Completion, type FormulaProblem, type FormulaScope } from '../../../../shared/formula';
import { noteSent, syncFromParent } from '../../lore/parentSync';

export interface FormulaEditorProps {
  /** The accessible name of the formula box ("Part crit", "Result", …). */
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** Leaving the box, or Enter with no suggestions open (the editors save then). */
  onBlur?: () => void;
  /** The suggestion list opened or closed (FormulaInput holds back the problem words while it is open). */
  onMenu?: (open: boolean) => void;
  /** What the formula may name, for completion. */
  scope: FormulaScope;
  /** Problems to mark in the text (red underline); the words are shown under the box by FormulaInput. */
  problems: FormulaProblem[];
  placeholder?: string;
  /** Id of the element that describes the box (its problems). */
  describedBy?: string;
}

/** At most this many suggestions are listed. */
const MAX_ITEMS = 40;

const setProblems = StateEffect.define<FormulaProblem[]>();
const problemMark = Decoration.mark({ class: 'cm-formula-problem' });
/** Problems as underlines; an empty place (the end of the text) marks the character before it. */
const problemField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) {
      if (!e.is(setProblems)) continue;
      const len = tr.state.doc.length;
      const ranges: Range<Decoration>[] = [];
      for (const p of e.value) {
        let from = Math.max(0, Math.min(p.from, len));
        let to = Math.max(from, Math.min(p.to, len));
        if (to === from) { if (from < len) to = from + 1; else if (len > 0) from = len - 1, to = len; else continue; }
        ranges.push(problemMark.range(from, to));
      }
      return Decoration.set(ranges, true);
    }
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** One line of a suggestion: "armor (hp)" for a field with a unit. */
export const completionText = (c: Completion) => (c.unit ? `${c.label} (${c.unit})` : c.label);

const KIND_WORD: Record<Completion['kind'], string> = {
  role: 'role', field: 'field', part: 'part', state: 'state', table: 'table', function: 'function', rule: 'rule', option: 'option', keyword: 'word',
};

interface Menu { items: Completion[]; active: number; pos: { top: number; left: number } | null }

/**
 * A formula box: CodeMirror over the formula text, with suggestions as you type (roles, fields with their unit,
 * parts, state, tables, rules, functions, enum options inside quotes) and the problems underlined.
 * Keys: ↑/↓ choose a suggestion, Enter or Tab takes it, Esc closes the list, Ctrl+Space opens it; Enter otherwise
 * saves, like leaving the box (a formula is one line; long ones wrap).
 */
export function FormulaEditor({ label, value, onChange, onBlur, onMenu, scope, problems, placeholder, describedBy }: FormulaEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const attrs = useRef(new Compartment()).current;
  const listId = useId();
  const [menu, setMenuState] = useState<Menu | null>(null);
  const menuRef = useRef(menu);
  const live = useRef({ onChange, onBlur, onMenu, scope });
  live.current = { onChange, onBlur, onMenu, scope };
  const setMenu = (m: Menu | null) => {
    if (!!m !== !!menuRef.current) live.current.onMenu?.(!!m);
    menuRef.current = m;
    setMenuState(m);
  };
  const sent = useRef<string[]>([]);

  const position = (view: EditorView, at: number) => {
    const c = view.coordsAtPos(at);
    const box = area.current?.getBoundingClientRect();
    if (!c || !box) return null;
    return { top: c.bottom - box.top + 2, left: Math.max(0, Math.min(c.left - box.left, box.width - 260)) };
  };

  /** Suggestions for the caret: shown once something is typed, after a `.`, inside quotes, or when asked (Ctrl+Space). */
  const suggest = (view: EditorView, asked: boolean) => {
    const sel = view.state.selection.main;
    if (!sel.empty) { setMenu(null); return; }
    const text = view.state.sliceDoc();
    const items = completions(text, sel.head, live.current.scope).slice(0, MAX_ITEMS);
    const first = items[0];
    const typed = !!first && (first.to > first.from || text[first.from - 1] === '.' || first.kind === 'option');
    // A suggestion that is exactly what is typed already adds nothing.
    const useful = items.filter((c) => !(c.to - c.from === c.label.length && text.slice(c.from, c.to) === c.label && items.length === 1));
    if (!useful.length || (!typed && !asked)) { setMenu(null); return; }
    const old = menuRef.current;
    const keep = old ? useful.findIndex((c) => c.label === old.items[old.active]?.label) : -1;
    setMenu({ items: useful, active: Math.max(0, keep), pos: position(view, useful[0].from) });
  };

  const accept = (view: EditorView, c: Completion) => {
    // Functions and rules open their brackets; a role goes on to its fields.
    const after = c.kind === 'function' || c.kind === 'rule' ? '(' : c.kind === 'role' ? '.' : c.kind === 'option' ? "'" : '';
    const next = view.state.sliceDoc(c.to, c.to + 1);
    const insert = c.label + (after && next !== after ? after : '');
    view.dispatch({ changes: { from: c.from, to: c.to, insert }, selection: EditorSelection.cursor(c.from + insert.length + (after && next === after ? 1 : 0)), userEvent: 'input.complete' });
    if (c.kind === 'role') suggest(view, true);
    else setMenu(null);
  };

  const menuKey = (view: EditorView, k: 'down' | 'up' | 'pick' | 'close') => {
    const m = menuRef.current;
    if (!m || !m.items.length) return false;
    if (k === 'close') { setMenu(null); return true; }
    if (k === 'pick') { accept(view, m.items[m.active] ?? m.items[0]); return true; }
    const step = k === 'down' ? 1 : m.items.length - 1;
    setMenu({ ...m, active: (m.active + step) % m.items.length });
    return true;
  };

  const contentAttrs = (m: Menu | null) => EditorView.contentAttributes.of({
    'aria-label': label,
    // One line with a suggestion list: a combobox, not a multi-line text box.
    role: 'combobox',
    'aria-multiline': 'false',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': m ? 'true' : 'false',
    ...(m ? { 'aria-controls': listId, 'aria-activedescendant': `${listId}-${m.active}` } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(problems.length ? { 'aria-invalid': 'true' } : {}),
    'data-testid': 'formula-input',
  });

  useLayoutEffect(() => {
    const keys = Prec.highest(keymap.of([
      { key: 'ArrowDown', run: (v) => menuKey(v, 'down') },
      { key: 'ArrowUp', run: (v) => menuKey(v, 'up') },
      // Enter takes a suggestion; with none open it saves, as leaving the box does (a formula is one line).
      { key: 'Enter', run: (v) => { if (!menuKey(v, 'pick')) live.current.onBlur?.(); return true; } },
      { key: 'Tab', run: (v) => menuKey(v, 'pick') },
      { key: 'Escape', run: (v) => menuKey(v, 'close') },
      { key: 'Ctrl-Space', run: (v) => { suggest(v, true); return true; } },
    ]));
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          keys, history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, problemField,
          attrs.of(contentAttrs(null)),
          placeholder ? placeholderText(placeholder) : [],
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged) {
              const text = u.state.sliceDoc();
              sent.current = noteSent(sent.current, text);
              live.current.onChange(text);
            }
            if (u.view.hasFocus && (u.docChanged || u.selectionSet)) suggest(u.view, false);
            if (u.focusChanged && !u.view.hasFocus) { setMenu(null); live.current.onBlur?.(); }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { viewRef.current = null; view.destroy(); };
  }, []);

  // A text from the parent that is not an echo of what was typed (an undo, a reset) replaces the box's text.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const r = syncFromParent(value, view.state.sliceDoc(), sent.current);
    sent.current = r.sent;
    if (r.replace) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  const problemKey = JSON.stringify(problems);
  useEffect(() => { viewRef.current?.dispatch({ effects: setProblems.of(problems) }); }, [problemKey, value]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: attrs.reconfigure(contentAttrs(menu)) });
  }, [label, describedBy, problems.length > 0, menu?.active, !!menu]);

  return (
    <div className="formula-area" ref={area}>
      <div className="formula-editor" ref={host} />
      {menu && (
        <ul className="formula-menu" role="listbox" id={listId} aria-label={`Suggestions for ${label}`}
          style={menu.pos ? { top: menu.pos.top, left: menu.pos.left } : undefined}>
          {menu.items.map((c, i) => (
            <li key={`${c.kind}:${c.label}`} id={`${listId}-${i}`} role="option" aria-selected={i === menu.active} className="formula-option"
              onMouseDown={(e) => { e.preventDefault(); const v = viewRef.current; if (v) accept(v, c); }}>
              <span className="formula-option-label">{completionText(c)}</span>
              <span className="formula-option-kind">{KIND_WORD[c.kind]}{c.detail ? ` · ${c.detail}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

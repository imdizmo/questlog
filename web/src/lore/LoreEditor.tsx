import { flushSync } from 'react-dom';
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { Compartment, EditorSelection, EditorState, Prec, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderText, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { tokenBoundary } from '../../../shared/content';
import { showToast } from '../toast';
import { COMMANDS, filterCommands, SlashMenu, type Command, type RefKind } from '../components/SlashMenu';
import { RefPicker } from '../components/RefPicker';
import type { EditorProps } from '../components/Editor';
import { loreDecorationsExtension, loreMarkdown, loreNamesField, setLoreNames, type LoreNames } from './decorations';
import { ignoreName } from '../linkIgnores';
import { useStore } from '../store';
import { campaignNameIndex, entryPath } from '../wiki';
import { usePanelOpener } from '../components/wiki/panelContext';
import { titleOf } from '../../../shared/cards';
import { noteSent, syncFromParent } from './parentSync';
import {
  backspaceHeading, insertLink, onCaretLine, setHeading, toggleBold, toggleChecklist, toggleItalic, toggleList, toggleQuote,
} from './commands';

/** `cardId`: the card whose text this is; its own names are not marked, and "Not a link here" applies to it. */
export type LoreEditorProps = Omit<EditorProps, 'textareaRef'> & { editorRef?: Ref<{ focus(): void }> };

/** Opens a wiki entry in a new tab, so the text being edited stays as it is. */
const openInTab = (href: string) => { window.open(href, '_blank', 'noopener'); };

/** Where the `/` that opened the menu sits, the text typed after it, the highlighted command and where to show it. */
interface Slash { at: number; query: string; active: number; pos: { top: number; left: number } | null }

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * CodeMirror's default keys minus the ones that edit beyond what was typed or take Esc: Esc (the
 * surrounding dialog gets it, as with the textarea), comment toggles and moving, copying or
 * deleting whole lines.
 */
const DROPPED = new Set(['Escape', 'Mod-/', 'Alt-A', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Shift-Alt-ArrowUp', 'Shift-Alt-ArrowDown', 'Shift-Mod-k']);
const LORE_KEYMAP = [...defaultKeymap.filter((b) => !DROPPED.has(b.key ?? '')), ...historyKeymap];

const TOOLBAR: { label: string; title: string; cmd: (s: EditorState) => TransactionSpec }[] = [
  { label: 'Heading', title: 'Heading (Ctrl+Alt+1, 2 or 3 for a level)', cmd: setHeading(2) },
  { label: 'Bold', title: 'Bold (Ctrl+B)', cmd: toggleBold },
  { label: 'Italic', title: 'Italic (Ctrl+I)', cmd: toggleItalic },
  { label: 'List', title: 'Bulleted list', cmd: toggleList },
  { label: 'Checklist', title: 'Checklist', cmd: toggleChecklist },
  { label: 'Quote', title: 'Quote', cmd: toggleQuote },
  { label: 'Link', title: 'Link', cmd: insertLink },
];

/**
 * The lore editor: a CodeMirror view over the Markdown text that hides marks away from the caret,
 * with a toolbar, the `/` menu and reference pickers of the task editor, and focus mode.
 * The text is the Markdown string exactly as stored; only the person's own edits change it.
 * Ctrl+Enter saves; Esc closes the innermost thing that is open (menu, focus mode, then the editor).
 */
export function LoreEditor({
  value, onChange, onSave, onCancel, label = 'Text', rows = 12, placeholder, autoFocus,
  projectId = null, images = [], onSetProperties, editorRef, cardId = null,
}: LoreEditorProps) {
  const inlineHost = useRef<HTMLDivElement>(null);
  const focusHost = useRef<HTMLDivElement>(null);
  const inlineArea = useRef<HTMLDivElement>(null);
  const focusArea = useRef<HTMLDivElement>(null);
  const focusDialog = useRef<HTMLDialogElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const attrs = useRef(new Compartment()).current;
  const menuId = useId();
  const [slash, setSlashState] = useState<Slash | null>(null);
  const [picker, setPicker] = useState<{ kind: RefKind; at: number; end: number } | null>(null);
  const [focus, setFocusState] = useState(false);

  const commands = onSetProperties ? COMMANDS : COMMANDS.filter((c) => c.action.kind !== 'properties');
  const items = slash ? filterCommands(slash.query, commands) : [];

  // CodeMirror's handlers are set up once; they read the latest props and state through these refs.
  const slashRef = useRef(slash);
  const setSlash = (s: Slash | null) => { slashRef.current = s; setSlashState(s); };
  const focusRef = useRef(focus);
  const setFocus = (f: boolean) => { focusRef.current = f; setFocusState(f); };
  const live = useRef({ value, onChange, onSave, onCancel, commands, items, run: (_c: Command) => {} });
  live.current = { value, onChange, onSave, onCancel, commands, items, run: (c: Command) => run(c) };
  /** Texts reported through onChange that the parent hasn't shown back yet, oldest first. */
  const sent = useRef<string[]>([]);
  const send = (text: string) => { sent.current = noteSent(sent.current, text); live.current.onChange(text); };

  useImperativeHandle(editorRef, () => ({ focus: () => viewRef.current?.focus() }), []);

  // Recognised names: the campaign's index (rebuilt only when a name or alias changes) and this card's ignores. A new
  // entry, alias or ignore anywhere (this client or another) reaches the store and re-marks the text without a keystroke.
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const project = projectId ? projects.get(projectId) : undefined;
  const index = project ? campaignNameIndex({ cards, decks }, project.id) : null;
  const ignores = (cardId ? cards.get(cardId)?.linkIgnores : null) ?? [];
  const ignoresKey = ignores.join('\u0000');
  // In the wiki's entry stack a name opens as a panel beside this column (the editor stays mounted, so the draft stays);
  // elsewhere, and from focus mode (a dialog over the page), in a new tab.
  const beside = usePanelOpener();
  const lookups = useRef({ cards, seq: project?.seq ?? 0, beside });
  lookups.current = { cards, seq: project?.seq ?? 0, beside };
  const names = useMemo<LoreNames | null>(() => (index && index.size > 0 ? {
    index,
    selfId: cardId,
    ignores,
    title: (id) => { const c = lookups.current.cards.get(id); return c ? titleOf(c.content) : null; },
    open: (id) => {
      const { cards: all, seq, beside: panel } = lookups.current;
      const c = all.get(id);
      if (!c) return;
      if (panel && !focusRef.current && panel.openHref(entryPath(seq, c))) return;
      openInTab(entryPath(seq, c));
    },
    ignore: cardId ? (name) => ignoreName(cardId, name) : null,
  } : null), [index, cardId, ignoresKey]);
  const namesRef = useRef(names);
  namesRef.current = names;
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.field(loreNamesField, false) !== names) view.dispatch({ effects: setLoreNames.of(names) });
  }, [names]);

  /** Where the menu goes for the `/` at `at`, relative to the area holding the editor. */
  const menuPos = (view: EditorView, at: number) => {
    const area = (focusRef.current ? focusArea : inlineArea).current;
    const c = view.coordsAtPos(at);
    if (!area || !c) return null;
    const box = area.getBoundingClientRect();
    return { top: c.bottom - box.top + 4, left: Math.max(0, Math.min(c.left - box.left, box.width - 240)) };
  };

  /** Opens, updates or closes the menu after the text or caret changed (as the task editor does). */
  const track = (u: ViewUpdate) => {
    const st = u.state;
    const sel = st.selection.main;
    const cur = slashRef.current;
    if (!sel.empty || st.selection.ranges.length > 1) { if (cur) setSlash(null); return; }
    const caret = sel.head;
    if (!cur) {
      if (!u.docChanged) return;
      let typed = false;
      for (const tr of u.transactions) {
        if (!tr.isUserEvent('input.type')) continue;
        tr.changes.iterChanges((fa, ta, _fb, tb, ins) => { if (fa === ta && tb === caret && ins.toString() === '/') typed = true; });
      }
      if (!typed) return;
      const line = st.doc.lineAt(caret);
      const prev = caret - 1 === 0 ? undefined : caret - 1 === line.from ? '\n' : st.sliceDoc(caret - 2, caret - 1);
      if (!tokenBoundary(prev)) return;
      const at = caret - 1;
      setSlash({ at, query: '', active: 0, pos: null });
      u.view.requestMeasure({
        read: (v) => menuPos(v, at),
        write: (pos) => { const s = slashRef.current; if (s && s.at === at) setSlash({ ...s, pos }); },
      });
      return;
    }
    const at = u.docChanged ? u.changes.mapPos(cur.at, 1) : cur.at;
    const q = st.sliceDoc(at + 1, Math.max(at + 1, caret));
    if (caret <= at || st.sliceDoc(at, at + 1) !== '/' || /^\s|\n|\s\s/.test(q) || !filterCommands(q, live.current.commands).length) setSlash(null);
    else if (q !== cur.query || at !== cur.at) setSlash({ ...cur, at, query: q, active: 0 });
  };

  const apply = (cmd: (s: EditorState) => TransactionSpec | null) => {
    const view = viewRef.current;
    if (!view) return false;
    const spec = cmd(view.state);
    if (spec) view.dispatch(spec);
    return true;
  };

  const leaveFocus = () => { setSlash(null); setFocus(false); };
  const enterFocus = () => { setSlash(null); setFocus(true); };

  /** Builds the editor state for `text`, with the caret at the end. */
  const makeState = (text: string) => {
    const keys = Prec.highest(keymap.of([
      { key: 'ArrowDown', run: () => menuKey('down') },
      { key: 'ArrowUp', run: () => menuKey('up') },
      { key: 'Enter', run: () => menuKey('pick') },
      { key: 'Tab', run: () => menuKey('pick') },
      {
        key: 'Mod-Enter',
        run: (v) => {
          setSlash(null);
          // The parent must hold the latest text before it saves.
          const text = v.state.sliceDoc();
          if (text !== live.current.value) flushSync(() => send(text));
          live.current.onSave();
          return true;
        },
      },
      {
        key: 'Escape',
        run: () => {
          if (slashRef.current && live.current.items.length) { setSlash(null); return true; }
          if (focusRef.current) { leaveFocus(); return true; }
          if (live.current.onCancel) { live.current.onCancel(); return true; }
          return false; // left to the surrounding dialog
        },
      },
    ]));
    const format = Prec.high(keymap.of([
      { key: 'Mod-b', run: () => apply(toggleBold) },
      { key: 'Mod-i', run: () => apply(toggleItalic) },
      { key: 'Mod-Alt-1', run: () => apply(setHeading(1)) },
      { key: 'Mod-Alt-2', run: () => apply(setHeading(2)) },
      { key: 'Mod-Alt-3', run: () => apply(setHeading(3)) },
      { key: 'Backspace', run: (v) => { const spec = backspaceHeading(v.state); if (!spec) return false; v.dispatch(spec); return true; } },
      // List and quote continuation, kept to the caret's line; otherwise a plain newline.
      { key: 'Enter', run: (v) => { const tr = onCaretLine(v.state, insertNewlineContinueMarkup); if (!tr) return insertNewline(v); v.dispatch(tr); return true; } },
      { key: 'Backspace', run: (v) => { const tr = onCaretLine(v.state, deleteMarkupBackward); if (!tr) return false; v.dispatch(tr); return true; } },
    ]));
    const s = EditorState.create({
      doc: text,
      extensions: [
        keys,
        format,
        loreMarkdown(text),
        loreNamesField.init(() => namesRef.current),
        loreDecorationsExtension(),
        history(),
        keymap.of(LORE_KEYMAP),
        EditorView.lineWrapping,
        attrs.of(contentAttrs(null)),
        placeholder ? placeholderText(placeholder) : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged) send(u.state.sliceDoc());
          if (u.docChanged || u.selectionSet) track(u);
          if (u.focusChanged && !u.view.hasFocus && slashRef.current) setSlash(null);
        }),
      ],
    });
    return s.update({ selection: EditorSelection.cursor(s.doc.length) }).state;
  };

  function menuKey(k: 'down' | 'up' | 'pick') {
    const s = slashRef.current;
    const list = live.current.items;
    if (!s || !list.length) return false;
    if (k === 'pick') { live.current.run(list[s.active] ?? list[0]); return true; }
    const step = k === 'down' ? 1 : list.length - 1;
    setSlash({ ...s, active: (s.active + step) % list.length });
    return true;
  }

  function contentAttrs(s: Slash | null) {
    const active = s && live.current.items[s.active];
    return EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-haspopup': 'listbox',
      ...(autoFocus ? { 'data-autofocus': 'true' } : {}),
      ...(s ? { 'aria-controls': menuId, 'aria-expanded': 'true' } : {}),
      ...(active ? { 'aria-activedescendant': `${menuId}-${active.id}` } : {}),
    });
  }

  // The view lives as long as the component; focus mode moves its DOM into the dialog and back.
  useLayoutEffect(() => {
    const view = new EditorView({ state: makeState(value), parent: inlineHost.current! });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => { viewRef.current = null; view.destroy(); };
  }, []);

  // The parent's text. An echo of what we reported, even one overtaken by later typing, is left
  // alone. A new text (a template after "Create another", a restored draft) starts a fresh state:
  // caret at the end and no undo history, so Ctrl+Z can't bring back the text it replaced.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const r = syncFromParent(value, view.state.sliceDoc(), sent.current);
    sent.current = r.sent;
    if (!r.replace) return;
    setSlash(null);
    setPicker(null);
    view.setState(makeState(value));
  }, [value]);

  // The content element's accessible name and its link to the open menu.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: attrs.reconfigure(contentAttrs(slash)) });
  }, [label, slash?.active, !!slash, items.length]);

  // Focus mode is a modal <dialog>; its own Esc (cancel) leaves focus mode.
  useLayoutEffect(() => {
    const d = focusDialog.current;
    const view = viewRef.current;
    if (!focus || !d || !view) return;
    if (!d.open) d.showModal();
    focusHost.current!.appendChild(view.dom);
    view.focus();
    view.requestMeasure();
    const onDialogCancel = (e: Event) => { e.preventDefault(); leaveFocus(); };
    d.addEventListener('cancel', onDialogCancel);
    return () => {
      d.removeEventListener('cancel', onDialogCancel);
      inlineHost.current?.appendChild(view.dom);
      if (d.open) d.close();
      if (viewRef.current === view) { view.focus(); view.requestMeasure(); }
    };
  }, [focus]);

  /** Replaces [from, to) and leaves the selection at [selA, selB] relative to the inserted text. */
  const replace = (from: number, to: number, text: string, sel: [number, number] = [text.length, text.length]) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.range(from + sel[0], from + sel[1]), userEvent: 'input', scrollIntoView: true });
    view.focus();
  };

  function run(c: Command) {
    const s = slashRef.current;
    const view = viewRef.current;
    if (!s || !view) return;
    const at = s.at;
    const end = at + 1 + s.query.length;
    setSlash(null);
    const a = c.action;
    if (a.kind === 'block') {
      // Block Markdown must start its own line.
      const line = view.state.doc.lineAt(at);
      const pre = view.state.sliceDoc(line.from, at).trim() ? '\n' : '';
      const caret = pre.length + (a.caret ?? a.text.length);
      replace(at, end, pre + a.text, [caret, caret]);
    } else if (a.kind === 'inline') {
      replace(at, end, a.text, a.select);
    } else if (a.kind === 'pick') {
      if (a.ref === 'image' && images.every((f) => !IMAGE.test(f.mime))) {
        replace(at, end, '');
        showToast(images.length || onSetProperties ? 'No images attached to this task yet.' : 'Attach images after the task is created.', 'info', 4000);
        return;
      }
      setPicker({ kind: a.ref, at, end });
    } else if (a.kind === 'properties') {
      replace(at, end, '');
      onSetProperties?.();
    } else {
      replace(at, end, '');
      enterFocus();
    }
  }

  const pick = (markdown: string) => {
    if (!picker) return;
    const { at, end } = picker;
    setPicker(null);
    replace(at, end, markdown);
  };
  const closePicker = () => {
    if (!picker) return;
    const { at } = picker;
    setPicker(null);
    // Back to just after the `/`, which stays in the text.
    const view = viewRef.current;
    if (view) { view.dispatch({ selection: EditorSelection.cursor(at + 1) }); view.focus(); }
  };

  const toolbar = (
    <div className="lore-toolbar" role="toolbar" aria-label="Formatting">
      {TOOLBAR.map((t) => (
        <button key={t.label} type="button" className="btn btn-ghost btn-sm" title={t.title}
          onMouseDown={(e) => e.preventDefault() /* keep the selection in the editor */}
          onClick={() => { apply(t.cmd); viewRef.current?.focus(); }}>{t.label}</button>
      ))}
    </div>
  );

  const menu = (inFocus: boolean) =>
    slash && slash.pos && items.length > 0 && focus === inFocus ? (
      <SlashMenu id={menuId} items={items} active={Math.min(slash.active, items.length - 1)} pos={slash.pos}
        onHover={(i) => setSlash({ ...slash, active: i })} onPick={(c) => run(c)} />
    ) : null;

  return (
    <div className="md-editor lore-editor" style={{ '--lore-rows': rows } as CSSProperties}>
      <div className="md-editor-bar">
        <span className="hint">Markdown · type / for commands</span>
        {!focus && toolbar}
        <button type="button" className="btn btn-ghost btn-sm" onClick={enterFocus}>Focus mode</button>
      </div>
      {focus && <p className="muted md-away">Editing in focus mode. Esc returns here.</p>}
      <div ref={inlineArea} className="md-area" hidden={focus}>
        <div className="field">
          {/* The content element carries the name (aria-label); this is the visible copy. */}
          <span aria-hidden="true" onClick={() => viewRef.current?.focus()}>{label}</span>
          <div ref={inlineHost} className="lore-host" />
        </div>
        {menu(false)}
      </div>
      {focus && (
        <dialog ref={focusDialog} className="focus-editor" aria-label="Focus mode">
          <div className="focus-inner">
            <div className="md-editor-bar">
              <span className="hint">Focus mode · Esc returns · Ctrl+Enter saves</span>
              {toolbar}
              <button type="button" className="btn btn-ghost btn-sm" onClick={leaveFocus}>Leave focus mode</button>
            </div>
            <div ref={focusArea} className="md-area lore-focus">
              <div ref={focusHost} className="lore-host" />
              {menu(true)}
            </div>
          </div>
        </dialog>
      )}
      {picker && (
        <RefPicker kind={picker.kind} projectId={projectId} images={images.filter((f) => IMAGE.test(f.mime))}
          onPick={pick} onClose={closePicker} />
      )}
    </div>
  );
}

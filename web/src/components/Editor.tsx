import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { tokenBoundary } from '../../../shared/content';
import type { CardFile } from '../store';
import { showToast } from '../toast';
import { COMMANDS, filterCommands, SlashMenu, type Command, type RefKind } from './SlashMenu';
import { RefPicker } from './RefPicker';
import { MarkdownView } from './MarkdownView';

/** Where the `/` that opened the menu sits, and which command is highlighted. */
interface Slash { at: number; query: string; active: number; pos: { top: number; left: number } }

const MIRRORED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontSize', 'lineHeight', 'fontFamily', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent',
] as const;

/** Pixel position of a character in a textarea (relative to the textarea's box), via a hidden mirror. */
function caretPoint(ta: HTMLTextAreaElement, index: number): { top: number; left: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of MIRRORED) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  div.textContent = ta.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(index) || '.';
  div.appendChild(mark);
  document.body.appendChild(div);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const point = { top: mark.offsetTop - ta.scrollTop + line + 4, left: mark.offsetLeft - ta.scrollLeft };
  div.remove();
  return point;
}

export interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl+Enter. */
  onSave: () => void;
  /** Esc (outside menus and focus mode). Without it, Esc is left to the surrounding dialog. */
  onCancel?: () => void;
  label?: string;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** Tags offered by "Add tag" come from this project. */
  projectId?: string | null;
  /** Images attached to the card, for "Embed attached image". */
  images?: CardFile[];
  /** "Set properties": shows the card's properties. Hidden from the menu when absent. */
  onSetProperties?: () => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

/**
 * Markdown textarea with a `/` command menu, reference pickers, Preview and Focus mode.
 * Ctrl+Enter saves; Esc closes the innermost thing that is open (menu, focus mode, then the editor).
 */
export function Editor({
  value, onChange, onSave, onCancel, label = 'Task text', rows = 12, placeholder, autoFocus,
  projectId = null, images = [], onSetProperties, textareaRef,
}: EditorProps) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const focusDialog = useRef<HTMLDialogElement>(null);
  const menuId = useId();
  const [slash, setSlash] = useState<Slash | null>(null);
  const [picker, setPicker] = useState<{ kind: RefKind; at: number; end: number } | null>(null);
  const [preview, setPreview] = useState(false);
  const [focus, setFocus] = useState(false);
  /** Selection to restore after the next render (insertions, switching views). */
  const nextSel = useRef<[number, number] | null>(null);
  const lastSel = useRef<[number, number]>([value.length, value.length]);

  const commands = onSetProperties ? COMMANDS : COMMANDS.filter((c) => c.action.kind !== 'properties');
  const items = slash ? filterCommands(slash.query, commands) : [];

  const setArea = (el: HTMLTextAreaElement | null) => {
    area.current = el;
    if (typeof textareaRef === 'function') textareaRef(el);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  // Focus mode is a modal <dialog>; its own Esc (cancel) leaves focus mode. A layout effect, and
  // before the caret one below, so the textarea is focusable by the time the caret is restored.
  useLayoutEffect(() => {
    const d = focusDialog.current;
    if (!focus || !d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => { e.preventDefault(); leaveFocus(); };
    d.addEventListener('cancel', onCancel);
    return () => { d.removeEventListener('cancel', onCancel); if (d.open) d.close(); };
  }, [focus]);

  // Put the caret back where it belongs whenever the textarea is (re)mounted or text was inserted.
  useLayoutEffect(() => {
    const ta = area.current;
    if (!ta || !nextSel.current) return;
    const [a, b] = nextSel.current;
    nextSel.current = null;
    ta.focus();
    ta.setSelectionRange(a, b);
  });

  const remember = () => { const ta = area.current; if (ta) lastSel.current = [ta.selectionStart, ta.selectionEnd]; };
  const restoreAfterSwitch = () => { nextSel.current = lastSel.current; };
  const enterFocus = () => { remember(); restoreAfterSwitch(); setSlash(null); setPreview(false); setFocus(true); };
  function leaveFocus() { remember(); restoreAfterSwitch(); setSlash(null); setFocus(false); }
  const togglePreview = () => {
    if (!preview) remember(); else restoreAfterSwitch();
    setSlash(null);
    setPreview((p) => !p);
  };

  /** Replaces text[from, to) and leaves the selection at [selA, selB] relative to the inserted text. */
  const replace = (from: number, to: number, text: string, sel: [number, number] = [text.length, text.length]) => {
    onChange(value.slice(0, from) + text + value.slice(to));
    nextSel.current = [from + sel[0], from + sel[1]];
  };

  const run = (c: Command) => {
    if (!slash) return;
    const at = slash.at;
    const end = at + 1 + slash.query.length;
    setSlash(null);
    const a = c.action;
    if (a.kind === 'block') {
      // Block Markdown must start its own line.
      const lineStart = value.lastIndexOf('\n', at - 1) + 1;
      const pre = value.slice(lineStart, at).trim() ? '\n' : '';
      const caret = pre.length + (a.caret ?? a.text.length);
      replace(at, end, pre + a.text, [caret, caret]);
    } else if (a.kind === 'inline') {
      replace(at, end, a.text, a.select);
    } else if (a.kind === 'pick') {
      if (a.ref === 'image' && images.every((f) => !/^image\/(png|jpeg|gif|webp)$/.test(f.mime))) {
        replace(at, end, '');
        showToast(images.length || onSetProperties ? 'No images attached to this task yet.' : 'Attach images after the task is created.', 'info', 4000);
        return;
      }
      remember();
      setPicker({ kind: a.ref, at, end });
    } else if (a.kind === 'properties') {
      replace(at, end, '');
      onSetProperties?.();
    } else {
      onChange(value.slice(0, at) + value.slice(end));
      lastSel.current = [at, at];
      nextSel.current = [at, at];
      setPreview(false);
      setFocus(true);
    }
  };

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
    nextSel.current = [at + 1, at + 1]; // back to just after the `/`, which stays in the text
  };

  /** Opens, updates or closes the menu after the text or caret changed. */
  const track = (text: string, prevLength: number) => {
    const ta = area.current;
    if (!ta || ta.selectionStart !== ta.selectionEnd) { setSlash(null); return; }
    const caret = ta.selectionStart;
    if (!slash) {
      if (text.length === prevLength + 1 && text[caret - 1] === '/' && tokenBoundary(caret >= 2 ? text[caret - 2] : undefined)) {
        const p = caretPoint(ta, caret - 1);
        setSlash({ at: caret - 1, query: '', active: 0, pos: { top: ta.offsetTop + p.top, left: ta.offsetLeft + Math.max(0, Math.min(p.left, ta.clientWidth - 240)) } });
      }
      return;
    }
    const q = text.slice(slash.at + 1, caret);
    if (caret <= slash.at || text[slash.at] !== '/' || /^\s|\n|\s\s/.test(q) || !filterCommands(q, commands).length) setSlash(null);
    else if (q !== slash.query) setSlash({ ...slash, query: q, active: 0 });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
        setSlash({ ...slash, active: (slash.active + step) % items.length });
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') { e.preventDefault(); run(items[slash.active] ?? items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSlash(null); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSlash(null); onSave(); }
    else if (e.key === 'Escape') {
      if (focus) { e.preventDefault(); e.stopPropagation(); leaveFocus(); }
      else if (onCancel) { e.preventDefault(); onCancel(); }
    }
  };

  const textarea = (inFocus: boolean) => (
    <div className="md-area">
      <label className="field">
        <span className={inFocus ? 'sr-only' : undefined}>{label}</span>
        <textarea
          ref={setArea} autoFocus={autoFocus || inFocus} data-autofocus={autoFocus || inFocus ? true : undefined} rows={inFocus ? undefined : rows} placeholder={placeholder}
          className={inFocus ? 'card-textarea focus-textarea' : 'card-textarea'} value={value}
          aria-controls={slash ? menuId : undefined} aria-expanded={slash ? true : undefined} aria-haspopup="listbox"
          aria-activedescendant={slash && items[slash.active] ? `${menuId}-${items[slash.active].id}` : undefined}
          onChange={(e) => { const prev = value.length; onChange(e.target.value); track(e.target.value, prev); }}
          onSelect={(e) => { const t = e.currentTarget.value; if (slash) track(t, t.length); }}
          onBlur={() => setSlash(null)}
          onKeyDown={onKey}
        />
      </label>
      {slash && items.length > 0 && (
        <SlashMenu id={menuId} items={items} active={Math.min(slash.active, items.length - 1)} pos={slash.pos}
          onHover={(i) => setSlash({ ...slash, active: i })} onPick={run} />
      )}
    </div>
  );

  return (
    <div className="md-editor">
      <div className="md-editor-bar">
        <span className="hint">Markdown · type / for commands</span>
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={preview} onClick={togglePreview}>Preview</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={enterFocus}>Focus mode</button>
      </div>
      {preview ? (
        <div className="md-preview">
          {value.trim() ? <MarkdownView content={value} testId="md-preview" /> : <p className="muted" data-testid="md-preview">Nothing to preview yet.</p>}
        </div>
      ) : focus ? (
        <p className="muted md-away">Editing in focus mode. Esc returns here.</p>
      ) : (
        textarea(false)
      )}
      {focus && (
        <dialog ref={focusDialog} className="focus-editor" aria-label="Focus mode">
          <div className="focus-inner">
            <div className="md-editor-bar">
              <span className="hint">Focus mode · Esc returns · Ctrl+Enter saves</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={leaveFocus}>Leave focus mode</button>
            </div>
            {textarea(true)}
          </div>
        </dialog>
      )}
      {picker && (
        <RefPicker kind={picker.kind} projectId={projectId} images={images.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.mime))}
          onPick={pick} onClose={closePicker} />
      )}
    </div>
  );
}

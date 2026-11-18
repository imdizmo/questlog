import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Editor } from '../components/Editor';
import type { LoreEditorProps } from './LoreEditor';
import { LoreLoadError, retryable } from './retryable';

// CodeMirror and its Markdown support load with the first lore edit, not with the app.
const load = retryable(() => import('./LoreEditor').then((m) => ({ default: m.LoreEditor })));
const makeLazy = () => lazy(load);
/** React.lazy keeps a rejection for good, so a failed load gets a fresh lazy component for the next mount. */
let LoreEditor = makeLazy();

/** The note above the plain editor when the lore editor fails. */
export function fallbackNote(error: unknown): string {
  return error instanceof LoreLoadError
    ? "The lore editor couldn't load; you're using the plain editor."
    : "The lore editor hit a problem; you're using the plain editor.";
}

/**
 * Shows the plain textarea editor (over the same text) when the lore editor fails: its code
 * couldn't load, or it hit a bug (logged). The draft is never lost to an error boundary higher up.
 */
class Fallback extends Component<{ props: LoreEditorProps; children: ReactNode }, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  componentDidCatch(error: unknown) {
    if (error instanceof LoreLoadError) LoreEditor = makeLazy();
    else console.error('Lore editor failed:', error);
  }
  render() {
    const { failed, error } = this.state;
    if (!failed) return this.props.children;
    const { editorRef, label = 'Text', ...rest } = this.props.props;
    const setRef = (el: HTMLTextAreaElement | null) => {
      if (typeof editorRef === 'function') editorRef(el);
      else if (editorRef) (editorRef as { current: { focus(): void } | null }).current = el;
    };
    return (
      <div className="lore-fallback">
        <p className="hint" role="status">{fallbackNote(error)}</p>
        <Editor {...rest} label={label} textareaRef={setRef} />
      </div>
    );
  }
}

/** The lore editor, loaded on first use; a short line shows meanwhile, the textarea editor if it fails. */
export function LazyLoreEditor(props: LoreEditorProps) {
  const Lazy = LoreEditor;
  return (
    <Fallback props={props}>
      <Suspense fallback={<p className="muted lore-loading" role="status">Loading editor…</p>}>
        <Lazy {...props} />
      </Suspense>
    </Fallback>
  );
}

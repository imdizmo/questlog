import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { FormulaProblem } from '../../../../shared/formula';
import { retryable } from '../../lore/retryable';
import type { FormulaEditorProps } from './FormulaEditor';

// CodeMirror loads with the first formula on screen, not with the app (as the lore editor does).
export const loadFormulaEditor = retryable(() => import('./FormulaEditor').then((m) => ({ default: m.FormulaEditor })));
const makeLazy = () => lazy(loadFormulaEditor);
/** React.lazy keeps a rejection for good, so a failed load gets a fresh lazy component for the next mount. */
let Lazy = makeLazy();

/** A plain text box over the same formula: while the editor loads, and if it can't (no suggestions then). */
function PlainFormula({ label, value, onChange, onBlur, problems, placeholder, describedBy }: FormulaEditorProps) {
  return (
    <textarea className="formula-plain" aria-label={label} rows={1} value={value} placeholder={placeholder} aria-describedby={describedBy}
      aria-invalid={problems.length ? true : undefined} spellCheck={false}
      onChange={(e) => onChange(e.target.value.replace(/\r?\n/g, ' '))} onBlur={onBlur} />
  );
}

class Fallback extends Component<{ props: FormulaEditorProps; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    Lazy = makeLazy();
    console.error('Formula editor failed:', error);
  }
  render() {
    return this.state.failed ? <PlainFormula {...this.props.props} /> : this.props.children;
  }
}

/** Plain words for a problem: the message, and where it is when the text is long enough for that to help. */
export function problemText(p: FormulaProblem, text: string): string {
  return text.length > 24 && p.to > p.from ? `${p.message} (at “${text.slice(p.from, Math.min(p.to, p.from + 24))}”)` : p.message;
}

/** How long typing must pause before the problems are spelled out again. */
const PAUSE_MS = 700;

/**
 * A formula box with suggestions, the problems underlined, and each problem in plain words under it. `problems`
 * come from the parent, which knows what the formula may name and what it must give. While the suggestion list is
 * open, and while typing goes on (until a short pause or leaving the box), the words are held back (the underline
 * stays), so a half-typed name doesn't shout and the list never covers them. The words' live region is always there.
 */
export function FormulaInput(props: Omit<FormulaEditorProps, 'describedBy' | 'onMenu'> & { className?: string }) {
  const id = useId();
  const { problems, value, className, onChange, onBlur, ...rest } = props;
  const [held, setHeld] = useState(false);
  const menuOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const later = () => { stop(); timer.current = setTimeout(() => { timer.current = null; if (!menuOpen.current) setHeld(false); }, PAUSE_MS); };
  useEffect(() => stop, []);
  const editorProps: FormulaEditorProps = {
    ...rest, value, problems, describedBy: id,
    onChange: (t) => { setHeld(true); later(); onChange(t); },
    onBlur: () => { stop(); menuOpen.current = false; setHeld(false); onBlur?.(); },
    onMenu: (open) => { menuOpen.current = open; if (open) { stop(); setHeld(true); } else later(); },
  };
  const Editor = Lazy;
  const shown = held ? [] : problems;
  return (
    <div className={`formula-input${className ? ` ${className}` : ''}`}>
      <Fallback props={editorProps}>
        <Suspense fallback={<PlainFormula {...editorProps} />}>
          <Editor {...editorProps} />
        </Suspense>
      </Fallback>
      <ul className="formula-problems" id={id} aria-live="polite">
        {shown.map((p, i) => <li key={i}>{problemText(p, value)}</li>)}
      </ul>
    </div>
  );
}

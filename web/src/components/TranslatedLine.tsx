import { LANG_NAME, type Shown } from '../translate';

/**
 * The small line under translated text: "Translated from Italian · Show original", "Show translation" while the
 * original is shown on request, or "Translating…" while the server works on it. Nothing when the text is as written.
 */
export function TranslatedLine({ shown, showOriginal, canTranslate, onToggle }: {
  shown: Shown;
  /** The reader asked for the original of this item. */
  showOriginal: boolean;
  /** A translation for the reader's language exists (so "Show translation" has something to show). */
  canTranslate: boolean;
  onToggle: () => void;
}) {
  if (showOriginal && canTranslate) {
    return <p className="translated-line" data-testid="translated-line"><button type="button" className="link-btn" onClick={onToggle}>Show translation</button></p>;
  }
  if (shown.from) {
    return (
      <p className="translated-line" data-testid="translated-line">
        Translated from {LANG_NAME[shown.from]} · <button type="button" className="link-btn" onClick={onToggle}>Show original</button>
      </p>
    );
  }
  if (shown.pending) return <p className="translated-line" data-testid="translated-line" role="status">Translating…</p>;
  return null;
}

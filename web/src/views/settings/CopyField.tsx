import { useRef } from 'react';
import { showToast } from '../../toast';

/** A read-only value with a Copy button: the clipboard API when it exists (LAN http may lack it), else select + execCommand. */
export function CopyField({ label, value, autoFocus }: { label: string; value: string; autoFocus?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      input.current?.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* unavailable */ }
      if (!ok) { showToast('Copy failed: select the text and copy it by hand.'); return; }
    }
    showToast('Copied', 'info', 2000);
  };
  return (
    <div className="field-row copy-field">
      <label className="field">
        <span>{label}</span>
        <input ref={input} readOnly data-autofocus={autoFocus ? '' : undefined} value={value} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <button type="button" className="btn" onClick={copy}>Copy</button>
    </div>
  );
}

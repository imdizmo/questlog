import { useEffortOn } from '../store';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { AccountSettings } from '../../../shared/types';
import { effortScale } from '../../../shared/properties';

/**
 * One button per scale value plus a number box for anything else. Clicking the active value
 * clears it; the box commits on Enter or when it loses focus (empty clears).
 */
export function EffortField({ value, onChange, settings, disabled }: {
  value: number | null;
  onChange: (e: number | null) => void;
  settings: Pick<AccountSettings, 'effortScale'>;
  disabled?: boolean;
}) {
  const scale = effortScale(settings);
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => { setText(value === null ? '' : String(value)); }, [value]);
  const on = useEffortOn();

  const commit = () => {
    const t = text.trim();
    if (t === '') { if (value !== null) onChange(null); return; }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) { setText(value === null ? '' : String(value)); return; }
    if (n !== value) onChange(n);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Inside a form (the new card panel) Enter must not submit it.
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { setText(value === null ? '' : String(value)); }
  };

  if (!on) return null; // effort points are switched off for the workspace
  return (
    <div className="effort-field">
      <div className="seg" role="group" aria-label="Effort">
        {scale.map((n) => {
          const on = value === n;
          return (
            <button key={n} type="button" className={`seg-btn num${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled}
              onClick={() => onChange(on ? null : n)}>
              {n}
            </button>
          );
        })}
      </div>
      <input className="num-inline effort-input" type="number" min={0} step="any" inputMode="decimal" aria-label="Custom effort"
        placeholder="Other" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKey} />
    </div>
  );
}

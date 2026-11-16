import { useId } from 'react';
import { isPastDate } from '../../../shared/properties';
import { localToday } from '../cards';

/** Native date input that can't pick a past day, plus Clear. Only rendered when due dates are switched on. */
export function DueDateField({ value, onChange, disabled, locked, labelClass = 'sr-only' }: {
  value: string | null;
  onChange: (day: string | null) => void;
  disabled?: boolean;
  /** A date can't be set, only cleared (the plan lacks due dates). */
  locked?: boolean;
  /** Class of the "Due date" label; hidden by default for places that show their own heading. */
  labelClass?: string;
}) {
  const id = useId();
  const today = localToday();
  const past = value !== null && isPastDate(value, today);
  return (
    <>
      <label htmlFor={id} className={labelClass}>Due date</label>
      <div className="due-field">
        <input id={id} type="date" className="num-inline date-input" min={today} value={value ?? ''} disabled={disabled || locked}
          aria-describedby={past ? `${id}-past` : undefined}
          onChange={(e) => { if (e.target.value) onChange(e.target.value); }} />
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Clear due date" disabled={disabled || value === null}
          onClick={() => onChange(null)}>Clear</button>
        {past && <span id={`${id}-past`} className="hint due-past">This date has passed.</span>}
      </div>
    </>
  );
}

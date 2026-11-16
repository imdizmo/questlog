import type { AccountSettings, Priority } from '../../../shared/types';
import { PRIORITY_ORDER, priorityLabel } from '../../../shared/properties';

/** Low / Medium / High as toggle buttons (org labels). Clicking the active one clears the priority. */
export function PriorityButtons({ value, onChange, settings, disabled }: {
  value: Priority | null;
  onChange: (p: Priority | null) => void;
  settings: Pick<AccountSettings, 'priorityLabels'>;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label="Priority">
      {PRIORITY_ORDER.map((p) => {
        const on = value === p;
        return (
          <button key={p} type="button" className={`seg-btn prio-${p}${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled}
            title={on ? 'Click again to clear' : undefined} onClick={() => onChange(on ? null : p)}>
            <PriorityMark priority={p} />
            {priorityLabel(p, settings)}
          </button>
        );
      })}
    </div>
  );
}

/** Three rising bars; as many are lit as the priority is high. Decorative: callers say the level in words. */
export function PriorityMark({ priority }: { priority: Priority }) {
  const lit = priority === 'a' ? 3 : priority === 'b' ? 2 : 1;
  return (
    <svg className={`prio-mark prio-${priority}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={i * 4} y={8 - i * 3} width="3" height={4 + i * 3} rx="1" fill="currentColor" opacity={i < lit ? 1 : 0.25} />
      ))}
    </svg>
  );
}

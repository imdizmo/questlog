import { useMemo, useState } from 'react';
import { Dialog } from './Dialog';

export interface PlanOption { id: string; label: string; detail?: string }

/** Searchable list of milestones or runs; picking one closes it. "None" clears the current choice. */
export function PlanPicker({ title, options, value, onPick, onClose }: {
  title: string;
  options: PlanOption[];
  value: string | null;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);
  const choose = (id: string | null) => { onPick(id); onClose(); };
  return (
    <Dialog title={title} onClose={onClose} actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <label className="field">
        <span>Search</span>
        <input data-autofocus type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ul className="plan-list">
        {value && <li><button type="button" className="btn btn-sm" onClick={() => choose(null)}>None</button></li>}
        {shown.map((o) => (
          <li key={o.id}>
            <button type="button" className={`plan-opt${o.id === value ? ' on' : ''}`} aria-pressed={o.id === value} onClick={() => choose(o.id)}>
              <span>{o.label}</span>{o.detail && <span className="muted">{o.detail}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">Nothing matches.</li>}
      </ul>
    </Dialog>
  );
}

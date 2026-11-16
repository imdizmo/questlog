import { useState } from 'react';
import { completeStep } from '../onboarding';
import { addSortKey, NOT_SECONDARY, ORDER_LABELS, type DeckView, type OrderProp, type ViewFeatures } from '../../../shared/order';
import { Toggle } from './AddCardPanel';
import { Icon } from './icons';
import { useEffortOn } from '../store';

/** Rows with a direction pair. For Priority the engine's natural order (High first) reads as descending. */
const DIRECTIONAL: OrderProp[] = ['priority', 'effort', 'status', 'sprint', 'milestone'];
const TAGS: { prop: OrderProp; text: string; label: string }[] = [
  { prop: 'projectTags', text: 'Project', label: 'Project Tags' },
  { prop: 'tags', text: '&', label: 'Project and personal tags' },
  { prop: 'personalTags', text: 'Personal', label: 'Personal Tags' },
];
const SINGLE: OrderProp[] = [
  'manual', 'assignee', 'creator', 'lastUpdatedAt', 'createdAt', 'title', 'changes', 'timeTracked', 'dueDate', 'heroCard', 'beastLevel',
];

const available = (p: OrderProp, f: ViewFeatures): boolean => {
  if (p === 'milestone') return f.milestonesEnabled;
  if (p === 'sprint' || p === 'beastLevel') return f.sprintsEnabled;
  if (p === 'dueDate') return f.dueDateEnabled;
  if (p === 'timeTracked') return f.timeTrackingOn;
  return true;
};

interface Props {
  view: DeckView;
  features: ViewFeatures;
  /** True when the local view equals what a fresh visitor would get (disables Reset and Save). */
  atDefault: boolean;
  canSave: boolean;
  onChange(v: DeckView): void;
  onReset(): void;
  onSave(): void;
  onClose(): void;
  /** Shared projects (Open Decks), for project managers: make this view what visitors get. */
  visitors?: { isDefault: boolean; onSet(): void };
}

export function OrderPanel({ view, features, atDefault, canSave, onChange, onReset, onSave, onClose, visitors }: Props) {
  // Not stored, as observed: a fresh load always starts in single-key mode.
  const [multi, setMulti] = useState(false);
  const effortOn = useEffortOn();
  /** 1-based place among the active keys, 0 when not active. */
  const position = (p: OrderProp): number => {
    if (p === view.prop) return 1;
    const i = (view.secondary ?? []).findIndex((k) => k.prop === p);
    return i < 0 ? 0 : i + 2;
  };
  const isReversed = (p: OrderProp): boolean => (p === view.prop ? view.isReversed : !!view.secondary?.find((k) => k.prop === p)?.isReversed);
  const disabled = (p: OrderProp) => multi && NOT_SECONDARY.includes(p) && p !== view.prop;

  const choose = (p: OrderProp, reversed: boolean) => { completeStep('useSorting'); onChange(addSortKey(view, p, reversed, multi)); };
  /** A plain key: a second click on the active one flips it. */
  const toggle = (p: OrderProp) => {
    if (!multi && p === view.prop) { completeStep('useSorting'); onChange({ ...view, isReversed: !view.isReversed }); }
    else choose(p, false);
  };
  const badge = (p: OrderProp) =>
    multi && position(p) > 0 ? <span className="sort-badge" data-testid={`sort-badge-${p}`} title={`Sort position ${position(p)}`} aria-hidden>{position(p)}</span> : null;
  const active = (p: OrderProp) => position(p) > 0 && (multi || p === view.prop);
  const hideEmptyOk = view.prop === 'sprint' || view.prop === 'milestone';

  return (
    <aside className="order-panel" aria-label="Order">
      <div className="order-head">
        <h2>Order</h2>
        <button type="button" className="icon-btn" aria-label="Close order panel" onClick={onClose}><Icon name="close" /></button>
      </div>

      {multi && <p className="hint order-hint">Pick keys in turn: each one breaks ties left by the keys before it. Pick a key again to flip it.</p>}

      <div className="order-rows">
        {DIRECTIONAL.filter((p) => available(p, features) && (p !== 'effort' || effortOn)).map((p) => {
          const naturalLabel = p === 'priority' ? 'Descending' : 'Ascending';
          const flippedLabel = p === 'priority' ? 'Ascending' : 'Descending';
          return (
            <div key={p} className="order-row">
              <span className="order-label">{ORDER_LABELS[p]}{badge(p)}</span>
              <span className="order-dirs">
                {[[naturalLabel, false], [flippedLabel, true]].map(([dir, rev]) => (
                  <button key={String(dir)} type="button" aria-label={`${ORDER_LABELS[p]} ${String(dir).toLowerCase()}`}
                    className={active(p) && isReversed(p) === rev ? 'btn btn-active' : 'btn'} aria-pressed={active(p) && isReversed(p) === rev}
                    disabled={disabled(p)} onClick={() => choose(p, rev as boolean)}>{dir}</button>
                ))}
              </span>
            </div>
          );
        })}
        <div className="order-row">
          <span className="order-label">Tags</span>
          <span className="order-dirs">
            {TAGS.map((t) => (
              <button key={t.prop} type="button" aria-label={t.label} className={active(t.prop) ? 'btn btn-active' : 'btn'}
                aria-pressed={active(t.prop)} onClick={() => toggle(t.prop)}>{t.text}{badge(t.prop)}</button>
            ))}
          </span>
        </div>
        <div className="order-keys">
          {SINGLE.filter((p) => available(p, features)).map((p) => (
            <button key={p} type="button" className={active(p) ? 'btn btn-active' : 'btn'} aria-pressed={active(p)}
              disabled={disabled(p)} onClick={() => toggle(p)}>{ORDER_LABELS[p]}{badge(p)}</button>
          ))}
        </div>
      </div>

      <div className="order-toggles">
        <Toggle label="Multi Sort" checked={multi} onChange={setMulti} />
        <Toggle label="Compact" checked={!!view.isCompact} onChange={(v) => onChange({ ...view, isCompact: v })} />
        <Toggle label="Hide empty" checked={!!view.hideEmpty} disabled={!hideEmptyOk}
          title={hideEmptyOk ? undefined : 'Only for Sprint and Milestone, the keys that can have empty groups'}
          onChange={(v) => onChange({ ...view, hideEmpty: v })} />
        <Toggle label="Table" checked={view.mode === 'tableView'} onChange={(v) => onChange({ ...view, mode: v ? 'tableView' : 'miniCard' })} />
      </div>

      <div className="order-default">
        <h3>Default View</h3>
        <div className="order-dirs">
          <button type="button" className="btn" disabled={atDefault} onClick={onReset}>Reset</button>
          {canSave && <button type="button" className="btn btn-primary" disabled={atDefault} onClick={onSave}>Save</button>}
        </div>
      </div>
      {visitors && (
        <div className="order-default">
          <h3>Public lists</h3>
          <button type="button" className={visitors.isDefault ? 'btn btn-active' : 'btn'} aria-pressed={visitors.isDefault}
            title={visitors.isDefault ? 'Visitors of the public page see this order' : 'Show visitors of the public page this order'}
            disabled={visitors.isDefault} onClick={visitors.onSet}>
            <Icon name="star" size={16} /> Default for visitors
          </button>
        </div>
      )}
    </aside>
  );
}

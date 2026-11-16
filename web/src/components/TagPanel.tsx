import { Icon } from './icons';

export interface TagCount { key: string; name: string; count: number }

/** Selection keys: `project:<name>`, `personal:<name>` and NOT_TAGGED. */
export const NOT_TAGGED = 'none';

interface Props {
  project: TagCount[];
  personal: TagCount[];
  notTagged: number;
  selected: string[];
  /** True: a card needs any selected tag; false: all of them. */
  any: boolean;
  onToggle(key: string): void;
  onMode(any: boolean): void;
  onClose(): void;
}

const plural = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

export function TagPanel({ project, personal, notTagged, selected, any, onToggle, onMode, onClose }: Props) {
  const btn = (key: string, text: string, label: string, count: number, personalTag = false) => {
    const on = selected.includes(key);
    return (
      <button key={key} type="button" aria-label={`${label}, ${plural(count)}`} aria-pressed={on}
        className={`${on ? 'btn btn-active' : 'btn'}${personalTag ? ' tag-personal' : ''}`} onClick={() => onToggle(key)}>
        {text} <span className="muted">{count}</span>
      </button>
    );
  };
  return (
    <aside className="order-panel" aria-label="Tags">
      <div className="order-head">
        <h2>Tags</h2>
        <button type="button" className="icon-btn" aria-label="Close tags panel" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="order-dirs" role="radiogroup" aria-label="Match">
        {([['and', false], ['or', true]] as const).map(([text, v]) => (
          <label key={text} className={any === v ? 'btn btn-active' : 'btn'}>
            <input type="radio" name="tag-match" className="sr-only" checked={any === v} onChange={() => onMode(v)} aria-label={text} />
            {text}
          </label>
        ))}
      </div>
      <div className="order-dirs">
        {project.map((t) => btn(t.key, `#${t.name}`, `Tag #${t.name}`, t.count))}
        {personal.map((t) => btn(t.key, `#${t.name}`, `Personal tag #${t.name}`, t.count, true))}
        {btn(NOT_TAGGED, 'Not tagged', 'Not tagged', notTagged)}
      </div>
    </aside>
  );
}

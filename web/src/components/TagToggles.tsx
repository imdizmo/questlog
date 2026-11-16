import type { ProjectTag } from '../../../shared/types';

/** The visible mark of a tag: its emoji, or `#` when it has none. */
export const tagMark = (t: Pick<ProjectTag, 'emoji'> | undefined) => t?.emoji || '#';

/**
 * One toggle per project tag. `onChange` gets the whole new list in project order
 * (names the project no longer has are dropped; the server would refuse them).
 */
export function TagToggles({ tags, value, onChange, disabled }: {
  tags: ProjectTag[];
  value: string[];
  /** Gets an updater; apply it to the newest list (several toggles can land before a re-render). */
  onChange: (update: (cur: string[]) => string[]) => void;
  disabled?: boolean;
}) {
  if (!tags.length) return <p className="hint">This project has no tags yet.</p>;
  const set = new Set(value);
  const toggle = (name: string) => onChange((cur) => {
    const next = new Set(cur);
    if (next.has(name)) next.delete(name); else next.add(name);
    return tags.map((t) => t.name).filter((n) => next.has(n));
  });
  return (
    <div className="tag-toggles" role="group" aria-label="Project tags">
      {tags.map((t) => {
        const on = set.has(t.name);
        return (
          <button key={t.name} type="button" className={`tag-toggle${on ? ' on' : ''}`} aria-pressed={on} aria-label={`Tag ${t.name}`}
            disabled={disabled} onClick={() => toggle(t.name)}>
            <span className="tag-mark" aria-hidden>{tagMark(t)}</span>{t.name}
          </button>
        );
      })}
    </div>
  );
}

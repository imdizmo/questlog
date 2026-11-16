import { useId, useState } from 'react';
import type { Project, ProjectTag } from '../../../shared/types';
import { dispatch } from '../api';
import { useStore } from '../store';
import { Dialog } from './Dialog';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './icons';
import { tagMark } from './TagToggles';

/** Mirrors the server: lowercase letters, digits, `_` and `-`, at most 32. */
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

/**
 * Add and delete a project's tags. Every change sends the whole list; deleting a tag
 * also takes it off every card in the project, so the confirm says how many that is.
 */
export function ProjectTagsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const decks = useStore((s) => s.decks);
  const cards = useStore((s) => s.cards);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ProjectTag | null>(null);
  const tags = project.tags ?? [];
  const errId = useId();

  const save = (next: ProjectTag[]) => dispatch('projects', 'update', { id: project.id, tags: next });

  const add = async () => {
    const n = name.trim().replace(/^#/, '').toLowerCase();
    const e = emoji.trim();
    if (!NAME_RE.test(n)) { setError('Use up to 32 letters, digits, - or _ (no spaces).'); return; }
    if (tags.some((t) => t.name === n)) { setError(`There already is a tag "${n}".`); return; }
    if ([...e].length > 4 || e.length > 8) { setError('Use a single emoji, or leave it empty.'); return; }
    setBusy(true);
    try {
      await save([...tags, { name: n, emoji: e || null }]);
      setName('');
      setEmoji('');
      setError(null);
    } catch { /* toast */ } finally { setBusy(false); }
  };

  const usedBy = (tag: string) => {
    const deckIds = new Set([...decks.values()].filter((d) => d.projectId === project.id).map((d) => d.id));
    return [...cards.values()].filter((c) => c.deckId && deckIds.has(c.deckId) && c.masterTags?.includes(tag)).length;
  };
  const n = removing ? usedBy(removing.name) : 0;

  return (
    <>
      <Dialog title="Project tags" onClose={onClose} onSubmit={add} actions={
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      }>
        <p className="hint">Tags for every task in <strong>{project.name}</strong>. Typing <code>#name</code> in a task adds the tag too.</p>
        {tags.length ? (
          <ul className="tag-list" aria-label="Tags">
            {tags.map((t) => (
              <li key={t.name}>
                <span className="tag-mark" aria-hidden>{tagMark(t)}</span>
                <span className="tag-name">{t.name}</span>
                <button type="button" className="icon-btn" aria-label={`Delete tag ${t.name}`} title="Delete tag" disabled={busy}
                  onClick={() => setRemoving(t)}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No tags yet.</p>}
        <div className="tag-add">
          <label className="field">
            <span>Tag name</span>
            <input value={name} maxLength={33} autoComplete="off" onChange={(e) => { setName(e.target.value); setError(null); }}
              aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} />
          </label>
          <label className="field tag-emoji">
            <span>Emoji (optional)</span>
            <input value={emoji} maxLength={8} autoComplete="off" onChange={(e) => { setEmoji(e.target.value); setError(null); }} />
          </label>
          <button type="submit" className="btn" disabled={busy || !name.trim()}><Icon name="plus" size={16} /> Add tag</button>
        </div>
        {error && <p className="form-error" id={errId} role="alert">{error}</p>}
      </Dialog>
      {removing && (
        <ConfirmDialog title="Delete tag?" confirmLabel="Delete tag" danger onClose={() => setRemoving(null)}
          onConfirm={() => save(tags.filter((t) => t.name !== removing.name))}>
          <p>
            <strong>{tagMark(removing)} {removing.name}</strong> will be removed from the project.{' '}
            {n === 0 ? 'No task uses it.' : n === 1 ? '1 task uses it and loses the tag.' : `${n} tasks use it and lose the tag.`}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

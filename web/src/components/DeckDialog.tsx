import { useState } from 'react';
import type { Cover } from '../../../shared/covers';
import { Dialog } from './Dialog';
import { CoverPicker, coverFields, type CoverChoice } from './CoverPicker';

interface Props {
  projectId: string;
  /** Edit an existing deck; omit to create one. */
  initialTitle?: string;
  initialCover?: Cover;
  /** Shown under the field, e.g. which section the deck lands in. */
  hint?: string;
  onSubmit: (title: string, cover: { cover: Cover } | { coverUrl: string }) => Promise<void>;
  onClose: () => void;
}

export function DeckDialog({ projectId, initialTitle, initialCover, hint, onSubmit, onClose }: Props) {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [cover, setCover] = useState<CoverChoice>(initialCover ?? null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const renaming = initialTitle !== undefined;

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await onSubmit(title.trim(), coverFields(cover)); onClose(); } catch { /* toast already shown */ } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={renaming ? 'Edit list' : 'New list'}
      onClose={onClose}
      onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || uploading || !title.trim()}>{renaming ? 'Save' : 'Create list'}</button>
      </>}
    >
      <label className="field">
        <span>List name</span>
        <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <CoverPicker projectId={projectId} value={cover} onChange={setCover} onBusy={setUploading} />
      {hint && <p className="hint">{hint}</p>}
    </Dialog>
  );
}

import { useState } from 'react';
import type { DeckType } from '../../../shared/types';
import { Dialog } from './Dialog';
import { DeckTypeIcon, DECK_TYPE_LABEL } from './icons';

const TYPES: { type: DeckType; blurb: string }[] = [
  { type: 'task', blurb: 'Tasks are tasks with an owner and a status.' },
  { type: 'asset', blurb: 'Tasks are features or assets that move through production.' },
  { type: 'doc', blurb: 'Lore only: pages with no status and no owner.' },
  { type: 'mixed', blurb: 'Tasks and lore.' },
];

export function DeckTypeDialog({ current, onSubmit, onClose }: {
  current: DeckType;
  onSubmit: (t: DeckType) => Promise<void>;
  onClose: () => void;
}) {
  const [type, setType] = useState<DeckType>(current);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await onSubmit(type); onClose(); } catch { /* toast already shown */ } finally { setBusy(false); }
  };
  return (
    <Dialog
      title="List type"
      onClose={onClose}
      onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || type === current}>Save</button>
      </>}
    >
      <fieldset className="choice-list">
        <legend>Type</legend>
        {TYPES.map((t) => (
          <label key={t.type} className={type === t.type ? 'choice selected' : 'choice'}>
            <input type="radio" name="deck-type" value={t.type} checked={type === t.type} onChange={() => setType(t.type)} />
            <span className="choice-title">{DECK_TYPE_LABEL[t.type]}<DeckTypeIcon type={t.type} size={16} /></span>
            <span className="choice-blurb">{t.blurb}</span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

import { useState } from 'react';
import type { Space } from '../../../shared/types';
import { Dialog } from './Dialog';
import { DeckTypeIcon, DECK_TYPE_LABEL } from './icons';
import { SPACE_KINDS, kindOf, type SpaceInput } from '../spaces';

interface Props {
  /** Edit this section; omit to create a new one. */
  space?: Space;
  onSubmit: (input: SpaceInput) => Promise<void>;
  onClose: () => void;
}

/** Pick one of the five section types; Custom takes a name. */
export function SpaceDialog({ space, onSubmit, onClose }: Props) {
  const [kind, setKind] = useState(space ? kindOf(space) : 'Tasks');
  const [customName, setCustomName] = useState(space && kindOf(space) === 'Custom' ? space.name ?? '' : '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try { await onSubmit({ kind, customName }); onClose(); } catch { /* toast already shown */ } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={space ? 'Edit area' : 'New area'}
      onClose={onClose}
      onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{space ? 'Update' : 'Add area'}</button>
      </>}
    >
      <fieldset className="choice-grid">
        <legend>Area type</legend>
        {SPACE_KINDS.map((k) => (
          <label key={k.kind} className={kind === k.kind ? 'choice selected' : 'choice'}>
            <input type="radio" name="space-kind" value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} />
            <span className="choice-title">{k.kind}<DeckTypeIcon type={k.deckType} size={16} /></span>
            <span className="choice-blurb">{k.blurb}</span>
            <span className="choice-meta">New lists: {DECK_TYPE_LABEL[k.deckType].toLowerCase()}</span>
          </label>
        ))}
      </fieldset>
      {kind === 'Custom' && (
        <label className="field">
          <span>Area name</span>
          <input autoFocus value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder={'Leave empty for "General"'} />
        </label>
      )}
    </Dialog>
  );
}

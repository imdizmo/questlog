import { useId, useState } from 'react';
import type { Deck } from '../../../shared/types';
import { dispatch } from '../api';
import { canViewProject, people, planAllows, useStore } from '../store';
import { Dialog } from './Dialog';

/** Guardian rule for a deck: on/off plus which people may mark done, archive or move out its cards. */
export function GuardiansDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const users = useStore((s) => s.users);
  const guardians = useStore((s) => s.deckGuardians);
  const state = useStore((s) => s);
  const id = useId();
  const candidates = people(users).filter((u) => !u.disabled && canViewProject(state, u.id, deck.projectId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [enabled, setEnabled] = useState(deck.guardiansEnabled);
  const [picked, setPicked] = useState(() => new Set([...guardians.values()].filter((g) => g.deckId === deck.id).map((g) => g.userId)));
  const [busy, setBusy] = useState(false);
  // Without the plan feature guardians can be switched off and removed, not switched on or added.
  const allowed = planAllows(state, 'guardians');
  const had = new Set([...guardians.values()].filter((g) => g.deckId === deck.id).map((g) => g.userId));

  const toggle = (uid: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(uid); else n.delete(uid); return n; });
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await dispatch('decks', 'update', { id: deck.id, guardiansEnabled: enabled, guardianIds: [...picked] });
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <Dialog title="Reviewers" onClose={onClose} onSubmit={save} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
    </>}>
      <div className="settings-panel">
        <div className="setting-row">
          <div>
            <label className="setting-label" htmlFor={`${id}-on`}>Reviewers</label>
            <p className="hint" id={`${id}-d`}>When on, only the chosen people can mark tasks done, archive them or move them out of this list.{!allowed && ' Reviewers are part of the Pro plan.'}</p>
          </div>
          <span className="switch">
            <input id={`${id}-on`} type="checkbox" role="switch" checked={enabled} aria-describedby={`${id}-d`} disabled={!allowed && !enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="track" />
          </span>
        </div>
        <fieldset className="field" disabled={!enabled}>
          <legend>Who are the reviewers</legend>
          {candidates.map((u) => (
            <label key={u.id} className="check-row">
              <input type="checkbox" checked={picked.has(u.id)} disabled={!allowed && !had.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
              <span>{u.name}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}

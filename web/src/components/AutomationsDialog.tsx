import { useId, useState } from 'react';
import type { Deck } from '../../../shared/types';
import { titleOf } from '../../../shared/cards';
import { dispatch } from '../api';
import { settingsOf, useStore } from '../store';
import { coversProject } from '../planning';
import { Dialog } from './Dialog';

/** Deck automations: a project tag every new card gets, and a card new cards start from. */
export function AutomationsDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const project = useStore((s) => s.projects.get(deck.projectId));
  const cards = useStore((s) => s.cards);
  const id = useId();
  const milestonesEnabled = useStore((s) => settingsOf(s).milestonesEnabled);
  const milestones = useStore((s) => s.milestones);
  const covering = [...milestones.values()].filter((m) => coversProject(m, deck.projectId)).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const [autoMs, setAutoMs] = useState(deck.autoMilestoneId && covering.some((m) => m.id === deck.autoMilestoneId) ? deck.autoMilestoneId : '');
  const tags = project?.tags ?? [];
  const deckCards = [...cards.values()].filter((c) => c.deckId === deck.id && c.visibility === 'default').sort((a, b) => a.seq - b.seq);
  const [autoTag, setAutoTag] = useState(deck.autoTag && tags.some((t) => t.name === deck.autoTag) ? deck.autoTag : '');
  const [defaultCard, setDefaultCard] = useState(deck.defaultCardId && deckCards.some((c) => c.id === deck.defaultCardId) ? deck.defaultCardId : '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await dispatch('decks', 'update', { id: deck.id, autoTag: autoTag || null, defaultCardId: defaultCard || null, ...(milestonesEnabled ? { autoMilestoneId: autoMs || null } : {}) });
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <Dialog title="List automations" onClose={onClose} onSubmit={save} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
    </>}>
      <div className="settings-panel">
        <label className="field">
          <span>Auto project tag</span>
          <select value={autoTag} onChange={(e) => setAutoTag(e.target.value)} aria-describedby={`${id}-tag`}>
            <option value="">None</option>
            {tags.map((t) => <option key={t.name} value={t.name}>{t.emoji ? `${t.emoji} ` : '#'}{t.name}</option>)}
          </select>
          <small className="hint" id={`${id}-tag`}>Tasks created in or moved into this list get this tag.</small>
        </label>
        <label className="field">
          <span>Default task</span>
          <select value={defaultCard} onChange={(e) => setDefaultCard(e.target.value)} aria-describedby={`${id}-card`}>
            <option value="">None</option>
            {deckCards.map((c) => <option key={c.id} value={c.id}>{titleOf(c.content) || 'Untitled'}</option>)}
          </select>
          <small className="hint" id={`${id}-card`}>New tasks here start with its text, priority, Effort and tags.</small>
        </label>
        {milestonesEnabled && (
          <label className="field">
            <span>Auto Milestone</span>
            <select value={autoMs} onChange={(e) => setAutoMs(e.target.value)} aria-describedby={`${id}-ms`}>
              <option value="">None</option>
              {covering.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <small className="hint" id={`${id}-ms`}>New tasks in this list join this milestone.</small>
          </label>
        )}
      </div>
    </Dialog>
  );
}

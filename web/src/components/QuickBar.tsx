import { useId } from 'react';
import type { Card, Priority, Project } from '../../../shared/types';
import { effortScale, PRIORITY_ORDER, priorityLabel } from '../../../shared/properties';
import { GUARDIAN_TIP, settingsOf, useEffortOn, useStore } from '../store';
import { DeckPicker } from './DeckPicker';
import { OwnerPicker } from './OwnerPicker';
import { PlanFields } from './PlanFields';

/** The card header row: Deck, Owner, Priority, Effort, Milestone and Run. */
export function QuickBar({ card, project, disabled, moveLocked, update }: {
  card: Card;
  project: Project | undefined;
  disabled: boolean;
  /** The card's deck is guarded and I am not a guardian: moving it out is off. */
  moveLocked?: boolean;
  update: (patch: object) => void;
}) {
  const effortOn = useEffortOn();
  const settings = useStore(settingsOf);
  const id = useId();
  const scale = effortScale(settings);
  // A typed-in effort that isn't on the scale still shows as itself.
  const efforts = card.effort !== null && !scale.includes(card.effort) ? [...scale, card.effort].sort((a, b) => a - b) : scale;

  return (
    <div className="quick-bar" aria-label="Task properties" role="group">
      <div className="quick-field">
        <span>List</span>
        <span title={moveLocked ? GUARDIAN_TIP : undefined}>
        <DeckPicker value={card.deckId} isDoc={card.isDoc} disabled={disabled || !!moveLocked} onChange={(deckId) => update({ deckId })} />
        </span>
      </div>
      {!card.isDoc && (
        <>
          <OwnerPicker value={card.assigneeId} project={project} disabled={disabled} onChange={(assigneeId) => update({ assigneeId })} />
          <div className="quick-field">
            <label htmlFor={`${id}-p`}>Priority</label>
            <select id={`${id}-p`} className="quick-select" value={card.priority ?? ''} disabled={disabled}
              onChange={(e) => update({ priority: (e.target.value || null) as Priority | null })}>
              <option value="">None</option>
              {[...PRIORITY_ORDER].reverse().map((p) => <option key={p} value={p}>{priorityLabel(p, settings)}</option>)}
            </select>
          </div>
          <div className="quick-field" hidden={!effortOn}>
            <label htmlFor={`${id}-e`}>Effort</label>
            <select id={`${id}-e`} className="quick-select" value={card.effort === null ? '' : String(card.effort)} disabled={disabled}
              onChange={(e) => update({ effort: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">None</option>
              {efforts.map((n) => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </div>
          {project && settings.milestonesEnabled && (
            <div className="quick-field"><span>Milestone</span><PlanFields kind="milestone" compact card={card} project={project} editable={!disabled} update={update} /></div>
          )}
          {project && settings.sprintsEnabled && (
            <div className="quick-field"><span>Sprint</span><PlanFields kind="run" compact card={card} project={project} editable={!disabled} update={update} /></div>
          )}
        </>
      )}
    </div>
  );
}

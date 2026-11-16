import { useState } from 'react';
import type { Deck, JourneyStep } from '../../../shared/types';
import { dispatch } from '../api';
import { canManageProject, settingsOf, useStore } from '../store';
import { Dialog } from './Dialog';
import { OwnerPicker } from './OwnerPicker';
import { PriorityButtons } from './PriorityButtons';
import { EffortField } from './EffortField';

const MAX_STEPS = 30;
const blank = (): JourneyStep => ({ title: '', assigneeId: null, priority: null, effort: null });

/** The deck's journey: an ordered step list. Project managers edit it; everyone else sees it read-only. */
export function JourneyDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const s = useStore((x) => x);
  const project = s.projects.get(deck.projectId);
  const settings = settingsOf(s);
  const canEdit = project ? canManageProject(s, project) : false;
  const [steps, setSteps] = useState<JourneyStep[]>(() => s.journeys.get(deck.id)?.steps.map((x) => ({ ...x })) ?? []);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<JourneyStep>) => setSteps((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setSteps((a) => {
    const n = [...a];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });
  const save = async () => {
    if (busy || !canEdit) return;
    const clean = steps.map((x) => ({ ...x, title: x.title.trim() })).filter((x) => x.title);
    setBusy(true);
    try {
      await dispatch('journeys', 'set', { deckId: deck.id, steps: clean });
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <Dialog title="Task chain" onClose={onClose} onSubmit={save} wide scroll actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
      {canEdit && <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>}
    </>}>
      <p className="hint">Applying the task chain to a task adds one subtask per step, in this list.</p>
      {!canEdit && steps.length === 0 && <p className="muted">This list has no task chain.</p>}
      <ol className="journey-steps" aria-label="Task chain steps">
        {steps.map((st, i) => (
          <li key={i} className="journey-step" data-testid="journey-step">
            {canEdit ? (
              <>
                <label className="field">
                  <span>Step {i + 1} title</span>
                  <input value={st.title} maxLength={200} onChange={(e) => patch(i, { title: e.target.value })} data-autofocus={i === steps.length - 1 ? '' : undefined} />
                </label>
                <OwnerPicker value={st.assigneeId} project={project} onChange={(assigneeId) => patch(i, { assigneeId })} />
                <PriorityButtons value={st.priority} settings={settings} onChange={(priority) => patch(i, { priority })} />
                <EffortField value={st.effort} settings={settings} onChange={(effort) => patch(i, { effort })} />
                <div className="seg">
                  <button type="button" className="btn btn-sm" disabled={i === 0} aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}>Up</button>
                  <button type="button" className="btn btn-sm" disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)}>Down</button>
                  <button type="button" className="btn btn-sm" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((a) => a.filter((_, j) => j !== i))}>Remove</button>
                </div>
              </>
            ) : (
              <p>
                <strong>{i + 1}. {st.title}</strong>
                {st.assigneeId && <span className="muted"> · {s.users.get(st.assigneeId)?.name ?? 'Unknown'}</span>}
                {st.priority && <span className="muted"> · priority {st.priority.toUpperCase()}</span>}
                {st.effort !== null && <span className="muted"> · {st.effort} effort</span>}
              </p>
            )}
          </li>
        ))}
      </ol>
      {canEdit && (
        <button type="button" className="btn" disabled={steps.length >= MAX_STEPS} onClick={() => setSteps((a) => [...a, blank()])}>Add step</button>
      )}
    </Dialog>
  );
}

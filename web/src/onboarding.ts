import { store, type State } from './store';
import { QUEST_STEP_KEYS, QUESTS, currentChapter, unavailableSteps } from '../../shared/quests';
import { featureAllowed } from '../../shared/plans';

/** Steps whose request is on its way, so a burst of the same action sends one request. */
const sending = new Set<string>();

/**
 * Tells the server I completed a card step. Fire and forget, once per person: nothing is sent when the store already
 * lists the step, and a failure is silent (the next time the action happens it tries again).
 */
export function completeStep(step: string): void {
  const s = store.get();
  if (s.status !== 'ready' || !QUEST_STEP_KEYS.has(step) || s.onboarding.has(step) || sending.has(step)) return;
  sending.add(step);
  fetch('/dispatch/onboarding/progress', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step }),
  }).catch(() => {}).finally(() => { sending.delete(step); });
}

/** The card steps a successful command completes (the places that run commands do not each need to know). */
export function stepsForCommand(ns: string, action: string, payload: any): string[] {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (`${ns}/${action}`) {
    case 'cards/create': return ['createCard', ...(p.parentCardId ? ['addSubCard'] : [])];
    case 'cards/update': return [
      ...(p.status === 'started' ? ['startCard'] : []),
      ...((Array.isArray(p.childCards) && p.childCards.length) || p.parentCardId ? ['addSubCard'] : []),
    ];
    case 'cards/bulkUpdate': return ['bulkEdit', ...(p.status === 'started' ? ['startCard'] : [])];
    case 'resolvables/comment': return ['addComment'];
    case 'resolvables/create': return p.context === 'comment' ? ['addComment'] : [];
    case 'milestones/create': return ['createMilestone'];
    case 'sprints/createConfig': return ['setUpRun'];
    case 'timeTracking/start': case 'timeTracking/create': return ['trackTime'];
    case 'visionBoard/createBoard': return ['createVisionBoard'];
    case 'search/save': return ['saveSearch'];
    case 'invites/create': return ['inviteTeammate'];
    default: return [];
  }
}

/** Called by dispatch after a command succeeded. */
export function noteCommand(ns: string, action: string, payload: unknown): void {
  for (const step of stepsForCommand(ns, action, payload)) completeStep(step);
}

/** Done step keys, the sprint to work on, and my progress as numbers. */
export function questProgress(s: Pick<State, 'onboarding'> & Partial<Pick<State, 'account'>>) {
  const done = new Set(s.onboarding.keys());
  // Steps the plan does not allow (time tracking on Free) are shown as unavailable and never hold a sprint back.
  const skipped = s.account ? unavailableSteps((f) => featureAllowed(s.account!, f)) : new Set<string>();
  const open = QUESTS.flatMap((c) => c.steps).filter((x) => !skipped.has(x.key));
  return { done, skipped, chapter: currentChapter(done, skipped), doneCount: open.filter((x) => done.has(x.key)).length, total: open.length };
}

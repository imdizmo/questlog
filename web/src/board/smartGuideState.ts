import type { SmartMode } from '../../../shared/board';
import type { Prefs } from '../prefs';

/**
 * The Smart Node guide: a few steps beside a new Smart Node, each ticked when the person does it. It opens by itself
 * the first time this person adds one (editors only, not while the Tutorial is paused) and again from the node's
 * "Show guide". Per person (the `smartGuide` preference, so it follows them to every device); nothing goes into the
 * board's document.
 */
export type GuideStep = 'project' | 'filter' | 'display' | 'search';

export const STEP_TEXT: Record<GuideStep, { label: string; hint: string }> = {
  project: { label: 'Pick a project', hint: 'On Home a Smart Node counts the tasks of one project.' },
  filter: { label: 'Add a filter', hint: 'Set up filter, add a chip, then Save filter.' },
  display: { label: 'Choose how it shows', hint: 'Display: bars, donut, number, or a table.' },
  search: { label: 'Open it as a search', hint: 'Open as search lists its tasks with the same chips.' },
};

/** Home keeps each Smart Node with a project, so it starts there; a card board has its task's. */
export const guideSteps = (home: boolean): GuideStep[] => (home ? ['project', 'filter', 'display', 'search'] : ['filter', 'display', 'search']);

/** What the person has done, read from the node, its query and this page. */
export type GuideFacts = Record<GuideStep, boolean>;

export function guideFacts(x: { projectId: string | null | undefined; tokens: number; mode: SmartMode; startMode: SmartMode; opened: boolean }): GuideFacts {
  return { project: !!x.projectId, filter: x.tokens > 0, display: x.mode !== x.startMode, search: x.opened };
}

export interface GuideState {
  nodeId: string;
  steps: GuideStep[];
  /** Steps ticked so far; a tick stays (changing the mode back does not undo it). */
  done: GuideStep[];
  /** Next › moves this past the current step without ticking it. */
  at: number;
  /** The mode when the guide opened: a change from it ticks "Choose how it shows". */
  startMode: SmartMode;
}

export function startGuide(nodeId: string, home: boolean, startMode: SmartMode, facts: Partial<GuideFacts> = {}): GuideState {
  const steps = guideSteps(home);
  return { nodeId, steps, done: steps.filter((s) => facts[s]), at: 0, startMode };
}

/** Adds what is now done; the same object when nothing new is. */
export function tickGuide(g: GuideState, facts: GuideFacts): GuideState {
  const add = g.steps.filter((s) => facts[s] && !g.done.includes(s));
  return add.length ? { ...g, done: g.steps.filter((s) => g.done.includes(s) || add.includes(s)) } : g;
}

/** The step shown open: the first one not done at or after the cursor; -1 when none is left. */
export function currentStep(g: GuideState): number {
  for (let i = g.at; i < g.steps.length; i++) if (!g.done.includes(g.steps[i])) return i;
  return -1;
}

export const nextStep = (g: GuideState): GuideState => ({ ...g, at: currentStep(g) + 1 });

/** 'done': every step ticked; 'closed': the person moved past the last one without doing them all. */
export function guidePhase(g: GuideState): 'step' | 'done' | 'closed' {
  if (g.done.length === g.steps.length) return 'done';
  return currentStep(g) < 0 ? 'closed' : 'step';
}

// ---- the person's preference ----

const KEY = 'smartGuide';
export type GuideSeen = 'seen' | 'done';
const isSeen = (v: unknown): v is GuideSeen => v === 'seen' || v === 'done';

export const guideSeen = (p: Prefs): GuideSeen | null => p.get<GuideSeen | null>(KEY, (v): v is GuideSeen | null => isSeen(v), null);

/** Shown once (Skip counts as seen), finished keeps 'done'. Sent at once: a reload must not show it again. */
export function markGuide(p: Prefs, value: GuideSeen): void {
  if (guideSeen(p) === value || (value === 'seen' && guideSeen(p) === 'done')) return;
  p.set(KEY, value, true);
}

/** Opens by itself only for an editor, with the preferences loaded, the Tutorial not paused, and never seen before. */
export function opensByItself(p: Prefs, x: { canEdit: boolean; paused: boolean }): boolean {
  return x.canEdit && !x.paused && p.ready() && guideSeen(p) === null;
}

// ---- one guide at a time, across boards on the page ----

let closeShown: (() => void) | null = null;
/** Closes the guide another board shows; `close` is how this one is closed by the next. */
export function claimGuide(close: () => void): void {
  if (closeShown && closeShown !== close) closeShown();
  closeShown = close;
}
export function releaseGuide(close: () => void): void {
  if (closeShown === close) closeShown = null;
}

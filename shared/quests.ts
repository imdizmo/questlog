/**
 * Onboarding tutorial: short parts of things worth trying once, in our own words. A step is completed per person
 * the first time they do it (`onboarding/progress {step}`); the keys are stable, the text may change.
 */
import type { PlanFeature } from './plans';

export interface QuestStep {
  key: string;
  title: string;
  hint: string;
}
export interface QuestChapter {
  title: string;
  steps: QuestStep[];
}

export const QUESTS: QuestChapter[] = [
  {
    title: 'First steps',
    steps: [
      { key: 'createCard', title: 'Create a task', hint: 'Open a list and add a task with the plus button.' },
      { key: 'startCard', title: 'Start a task', hint: 'Mark a task as started so the team sees you are on it.' },
      { key: 'addComment', title: 'Write a comment', hint: 'Open a task and start a discussion in its thread.' },
    ],
  },
  {
    title: 'Keeping order',
    steps: [
      { key: 'addSubCard', title: 'Split a task into subtasks', hint: 'Break a big task into smaller ones under a main task.' },
      { key: 'useSorting', title: 'Sort a list', hint: 'Open the order panel on a list and pick a sort key.' },
    ],
  },
  {
    title: 'Planning ahead',
    steps: [
      { key: 'createMilestone', title: 'Create a milestone', hint: 'Group tasks under a goal on the Timeline.' },
      { key: 'setUpRun', title: 'Set up a sprint', hint: 'Plan recurring sprints of work for your projects.' },
      { key: 'trackTime', title: 'Track time on a task', hint: 'Start a timer or log time by hand.' },
    ],
  },
  {
    title: 'Finding things',
    steps: [
      { key: 'useSearch', title: 'Search your tasks', hint: 'Use the search box in the top bar and pick a filter.' },
      { key: 'saveSearch', title: 'Save a search', hint: 'Keep a filter you use often for later.' },
      { key: 'bulkEdit', title: 'Edit several tasks at once', hint: 'Select a few tasks and change them together.' },
    ],
  },
  {
    title: 'Working together',
    steps: [
      { key: 'createVisionBoard', title: 'Draw on a map', hint: 'Sketch ideas on a map attached to a task.' },
      { key: 'inviteTeammate', title: 'Invite a teammate', hint: 'Send an invite link from the Members page.' },
      { key: 'applySCMIntegration', title: 'Connect your source control', hint: 'Link a git host in the workspace settings.' },
    ],
  },
];

export const QUEST_STEP_KEYS: ReadonlySet<string> = new Set(QUESTS.flatMap((c) => c.steps.map((s) => s.key)));

/** Steps that need a plan feature: on a plan without it the step is not available (the server answers 409 plan_feature). */
export const STEP_FEATURE: Readonly<Record<string, PlanFeature>> = { trackTime: 'timeTracking' };

/** The steps the plan does not allow, to leave out of the sprint marker and the counts. */
export function unavailableSteps(allowed: (feature: PlanFeature) => boolean): Set<string> {
  return new Set(Object.entries(STEP_FEATURE).filter(([, f]) => !allowed(f)).map(([k]) => k));
}

/** The sprint (1-based) to work on now: the first with an open step that is available; the last one once everything is done. */
export function currentChapter(done: ReadonlySet<string>, skip: ReadonlySet<string> = new Set()): number {
  const i = QUESTS.findIndex((c) => c.steps.some((s) => !done.has(s.key) && !skip.has(s.key)));
  return i < 0 ? QUESTS.length : i + 1;
}

const ROMAN: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
/** 1 → "I", 8 → "VIII". */
export function toRoman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

import { describe, it, expect } from 'vitest';
import { createPrefs, type PrefsIO } from '../web/src/prefs';
import {
  currentStep, guideFacts, guidePhase, guideSeen, guideSteps, markGuide, nextStep, opensByItself, startGuide, tickGuide,
} from '../web/src/board/smartGuideState';

// The Smart Node guide (web/src/board/smartGuideState.ts): which steps a board lists, ticks read off the node and its
// query, Next and Skip, and the per-person "seen" preference that keeps it from opening by itself twice.
const none = { project: false, filter: false, display: false, search: false };

function fakeIO(server: Record<string, unknown> = {}) {
  const puts: [string, unknown][] = [];
  const io: PrefsIO = {
    get: async () => ({ prefs: { ...server }, updatedAt: {} }),
    put: async (k, v) => { puts.push([k, v]); server[k] = v; },
    readLocal: () => null,
    writeLocal: () => {},
  };
  return { io, puts, server };
}

describe('Smart Node guide steps', () => {
  it('Home starts with Pick a project; a card board has three steps', () => {
    expect(guideSteps(true)).toEqual(['project', 'filter', 'display', 'search']);
    expect(guideSteps(false)).toEqual(['filter', 'display', 'search']);
    expect(startGuide('n', false, 'horBar').steps).toHaveLength(3);
  });

  it('reads the ticks from the node and its query', () => {
    const base = { projectId: null, tokens: 0, mode: 'horBar' as const, startMode: 'horBar' as const, opened: false };
    expect(guideFacts(base)).toEqual(none);
    expect(guideFacts({ ...base, projectId: 'p1' }).project).toBe(true);
    expect(guideFacts({ ...base, tokens: 1 }).filter).toBe(true);
    expect(guideFacts({ ...base, mode: 'donut' }).display).toBe(true);
    expect(guideFacts({ ...base, opened: true }).search).toBe(true);
  });

  it('on Home a project picked first is already ticked: the guide opens on Add a filter, 1 of 4', () => {
    const g = startGuide('n', true, 'horBar', { project: true });
    expect(g.done).toEqual(['project']);
    expect(g.steps[currentStep(g)]).toBe('filter');
  });

  it('a tick moves the open step on and stays, even when the mode goes back', () => {
    let g = startGuide('n', false, 'horBar');
    expect(g.steps[currentStep(g)]).toBe('filter');
    g = tickGuide(g, { ...none, filter: true });
    expect(g.steps[currentStep(g)]).toBe('display');
    g = tickGuide(g, { ...none, filter: true, display: true });
    g = tickGuide(g, none);
    expect(g.done).toEqual(['filter', 'display']);
    expect(g.steps[currentStep(g)]).toBe('search');
    expect(tickGuide(g, { ...none, filter: true })).toBe(g); // nothing new: the same state
    g = tickGuide(g, { ...none, search: true });
    expect(guidePhase(g)).toBe('done');
  });

  it('a step done out of order ticks too', () => {
    const g = tickGuide(startGuide('n', false, 'horBar'), { ...none, display: true });
    expect(g.done).toEqual(['display']);
    expect(g.steps[currentStep(g)]).toBe('filter');
  });

  it('Next moves on without ticking; past the last step the guide closes', () => {
    let g = nextStep(startGuide('n', false, 'horBar'));
    expect(g.done).toEqual([]);
    expect(g.steps[currentStep(g)]).toBe('display');
    g = tickGuide(g, { ...none, display: true });
    expect(g.steps[currentStep(g)]).toBe('search'); // the skipped filter step is not asked again
    g = nextStep(g);
    expect(currentStep(g)).toBe(-1);
    expect(guidePhase(g)).toBe('closed');
  });
});

describe('Smart Node guide: seen, per person', () => {
  it('opens by itself once for an editor; Skip and finishing count as seen; it is sent to the server at once', async () => {
    const f = fakeIO();
    const p = createPrefs(f.io);
    expect(opensByItself(p, { canEdit: true, paused: false })).toBe(false); // not loaded yet: wait, never guess
    await p.load();
    expect(opensByItself(p, { canEdit: true, paused: false })).toBe(true);
    expect(opensByItself(p, { canEdit: false, paused: false })).toBe(false);
    expect(opensByItself(p, { canEdit: true, paused: true })).toBe(false);
    markGuide(p, 'seen'); // shown (then skipped)
    await p.flush();
    expect(f.puts).toEqual([['smartGuide', 'seen']]);
    expect(opensByItself(p, { canEdit: true, paused: false })).toBe(false);
    markGuide(p, 'done');
    markGuide(p, 'seen'); // a replay never takes "done" back
    await p.flush();
    expect(guideSeen(p)).toBe('done');
    expect(f.puts).toEqual([['smartGuide', 'seen'], ['smartGuide', 'done']]);
  });

  it('follows the person: another device that loads the preference does not open it again', async () => {
    const p = createPrefs(fakeIO({ smartGuide: 'seen' }).io);
    await p.load();
    expect(opensByItself(p, { canEdit: true, paused: false })).toBe(false);
    const odd = createPrefs(fakeIO({ smartGuide: 42 }).io);
    await odd.load();
    expect(guideSeen(odd)).toBeNull();
  });
});

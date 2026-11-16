import type { ProjectTemplate } from './types';

export const simulation: ProjectTemplate = {
  id: 'simulation',
  name: 'Simulation',
  blurb: 'A system that runs by itself, with tools to watch it and nudge it.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Art and data', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'model', emoji: '🧮' }, { name: 'economy', emoji: '💰' }, { name: 'agents', emoji: '🧑‍🔧' },
    { name: 'ui', emoji: '🖥️' }, { name: 'perf', emoji: '⏱️' }, { name: 'bug', emoji: '🐞' }, { name: 'data', emoji: null },
  ],
  decks: [
    { title: 'Model notes', deckType: 'doc', space: 1, cards: [
      { content: 'What is simulated\nList the quantities that change over time, what drives them, and what the player may change directly.' },
      { content: 'Time and speed\nFixed time step, pause, and three speeds. Decide what must stay deterministic.' },
    ] },
    { title: 'Simulation core', deckType: 'task', space: 2, cards: [
      { content: 'Fixed time step loop with pause and speed control', priority: 'a', effort: 3, tags: ['model'] },
      { content: 'Resource flow between producers and consumers', priority: 'a', effort: 8, tags: ['model', 'economy'] },
      { content: 'Agents that pick a job, walk to it and finish it', priority: 'b', effort: 8, tags: ['agents'] },
      { content: 'Graphs for the main numbers, drawn over the last day', priority: 'b', effort: 5, tags: ['ui', 'data'] },
      { content: 'Profile the tick with ten thousand agents', priority: 'c', effort: 3, tags: ['perf'] },
    ] },
    { title: 'Buildings and icons', deckType: 'asset', space: 3, cards: [
      { content: 'First set of buildings with a consistent footprint', tags: ['ui'], effort: 5 },
      { content: 'Resource icons that read at small sizes', tags: ['ui'], effort: 2 },
    ] },
  ],
};

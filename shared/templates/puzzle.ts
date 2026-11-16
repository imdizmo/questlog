import type { ProjectTemplate } from './types';

export const puzzle: ProjectTemplate = {
  id: 'puzzle',
  name: 'Puzzle',
  blurb: 'Rules, level sets and difficulty curves you can playtest and adjust.',
  spaces: [
    { id: 1, name: 'Rules', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
  ],
  tags: [
    { name: 'rules', emoji: '📏' }, { name: 'levels', emoji: '🧱' }, { name: 'tutorial', emoji: '🎓' },
    { name: 'difficulty', emoji: '📈' }, { name: 'bug', emoji: '🐞' }, { name: 'ui', emoji: null },
  ],
  decks: [
    { title: 'Rules and theory', deckType: 'doc', space: 1, cards: [
      { content: 'Core rule set\nThe smallest list of rules that still produces surprising puzzles. Write each as one sentence.' },
      { content: 'Difficulty curve\nPlan where the player learns, where they are tested and where they get a breather.' },
    ] },
    { title: 'Engine', deckType: 'task', space: 2, cards: [
      { content: 'Board state model with undo and redo', priority: 'a', effort: 5, tags: ['rules'] },
      { content: 'Win and fail detection, plus a hint for stuck players', priority: 'a', effort: 3, tags: ['rules'] },
      { content: 'Level file format and loader', priority: 'b', effort: 3, tags: ['levels'] },
      { content: 'Level editor in the game for quick iteration', priority: 'c', effort: 8, tags: ['levels'] },
    ] },
    { title: 'Levels', deckType: 'task', space: 2, cards: [
      { content: 'Tutorial levels one to five, one new idea each', priority: 'a', effort: 5, tags: ['tutorial', 'levels'] },
      { content: 'Playtest the first twenty levels and note where people stall', priority: 'b', effort: 3, tags: ['difficulty'] },
    ] },
  ],
};

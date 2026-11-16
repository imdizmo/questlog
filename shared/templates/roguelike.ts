import type { ProjectTemplate } from './types';

export const roguelike: ProjectTemplate = {
  id: 'roguelike',
  name: 'Roguelike',
  blurb: 'Runs, randomness and a pile of content that has to stay balanced.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Content', icon: null, defaultDeckType: 'mixed' },
  ],
  tags: [
    { name: 'generation', emoji: '🎲' }, { name: 'items', emoji: '🎒' }, { name: 'enemy', emoji: '👹' },
    { name: 'balance', emoji: '⚖️' }, { name: 'meta', emoji: '🔓' }, { name: 'bug', emoji: '🐞' }, { name: 'seed', emoji: null },
  ],
  decks: [
    { title: 'Run structure', deckType: 'doc', space: 1, cards: [
      { content: 'Anatomy of a run\nHow long a run takes, how many floors, where the player chooses and where they are surprised.' },
      { content: 'What carries over between runs\nDecide what is permanent progress and what is only knowledge.' },
    ] },
    { title: 'Systems', deckType: 'task', space: 2, cards: [
      { content: 'Seeded random number source used by every system', priority: 'a', effort: 2, tags: ['seed', 'generation'] },
      { content: 'Room based floor generator with guaranteed path to the exit', priority: 'a', effort: 8, tags: ['generation'] },
      { content: 'Item pool with rarity weights and a no-duplicates rule', priority: 'b', effort: 5, tags: ['items'] },
      { content: 'Death screen, run summary and restart in one button', priority: 'b', effort: 3, tags: ['meta'] },
      { content: 'Log every run to a file so balance can be reviewed', priority: 'c', effort: 2, tags: ['balance'] },
    ] },
    { title: 'Content backlog', deckType: 'mixed', space: 3, cards: [
      { content: 'Ten starter items', tags: ['items'], effort: 5 },
      { content: 'Five enemies and one boss for floor one', tags: ['enemy'], effort: 8 },
    ] },
  ],
};

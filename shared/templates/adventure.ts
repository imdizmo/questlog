import type { ProjectTemplate } from './types';

export const adventure: ProjectTemplate = {
  id: 'adventure',
  name: 'Adventure',
  blurb: 'Story, places, puzzles and characters, with the script kept next to the work.',
  spaces: [
    { id: 1, name: 'Story', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Assets', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'story', emoji: '📖' }, { name: 'dialogue', emoji: '💬' }, { name: 'puzzle', emoji: '🧩' },
    { name: 'scene', emoji: '🏞️' }, { name: 'character', emoji: '🧑' }, { name: 'bug', emoji: '🐞' }, { name: 'cutscene', emoji: '🎬' },
  ],
  decks: [
    { title: 'Script and lore', deckType: 'doc', space: 1, cards: [
      { content: 'Story outline\nOne page: who wants what, what stands in the way, and how it ends. Keep it short enough to reread weekly.' },
      { content: 'Cast list\nFor each character: want, secret, and how they speak.' },
    ] },
    { title: 'Vertical slice', deckType: 'task', space: 2, cards: [
      { content: 'Point and click movement with interaction highlights', priority: 'a', effort: 5, tags: ['scene'] },
      { content: 'Dialogue system with choices and a conversation log', priority: 'a', effort: 8, tags: ['dialogue'] },
      { content: 'Inventory with combine and use-on interactions', priority: 'b', effort: 8, tags: ['puzzle'] },
      { content: 'First puzzle chain: three steps, one clear hint', priority: 'b', effort: 5, tags: ['puzzle', 'story'] },
      { content: 'Save and load between scenes', priority: 'c', effort: 3 },
    ] },
    { title: 'Scenes and characters', deckType: 'asset', space: 3, cards: [
      { content: 'Opening location background and props', tags: ['scene'], effort: 5 },
      { content: 'Main character portrait set', tags: ['character'], effort: 3 },
      { content: 'Intro cutscene storyboard', tags: ['cutscene', 'story'], effort: 3 },
    ] },
  ],
};

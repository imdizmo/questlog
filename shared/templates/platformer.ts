import type { ProjectTemplate } from './types';

export const platformer: ProjectTemplate = {
  id: 'platformer',
  name: 'Platformer',
  blurb: 'Jump feel first, then levels that teach one idea at a time.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Art and audio', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'movement', emoji: '🏃' }, { name: 'level', emoji: '🗺️' }, { name: 'enemy', emoji: '👾' },
    { name: 'collectible', emoji: '⭐' }, { name: 'bug', emoji: '🐞' }, { name: 'polish', emoji: '✨' }, { name: 'tilemap', emoji: null },
  ],
  decks: [
    { title: 'Design notes', deckType: 'doc', space: 1, cards: [
      { content: 'Movement spec\nRun speed, jump height and time to apex, coyote time and buffer window. Numbers, not adjectives.' },
      { content: 'Level teaching order\nWhich mechanic is introduced in which world, and where it is combined.' },
    ] },
    { title: 'Prototype', deckType: 'task', space: 2, cards: [
      { content: 'Character controller with variable jump height', priority: 'a', effort: 5, tags: ['movement'] },
      { content: 'Coyote time and jump buffering', priority: 'a', effort: 2, tags: ['movement'] },
      { content: 'Tilemap collision with one-way platforms and slopes', priority: 'a', effort: 8, tags: ['tilemap', 'level'] },
      { content: 'Patrol enemy that turns at ledges', priority: 'b', effort: 3, tags: ['enemy'] },
      { content: 'Checkpoints and respawn without a loading screen', priority: 'b', effort: 3, tags: ['level'] },
      { content: 'Collectible counter and a bonus room', priority: 'c', effort: 3, tags: ['collectible'] },
    ] },
    { title: 'Sprites and music', deckType: 'asset', space: 3, cards: [
      { content: 'Player run, jump and fall animation set', tags: ['movement', 'polish'], effort: 5 },
      { content: 'World one tileset', tags: ['tilemap'], effort: 5 },
    ] },
  ],
};

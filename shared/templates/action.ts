import type { ProjectTemplate } from './types';

export const action: ProjectTemplate = {
  id: 'action',
  name: 'Action',
  blurb: 'Fast combat, tight controls and a game feel you can tune every day.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Art and audio', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'combat', emoji: '⚔️' }, { name: 'feel', emoji: '✨' }, { name: 'enemy', emoji: '👹' },
    { name: 'level', emoji: '🗺️' }, { name: 'bug', emoji: '🐞' }, { name: 'polish', emoji: null }, { name: 'audio', emoji: '🔊' },
  ],
  decks: [
    { title: 'Core loop', deckType: 'doc', space: 1, cards: [
      { content: 'Combat pillars\nWrite down three sentences that say how a fight should feel: speed, risk, and what the player is rewarded for.' },
      { content: 'Control scheme\nList every action, its default binding on pad and keyboard, and its input buffer window.' },
    ] },
    { title: 'Combat prototype', deckType: 'task', space: 2, cards: [
      { content: 'Player movement with acceleration and dodge', priority: 'a', effort: 5, tags: ['combat', 'feel'] },
      { content: 'Light and heavy attack with hit stop and cancel windows', priority: 'a', effort: 8, tags: ['combat', 'feel'] },
      { content: 'First enemy: melee grunt with a telegraphed swing', priority: 'b', effort: 5, tags: ['enemy'] },
      { content: 'Greybox arena with a camera that frames the fight', priority: 'b', effort: 3, tags: ['level'] },
      { content: 'Tune hit stop, screen shake and knockback values', priority: 'c', effort: 2, tags: ['feel', 'polish'] },
    ] },
    { title: 'Effects and sound', deckType: 'asset', space: 3, cards: [
      { content: 'Slash trail and impact flash', tags: ['polish'], effort: 3 },
      { content: 'Hit, block and whoosh sounds', tags: ['audio'], effort: 2 },
    ] },
  ],
};

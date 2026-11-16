import type { ProjectTemplate } from './types';

export const rpg: ProjectTemplate = {
  id: 'rpg',
  name: 'RPG',
  blurb: 'Characters, quests, items and the systems that tie them together.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Content', icon: null, defaultDeckType: 'mixed' },
  ],
  tags: [
    { name: 'quest', emoji: '📜' }, { name: 'combat', emoji: '⚔️' }, { name: 'items', emoji: '🎒' },
    { name: 'stats', emoji: '📊' }, { name: 'dialogue', emoji: '💬' }, { name: 'world', emoji: '🌍' }, { name: 'bug', emoji: '🐞' },
  ],
  decks: [
    { title: 'World and rules', deckType: 'doc', space: 1, cards: [
      { content: 'Character stats\nWhich stats exist, what each one changes, and the formula for damage and hit chance.' },
      { content: 'World map\nRegions, factions and the order in which the player is allowed to see them.' },
    ] },
    { title: 'Core systems', deckType: 'task', space: 2, cards: [
      { content: 'Stat block and level-up curve', priority: 'a', effort: 5, tags: ['stats'] },
      { content: 'Turn order and action resolution', priority: 'a', effort: 8, tags: ['combat'] },
      { content: 'Inventory, equipment slots and item tooltips', priority: 'b', effort: 8, tags: ['items'] },
      { content: 'Quest log with objectives and a tracked quest on screen', priority: 'b', effort: 5, tags: ['quest'] },
      { content: 'Dialogue with conditions on quest state', priority: 'b', effort: 5, tags: ['dialogue', 'quest'] },
      { content: 'Save anywhere, with a version number in the file', priority: 'c', effort: 3 },
    ] },
    { title: 'First town', deckType: 'mixed', space: 3, cards: [
      { content: 'Town layout and five buildings', tags: ['world'], effort: 5 },
      { content: 'Tutorial quest: the missing shipment', tags: ['quest', 'dialogue'], effort: 3 },
    ] },
  ],
};

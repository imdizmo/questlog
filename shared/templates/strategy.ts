import type { ProjectTemplate } from './types';

export const strategy: ProjectTemplate = {
  id: 'strategy',
  name: 'Strategy',
  blurb: 'Units, resources and decisions, with a balance sheet that stays honest.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Content', icon: null, defaultDeckType: 'mixed' },
  ],
  tags: [
    { name: 'units', emoji: '🛡️' }, { name: 'economy', emoji: '💰' }, { name: 'ai', emoji: '🤖' },
    { name: 'map', emoji: '🗺️' }, { name: 'balance', emoji: '⚖️' }, { name: 'bug', emoji: '🐞' }, { name: 'multiplayer', emoji: '🌐' },
  ],
  decks: [
    { title: 'Design pillars', deckType: 'doc', space: 1, cards: [
      { content: 'Decisions that matter\nName the three choices a player makes every few minutes, and what each one costs.' },
      { content: 'Balance sheet\nOne table: cost, build time, strengths and counters of every unit and building.' },
    ] },
    { title: 'Core game', deckType: 'task', space: 2, cards: [
      { content: 'Map with fog of war and a pathfinding grid', priority: 'a', effort: 8, tags: ['map'] },
      { content: 'Unit selection, orders and formation movement', priority: 'a', effort: 8, tags: ['units'] },
      { content: 'Resource gathering and a build queue', priority: 'a', effort: 5, tags: ['economy'] },
      { content: 'Combat resolution with counters and armor', priority: 'b', effort: 5, tags: ['units', 'balance'] },
      { content: 'Opponent AI that expands, builds and attacks in waves', priority: 'b', effort: 13, tags: ['ai'] },
      { content: 'Replay file from the command stream, to catch desyncs', priority: 'c', effort: 5, tags: ['multiplayer'] },
    ] },
    { title: 'Factions', deckType: 'mixed', space: 3, cards: [
      { content: 'First faction: ten units and six buildings', tags: ['units'], effort: 13 },
      { content: 'Tutorial scenario on a small map', tags: ['map'], effort: 5 },
    ] },
  ],
};

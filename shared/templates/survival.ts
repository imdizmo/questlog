import type { ProjectTemplate } from './types';

export const survival: ProjectTemplate = {
  id: 'survival',
  name: 'Survival',
  blurb: 'Needs, crafting, building and a world that pushes back.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'World assets', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'crafting', emoji: '🔨' }, { name: 'needs', emoji: '🍖' }, { name: 'building', emoji: '🏕️' },
    { name: 'world', emoji: '🌲' }, { name: 'threat', emoji: '🐺' }, { name: 'bug', emoji: '🐞' }, { name: 'multiplayer', emoji: '🌐' },
  ],
  decks: [
    { title: 'Survival loop', deckType: 'doc', space: 1, cards: [
      { content: 'The first hour\nWhat the player does in minute one, ten and sixty, and what they are afraid of at each point.' },
      { content: 'Needs and pressure\nHunger, thirst, warmth: rates, thresholds and what happens at zero.' },
    ] },
    { title: 'Systems', deckType: 'task', space: 2, cards: [
      { content: 'Needs meters with rates that depend on weather', priority: 'a', effort: 5, tags: ['needs'] },
      { content: 'Gathering with tool tiers and respawning resources', priority: 'a', effort: 5, tags: ['crafting', 'world'] },
      { content: 'Crafting menu with recipes unlocked by discovery', priority: 'b', effort: 8, tags: ['crafting'] },
      { content: 'Base building on a grid with structural support', priority: 'b', effort: 13, tags: ['building'] },
      { content: 'Day and night cycle with creatures that come out at dusk', priority: 'b', effort: 8, tags: ['threat', 'world'] },
      { content: 'Persist the world and the player between sessions', priority: 'c', effort: 5 },
    ] },
    { title: 'Biome art', deckType: 'asset', space: 3, cards: [
      { content: 'Forest biome props and ground textures', tags: ['world'], effort: 8 },
      { content: 'Campfire and shelter pieces', tags: ['building'], effort: 3 },
    ] },
  ],
};

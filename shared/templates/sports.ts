import type { ProjectTemplate } from './types';

export const sports: ProjectTemplate = {
  id: 'sports',
  name: 'Sports',
  blurb: 'Rules of the game, athletes, matches and the feel of every touch.',
  spaces: [
    { id: 1, name: 'Design', icon: null, defaultDeckType: 'doc' },
    { id: 2, name: 'Production', icon: null, defaultDeckType: 'task' },
    { id: 3, name: 'Presentation', icon: null, defaultDeckType: 'asset' },
  ],
  tags: [
    { name: 'rules', emoji: '📏' }, { name: 'ai', emoji: '🤖' }, { name: 'controls', emoji: '🎮' },
    { name: 'animation', emoji: '🎞️' }, { name: 'online', emoji: '🌐' }, { name: 'bug', emoji: '🐞' }, { name: 'camera', emoji: '🎥' },
  ],
  decks: [
    { title: 'Match design', deckType: 'doc', space: 1, cards: [
      { content: 'Rules and scoring\nWrite the sport rules as the game will enforce them, including the odd cases such as ties and fouls.' },
      { content: 'Controls and feel\nWhat each button does at each moment of play, and how forgiving the timing is.' },
    ] },
    { title: 'Match prototype', deckType: 'task', space: 2, cards: [
      { content: 'Ball or puck physics with tuned bounce and friction', priority: 'a', effort: 5, tags: ['rules'] },
      { content: 'Athlete movement and action set', priority: 'a', effort: 8, tags: ['controls', 'animation'] },
      { content: 'Referee logic for fouls, out of bounds and scoring', priority: 'b', effort: 5, tags: ['rules'] },
      { content: 'Teammate and opponent AI with simple roles', priority: 'b', effort: 8, tags: ['ai'] },
      { content: 'Broadcast style camera that follows the play', priority: 'c', effort: 5, tags: ['camera'] },
    ] },
    { title: 'Presentation assets', deckType: 'asset', space: 3, cards: [
      { content: 'Athlete model and kit variations', tags: ['animation'], effort: 8 },
      { content: 'Scoreboard and replay overlay', tags: ['camera'], effort: 3 },
    ] },
  ],
};

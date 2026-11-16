import type { DeckType, ProjectTag, Space } from '../types';

export interface TemplateCard {
  /** Markdown; the first line is the title. */
  content: string;
  priority?: 'a' | 'b' | 'c';
  effort?: number;
  /** Project tag names (each must be one of the template's tags). */
  tags?: string[];
}
export interface TemplateDeck {
  title: string;
  deckType: DeckType;
  /** Id of one of the template's spaces. */
  space: number;
  cards: TemplateCard[];
}
/** A starter project for one game genre: sections, decks, a few cards and tags. All text is ours. */
export interface ProjectTemplate {
  id: string;
  name: string;
  blurb: string;
  spaces: Space[];
  tags: ProjectTag[];
  decks: TemplateDeck[];
}

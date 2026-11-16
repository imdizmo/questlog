import type { ProjectTemplate } from './types';
import { action } from './action';
import { adventure } from './adventure';
import { platformer } from './platformer';
import { puzzle } from './puzzle';
import { roguelike } from './roguelike';
import { rpg } from './rpg';
import { simulation } from './simulation';
import { sports } from './sports';
import { strategy } from './strategy';
import { survival } from './survival';

export type { ProjectTemplate, TemplateCard, TemplateDeck } from './types';

/** The genre templates, in the order the project wizard lists them. */
export const TEMPLATES: ProjectTemplate[] = [action, adventure, platformer, puzzle, roguelike, rpg, simulation, sports, strategy, survival];
export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const templateById = (id: string): ProjectTemplate | undefined => TEMPLATES.find((t) => t.id === id);

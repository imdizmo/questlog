import type { DeckType, Space } from '../../shared/types';

export type SpaceKind = 'GDD' | 'Tasks' | 'Knowledge' | 'QA' | 'Custom';

/** Section types offered when creating/editing a section: stored name + the deck type new decks get. */
export const SPACE_KINDS: { kind: SpaceKind; deckType: DeckType; blurb: string }[] = [
  { kind: 'GDD', deckType: 'asset', blurb: 'Design docs, features and assets' },
  { kind: 'Tasks', deckType: 'task', blurb: 'Work that gets started and finished' },
  { kind: 'Knowledge', deckType: 'doc', blurb: 'Reference pages and lore' },
  { kind: 'QA', deckType: 'task', blurb: 'Bugs and test passes' },
  { kind: 'Custom', deckType: 'mixed', blurb: 'Your own name, tasks and lore' },
];

export const DEFAULT_SECTION_LABEL = 'General';
export const spaceLabel = (s: Pick<Space, 'name'>) => s.name ?? DEFAULT_SECTION_LABEL;

export function kindOf(s: Pick<Space, 'name'>): SpaceKind {
  return (SPACE_KINDS.find((k) => k.kind !== 'Custom' && k.kind === s.name)?.kind) ?? 'Custom';
}

export interface SpaceInput { kind: SpaceKind; customName: string }

/** Name + deck type that a chosen kind stores. An empty custom name is the unnamed section. */
export function fieldsFor(input: SpaceInput): Pick<Space, 'name' | 'defaultDeckType'> {
  const k = SPACE_KINDS.find((x) => x.kind === input.kind)!;
  const name = input.kind === 'Custom' ? (input.customName.trim() || null) : input.kind;
  return { name, defaultDeckType: k.deckType };
}

/** New sections go first and take id = max + 1. */
export function addSpace(spaces: Space[], input: SpaceInput): Space[] {
  const id = spaces.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  return [{ id, icon: null, ...fieldsFor(input) }, ...spaces];
}

export const updateSpace = (spaces: Space[], id: number, input: SpaceInput): Space[] =>
  spaces.map((s) => (s.id === id ? { ...s, ...fieldsFor(input) } : s));

export const removeSpace = (spaces: Space[], id: number): Space[] => spaces.filter((s) => s.id !== id);

/** Moves the section `id` to index `to` (clamped). */
export function moveSpace(spaces: Space[], id: number, to: number): Space[] {
  const from = spaces.findIndex((s) => s.id === id);
  if (from < 0) return spaces;
  const out = spaces.slice();
  const [s] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, s);
  return out;
}

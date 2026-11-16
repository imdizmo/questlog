// The editable game starter pack of the Wiki: entry types and link kinds any game can use (spec "Starter pack").
// Data only; server/commands/wiki.ts (wiki/addStarterPack) adds it to a campaign, skipping keys that already exist.
// Order matters: a parent type comes before its children, and a type before any field that targets it.
import type { FieldDef } from '../types';

export interface StarterType {
  key: string; name: string; icon: string;
  /** Key of the parent type. */
  parent?: string;
  /** Own fields; a child type inherits its parent's (description and icon included). */
  fields: FieldDef[];
  /** Headings a new page of the type starts with; child types add theirs after the parent's. */
  sections?: string[];
  /** Part of the small set a new wiki starts with; the rest is the RPG extras. */
  core?: boolean;
}
export interface StarterKind {
  key: string; label: string; reverseLabel: string;
  /** Type keys; [] = any. */
  fromTypes: string[]; toTypes: string[];
  props: FieldDef[];
  sumRule?: { prop: string; max: number };
  core?: boolean;
}

const description: FieldDef = { key: 'description', label: 'Description', kind: 'longtext', inInfobox: false };
const icon: FieldDef = { key: 'icon', label: 'Icon', kind: 'image' };
/** Every root type starts with these; child types inherit them. */
const common = [description, icon];

const int = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'integer', min: 0, ...extra });
const num = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'number', min: 0, ...extra });
const enm = (key: string, label: string, options: string[], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'enum', options, ...extra });
const bool = (key: string, label: string): FieldDef => ({ key, label, kind: 'boolean' });
const text = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'text', ...extra });
const ref = (key: string, label: string, target: string): FieldDef => ({ key, label, kind: 'entry', target });
const level = int('level', 'Level', { min: 1, inTable: true });
const difficulty = enm('difficulty', 'Difficulty', ['easy', 'normal', 'hard', 'elite'], { inTable: true });

export const STARTER_TYPES: StarterType[] = [
  { key: 'item', name: 'Item', icon: '🎒', core: true, fields: [...common,
    enm('rarity', 'Rarity', ['common', 'uncommon', 'rare', 'epic', 'legendary'], { inTable: true }),
    level, int('value', 'Value', { inTable: true }), int('stack_size', 'Stack size', { min: 1 })] },
  { key: 'weapon', name: 'Weapon', icon: '⚔️', parent: 'item', fields: [
    { key: 'damage', label: 'Damage', kind: 'range', min: 0, inTable: true }, num('speed', 'Speed', { inTable: true }),
    enm('slot', 'Slot', ['main_hand', 'off_hand', 'two_hands', 'ranged'], { inTable: true })] },
  { key: 'armor', name: 'Armor', icon: '🛡️', parent: 'item', fields: [
    int('armor', 'Armor', { inTable: true }),
    enm('slot', 'Slot', ['head', 'shoulders', 'chest', 'hands', 'waist', 'legs', 'feet', 'back', 'neck', 'ring'], { inTable: true })] },
  { key: 'consumable', name: 'Consumable', icon: '🧪', parent: 'item', fields: [
    num('cooldown', 'Cooldown', { unit: 's' }), num('duration', 'Duration', { unit: 's' }), int('charges', 'Charges', { min: 1 })] },
  { key: 'material', name: 'Material', icon: '🪵', parent: 'item', fields: [int('tier', 'Tier', { min: 1, inTable: true })] },
  { key: 'quest_item', name: 'Quest item', icon: '📜', parent: 'item', fields: [bool('unique', 'Unique')] },
  { key: 'item_set', name: 'Item set', icon: '🧩', fields: [...common, { key: 'bonuses', label: 'Set bonuses', kind: 'longtext' }] },
  { key: 'currency', name: 'Currency', icon: '🪙', fields: [...common, int('max_amount', 'Max amount'), bool('tradable', 'Tradable')] },
  { key: 'creature', name: 'Creature', icon: '🐺', core: true, sections: ['Behaviour', 'Lore'], fields: [...common, level, int('health', 'Health', { inTable: true }),
    enm('kind', 'Kind', ['beast', 'humanoid', 'undead', 'elemental', 'construct', 'dragon', 'demon', 'critter'], { inTable: true }),
    int('xp', 'XP reward')] },
  { key: 'npc', name: 'Character', icon: '🧑', core: true, sections: ['Appearance', 'History', 'What they want', 'Voice'], fields: [...common, level,
    enm('role', 'Role', ['civilian', 'vendor', 'quest_giver', 'trainer', 'guard'], { inTable: true }), bool('friendly', 'Friendly')] },
  { key: 'faction', name: 'Faction', icon: '🏳️', core: true, sections: ['What they want', 'History', 'How they treat outsiders'], fields: [...common, enm('alignment', 'Alignment', ['friendly', 'neutral', 'hostile'], { inTable: true })] },
  { key: 'location', name: 'Place', icon: '🗺️', core: true, sections: ['Look and feel', 'History', 'Who lives here'], fields: [...common, { key: 'level_range', label: 'Level range', kind: 'range', min: 1, inTable: true }] },
  { key: 'region', name: 'Region', icon: '🏔️', parent: 'location', fields: [text('climate', 'Climate')] },
  { key: 'zone', name: 'Zone', icon: '🌲', parent: 'location', fields: [bool('pvp', 'PvP')] },
  { key: 'point_of_interest', name: 'Point of interest', icon: '📍', parent: 'location', fields: [bool('discoverable', 'Discoverable')] },
  { key: 'dungeon', name: 'Dungeon', icon: '🏰', fields: [...common, { key: 'level_range', label: 'Level range', kind: 'range', min: 1, inTable: true },
    int('players', 'Players', { min: 1, inTable: true }), difficulty] },
  { key: 'encounter', name: 'Encounter', icon: '⚡', fields: [...common, level, difficulty] },
  { key: 'resource_node', name: 'Resource node', icon: '⛏️', fields: [...common, int('skill_level', 'Skill level', { inTable: true }), num('respawn', 'Respawn', { unit: 's' })] },
  { key: 'container', name: 'Container', icon: '📦', fields: [...common, bool('locked', 'Locked'), num('respawn', 'Respawn', { unit: 's' })] },
  { key: 'shop', name: 'Shop', icon: '🏪', fields: [...common, num('restock', 'Restock', { unit: 'h' })] },
  { key: 'profession', name: 'Profession', icon: '🔨', fields: [...common, int('max_level', 'Max level', { min: 1, inTable: true })] },
  { key: 'recipe', name: 'Recipe', icon: '📖', fields: [...common, ref('profession', 'Profession', 'profession'),
    int('skill_level', 'Skill level', { inTable: true }), num('craft_time', 'Craft time', { unit: 's' })] },
  { key: 'ability', name: 'Ability', icon: '✨', fields: [...common, num('cooldown', 'Cooldown', { unit: 's', inTable: true }),
    int('cost', 'Cost', { inTable: true }), num('cast_time', 'Cast time', { unit: 's' }), num('range', 'Range', { unit: 'm' })] },
  { key: 'status_effect', name: 'Status effect', icon: '🔥', fields: [...common, enm('kind', 'Kind', ['buff', 'debuff'], { inTable: true }),
    num('duration', 'Duration', { unit: 's', inTable: true }), int('max_stacks', 'Max stacks', { min: 1 })] },
  { key: 'class', name: 'Class', icon: '🧙', fields: [...common, enm('role', 'Role', ['tank', 'healer', 'damage', 'support'], { inTable: true }),
    text('primary_stat', 'Primary stat')] },
  { key: 'race', name: 'Race', icon: '🧝', fields: [...common, bool('playable', 'Playable')] },
  { key: 'talent', name: 'Talent', icon: '🌟', fields: [...common, int('tier', 'Tier', { min: 1, inTable: true }), int('max_rank', 'Max rank', { min: 1 })] },
  { key: 'mission', name: 'Quest', icon: '❗', core: true, sections: ['What happens', 'Why it matters'], fields: [...common, level, ref('giver', 'Giver', 'npc'),
    { key: 'objectives', label: 'Objectives', kind: 'longtext', inInfobox: false }, int('xp', 'XP reward')] },
  { key: 'achievement', name: 'Achievement', icon: '🏆', fields: [...common, int('points', 'Points', { inTable: true }), bool('secret', 'Secret')] },
  { key: 'mount', name: 'Mount', icon: '🐎', fields: [...common, num('speed', 'Speed', { unit: '%', inTable: true }), bool('flying', 'Flying')] },
  { key: 'pet', name: 'Pet', icon: '🐾', fields: [...common, level, bool('battle', 'Can battle')] },
  { key: 'event', name: 'Event', icon: '🎉', fields: [...common, bool('recurring', 'Recurring'), num('duration', 'Duration', { unit: 'h' })] },
  { key: 'title', name: 'Title', icon: '🎖️', fields: [...common, text('display', 'Display text', { help: 'Use %s for the name, as in "%s the Brave".' })] },
  { key: 'stat', name: 'Stat', icon: '📊', fields: [...common, { key: 'base', label: 'Base value', kind: 'number', inTable: true }, { key: 'max_value', label: 'Max value', kind: 'number' }] },
  { key: 'level_curve', name: 'Level curve', icon: '📈', fields: [...common, int('max_level', 'Max level', { min: 1, inTable: true }),
    { key: 'xp_table', label: 'XP table', kind: 'longtext', help: 'XP needed per level, one number per line.' }] },
  { key: 'dialogue', name: 'Dialogue', icon: '💬', fields: [...common, ref('speaker', 'Speaker', 'npc'), { key: 'lines', label: 'Lines', kind: 'longtext', inInfobox: false }] },
  { key: 'history', name: 'History', icon: '⏳', core: true, sections: ['What happened', 'What it changed'], fields: [...common,
    text('era', 'Era', { inTable: true }), { key: 'year', label: 'Year', kind: 'integer', inTable: true }] },
  { key: 'storyline', name: 'Storyline', icon: '🎬', core: true, sections: ['Premise'], fields: [...common] },
  { key: 'asset', name: 'Asset', icon: '🎨', fields: [...common, text('path', 'Path', { inTable: true }), { key: 'file', label: 'File', kind: 'image' },
    enm('kind', 'Kind', ['model', 'texture', 'sprite', 'animation', 'sound', 'music', 'vfx', 'ui', 'other'], { inTable: true }),
    enm('status', 'Status', ['planned', 'in_progress', 'review', 'done'], { inTable: true })] },
];

const qty = { key: 'qty', label: 'Quantity', kind: 'range', min: 0 } as const satisfies FieldDef;
const chance = { key: 'chance', label: 'Chance', kind: 'number', min: 0, max: 100, unit: '%' } as const satisfies FieldDef;
const count = (label = 'Quantity'): FieldDef => ({ key: 'qty', label, kind: 'integer', min: 1 });

export const STARTER_KINDS: StarterKind[] = [
  { key: 'drops', label: 'drops', reverseLabel: 'dropped by', core: true, fromTypes: ['creature', 'npc', 'encounter', 'dungeon'], toTypes: ['item', 'currency'],
    props: [chance, qty] }, // each drop rolls on its own: two drops at 80% and 60% are fine
  { key: 'sells', label: 'sells', reverseLabel: 'sold by', fromTypes: ['npc', 'shop'], toTypes: ['item', 'mount', 'pet', 'recipe'],
    props: [num('price', 'Price'), ref('currency', 'Currency', 'currency'), int('stock', 'Stock', { help: 'Empty for unlimited.' })] },
  { key: 'needs', label: 'needs', reverseLabel: 'reagent for', fromTypes: ['recipe'], toTypes: ['item', 'currency'], props: [count()] },
  { key: 'makes', label: 'makes', reverseLabel: 'created by', fromTypes: ['recipe'], toTypes: ['item'], props: [count()] },
  // Not from a place: a place goes inside another one through located_in, so a place page offers one way to say it.
  { key: 'found_in', label: 'found in', reverseLabel: 'home of', core: true,
    fromTypes: ['item', 'creature', 'npc', 'faction', 'mission', 'history', 'encounter', 'resource_node', 'container', 'event'], toTypes: ['location', 'dungeon'], props: [] },
  { key: 'gathered_from', label: 'gathered from', reverseLabel: 'yields', fromTypes: ['item'], toTypes: ['resource_node', 'creature'], props: [chance, qty] },
  { key: 'contains', label: 'contains', reverseLabel: 'contained in', fromTypes: ['container'], toTypes: ['item', 'currency'], props: [chance, qty] },
  { key: 'uses', label: 'uses', reverseLabel: 'used by', fromTypes: [], toTypes: [], props: [] },
  { key: 'learns', label: 'learns', reverseLabel: 'taught by', fromTypes: ['class', 'race', 'profession', 'creature', 'npc', 'pet'], toTypes: ['ability', 'recipe', 'talent'],
    props: [int('level', 'Level', { min: 1 })] },
  { key: 'member_of', label: 'member of', reverseLabel: 'members', core: true, fromTypes: ['npc', 'creature'], toTypes: ['faction'], props: [text('rank', 'Rank')] },
  { key: 'rewards', label: 'rewards', reverseLabel: 'reward from', fromTypes: ['mission', 'achievement', 'encounter', 'dungeon', 'event'], toTypes: [], props: [count()] },
  { key: 'gives', label: 'gives', reverseLabel: 'given by', fromTypes: ['npc'], toTypes: ['mission'], props: [] },
  { key: 'part_of_set', label: 'part of set', reverseLabel: 'set pieces', fromTypes: ['item'], toTypes: ['item_set'], props: [] },
  { key: 'requires', label: 'requires', reverseLabel: 'required by', fromTypes: [], toTypes: [], props: [] },
  { key: 'criteria_of', label: 'criteria of', reverseLabel: 'has criteria', fromTypes: [], toTypes: ['achievement'], props: [] },
  { key: 'located_in', label: 'inside', reverseLabel: 'contains', core: true, fromTypes: ['location', 'dungeon', 'shop'], toTypes: ['location'], props: [] },
  { key: 'applies', label: 'applies', reverseLabel: 'applied by', fromTypes: ['ability', 'item', 'creature', 'status_effect'], toTypes: ['status_effect'],
    props: [num('duration', 'Duration', { unit: 's' }), int('stacks', 'Stacks', { min: 1 })] },
  { key: 'follows', label: 'follows', reverseLabel: 'followed by', fromTypes: ['mission'], toTypes: ['mission'], props: [] },
  { key: 'frames', label: 'shows', reverseLabel: 'shown in', core: true, fromTypes: ['storyline'], toTypes: [], props: [] },
  // Who and what takes part in a quest: what dragging an entry onto a storyboard frame records.
  { key: 'features', label: 'features', reverseLabel: 'appears in', core: true, fromTypes: ['mission'], toTypes: [], props: [] },
  { key: 'art_for', label: 'art for', reverseLabel: 'art', fromTypes: ['asset'], toTypes: [], props: [] },
];

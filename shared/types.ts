import type { BillingMode, PlanOverwrites, PlanStatus, PlanType } from './plans';
import type { Cover } from './covers';
import type { DeckView } from './order';
import type { SearchToken } from './search';
import type { GlossaryEntry, Lang } from './translate';
export type CardStatus = 'not_started' | 'started' | 'done';
export type Visibility = 'default' | 'archived' | 'deleted';
export type ResolvableContext = 'block' | 'review' | 'comment';
export type DerivedStatus = 'unassigned' | 'assigned' | 'started' | 'blocked' | 'review' | 'done' | 'snoozing';
export type DeckType = 'asset' | 'task' | 'doc' | 'mixed';
/** 'guest': an Open Decks visitor, with no workspace access and no seat (server/permissions.ts isGuest). */
export type OrgRole = 'owner' | 'admin' | 'member' | 'observer' | 'guest';
export type ProjectRole = 'producer';
export type ProjectVisibility = 'full' | 'limited';

export interface AccountSettings {
  /** Effort points on tasks. Off: progress counts tasks. */
  effortEnabled: boolean;
  effortScale: string;
  priorityLabels: { a: string; b: string; c: string };
  staleHours: number;
  autoArchiveHours: number | null;
  fallbackEffort: number;
  maxHandSlots: number;
  timelineScale: string;
  weekStart: string;
  /** ISO weekday numbers, 1 = Monday .. 7 = Sunday */
  workdays: number[];
  hideCompletedCounts: boolean;
  defaultInboxDeckId: string | null;
  coverFromAttachments: string;
  heroCoverFromSubs: boolean;
  questLevel: string;
  milestonesEnabled: boolean;
  sprintsEnabled: boolean;
  visionBoardEnabled: boolean;
  dueDateEnabled: boolean;
  dependenciesEnabled: boolean;
  workflowMode: string | null;
  timeTrackingMode: string | null;
  /** The MCP endpoint answers only while this is on. */
  mcpEnabled: boolean;
  /** Workspace-wide MCP tool calls per UTC day; null = unlimited. */
  mcpDailyLimit: number | null;
  /** A few lines about the workspace, shown at the top of the workspace menu. */
  description: string;
  /** The workspace's picture: one of the built-in artworks (shared/covers.ts COVER_ARTWORKS), or none. */
  coverArt: number | null;
  /** Card text and comments are translated between English and Italian on the server (server/translate). */
  translationEnabled: boolean;
}

export const DEFAULT_SETTINGS: AccountSettings = {
  effortEnabled: false,
  effortScale: 'fibonacci',
  priorityLabels: { a: 'High', b: 'Medium', c: 'Low' },
  staleHours: 120,
  autoArchiveHours: 48,
  fallbackEffort: 1,
  maxHandSlots: 14,
  timelineScale: 'weeks',
  weekStart: 'monday',
  workdays: [1, 2, 3, 4, 5],
  hideCompletedCounts: false,
  defaultInboxDeckId: null,
  coverFromAttachments: 'first',
  heroCoverFromSubs: true,
  questLevel: 'full',
  milestonesEnabled: true,
  sprintsEnabled: true,
  visionBoardEnabled: true,
  dueDateEnabled: false,
  dependenciesEnabled: false,
  workflowMode: null,
  timeTrackingMode: null,
  mcpEnabled: true,
  mcpDailyLimit: null,
  description: '',
  coverArt: null,
  translationEnabled: false,
};

/**
 * A machine translation of a card's text or a comment into `lang` (server/translate/queue.ts). `sourceVersion` is the
 * card's contentVersion, or textVersion(entry.content) for a comment: a row behind its source is stale. `fromLang`
 * null: nothing in the text needed translating into `lang`, and `text` is the original.
 */
export type Translation = {
  kind: 'card' | 'entry' | 'fields'; sourceId: string; lang: Lang; sourceVersion: number; fromLang: Lang | null; text: string; createdAt: number;
};

export interface Account {
  id: string;
  name: string;
  settings: AccountSettings;
  cardSeq: number;
  deckSeq: number;
  projectSeq: number;
  createdAt: number;
  /** Personal API tokens allowed (org tokens are not affected). */
  userApiTokensEnabled?: boolean;
  /** Billing (shared/plans.ts). Absent on older rows means mode 'off'. */
  billingMode?: BillingMode;
  planType?: PlanType;
  planStatus?: PlanStatus;
  trialEndsAt?: number | null;
  trialStartedAt?: number | null;
  /** A Stripe customer / subscription exists (the ids never reach clients). */
  hasCustomer?: boolean;
  hasSubscription?: boolean;
  purchasedSeats?: number;
  planOverwrites?: PlanOverwrites;
  billingCycleEnd?: number | null;
  isDisabled?: boolean;
  disabledReason?: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
  timezone: string | null;
  disabled: boolean;
  createdAt: number;
  /** 'service': the acting user of an org API token; never logs in, hidden from people lists and pickers. */
  kind?: 'person' | 'service';
  /** Tailscale login that signs this person in (servers with JT_TAILSCALE_AUTH=1); null when none. Sent with `email`. */
  tailscaleLogin?: string | null;
}

/** An API token as clients see it: never the secret or its hash. */
export interface ApiToken {
  id: string;
  kind: 'org' | 'user';
  label: string;
  /** First characters of the token (kind prefix + 4), to recognise it. */
  prefix: string;
  role: 'admin' | 'producer' | 'limited';
  access: 'read' | 'write';
  /** MCP may delete tasks, lists and milestones (personal write tokens only; off unless chosen at creation). */
  mayDelete: boolean;
  projectIds: string[];
  /** Acting user: the owner (personal token) or the service user (org token). */
  userId: string;
  creatorId: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AccountRole {
  userId: string;
  role: OrgRole;
}

export interface Space {
  id: number;
  name: string | null;
  icon: string | null;
  defaultDeckType: DeckType;
}

export interface ProjectTag {
  name: string;
  emoji: string | null;
}

export const DEFAULT_PROJECT_TAGS: ProjectTag[] = [
  { name: 'art', emoji: null },
  { name: 'audio', emoji: null },
  { name: 'bug', emoji: '🐞' },
  { name: 'code', emoji: null },
  { name: 'design', emoji: null },
  { name: 'polish', emoji: null },
  { name: 'writing', emoji: null },
];

export type Priority = 'a' | 'b' | 'c';

export interface Project {
  id: string;
  seq: number;
  name: string;
  visibility: ProjectVisibility;
  isArchived: boolean;
  spaces: Space[];
  tags: ProjectTag[];
  cover: Cover;
  createdAt: number;
  /** Words the translator keeps as written, or always renders as given per language (shared/translate.ts). */
  glossary?: GlossaryEntry[];
}

export interface ProjectAccess {
  projectId: string;
  userId: string;
  projectRole: ProjectRole | null;
}

export interface Deck {
  id: string;
  seq: number;
  projectId: string;
  spaceId: number;
  title: string;
  deckType: DeckType;
  description: string;
  sortIndex: number;
  autoTag: string | null;
  defaultCardId: string | null;
  cover: Cover;
  guardiansEnabled: boolean;
  handSyncEnabled: boolean;
  autoMilestoneId: string | null;
  /** The deck's default view; null = the built-in default. */
  preferredOrder: DeckView | null;
  /** The order Open Decks visitors get (the Order panel's "Default for visitors" star); null = the built-in default. */
  publicOrder: DeckView | null;
  creatorId: string | null;
  createdAt: number;
}

export interface Card {
  id: string;
  seq: number;
  deckId: string | null;
  creatorId: string;
  assigneeId: string | null;
  content: string;
  status: CardStatus;
  visibility: Visibility;
  isDoc: boolean;
  version: number;
  contentVersion: number;
  sortIndex: number;
  createdAt: number;
  lastUpdatedAt: number;
  /** Set by the stale-card job; cleared by the next user write. */
  snoozedAt: number | null;
  /** When the card last became done (drives auto-archive). */
  doneAt: number | null;
  priority: Priority | null;
  effort: number | null;
  dueDate: string | null;
  parentCardId: string | null;
  milestoneId: string | null;
  milestoneZoneId: string | null;
  sprintId: string | null;
  /** How many run rollovers carried this card over. */
  carryCount: number;
  /** When the card joined its current run (ms); null when it has none. */
  sprintJoinedAt: number | null;
  masterTags: string[];
  tags: string[];
  mentionedUserIds: string[];
  checkboxStats: { checked: number; total: number } | null;
  coverFileId: string | null;
  /** Wiki: the entry type this card is an entry of (null for ordinary cards and untyped lore). */
  entryTypeId: string | null;
  /** Wiki: the entry's key, unique per project. */
  entryKey: string | null;
  /** Wiki: values of the type's fields, by field key. */
  fields: Record<string, unknown>;
  /** Wiki: the entry this one is filed under (page tree). */
  wikiParentId: string | null;
  /** Wiki: other names of the entry, recognised in text like its title (shared/autolink). */
  aliases: string[];
  /** Names (entry names or aliases) this card's text does not link: "Not a link here". */
  linkIgnores: string[];
  /** Wiki: the entry's own block layout and typed blocks' data (shared/blocks); none: its type's page, at view time. */
  layout?: EntryLayout | null;
  /** Derived: some locking card is not done. */
  hasBlockingDeps?: boolean;
  /** Derived: this card locks some card that is not done. */
  isBlockingDep?: boolean;
}

export type FieldKind = 'text' | 'longtext' | 'number' | 'integer' | 'boolean' | 'enum' | 'multienum' | 'entry' | 'entries' | 'image' | 'color' | 'range'
  | 'table' | 'rule' | 'scenario';

/**
 * A `table` field's value: numbers looked up by one or two keys (shared/formula: `table(name, key[, key2])`). A key's
 * values are words (an enum field's options, always matched exactly) or numbers going up (thresholds); `field` names
 * the field the key usually comes from. Cells are row-major: `cells[i0 * keys[1].values.length + i1]`.
 */
export interface TableValue {
  keys: { field?: string; values: string[] | number[] }[];
  mode: 'exact' | 'step' | 'linear';
  cells: number[];
}
/** A role of a rule or scenario: a name used in its formulas, bound to an entry of a type (key) or a child of it. */
export interface FormulaRole { name: string; type: string }
export interface NamedFormula { name: string; formula: string }
/** A saved example of a rule: an entry (key) per role and a seed; the export runs it into a golden sample. */
export interface RuleExample { roles: Record<string, string>; seed: number }
/** A `rule` field's value: named parts (each may use the ones before) and a result, written in the formula language. */
export interface RuleValue { roles: FormulaRole[]; parts: NamedFormula[]; result: string; examples: RuleExample[] }
/**
 * A clock of a scenario: first fires `first` seconds after the start (a formula; none = at once), then every `every`
 * seconds (a formula, re-evaluated after each tick), and applies `do` to the state, in order.
 */
export interface ScenarioClock { name: string; every: string; first?: string; do: NamedFormula[] }
/** A `scenario` field's value: state with start formulas, clocks, an end condition, a time cap (s), and measures. */
export interface ScenarioValue {
  roles: FormulaRole[]; state: { name: string; start: string }[]; clocks: ScenarioClock[]; end: string; cap: number; measures: NamedFormula[];
}
export interface FieldDef {
  key: string; label: string; kind: FieldKind; required?: boolean; min?: number; max?: number; unit?: string;
  options?: string[];
  /** Type key, for entry/entries fields. */
  target?: string;
  help?: string; inTable?: boolean; inInfobox?: boolean; hidden?: boolean;
}
/** A wiki entry type (Item, Weapon, ...); fields are inherited from parentTypeId. */
export interface EntryType {
  id: string; projectId: string; key: string; name: string; icon: string | null; color: string | null;
  parentTypeId: string | null; fields: FieldDef[]; sortIndex: number;
  /** Headings a new page of this type starts with (after its ancestors'). */
  sections: string[];
  /** Starting values and links offered when making an entry of this type. */
  templates: EntryTemplate[];
  /** The family it is filed under; root types only (a kind sits in its root's family). null: "No family". */
  familyId: string | null;
  /** Its picture; null is the painted "dusk" one. */
  picture: TypePicture | null;
  /** Its template as a page of blocks (shared/blocks); none: its parent's, else one made from its headings. */
  page?: TypePage | null;
}
export type BlockKind = 'text' | 'facts' | 'model' | 'picture' | 'map' | 'lines' | 'steps' | 'table' | 'links' | 'gallery';
/**
 * A block of a template page or an entry layout. Text blocks are the entry's `## title` sections of its markdown; the
 * rest keep their data in the entry's layout. `prompt`: the grey writing prompt (text, lines, steps); `cols`: a table's
 * columns; `to`: the type key a links block points at ('' any).
 */
export interface Block { id: string; kind: BlockKind; title: string; width: 'full' | 'half'; prompt?: string; cols?: string[]; to?: string }
/** A type's template page; `version` goes up with every save, so entries made from an older one can be found. */
export interface TypePage { version: number; guided: boolean; blocks: Block[] }
/** A typed block's data in an entry, by kind: lines/steps items, table rows, an asset, assets, linked entries (card ids). */
export interface BlockData { items?: string[]; rows?: string[][]; assetId?: string; assetIds?: string[]; cardIds?: string[] }
/**
 * An entry's own layout: the blocks it was made with and their data by block id. `owner` is the type whose page it came
 * from ('' for a page made from headings), `version` that page's version: a different owner or an older version is
 * out of date.
 */
export interface EntryLayout { version: number; owner?: string; blocks: Block[]; data: Record<string, BlockData> }
/** A type's picture: painted in its family's colour with its icon, or an uploaded one (a cover of the project). */
export type TypePicture = { kind: 'painted'; style: 'dusk' | 'dawn' | 'night' | 'flat' } | { kind: 'file'; fileId: string };
/** A named, coloured fold of root entry types (Characters, Items, ...) in the Wiki's Types tree. */
export interface EntryFamily { id: string; projectId: string; name: string; color: string; sortIndex: number }
/** A type's template: field values by key, and links to entries by key. */
export interface EntryTemplate {
  name: string; fields: Record<string, unknown>;
  links: { kindKey: string; toKey: string; props: Record<string, unknown> }[];
}
/** A kind of relation between two entries (drops, crafts, ...). */
export interface LinkKind {
  id: string; projectId: string; key: string; label: string; reverseLabel: string;
  fromTypes: string[]; toTypes: string[]; props: FieldDef[];
  sumRule: { prop: string; max: number } | null;
}
export interface EntryLink {
  id: string; projectId: string; kindKey: string; fromCardId: string; toCardId: string;
  props: Record<string, unknown>; sortIndex: number;
}

/** One card step I completed (shared/quests.ts); a person only ever receives their own rows. */
export interface OnboardingStep {
  userId: string;
  step: string;
  stepInfo: Record<string, string | number | boolean | null> | null;
  completedAt: number;
}

export interface SavedSearch {
  id: string;
  userId: string;
  tokens: SearchToken[];
  forceOr: boolean;
  createdAt: number;
}

export interface CardDep {
  lockedCardId: string;
  lockingCardId: string;
}

export interface CardFile {
  id: string;
  cardId: string;
  uploaderId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

export interface UserCardTag {
  userId: string;
  cardId: string;
  tag: string;
}

export interface PresetData {
  content?: string;
  priority?: Priority | null;
  effort?: number | null;
  masterTags?: string[];
  assigneeId?: string | null;
}

export interface CardPreset {
  id: string;
  name: string;
  data: PresetData;
  createdBy: string;
  createdAt: number;
}

export interface Resolvable {
  id: string;
  cardId: string;
  context: ResolvableContext;
  creatorId: string;
  isClosed: boolean;
  closedAt: number | null;
  closedBy: string | null;
  createdAt: number;
  latestEntryAt: number | null;
}

export interface ResolvableEntry {
  id: string;
  resolvableId: string;
  authorId: string;
  content: string;
  createdAt: number;
  version: number;
  lastChangedAt: number | null;
}

export interface Reaction {
  id: string;
  entryId: string;
  userId: string;
  emoji: string;
  createdAt: number;
}

/** Per-user state of a thread. `isSnoozing` is derived client-side as snoozeUntil > now. */
export interface ResolvableNotification {
  userId: string;
  resolvableId: string;
  isParticipating: boolean;
  isMuted: boolean;
  snoozeUntil: number | null;
  remindMeOn: number | null;
  unseenEntryCount: number;
  unseenAuthors: string[];
  latestEntryId: string | null;
  latestSeenEntryId: string | null;
  createdAt: number;
  lastUpdatedAt: number;
}

export interface HandCard {
  userId: string;
  cardId: string;
  sortIndex: number;
}

export interface Bookmark {
  userId: string;
  cardId: string;
  createdAt: number;
}

export interface DonePileEntry {
  userId: string;
  cardId: string;
  doneAt: number;
}

export interface HistoryChange {
  kind:
    | 'created' | 'content' | 'title' | 'deck' | 'owner' | 'status' | 'blocked'
    | 'unblocked' | 'reviewOpened' | 'reviewClosed' | 'commentOpened' | 'commentClosed' | 'visibility' | 'doc'
    | 'priority' | 'effort' | 'tags' | 'dueDate' | 'deps' | 'parent' | 'children' | 'file' | 'snoozed' | 'unsnoozed' | 'milestone' | 'milestoneZone' | 'sprint' | 'time'
    /** A git commit that referenced the card: `to` is {sha, author, url} (server/integrations/git.ts). */
    | 'commit'
    /** Wiki: field values (`fields`: the changed keys), the entry type (`type`), the key (`key`) or the wiki parent (`parent`) changed. */
    | 'entry'
    /** Wiki: the entry's aliases (`from`/`to`: the lists). */
    | 'aliases'
    /** The names this card's text does not link (`from`/`to`: the lists). */
    | 'linkIgnores'
    /** Wiki: a typed block's data (`title`: the block's; `from`/`to`: its data, null when empty). */
    | 'block';
  from?: unknown;
  to?: unknown;
  /** 'entry' only. */
  fields?: string[];
  /** 'block' only: the block's title. */
  title?: string;
  type?: { from: string | null; to: string | null };
  key?: { from: string | null; to: string | null };
  parent?: { from: string | null; to: string | null };
  /** 'system' when a scheduled job made the change. */
  by?: 'system';
  quote?: string;
}

/** One stretch of tracked time on a card. A null duration means the timer is still running. */
export interface TimeSegment {
  id: string;
  cardId: string;
  userId: string;
  startedAt: number;
  durationInMs: number | null;
  createdAt: number;
}

export interface CardHistory {
  cardId: string;
  version: number;
  changerId: string;
  at: number;
  changes: HistoryChange[];
}

export interface Milestone {
  id: string;
  accountSeq: number;
  name: string;
  date: string | null;
  startDate: string | null;
  color: string;
  isGlobal: boolean;
  isPinned: boolean;
  createdBy: string | null;
  createdAt: number;
  /** Empty when global. Ids only: a viewer may not see every covered project. */
  projectIds: string[];
}

export interface MilestoneZone {
  id: string;
  milestoneId: string;
  name: string;
  sortIndex: number;
}

/** One project's share of a milestone on one day; a viewer sums the rows of the projects they can see. */
export interface MilestoneProgress {
  milestoneId: string;
  projectId: string;
  day: string;
  totalCount: number;
  doneCount: number;
  totalEffort: number;
  doneEffort: number;
}

export interface SprintConfig {
  id: string;
  name: string;
  runLabelTemplate: string;
  color: string;
  upcoming: number;
  durationWeeks: number;
  startDay: string;
  moveOnFinish: ('review' | 'blocked' | 'undone')[];
  isGlobal: boolean;
  endHour: number;
  endTz: string;
  createdBy: string | null;
  createdAt: number;
  isArchived: boolean;
  /** Empty when global. Ids only: a viewer may not see every covered project. */
  projectIds: string[];
}

export interface Sprint {
  id: string;
  configId: string;
  accountSeq: number;
  runNr: number;
  label: string;
  startDay: string;
  endDay: string;
  endsAt: number;
  isFinished: boolean;
}

/** One project's share of a run on one day; a config's own progress is the sum over its runs. */
export interface SprintProgress {
  sprintId: string;
  projectId: string;
  day: string;
  totalCount: number;
  doneCount: number;
  totalEffort: number;
  doneEffort: number;
}

export interface JourneyStep { title: string; assigneeId: string | null; priority: Priority | null; effort: number | null }
/** The step list of one deck (workflowMode 'journeys'); applying it turns a card into a hero with one sub card per step. */
export type BoardState = 'default' | 'read_only' | 'locked';
/** A vision board hosted by one card (the Yjs document is not part of the row). */
export interface VisionBoard { id: string; accountSeq: number; cardId: string; creatorId: string; state: BoardState; createdAt: number; updatedAt: number }
/** A saved card filter used by a board's smart node. */
/** A Smart Node's saved filter: owned by a card board's host card, or (on Home) by the project picked for it. */
export interface VisionQuery { id: string; cardId: string | null; projectId: string | null; creatorId: string; query: { type: 'filter'; tokens: SearchToken[]; forceOr: boolean }; createdAt: number }
export interface Journey { id: string; deckId: string; projectId: string; steps: JourneyStep[]; updatedAt: number }

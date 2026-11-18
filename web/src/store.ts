import { useRef, useSyncExternalStore } from 'react';
import { showToast } from './toast';
import type {
  Account, AccountRole, ApiToken, Bookmark, DonePileEntry, AccountSettings, Card, Deck, HandCard, Journey, VisionBoard, VisionQuery, Milestone, MilestoneProgress, MilestoneZone, Sprint, SprintConfig, SprintProgress, TimeSegment, OrgRole, PresetData, Project, ProjectAccess, Resolvable, ResolvableEntry, Reaction, ResolvableNotification, SavedSearch, User, OnboardingStep, EntryType, LinkKind, EntryLink,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { featureAllowed, type PlanFeature } from '../../shared/plans';

export interface CardDep { lockedCardId: string; lockingCardId: string }
export interface CardFile { id: string; cardId: string; uploaderId?: string; name: string; mime: string; size: number; createdAt?: number }
export interface UserCardTag { userId: string; cardId: string; tag: string }
export interface Preset { id: string; name: string; data: PresetData; createdBy?: string; createdAt?: number }

export interface CardSubscription { userId: string; cardId: string; createdAt?: number }
export interface DeckSubscription { userId: string; deckId: string; createdAt?: number }
export interface DeckGuardian { deckId: string; userId: string }

export interface ProjectPref { userId: string; projectId: string; visible: boolean }

export type ModelName =
  | 'account' | 'user' | 'accountRole' | 'project' | 'projectAccess' | 'projectPref'
  | 'deck' | 'card' | 'resolvable' | 'resolvableEntry' | 'reaction' | 'handCard' | 'preset' | 'userCardTag' | 'cardDep' | 'file' | 'resolvableNotification' | 'cardSubscription' | 'deckSubscription' | 'deckGuardian' | 'journey' | 'visionBoard' | 'visionQuery' | 'bookmark' | 'donePile' | 'savedSearch' | 'onboardingStep' | 'milestone' | 'milestoneZone' | 'milestoneProgress' | 'sprintConfig' | 'sprint' | 'sprintProgress' | 'timeSegment' | 'apiToken'
  | 'entryType' | 'linkKind' | 'entryLink';
/** Mirrors server/dispatch.ts. 'access' (model 'project', row {id}): our view of that project may have changed. */
export type ChangeOp = 'upsert' | 'remove' | 'access';
export interface ChangeEvent { model: ModelName; op: ChangeOp; row: any }

/** Normalised client copy of everything the server lets this user see. Collections are replaced, never mutated. */
export interface State {
  /** 'disabled': the workspace was disabled in the Danger Zone (423 / socket close 4423). */
  status: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error' | 'disabled';
  /**
   * The data is current: the push socket is up and the snapshot loaded after it (re)connected has been applied. False
   * while the socket is down and while a reload is in flight, when a 'ready' store may still hold data from before.
   */
  live: boolean;
  me: User | null;
  account: Account | null;
  users: Map<string, User>;
  accountRoles: Map<string, OrgRole>;
  projects: Map<string, Project>;
  projectAccess: Map<string, ProjectAccess>;
  projectPrefs: Map<string, ProjectPref>;
  decks: Map<string, Deck>;
  cards: Map<string, Card>;
  resolvables: Map<string, Resolvable>;
  entries: Map<string, ResolvableEntry>;
  reactions: Map<string, Reaction>;
  notifications: Map<string, ResolvableNotification>;
  handCards: Map<string, HandCard>;
  cardDeps: Map<string, CardDep>;
  files: Map<string, CardFile>;
  userCardTags: Map<string, UserCardTag>;
  presets: Map<string, Preset>;
  cardSubscriptions: Map<string, CardSubscription>;
  deckSubscriptions: Map<string, DeckSubscription>;
  deckGuardians: Map<string, DeckGuardian>;
  journeys: Map<string, Journey>;
  visionBoards: Map<string, VisionBoard>;
  visionQueries: Map<string, VisionQuery>;
  bookmarks: Map<string, Bookmark>;
  donePile: Map<string, DonePileEntry>;
  savedSearches: Map<string, SavedSearch>;
  /** Card steps I completed, by step key. */
  onboarding: Map<string, OnboardingStep>;
  milestones: Map<string, Milestone>;
  milestoneZones: Map<string, MilestoneZone>;
  milestoneProgress: Map<string, MilestoneProgress>;
  sprintConfigs: Map<string, SprintConfig>;
  sprints: Map<string, Sprint>;
  sprintProgress: Map<string, SprintProgress>;
  timeSegments: Map<string, TimeSegment>;
  /** API tokens I may manage (admins: all; members: their own). Never a secret or hash. */
  apiTokens: Map<string, ApiToken>;
  /** Wiki: entry types, link kinds and links of visible projects (`entries` above are thread messages). */
  entryTypes: Map<string, EntryType>;
  linkKinds: Map<string, LinkKind>;
  entryLinks: Map<string, EntryLink>;
}

/** People: users without the service users behind org API tokens (member lists and pickers). */
export const people = (users: Map<string, User>): User[] => [...users.values()].filter((u) => u.kind !== 'service');

type Coll = Exclude<keyof State, 'status' | 'live' | 'me' | 'account'>;

/** model → collection + key function. Remove events carry at least the key fields. */
const MODELS: Record<Exclude<ModelName, 'account'>, { coll: Coll; key: (r: any) => string }> = {
  user: { coll: 'users', key: (r) => r.id },
  accountRole: { coll: 'accountRoles', key: (r) => r.userId },
  project: { coll: 'projects', key: (r) => r.id },
  projectAccess: { coll: 'projectAccess', key: (r) => `${r.projectId}|${r.userId}` },
  projectPref: { coll: 'projectPrefs', key: (r) => r.projectId },
  deck: { coll: 'decks', key: (r) => r.id },
  card: { coll: 'cards', key: (r) => r.id },
  resolvable: { coll: 'resolvables', key: (r) => r.id },
  resolvableEntry: { coll: 'entries', key: (r) => r.id },
  reaction: { coll: 'reactions', key: (r) => r.id },
  resolvableNotification: { coll: 'notifications', key: (r) => `${r.userId}|${r.resolvableId}` },
  handCard: { coll: 'handCards', key: (r) => `${r.userId}|${r.cardId}` },
  cardDep: { coll: 'cardDeps', key: (r) => `${r.lockedCardId}|${r.lockingCardId}` },
  file: { coll: 'files', key: (r) => r.id },
  userCardTag: { coll: 'userCardTags', key: (r) => `${r.userId}|${r.cardId}|${r.tag}` },
  preset: { coll: 'presets', key: (r) => r.id },
  cardSubscription: { coll: 'cardSubscriptions', key: (r) => `${r.userId}|${r.cardId}` },
  deckSubscription: { coll: 'deckSubscriptions', key: (r) => `${r.userId}|${r.deckId}` },
  deckGuardian: { coll: 'deckGuardians', key: (r) => `${r.deckId}|${r.userId}` },
  journey: { coll: 'journeys', key: (r) => r.deckId },
  visionBoard: { coll: 'visionBoards', key: (r) => r.id },
  visionQuery: { coll: 'visionQueries', key: (r) => r.id },
  bookmark: { coll: 'bookmarks', key: (r) => `${r.userId}|${r.cardId}` },
  donePile: { coll: 'donePile', key: (r) => `${r.userId}|${r.cardId}` },
  savedSearch: { coll: 'savedSearches', key: (r) => r.id },
  onboardingStep: { coll: 'onboarding', key: (r) => r.step },
  milestone: { coll: 'milestones', key: (r) => r.id },
  milestoneZone: { coll: 'milestoneZones', key: (r) => r.id },
  milestoneProgress: { coll: 'milestoneProgress', key: (r) => `${r.milestoneId}|${r.projectId}|${r.day}` },
  sprintConfig: { coll: 'sprintConfigs', key: (r) => r.id },
  sprint: { coll: 'sprints', key: (r) => r.id },
  sprintProgress: { coll: 'sprintProgress', key: (r) => `${r.sprintId}|${r.projectId}|${r.day}` },
  timeSegment: { coll: 'timeSegments', key: (r) => r.id },
  apiToken: { coll: 'apiTokens', key: (r) => r.id },
  entryType: { coll: 'entryTypes', key: (r) => r.id },
  linkKind: { coll: 'linkKinds', key: (r) => r.id },
  entryLink: { coll: 'entryLinks', key: (r) => r.id },
};

const empty = (): State => ({
  status: 'idle', live: false, me: null, account: null,
  users: new Map(), accountRoles: new Map(), projects: new Map(), projectAccess: new Map(), projectPrefs: new Map(),
  decks: new Map(), cards: new Map(), resolvables: new Map(), entries: new Map(), reactions: new Map(), notifications: new Map(), handCards: new Map(),
  cardDeps: new Map(), files: new Map(), userCardTags: new Map(), presets: new Map(),
  cardSubscriptions: new Map(), deckSubscriptions: new Map(), deckGuardians: new Map(), journeys: new Map(), visionBoards: new Map(), visionQueries: new Map(), bookmarks: new Map(), donePile: new Map(), savedSearches: new Map(), onboarding: new Map(),
  milestones: new Map(), milestoneZones: new Map(), milestoneProgress: new Map(),
  sprintConfigs: new Map(), sprints: new Map(), sprintProgress: new Map(), timeSegments: new Map(), apiTokens: new Map(),
  entryTypes: new Map(), linkKinds: new Map(), entryLinks: new Map(),
});

const byKey = <T>(rows: T[] | undefined, key: (r: T) => string) => new Map((rows ?? []).map((r) => [key(r), r]));

/** Rows the snapshot leaves out must leave the store too, so an upsert can turn into a removal. */
function dropOnUpsert(model: ModelName, row: any): boolean {
  if (model === 'card') return row.visibility === 'deleted';
  if (model === 'resolvable') return !!row.isClosed;
  return false;
}

const keep = <K, V>(m: Map<K, V>, ok: (v: V) => boolean) => new Map([...m].filter(([, v]) => ok(v)));

/** Entries, reactions and notification rows of the given threads, dropped. */
function threadParts(s: State, resIds: Set<string>): Partial<State> {
  if (!resIds.size) return {};
  const entryIds = new Set([...s.entries.values()].filter((e) => resIds.has(e.resolvableId)).map((e) => e.id));
  return {
    entries: keep(s.entries, (e) => !resIds.has(e.resolvableId)),
    reactions: keep(s.reactions, (x) => !entryIds.has(x.entryId)),
    notifications: keep(s.notifications, (n) => !resIds.has(n.resolvableId)),
  };
}

/** The collections hanging off a set of cards: threads (entries, reactions, my notification rows), deps (either end), files and personal tags. */
function cardDependents(s: State, cardIds: Set<string>): Partial<State> {
  const resIds = new Set([...s.resolvables.values()].filter((r) => cardIds.has(r.cardId)).map((r) => r.id));
  return {
    ...threadParts(s, resIds),
    resolvables: keep(s.resolvables, (r) => !resIds.has(r.id)),
    cardDeps: keep(s.cardDeps, (d) => !cardIds.has(d.lockedCardId) && !cardIds.has(d.lockingCardId)),
    files: keep(s.files, (f) => !cardIds.has(f.cardId)),
    userCardTags: keep(s.userCardTags, (t) => !cardIds.has(t.cardId)),
    timeSegments: keep(s.timeSegments, (t) => !cardIds.has(t.cardId)),
    // A host card that is gone or deleted hides its board and saved queries (restoring re-sends them).
    visionBoards: keep(s.visionBoards, (b) => !cardIds.has(b.cardId)),
    visionQueries: keep(s.visionQueries, (q) => !cardIds.has(q.cardId)),
    // The snapshot sends links only between cards we see.
    entryLinks: keep(s.entryLinks, (l) => !cardIds.has(l.fromCardId) && !cardIds.has(l.toCardId)),
  };
}

/** Collections without the given projects' decks, cards, threads, hand slots, deps, files, personal tags, access rows and prefs. */
export function cascadeProjectRemove(s: State, projectIds: Set<string>): Partial<State> {
  const deckIds = new Set([...s.decks.values()].filter((d) => projectIds.has(d.projectId)).map((d) => d.id));
  const cardIds = new Set([...s.cards.values()].filter((c) => c.deckId !== null && deckIds.has(c.deckId)).map((c) => c.id));
  const resIds = new Set([...s.resolvables.values()].filter((r) => cardIds.has(r.cardId)).map((r) => r.id));
  // The server drops non-global milestones and run configs that only covered these projects; the remove events can't be routed any more.
  const lost = (x: { isGlobal: boolean; projectIds: string[] }) => !x.isGlobal && x.projectIds.length > 0 && x.projectIds.every((p) => projectIds.has(p));
  const msIds = new Set([...s.milestones.values()].filter(lost).map((m) => m.id));
  const cfgIds = new Set([...s.sprintConfigs.values()].filter(lost).map((c) => c.id));
  const spIds = new Set([...s.sprints.values()].filter((r) => cfgIds.has(r.configId)).map((r) => r.id));
  return {
    milestones: keep(s.milestones, (m) => !msIds.has(m.id)),
    milestoneZones: keep(s.milestoneZones, (z) => !msIds.has(z.milestoneId)),
    milestoneProgress: keep(s.milestoneProgress, (p) => !msIds.has(p.milestoneId)),
    sprintConfigs: keep(s.sprintConfigs, (c) => !cfgIds.has(c.id)),
    sprints: keep(s.sprints, (r) => !spIds.has(r.id)),
    sprintProgress: keep(s.sprintProgress, (p) => !spIds.has(p.sprintId)),
    decks: keep(s.decks, (d) => !deckIds.has(d.id)),
    journeys: keep(s.journeys, (j) => !deckIds.has(j.deckId)),
    cards: keep(s.cards, (c) => !cardIds.has(c.id)),
    resolvables: keep(s.resolvables, (r) => !resIds.has(r.id)),
    entries: keep(s.entries, (e) => !resIds.has(e.resolvableId)),
    reactions: keep(s.reactions, (x) => { const e = s.entries.get(x.entryId); return !e || !resIds.has(e.resolvableId); }),
    notifications: keep(s.notifications, (n) => !resIds.has(n.resolvableId)),
    handCards: keep(s.handCards, (h) => !cardIds.has(h.cardId)),
    ...cardDependents(s, cardIds),
    projectAccess: keep(s.projectAccess, (a) => !projectIds.has(a.projectId)),
    projectPrefs: keep(s.projectPrefs, (p) => !projectIds.has(p.projectId)),
    entryTypes: keep(s.entryTypes, (t) => !projectIds.has(t.projectId)),
    linkKinds: keep(s.linkKinds, (k) => !projectIds.has(k.projectId)),
    entryLinks: keep(s.entryLinks, (l) => !projectIds.has(l.projectId) && !cardIds.has(l.fromCardId) && !cardIds.has(l.toCardId)),
  };
}

const RELOAD_RETRY_MIN = 1000;
const RELOAD_RETRY_MAX = 30_000;

export class Store {
  private state: State = empty();
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  /** Events received while a snapshot load is in flight; re-applied on top of whatever the load leaves. */
  private queued: ChangeEvent[] | null = null;
  private stopped = true;
  private reloadWarned = false;
  /** The push socket has said hello (uuid) and not closed since: a snapshot loaded now is current. */
  private connected = false;
  /**
   * Bumped on every hello and every close of the push socket: a load started under an older generation may hold data
   * from before the reconnect, so it never sets `live` (a new load is started instead).
   */
  private gen = 0;
  /** A failed reload while the socket is up is retried after this long (doubling up to RELOAD_RETRY_MAX). */
  private reloadRetryMs = RELOAD_RETRY_MIN;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  get = (): State => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private set(next: State) {
    this.state = next;
    for (const fn of [...this.listeners]) fn();
  }

  /** Fetches the snapshot and replaces the whole state. Concurrent calls share one request. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.state.status !== 'ready') this.set({ ...this.state, status: 'loading', live: false });
    else if (this.state.live) this.set({ ...this.state, live: false });
    this.queued = [];
    this.clearReloadRetry();
    const gen = this.gen;
    this.loading = (async () => {
      try {
        const res = await fetch('/api/snapshot', { credentials: 'same-origin' });
        if (res.status === 401) { this.reset('unauthenticated'); return; }
        if (res.status === 423) { this.reset('disabled'); return; }
        if (!res.ok) { this.loadFailed(gen); return; }
        const s = await res.json();
        this.reloadWarned = false;
        this.reloadRetryMs = RELOAD_RETRY_MIN;
        // Started before the socket reconnected: the data may predate the reconnect, so it is not live; load again.
        this.set({
          status: 'ready',
          live: this.connected && gen === this.gen,
          me: s.me,
          account: s.account ?? null,
          users: byKey<User>(s.users, MODELS.user.key),
          accountRoles: new Map((s.accountRoles ?? []).map((r: AccountRole) => [r.userId, r.role])),
          projects: byKey<Project>(s.projects, MODELS.project.key),
          projectAccess: byKey<ProjectAccess>(s.projectAccess, MODELS.projectAccess.key),
          projectPrefs: byKey<ProjectPref>(s.projectPrefs, MODELS.projectPref.key),
          decks: byKey<Deck>(s.decks, MODELS.deck.key),
          cards: byKey<Card>(s.cards, MODELS.card.key),
          resolvables: byKey<Resolvable>(s.resolvables, MODELS.resolvable.key),
          entries: byKey<ResolvableEntry>(s.entries, MODELS.resolvableEntry.key),
          reactions: byKey<Reaction>(s.reactions, MODELS.reaction.key),
          notifications: byKey<ResolvableNotification>(s.notifications, MODELS.resolvableNotification.key),
          handCards: byKey<HandCard>(s.handCards, MODELS.handCard.key),
          cardDeps: byKey<CardDep>(s.cardDeps, MODELS.cardDep.key),
          files: byKey<CardFile>(s.files, MODELS.file.key),
          userCardTags: byKey<UserCardTag>(s.userCardTags, MODELS.userCardTag.key),
          presets: byKey<Preset>(s.presets, MODELS.preset.key),
          cardSubscriptions: byKey<CardSubscription>(s.cardSubscriptions, MODELS.cardSubscription.key),
          deckSubscriptions: byKey<DeckSubscription>(s.deckSubscriptions, MODELS.deckSubscription.key),
          deckGuardians: byKey<DeckGuardian>(s.deckGuardians, MODELS.deckGuardian.key),
          journeys: byKey<Journey>(s.journeys, MODELS.journey.key),
          visionBoards: byKey<VisionBoard>(s.visionBoards, MODELS.visionBoard.key),
          visionQueries: byKey<VisionQuery>(s.visionQueries, MODELS.visionQuery.key),
          bookmarks: byKey<Bookmark>(s.bookmarks, MODELS.bookmark.key),
          donePile: byKey<DonePileEntry>(s.donePile, MODELS.donePile.key),
          savedSearches: byKey<SavedSearch>(s.savedSearches, MODELS.savedSearch.key),
          onboarding: byKey<OnboardingStep>(s.onboarding, MODELS.onboardingStep.key),
          milestones: byKey<Milestone>(s.milestones, MODELS.milestone.key),
          milestoneZones: byKey<MilestoneZone>(s.milestoneZones, MODELS.milestoneZone.key),
          milestoneProgress: byKey<MilestoneProgress>(s.milestoneProgress, MODELS.milestoneProgress.key),
          sprintConfigs: byKey<SprintConfig>(s.sprintConfigs, MODELS.sprintConfig.key),
          sprints: byKey<Sprint>(s.sprints, MODELS.sprint.key),
          sprintProgress: byKey<SprintProgress>(s.sprintProgress, MODELS.sprintProgress.key),
          timeSegments: byKey<TimeSegment>(s.timeSegments, MODELS.timeSegment.key),
          apiTokens: byKey<ApiToken>(s.apiTokens, MODELS.apiToken.key),
          entryTypes: byKey<EntryType>(s.entryTypes, MODELS.entryType.key),
          linkKinds: byKey<LinkKind>(s.linkKinds, MODELS.linkKind.key),
          entryLinks: byKey<EntryLink>(s.entryLinks, MODELS.entryLink.key),
        });
      } catch {
        this.loadFailed(gen);
      } finally {
        this.loading = null;
        const q = this.queued;
        this.queued = null;
        // Signed out: the queue is moot. Otherwise replay; it may itself ask for another reload.
        if (q?.length && this.state.status !== 'unauthenticated') this.apply(q);
        // Started before the socket (re)connected (failed or not): this connection gets a load of its own.
        if (gen !== this.gen && this.connected && !this.loading && !this.stopped) void this.load();
      }
    })();
    return this.loading;
  }

  private clearReloadRetry() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  /**
   * Only the first load may show the error screen. A failed reload keeps the data we have (warning once) and, while the
   * socket is still up, is tried again with backoff (1 s, 2 s, 4 s, … up to 30 s) until it succeeds or the socket
   * closes; after a close, the next reconnect loads again.
   */
  private loadFailed(gen: number) {
    if (this.state.status !== 'ready') { this.set({ ...this.state, status: 'error' }); return; }
    if (!this.reloadWarned) showToast("Couldn't refresh your workspace. Retrying when the connection comes back.");
    this.reloadWarned = true;
    if (!this.connected || this.stopped) return;
    const wait = this.reloadRetryMs;
    this.reloadRetryMs = Math.min(this.reloadRetryMs * 2, RELOAD_RETRY_MAX);
    this.clearReloadRetry();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      // Only while the same connection is up: a reconnect starts its own load.
      if (this.connected && !this.stopped && gen === this.gen) void this.load();
    }, wait);
  }

  apply(events: ChangeEvent[]): void {
    if (!events.length) return;
    // A snapshot is on its way: applying now would be overwritten by it, so hold the events until it lands.
    if (this.queued) { this.queued.push(...events); return; }
    const next: State = { ...this.state };
    const touched = new Set<Coll>();
    let reload = false;
    const meId = this.state.me?.id;
    for (const ev of events) {
      if (ev.model === 'account') {
        if (ev.op === 'upsert') next.account = { ...(next.account ?? {}), ...ev.row } as Account;
        continue;
      }
      // Our view of a project changed (visibility): only the snapshot knows what we may see now.
      if (ev.op === 'access') { reload = true; continue; }
      const m = (MODELS as Partial<Record<ModelName, { coll: Coll; key: (r: any) => string }>>)[ev.model];
      if (!m) continue;
      // Rows for a project (or deck) we don't know mean we missed a visibility change.
      if (ev.op === 'upsert' && ev.model === 'deck' && !next.projects.has(ev.row.projectId)) reload = true;
      if (ev.op === 'upsert' && ev.model === 'card' && ev.row.deckId && !dropOnUpsert('card', ev.row)
        && !next.decks.has(ev.row.deckId)) reload = true;
      // Access changes for me can add or hide whole projects: the snapshot is the source of truth.
      if ((ev.model === 'projectAccess' || ev.model === 'accountRole') && ev.row.userId === meId) reload = true;
      if (!touched.has(m.coll)) {
        (next as any)[m.coll] = new Map((next as any)[m.coll]);
        touched.add(m.coll);
      }
      const map = (next as any)[m.coll] as Map<string, unknown>;
      const k = m.key(ev.row);
      if (ev.op === 'remove' || dropOnUpsert(ev.model, ev.row)) map.delete(k);
      else if (ev.model === 'accountRole') map.set(k, ev.row.role);
      else map.set(k, { ...(map.get(k) as object | undefined), ...ev.row });
      if (ev.model === 'user' && ev.row.id === meId && ev.op === 'upsert') next.me = { ...next.me!, ...ev.row };
    }
    // Removing a project drops everything that hung off it. The server can't send those removes:
    // once the project is gone nobody passes the visibility check for it any more.
    const gone = new Set(events.filter((e) => e.model === 'project' && e.op === 'remove').map((e) => e.row.id as string));
    // A card that ends the batch removed or deleted takes its deps, files and personal tags along, like the
    // snapshot (which leaves them out). Last event wins: a move sends remove + upsert, and the card stays.
    const cardEnd = new Map<string, boolean>();
    for (const e of events) if (e.model === 'card' && e.op !== 'access') cardEnd.set(e.row.id, e.op === 'remove' || dropOnUpsert('card', e.row));
    const goneCards = new Set([...cardEnd].filter(([, g]) => g).map(([id]) => id));
    if (goneCards.size) Object.assign(next, cardDependents(next, goneCards));
    // A thread that ends the batch closed keeps its messages out of the open-thread collections;
    // closed threads are fetched on demand ("Show closed").
    const closedEnd = new Map<string, boolean>();
    for (const e of events) if (e.model === 'resolvable' && e.op !== 'access') closedEnd.set(e.row.id, e.op === 'remove' || !!e.row.isClosed);
    const closedIds = new Set([...closedEnd].filter(([, c]) => c).map(([id]) => id));
    if (closedIds.size) {
      const { notifications: _keepRows, ...parts } = threadParts(next, closedIds);
      Object.assign(next, parts);
    }
    if (gone.size) Object.assign(next, cascadeProjectRemove(next, gone));
    // A removed deck takes its journey along (the server can't route that remove once the deck is gone).
    const goneDecks = new Set(events.filter((e) => e.model === 'deck' && e.op === 'remove').map((e) => e.row.id as string));
    if (goneDecks.size) next.journeys = keep(next.journeys, (j) => !goneDecks.has(j.deckId));
    // A removed milestone takes its zones and progress rows along (the server can't route those once it is gone).
    const goneMs = new Set(events.filter((e) => e.model === 'milestone' && e.op === 'remove').map((e) => e.row.id as string));
    for (const e of events) if (e.model === 'milestone' && e.op === 'upsert') goneMs.delete(e.row.id);
    // The server sends no per-card events for bulk milestone changes; the same rules are applied here.
    const goneZones = new Set(events.filter((e) => e.model === 'milestoneZone' && e.op === 'remove').map((e) => e.row.id as string));
    for (const e of events) if (e.model === 'milestoneZone' && e.op === 'upsert') goneZones.delete(e.row.id);
    // A milestone that is not global and now lists other projects lets go of cards in the unlisted ones.
    const scoped = new Map<string, Set<string>>();
    for (const e of events) {
      if (e.model !== 'milestone') continue;
      if (e.op === 'upsert' && !e.row.isGlobal) scoped.set(e.row.id, new Set(e.row.projectIds as string[]));
      else scoped.delete(e.row.id);
    }
    if (goneMs.size) {
      next.milestoneZones = keep(next.milestoneZones, (z) => !goneMs.has(z.milestoneId));
      next.milestoneProgress = keep(next.milestoneProgress, (p) => !goneMs.has(p.milestoneId));
    }
    if (goneMs.size || goneZones.size || scoped.size) {
      let changed = false;
      const cards = new Map(next.cards);
      for (const [id, c] of cards) {
        let patch: Partial<Card> | null = null;
        const ms = c.milestoneId;
        const projectId = c.deckId ? next.decks.get(c.deckId)?.projectId : undefined;
        if (ms && (goneMs.has(ms) || (scoped.has(ms) && (!projectId || !scoped.get(ms)!.has(projectId))))) patch = { milestoneId: null, milestoneZoneId: null };
        else if (c.milestoneZoneId && goneZones.has(c.milestoneZoneId)) patch = { milestoneZoneId: null };
        if (patch) { cards.set(id, { ...c, ...patch }); changed = true; }
      }
      if (changed) next.cards = cards;
    }
    // Runs: a config that went away (or shrank to other projects) takes its runs and progress along, and cards let go.
    const goneCfg = new Set(events.filter((e) => e.model === 'sprintConfig' && e.op === 'remove').map((e) => e.row.id as string));
    for (const e of events) if (e.model === 'sprintConfig' && e.op === 'upsert') goneCfg.delete(e.row.id);
    const cfgScoped = new Map<string, Set<string>>();
    for (const e of events) {
      if (e.model !== 'sprintConfig') continue;
      if (e.op === 'upsert' && !e.row.isGlobal) cfgScoped.set(e.row.id, new Set(e.row.projectIds as string[]));
      else cfgScoped.delete(e.row.id);
    }
    if (goneCfg.size || cfgScoped.size) {
      const goneSprints = new Set([...next.sprints.values()].filter((sp) => goneCfg.has(sp.configId)).map((sp) => sp.id));
      if (goneSprints.size) {
        next.sprints = keep(next.sprints, (sp) => !goneSprints.has(sp.id));
        next.sprintProgress = keep(next.sprintProgress, (p) => !goneSprints.has(p.sprintId));
      }
      let changed = false;
      const cards = new Map(next.cards);
      for (const [id, c] of cards) {
        if (!c.sprintId) continue;
        const cfgId = next.sprints.get(c.sprintId)?.configId;
        const projectId = c.deckId ? next.decks.get(c.deckId)?.projectId : undefined;
        if (goneSprints.has(c.sprintId) || (cfgId && cfgScoped.has(cfgId) && (!projectId || !cfgScoped.get(cfgId)!.has(projectId)))) {
          cards.set(id, { ...c, sprintId: null });
          changed = true;
        }
      }
      if (changed) next.cards = cards;
    }
    this.set(next);
    if (reload) void this.load();
  }

  /** Opens the live socket. The snapshot is (re)loaded after every successful connect. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Until the first snapshot arrives we are signing in, not signed out.
    if (this.state.status !== 'ready') this.set({ ...this.state, status: 'loading' });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const s = this.socket;
    this.socket = null;
    this.connected = false;
    this.gen++;
    this.clearReloadRetry();
    s?.close();
    if (this.state.live) this.set({ ...this.state, live: false });
  }

  private async checkDisabled(): Promise<void> {
    try {
      const r = await fetch('/api/status', { credentials: 'same-origin' });
      if (r.ok && (await r.json())?.disabled === true && !this.stopped) this.reset('disabled');
    } catch { /* offline: keep retrying */ }
  }

  /** Logged out or session gone: forget everything. */
  reset(status: State['status'] = 'unauthenticated'): void {
    this.stop();
    if (this.queued) this.queued = [];
    this.set({ ...empty(), status });
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/push`);
    this.socket = ws;
    ws.onmessage = (msg) => {
      let data: any;
      try { data = JSON.parse(String(msg.data)); } catch { return; }
      if (data?.type === 'uuid') {
        this.retryMs = 500;
        this.connected = true;
        this.gen++;
        this.reloadRetryMs = RELOAD_RETRY_MIN;
        void this.load();
      } else if (data?.type === 'events' && Array.isArray(data.events)) {
        this.apply(data.events);
      }
    };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.connected = false;
      this.gen++;
      this.clearReloadRetry();
      if (this.state.live) this.set({ ...this.state, live: false });
      if (ev.code === 4401) { this.reset('unauthenticated'); return; }
      if (ev.code === 4423) { this.reset('disabled'); return; }
      if (this.stopped) return;
      // A refused upgrade gives no code of its own: a disabled workspace would otherwise be retried forever.
      void this.checkDisabled();
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.stopped) this.connect(); }, wait);
    };
  }
}

export const store = new Store();

/** Subscribes a component to a slice of the store. `select` may be an inline function. */
export function useStore<T>(select: (s: State) => T): T {
  const cache = useRef<{ s: State; f: (s: State) => T; v: T } | null>(null);
  const get = () => {
    const s = store.get();
    const c = cache.current;
    if (c && c.s === s && c.f === select) return c.v;
    const v = select(s);
    cache.current = { s, f: select, v };
    return v;
  };
  return useSyncExternalStore(store.subscribe, get);
}

// ---- derived helpers shared by views ----

/** Workspace settings with defaults filled in (an older account row may lack newer keys). */
export const settingsOf = (s: State): AccountSettings => ({ ...DEFAULT_SETTINGS, ...s.account?.settings });
/** Whether the workspace uses effort points (a switch under Workspace settings, off by default). */
export const useEffortOn = (): boolean => useStore((s) => settingsOf(s).effortEnabled);
/** Whether the workspace's plan includes a feature (always, while billing is off). Without it, existing values show read-only. */
export const planAllows = (s: State, feature: PlanFeature): boolean => featureAllowed(s.account ?? {}, feature);
/** My personal tags on one card, in the order they were added. */
export const myCardTags = (s: State, cardId: string): string[] =>
  [...s.userCardTags.values()].filter((t) => t.cardId === cardId && t.userId === s.me?.id).map((t) => t.tag);

export const roleOf = (s: State, userId: string | undefined): OrgRole | null =>
  (userId && s.accountRoles.get(userId)) || null;
export const isAdmin = (s: State) => {
  const r = roleOf(s, s.me?.id);
  return r === 'owner' || r === 'admin';
};
/** Mirrors server/permissions.ts so we only offer what will be accepted. */
export function canManageProject(s: State, p: Project): boolean {
  if (isAdmin(s)) return true;
  return roleOf(s, s.me?.id) === 'member' && s.projectAccess.get(`${p.id}|${s.me?.id}`)?.projectRole === 'producer';
}
export function canEditContent(s: State, p: Project): boolean {
  if (isAdmin(s)) return true;
  return roleOf(s, s.me?.id) === 'member' && !p.isArchived;
}
export const projectVisible = (s: State, projectId: string) => s.projectPrefs.get(projectId)?.visible !== false;
/** Mirrors server assertCardAccess: a deck's project rules, or (no deck) its creator as a member, or an admin/owner. */
export function canEditCard(s: State, card: Pick<Card, 'creatorId'>, project: Project | null | undefined): boolean {
  if (project) return canEditContent(s, project);
  if (isAdmin(s)) return true;
  return card.creatorId === s.me?.id && roleOf(s, s.me?.id) === 'member';
}

/** Mirrors server/permissions.ts canView for another user. */
export function canViewProject(s: State, userId: string, projectId: string): boolean {
  const p = s.projects.get(projectId);
  const role = s.accountRoles.get(userId);
  if (!p || !role) return false;
  if (role === 'owner' || role === 'admin') return true;
  const hasRow = s.projectAccess.has(`${projectId}|${userId}`);
  if (role === 'member') return p.visibility === 'full' || hasRow;
  return hasRow;
}

/** Mirrors server activeGuardians: the rule is on and these guardians are active users who can still view the project. */
export function activeGuardianIds(s: State, deck: Pick<Deck, 'id' | 'projectId' | 'guardiansEnabled'> | null | undefined): string[] {
  if (!deck?.guardiansEnabled) return [];
  return [...s.deckGuardians.values()]
    .filter((g) => g.deckId === deck.id && s.users.get(g.userId) && !s.users.get(g.userId)!.disabled && canViewProject(s, g.userId, deck.projectId))
    .map((g) => g.userId);
}
/** True when guardians guard this deck and I am not one of them. */
export function guardedAgainstMe(s: State, deck: Deck | null | undefined): boolean {
  const g = activeGuardianIds(s, deck);
  return g.length > 0 && !g.includes(s.me?.id ?? '');
}
export const GUARDIAN_TIP = 'Only reviewers can do this';

export interface InboxRow { resolvable: Resolvable; card: Card; note: ResolvableNotification }
/** Threads I take part in, not muted, not snoozed, that have something unseen or whose reminder is due. */
export function inboxRows(s: State, now: number): InboxRow[] {
  const out: InboxRow[] = [];
  const me = s.me?.id;
  for (const note of s.notifications.values()) {
    if (note.userId !== me || !note.isParticipating || note.isMuted) continue;
    if (note.snoozeUntil !== null && note.snoozeUntil > now) continue;
    if (!(note.unseenEntryCount > 0 || (note.remindMeOn !== null && note.remindMeOn <= now))) continue;
    const resolvable = s.resolvables.get(note.resolvableId);
    const card = resolvable && s.cards.get(resolvable.cardId);
    if (!resolvable || resolvable.isClosed || !card || card.visibility === 'deleted') continue;
    out.push({ resolvable, card, note });
  }
  return out.sort((a, b) => (b.resolvable.latestEntryAt ?? 0) - (a.resolvable.latestEntryAt ?? 0));
}

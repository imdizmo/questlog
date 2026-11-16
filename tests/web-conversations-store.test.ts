import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store, activeGuardianIds, canViewProject, guardedAgainstMe, inboxRows } from '../web/src/store';

const NOW = 1_000_000;
const card = (id: string, deckId: string | null) => ({ id, seq: 1, deckId, creatorId: 'u1', content: id, status: 'not_started', visibility: 'default', isDoc: false, version: 1, contentVersion: 1, sortIndex: 1, createdAt: 0, lastUpdatedAt: 0 });
const note = (rid: string, over: object = {}) => ({
  userId: 'u1', resolvableId: rid, isParticipating: true, isMuted: false, snoozeUntil: null, remindMeOn: null,
  unseenEntryCount: 1, unseenAuthors: ['u2'], latestEntryId: null, latestSeenEntryId: null, createdAt: 0, lastUpdatedAt: 0, ...over,
});
const res = (id: string, cardId: string, isClosed = false) => ({ id, cardId, context: 'comment', creatorId: 'u2', isClosed, closedAt: null, closedBy: null, createdAt: 0, latestEntryAt: 0 });

const snap = () => ({
  me: { id: 'u1', name: 'A', disabled: false },
  account: { id: 'a', name: 'W', settings: {} },
  users: [{ id: 'u1', disabled: false }, { id: 'u2', disabled: false }, { id: 'u3', disabled: true }, { id: 'u4', disabled: false }],
  accountRoles: [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'member' }, { userId: 'u3', role: 'member' }, { userId: 'u4', role: 'observer' }],
  projects: [{ id: 'p1', seq: 1, name: 'p', visibility: 'full', isArchived: false, spaces: [], tags: [] }, { id: 'p2', seq: 2, name: 'q', visibility: 'limited', isArchived: false, spaces: [], tags: [] }],
  projectAccess: [],
  projectPrefs: [],
  decks: [{ id: 'd1', projectId: 'p1', guardiansEnabled: true }, { id: 'd2', projectId: 'p2', guardiansEnabled: true }],
  cards: [card('c1', 'd1'), card('c2', 'd1')],
  resolvables: [res('r1', 'c1'), res('r2', 'c2')],
  entries: [{ id: 'e1', resolvableId: 'r1' }, { id: 'e2', resolvableId: 'r2' }],
  reactions: [{ id: 'x1', entryId: 'e1', userId: 'u2', emoji: '👍' }, { id: 'x2', entryId: 'e2', userId: 'u2', emoji: '👍' }],
  notifications: [note('r1'), note('r2')],
  deckGuardians: [],
});

async function loaded(patch: object = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...snap(), ...patch }), { status: 200 })));
  const s = new Store();
  await s.load();
  return s;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('thread cascade', () => {
  it('a removed or deleted task drops its threads, entries, reactions and notification rows', async () => {
    const s = await loaded();
    s.apply([{ model: 'card', op: 'remove', row: { id: 'c1', projectId: 'p1' } }]);
    const st = s.get();
    expect([...st.resolvables.keys()]).toEqual(['r2']);
    expect([...st.entries.keys()]).toEqual(['e2']);
    expect([...st.reactions.keys()]).toEqual(['x2']);
    expect([...st.notifications.keys()]).toEqual(['u1|r2']);
    s.apply([{ model: 'card', op: 'upsert', row: { ...card('c2', 'd1'), visibility: 'deleted' } }]);
    expect(s.get().resolvables.size).toBe(0);
    expect(s.get().entries.size).toBe(0);
    expect(s.get().reactions.size).toBe(0);
    expect(s.get().notifications.size).toBe(0);
  });

  it('closing a thread live drops its entries and reactions but keeps my notification row', async () => {
    const s = await loaded();
    s.apply([{ model: 'resolvable', op: 'upsert', row: res('r1', 'c1', true) }]);
    const st = s.get();
    expect(st.resolvables.has('r1')).toBe(false);
    expect(st.entries.has('e1')).toBe(false);
    expect(st.reactions.has('x1')).toBe(false);
    expect(st.notifications.has('u1|r1')).toBe(true);
    expect(st.entries.has('e2') && st.reactions.has('x2')).toBe(true);
  });
});

describe('inboxRows', () => {
  const ids = (s: Store) => inboxRows(s.get(), NOW).map((r) => r.resolvable.id).sort();
  it('lists participating, unmuted, unsnoozed threads with unseen messages', async () => {
    expect(ids(await loaded())).toEqual(['r1', 'r2']);
  });
  it('leaves out muted, non-participating, snoozed and fully seen rows', async () => {
    const s = await loaded({ notifications: [
      note('r1', { isMuted: true }), note('r2', { isParticipating: false }),
    ] });
    expect(ids(s)).toEqual([]);
    expect(ids(await loaded({ notifications: [note('r1', { snoozeUntil: NOW + 1 }), note('r2', { unseenEntryCount: 0 })] }))).toEqual([]);
  });
  it('a past or null snooze does not hide a row; a due reminder shows a seen thread', async () => {
    expect(ids(await loaded({ notifications: [note('r1', { snoozeUntil: NOW - 1 }), note('r2', { unseenEntryCount: 0, remindMeOn: NOW })] }))).toEqual(['r1', 'r2']);
    expect(ids(await loaded({ notifications: [note('r2', { unseenEntryCount: 0, remindMeOn: NOW + 1 })] }))).toEqual([]);
  });
  it('needs the task and an open thread in the store, and ignores other users rows', async () => {
    const s = await loaded({ notifications: [note('r1'), note('gone'), note('r2', { userId: 'u2' })], resolvables: [res('r1', 'c1'), res('r2', 'c2', true)] });
    expect(ids(s)).toEqual(['r1']);
    expect(ids(await loaded({ cards: [card('c2', 'd1')] }))).toEqual(['r2']);
  });
});

describe('guardians', () => {
  it('canViewProject mirrors the server rules', async () => {
    const st = (await loaded({ projectAccess: [{ projectId: 'p2', userId: 'u4', projectRole: null }] })).get();
    expect(canViewProject(st, 'u1', 'p2')).toBe(true); // owner
    expect(canViewProject(st, 'u2', 'p1')).toBe(true); // member, full project
    expect(canViewProject(st, 'u2', 'p2')).toBe(false); // member, limited, no row
    expect(canViewProject(st, 'u4', 'p2')).toBe(true); // observer with a row
    expect(canViewProject(st, 'u4', 'p1')).toBe(false);
    expect(canViewProject(st, 'nobody', 'p1')).toBe(false);
  });
  it('disabled guardians and guardians without access do not count; rule off means none', async () => {
    const s = await loaded({ deckGuardians: [
      { deckId: 'd2', userId: 'u1' }, { deckId: 'd2', userId: 'u2' }, { deckId: 'd2', userId: 'u3' },
      { deckId: 'd1', userId: 'u3' },
    ] });
    const st = s.get();
    expect(activeGuardianIds(st, st.decks.get('d2'))).toEqual(['u1']); // u2 has no access, u3 disabled
    expect(activeGuardianIds(st, st.decks.get('d1'))).toEqual([]); // only a disabled guardian: rule inactive
    expect(activeGuardianIds(st, { ...st.decks.get('d2')!, guardiansEnabled: false })).toEqual([]);
    expect(guardedAgainstMe(st, st.decks.get('d2'))).toBe(false); // I am the one guardian
    expect(guardedAgainstMe(st, st.decks.get('d1'))).toBe(false);
  });
  it('guards against me when I am not an active guardian', async () => {
    const st = (await loaded({ deckGuardians: [{ deckId: 'd1', userId: 'u2' }] })).get();
    expect(guardedAgainstMe(st, st.decks.get('d1'))).toBe(true);
  });
});

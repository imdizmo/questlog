import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store, canEditCard } from '../web/src/store';
import { parse } from '../web/src/router';

const P1 = 'p1', P2 = 'p2';
const project = (id: string, seq: number) => ({ id, seq, name: id, visibility: 'full', isArchived: false, spaces: [{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }], createdAt: 0 });
const card = (id: string, deckId: string | null) => ({ id, seq: 1, deckId, creatorId: 'u1', assigneeId: null, content: id, status: 'not_started', visibility: 'default', isDoc: false, version: 1, contentVersion: 1, sortIndex: 1, createdAt: 0, lastUpdatedAt: 0 });

const snapshot = () => ({
  me: { id: 'u1', email: 'a@x', name: 'A', timezone: null, disabled: false, createdAt: 0 },
  account: { id: 'a', name: 'W', settings: {} },
  users: [{ id: 'u1' }], accountRoles: [{ userId: 'u1', role: 'owner' }],
  projects: [project(P1, 1), project(P2, 2)],
  projectAccess: [{ projectId: P1, userId: 'u2', projectRole: null }, { projectId: P2, userId: 'u2', projectRole: null }],
  projectPrefs: [{ userId: 'u1', projectId: P1, visible: false }],
  decks: [{ id: 'd1', projectId: P1, spaceId: 1 }, { id: 'd2', projectId: P2, spaceId: 1 }],
  cards: [card('c1', 'd1'), card('c2', 'd2'), card('c3', null)],
  resolvables: [{ id: 'r1', cardId: 'c1', context: 'block', isClosed: false }, { id: 'r2', cardId: 'c2', context: 'review', isClosed: false }],
  entries: [{ id: 'e1', resolvableId: 'r1' }, { id: 'e2', resolvableId: 'r2' }],
  handCards: [{ userId: 'u1', cardId: 'c1', sortIndex: 1 }, { userId: 'u1', cardId: 'c3', sortIndex: 2 }],
});

function stubFetch(...responses: Array<{ status: number; body?: unknown } | 'throw'>) {
  const f = vi.fn(async () => {
    const r = responses.shift() ?? { status: 500 };
    if (r === 'throw') throw new TypeError('network');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

async function loaded() {
  stubFetch({ status: 200, body: snapshot() });
  const s = new Store();
  await s.load();
  expect(s.get().status).toBe('ready');
  return s;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Store.apply', () => {
  it('project remove drops its lists, tasks, threads, entries, hand slots, access and prefs', async () => {
    const s = await loaded();
    s.apply([{ model: 'project', op: 'remove', row: { id: P1 } }]);
    const st = s.get();
    expect([...st.projects.keys()]).toEqual([P2]);
    expect([...st.decks.keys()]).toEqual(['d2']);
    expect([...st.cards.keys()].sort()).toEqual(['c2', 'c3']); // deckless card is untouched
    expect([...st.resolvables.keys()]).toEqual(['r2']);
    expect([...st.entries.keys()]).toEqual(['e2']);
    expect([...st.handCards.keys()]).toEqual(['u1|c3']);
    expect([...st.projectAccess.keys()]).toEqual([`${P2}|u2`]);
    expect(st.projectPrefs.size).toBe(0);
  });

  it('wiki rows load, upsert and remove; a task or project going away takes its links along', async () => {
    const snap = {
      ...snapshot(),
      entryTypes: [{ id: 't1', projectId: P1, key: 'item' }, { id: 't2', projectId: P2, key: 'item' }],
      linkKinds: [{ id: 'k1', projectId: P1, key: 'drops' }],
      entryLinks: [{ id: 'l1', projectId: P1, kindKey: 'drops', fromCardId: 'c1', toCardId: 'c1' }, { id: 'l2', projectId: P2, kindKey: 'drops', fromCardId: 'c2', toCardId: 'c2' }],
    };
    stubFetch({ status: 200, body: snap });
    const s = new Store();
    await s.load();
    expect([...s.get().entryTypes.keys()]).toEqual(['t1', 't2']);
    s.apply([{ model: 'entryType', op: 'upsert', row: { id: 't1', name: 'Item' } }, { model: 'linkKind', op: 'remove', row: { id: 'k1', projectId: P1 } }]);
    expect(s.get().entryTypes.get('t1')).toMatchObject({ key: 'item', name: 'Item' });
    expect(s.get().linkKinds.size).toBe(0);
    s.apply([{ model: 'card', op: 'remove', row: { id: 'c2', projectId: P2 } }]);
    expect([...s.get().entryLinks.keys()]).toEqual(['l1']);
    s.apply([{ model: 'project', op: 'remove', row: { id: P1 } }]);
    expect([...s.get().entryTypes.keys()]).toEqual(['t2']);
    expect(s.get().entryLinks.size).toBe(0);
  });

  it('upserts merge, removes use key fields, deleted tasks and closed threads leave', async () => {
    const s = await loaded();
    const before = s.get();
    s.apply([
      { model: 'card', op: 'upsert', row: { id: 'c2', status: 'started' } },
      { model: 'card', op: 'upsert', row: { ...card('c3', null), visibility: 'deleted' } },
      { model: 'resolvable', op: 'upsert', row: { id: 'r1', cardId: 'c1', isClosed: true } },
      { model: 'handCard', op: 'remove', row: { userId: 'u1', cardId: 'c1' } },
      { model: 'projectAccess', op: 'remove', row: { projectId: P2, userId: 'u2' } },
      { model: 'projectPref', op: 'upsert', row: { userId: 'u1', projectId: P2, visible: false } },
    ]);
    const st = s.get();
    expect(st).not.toBe(before);
    expect(before.cards.get('c2')!.status).toBe('not_started'); // old state not mutated
    expect(st.cards.get('c2')).toMatchObject({ status: 'started', deckId: 'd2' });
    expect(st.cards.has('c3')).toBe(false);
    expect(st.resolvables.has('r1')).toBe(false);
    expect(st.handCards.has('u1|c1')).toBe(false);
    expect(st.projectAccess.has(`${P2}|u2`)).toBe(false);
    expect(st.projectPrefs.get(P2)!.visible).toBe(false);
    expect(st.decks).toBe(before.decks); // untouched collections keep identity
  });
});

describe('Store reloads when its view of a project changes', () => {
  it('a project access signal reloads the snapshot', async () => {
    const s = await loaded();
    const f = stubFetch({ status: 200, body: { ...snapshot(), projects: [project(P1, 1)] } });
    s.apply([{ model: 'project', op: 'access', row: { id: P2 } }]);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect([...s.get().projects.keys()]).toEqual([P1]));
  });

  it('a list event for an unknown project reloads; a known one does not', async () => {
    const s = await loaded();
    const f = stubFetch({ status: 200, body: snapshot() });
    s.apply([{ model: 'deck', op: 'upsert', row: { id: 'd9', projectId: P1, spaceId: 1 } }]);
    expect(f).not.toHaveBeenCalled();
    s.apply([{ model: 'deck', op: 'upsert', row: { id: 'd8', projectId: 'p9', spaceId: 1 } }]);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
  });

  it('events that arrive during a load are re-applied on top of the snapshot', async () => {
    const s = await loaded();
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const p = s.load();
    s.apply([
      { model: 'card', op: 'upsert', row: { id: 'c2', status: 'started' } },
      { model: 'card', op: 'remove', row: { id: 'c1' } },
    ]);
    release(new Response(JSON.stringify(snapshot()), { status: 200 }));
    await p;
    const st = s.get();
    expect(st.cards.get('c2')!.status).toBe('started');
    expect(st.cards.has('c1')).toBe(false);
  });

  it('events queued during a failed reload still apply to the kept data', async () => {
    const s = await loaded();
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const p = s.load();
    s.apply([{ model: 'card', op: 'upsert', row: { id: 'c2', status: 'done' } }]);
    release(new Response('{}', { status: 502 }));
    await p;
    expect(s.get().cards.get('c2')!.status).toBe('done');
  });
});

describe('Store.load', () => {
  it('a failed first load shows the error state', async () => {
    stubFetch({ status: 500 });
    const s = new Store();
    await s.load();
    expect(s.get().status).toBe('error');
  });

  it('a failed reload keeps the ready state and its data', async () => {
    const s = await loaded();
    stubFetch({ status: 502 }, 'throw');
    await s.load();
    expect(s.get().status).toBe('ready');
    await s.load();
    expect(s.get().status).toBe('ready');
    expect(s.get().projects.size).toBe(2);
  });

  it('401 means signed out', async () => {
    stubFetch({ status: 401 });
    const s = new Store();
    await s.load();
    expect(s.get().status).toBe('unauthenticated');
  });
});

describe('router parse', () => {
  it('parses the route shapes', () => {
    expect(parse('/')).toEqual({ name: 'root' });
    expect(parse('/decks/')).toEqual({ name: 'decks' });
    expect(parse('/join/abc')).toEqual({ name: 'join', token: 'abc' });
    expect(parse('/decks/12-lore')).toEqual({ name: 'deck', deckSeq: 12, slug: 'lore' });
    expect(parse('/decks/12-lore/card/1a3-fix-jump')).toEqual({ name: 'deckCard', deckSeq: 12, slug: 'lore', code: '1a3', cardSlug: 'fix-jump' });
    expect(parse('/card/1a3')).toEqual({ name: 'card', code: '1a3', cardSlug: '' });
    expect(parse('/decks/x-lore')).toEqual({ name: 'notFound', path: '/decks/x-lore' });
  });

  it('returns notFound for malformed escapes instead of throwing', () => {
    expect(parse('/decks/%E0%A4%A')).toEqual({ name: 'notFound', path: '/decks/%E0%A4%A' });
    expect(parse('/join/%')).toEqual({ name: 'notFound', path: '/join/%' });
  });
});

describe('canEditCard', () => {
  const st = (role: string) => ({ ...new Store().get(), me: { id: 'u1' } as any, accountRoles: new Map([['u1', role as any]]) });
  it('deckless: creator member or admin/owner may edit, matching the server', () => {
    const mine = card('c', null) as any;
    const theirs = { ...mine, creatorId: 'u2' };
    expect(canEditCard(st('member'), mine, null)).toBe(true);
    expect(canEditCard(st('member'), theirs, null)).toBe(false);
    expect(canEditCard(st('observer'), mine, null)).toBe(false);
    expect(canEditCard(st('admin'), theirs, null)).toBe(true);
    expect(canEditCard(st('owner'), theirs, null)).toBe(true);
  });
});

describe('store applies new models', () => {
  const dep = (a: string, b: string) => ({ lockedCardId: a, lockingCardId: b });
  const file = (id: string, cardId: string) => ({ id, cardId, name: 'f', mime: 'text/plain', size: 1 });
  const utag = (cardId: string, tag = 't') => ({ userId: 'u1', cardId, tag });
  async function withNew() {
    stubFetch({ status: 200, body: { ...snapshot(),
      cardDeps: [dep('c1', 'c1b'), dep('c2', 'c2b')], files: [file('f1', 'c1'), file('f2', 'c2')],
      userCardTags: [utag('c1'), utag('c2')], presets: [{ id: 'p1', name: 'P' }] } });
    const s = new Store();
    await s.load();
    return s;
  }

  it('loads and upserts/removes each model', async () => {
    const s = await withNew();
    const st = () => s.get();
    expect([...st().cardDeps.keys()]).toEqual(['c1|c1b', 'c2|c2b']);
    expect([...st().files.keys()]).toEqual(['f1', 'f2']);
    expect([...st().userCardTags.keys()]).toEqual(['u1|c1|t', 'u1|c2|t']);
    expect([...st().presets.keys()]).toEqual(['p1']);
    s.apply([
      { model: 'cardDep', op: 'upsert', row: dep('c1', 'c3') },
      { model: 'cardDep', op: 'remove', row: dep('c1', 'c1b') },
      { model: 'file', op: 'upsert', row: file('f3', 'c1') },
      { model: 'file', op: 'remove', row: { id: 'f2', cardId: 'c2' } },
      { model: 'userCardTag', op: 'upsert', row: utag('c1', 'x') },
      { model: 'userCardTag', op: 'remove', row: utag('c2') },
      { model: 'preset', op: 'upsert', row: { id: 'p2', name: 'Q' } },
      { model: 'preset', op: 'remove', row: { id: 'p1' } },
    ]);
    expect([...st().cardDeps.keys()]).toEqual(['c2|c2b', 'c1|c3']);
    expect([...st().files.keys()]).toEqual(['f1', 'f3']);
    expect([...st().userCardTags.keys()]).toEqual(['u1|c1|t', 'u1|c1|x']);
    expect([...st().presets.keys()]).toEqual(['p2']);
  });

  it('task remove drops its deps, files and personal tags', async () => {
    const s = await withNew();
    s.apply([{ model: 'card', op: 'remove', row: { id: 'c2', projectId: P2 } }]);
    expect([...s.get().cardDeps.keys()]).toEqual(['c1|c1b']);
    expect([...s.get().files.keys()]).toEqual(['f1']);
    expect([...s.get().userCardTags.keys()]).toEqual(['u1|c1|t']);
  });

  it('soft-deleted task drops its dependents (like the snapshot); a move keeps them', async () => {
    const s = await withNew();
    const c2 = snapshot().cards.find((c) => c.id === 'c2')!;
    s.apply([{ model: 'card', op: 'upsert', row: { ...c2, visibility: 'deleted' } }]);
    expect(s.get().cards.has('c2')).toBe(false);
    expect(s.get().cardDeps.has('c2|c2b')).toBe(false);
    expect(s.get().files.has('f2')).toBe(false);
    expect(s.get().userCardTags.has('u1|c2|t')).toBe(false);
    // A move to another project we see: remove + upsert in one batch keeps the card's files and tags.
    const c1 = snapshot().cards.find((c) => c.id === 'c1')!;
    s.apply([
      { model: 'card', op: 'remove', row: { id: 'c1', projectId: P1 } },
      { model: 'card', op: 'upsert', row: { ...c1, deckId: 'd2' } },
    ]);
    expect(s.get().cards.get('c1')?.deckId).toBe('d2');
    expect(s.get().files.has('f1')).toBe(true);
    expect(s.get().userCardTags.has('u1|c1|t')).toBe(true);
  });

  it('project remove cascades to deps, files and personal tags', async () => {
    const s = await withNew();
    s.apply([{ model: 'project', op: 'remove', row: { id: P2 } }]);
    expect([...s.get().cardDeps.keys()]).toEqual(['c1|c1b']);
    expect([...s.get().files.keys()]).toEqual(['f1']);
    expect([...s.get().userCardTags.keys()]).toEqual(['u1|c1|t']);
  });
});

describe('Store.apply milestone cascades', () => {
  const withMs = async () => {
    const s = await loaded();
    s.apply([
      { model: 'milestone', op: 'upsert', row: { id: 'm1', isGlobal: true, projectIds: [] } },
      { model: 'milestoneZone', op: 'upsert', row: { id: 'z1', milestoneId: 'm1' } },
      { model: 'milestoneProgress', op: 'upsert', row: { milestoneId: 'm1', projectId: P1, day: '2026-11-14' } },
      { model: 'card', op: 'upsert', row: { id: 'c1', milestoneId: 'm1', milestoneZoneId: 'z1' } },
      { model: 'card', op: 'upsert', row: { id: 'c2', milestoneId: 'm1', milestoneZoneId: null } },
    ]);
    return s;
  };
  const ms = (s: Store, id: string) => [s.get().cards.get(id)!.milestoneId ?? null, s.get().cards.get(id)!.milestoneZoneId ?? null];

  it('milestone remove clears milestone and zone on its tasks and drops zones and progress', async () => {
    const s = await withMs();
    s.apply([{ model: 'milestone', op: 'remove', row: { id: 'm1', isGlobal: true, projectIds: [] } }]);
    expect(ms(s, 'c1')).toEqual([null, null]);
    expect(ms(s, 'c2')).toEqual([null, null]);
    expect(s.get().milestoneZones.size).toBe(0);
    expect(s.get().milestoneProgress.size).toBe(0);
  });

  it('zone remove clears only the zone', async () => {
    const s = await withMs();
    s.apply([{ model: 'milestoneZone', op: 'remove', row: { id: 'z1', milestoneId: 'm1' } }]);
    expect(ms(s, 'c1')).toEqual(['m1', null]);
  });

  it('a scope change drops tasks of unlisted projects; remove+upsert in one batch keeps the rest', async () => {
    const s = await withMs();
    s.apply([
      { model: 'milestone', op: 'remove', row: { id: 'm1', isGlobal: true, projectIds: [] } },
      { model: 'milestone', op: 'upsert', row: { id: 'm1', isGlobal: false, projectIds: [P2] } },
    ]);
    // c1 is in d1 (P1, unlisted) and c2 in d2 (P2, listed)
    expect(ms(s, 'c1')).toEqual([null, null]);
    expect(ms(s, 'c2')).toEqual(['m1', null]);
    expect(s.get().milestones.has('m1')).toBe(true);
    expect(s.get().milestoneZones.size).toBe(1);
  });
});


describe('runs in the store', () => {
  const withRuns = async () => {
    const s = await loaded();
    s.apply([
      { model: 'sprintConfig', op: 'upsert', row: { id: 'g1', isGlobal: true, projectIds: [] } },
      { model: 'sprint', op: 'upsert', row: { id: 's1', configId: 'g1', startDay: '2026-11-14', endDay: '2026-11-27', isFinished: false } },
      { model: 'sprint', op: 'upsert', row: { id: 's0', configId: 'g1', startDay: '2026-10-31', endDay: '2026-11-13', isFinished: true } },
      { model: 'sprintProgress', op: 'upsert', row: { sprintId: 's1', projectId: P1, day: '2026-11-14' } },
      { model: 'card', op: 'upsert', row: { id: 'c1', sprintId: 's1', assigneeId: 'u1', status: 'started', visibility: 'default' } },
      { model: 'card', op: 'upsert', row: { id: 'c2', sprintId: 's1', assigneeId: 'u1', status: 'done', visibility: 'default' } },
      { model: 'card', op: 'upsert', row: { id: 'c3', sprintId: 's0', assigneeId: 'u1', status: 'started', visibility: 'default' } },
    ]);
    return s;
  };
  it('runCardsFor counts my open tasks in running runs', async () => {
    const { runCardsFor } = await import('../web/src/hand');
    const s = await withRuns();
    expect(runCardsFor(s.get(), 'u1', '2026-11-20').map((c) => c.id)).toEqual(['c1']);
    expect(runCardsFor(s.get(), 'u2', '2026-11-20')).toEqual([]);
    expect(runCardsFor(s.get(), 'u1', '2026-12-30')).toEqual([]);
  });
  it('a config remove drops its runs and progress and clears the tasks', async () => {
    const s = await withRuns();
    s.apply([{ model: 'sprintConfig', op: 'remove', row: { id: 'g1', isGlobal: true, projectIds: [] } }]);
    expect(s.get().sprints.size).toBe(0);
    expect(s.get().sprintProgress.size).toBe(0);
    expect(s.get().cards.get('c1')!.sprintId).toBeNull();
  });
  it('a scope shrink keeps tasks of listed projects only', async () => {
    const s = await withRuns();
    s.apply([{ model: 'card', op: 'upsert', row: { id: 'c1', deckId: 'd1', sprintId: 's1', assigneeId: 'u1', status: 'started', visibility: 'default' } }]);
    s.apply([
      { model: 'sprintConfig', op: 'remove', row: { id: 'g1', isGlobal: true, projectIds: [] } },
      { model: 'sprintConfig', op: 'upsert', row: { id: 'g1', isGlobal: false, projectIds: [P2] } },
    ]);
    expect(s.get().cards.get('c1')!.sprintId).toBeNull();
    expect(s.get().sprints.has('s1')).toBe(true);
  });
});

describe('Store live flag', () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(public url: string) { FakeSocket.all.push(this); }
    close() { this.onclose?.({ code: 1000 }); }
  }

  it('is true only once the snapshot after a (re)connect is applied; false while the socket is down or a reload runs', async () => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const f = vi.fn(async (url: string) => {
        if (String(url).includes('/api/status')) return new Response('{}', { status: 200 });
        await gate;
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      });
      vi.stubGlobal('fetch', f);
      const s = new Store();
      expect(s.get().live).toBe(false);
      s.start();
      const ws = FakeSocket.all[0];
      ws.onmessage!({ data: JSON.stringify({ type: 'uuid' }) });
      expect(s.get().live).toBe(false); // the snapshot is still on its way
      release();
      await vi.waitFor(() => expect(s.get().status).toBe('ready'));
      expect(s.get().live).toBe(true);

      // The socket drops: the data we hold may be stale; still 'ready' (the page keeps working).
      ws.onclose!({ code: 1006 });
      expect(s.get().status).toBe('ready');
      expect(s.get().live).toBe(false);

      // Reconnect: live again only after the new snapshot lands.
      let release2!: () => void;
      const gate2 = new Promise<void>((r) => { release2 = r; });
      f.mockImplementation(async (url: string) => {
        if (String(url).includes('/api/status')) return new Response('{}', { status: 200 });
        await gate2;
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      });
      await vi.advanceTimersByTimeAsync(600);
      const ws2 = FakeSocket.all[1];
      ws2.onmessage!({ data: JSON.stringify({ type: 'uuid' }) });
      expect(s.get().live).toBe(false);
      release2();
      await vi.waitFor(() => expect(s.get().live).toBe(true));

      // A reload asked for by an event (access change) is in flight: not live until it lands.
      let release3!: () => void;
      const gate3 = new Promise<void>((r) => { release3 = r; });
      f.mockImplementation(async () => { await gate3; return new Response(JSON.stringify(snapshot()), { status: 200 }); });
      s.apply([{ model: 'project', op: 'access', row: { id: P1 } } as any]);
      expect(s.get().live).toBe(false);
      release3();
      await vi.waitFor(() => expect(s.get().live).toBe(true));
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reload that fails while the socket is up is retried after 1, 2, 4 s … until it succeeds; a close stops the retries', async () => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
    vi.useFakeTimers();
    try {
      let failing = false;
      const snapshots: number[] = [];
      const f = vi.fn(async (url: string) => {
        if (String(url).includes('/api/status')) return new Response('{}', { status: 200 });
        snapshots.push(Date.now());
        return failing ? new Response('no', { status: 500 }) : new Response(JSON.stringify(snapshot()), { status: 200 });
      });
      vi.stubGlobal('fetch', f);
      const s = new Store();
      s.start();
      FakeSocket.all[0].onmessage!({ data: JSON.stringify({ type: 'uuid' }) });
      await vi.waitFor(() => expect(s.get().live).toBe(true));

      failing = true;
      snapshots.length = 0;
      const t0 = Date.now();
      s.apply([{ model: 'project', op: 'access', row: { id: P1 } } as any]);
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toHaveLength(1);
      expect(s.get().live).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      expect(snapshots).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); // 1 s
      expect(snapshots).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000); // 2 s more
      expect(snapshots).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(4000); // 4 s more
      expect(snapshots).toHaveLength(4);
      expect(snapshots.map((x) => x - t0)).toEqual([0, 1000, 3000, 7000]);
      // It caps at 30 s.
      await vi.advanceTimersByTimeAsync(8000 + 16000 + 30000);
      expect(snapshots.map((x) => x - t0).slice(4)).toEqual([15000, 31000, 61000]);
      expect(s.get().live).toBe(false);
      failing = false;
      await vi.advanceTimersByTimeAsync(30000);
      expect(s.get().live).toBe(true);
      expect(s.get().status).toBe('ready');

      // Failing again, then the socket closes: no more snapshot requests until it reconnects.
      failing = true;
      s.apply([{ model: 'project', op: 'access', row: { id: P1 } } as any]);
      await vi.advanceTimersByTimeAsync(0);
      const n = snapshots.length;
      FakeSocket.all[0].onclose!({ code: 1006 });
      await vi.advanceTimersByTimeAsync(400); // before the socket's own retry (500 ms)
      await vi.advanceTimersByTimeAsync(60_000);
      // Only reconnect attempts, which never say hello here: no snapshot was asked for.
      expect(snapshots).toHaveLength(n);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a load started before a reconnect never sets live; the reconnect gets a load of its own', async () => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
    vi.useFakeTimers();
    try {
      const gates: Array<() => void> = [];
      const f = vi.fn(async (url: string) => {
        if (String(url).includes('/api/status')) return new Response('{}', { status: 200 });
        await new Promise<void>((r) => gates.push(r));
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      });
      vi.stubGlobal('fetch', f);
      const s = new Store();
      s.start();
      FakeSocket.all[0].onmessage!({ data: JSON.stringify({ type: 'uuid' }) });
      gates.shift()!();
      await vi.waitFor(() => expect(s.get().live).toBe(true));

      // A reload is in flight when the socket drops and comes back.
      s.apply([{ model: 'project', op: 'access', row: { id: P1 } } as any]);
      await vi.advanceTimersByTimeAsync(0);
      expect(gates).toHaveLength(1);
      FakeSocket.all[0].onclose!({ code: 1006 });
      await vi.advanceTimersByTimeAsync(600);
      FakeSocket.all[1].onmessage!({ data: JSON.stringify({ type: 'uuid' }) });
      // The old load lands: its data is used, but it is not live; a new load starts.
      gates.shift()!();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      expect(s.get().status).toBe('ready');
      expect(s.get().live).toBe(false);
      gates.shift()!();
      await vi.waitFor(() => expect(s.get().live).toBe(true));
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

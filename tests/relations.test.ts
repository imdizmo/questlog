import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { AppError } from '../server/errors';
import { LiveHub } from '../server/live';
import { buildSnapshot } from '../server/snapshot';
import { heroEffort } from '../shared/properties';
import type { User } from '../shared/types';

let db: Db;
let me: User;
let deck: string;
let pid: string;
const run = (name: string, p: unknown, u: User = me) => dispatch(db, u, name, p);
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};
const mk = (content = 'Task', extra: object = {}, d = deck) =>
  (run('cards/create', { content, deckId: d, ...extra }).payload as { id: string }).id;
const row = (id: string) => (buildSnapshot(db, me).cards as any[]).find((c) => c.id === id);
const raw = (id: string) => db.prepare('SELECT * FROM cards WHERE id=?').get(id) as any;
const upd = (id: string, p: object, u: User = me) => run('cards/update', { id, ...p }, u);
const hist = (id: string) =>
  (db.prepare('SELECT changes_json c FROM card_history WHERE card_id=? ORDER BY version').all(id) as any[]).map((r) => JSON.parse(r.c));
const flags = () => run('accounts/update', { settings: { dependenciesEnabled: true } });

beforeEach(() => {
  db = openDb(':memory:');
  me = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
  pid = (run('projects/create', { name: 'P' }).payload as any).id;
  deck = (run('decks/create', { title: 'D', projectId: pid }).payload as any).id;
});

const mkUser = (role: string, access: string[] = []) => {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,0,0)').run(id, `${id}@x.io`, role, 'x');
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  for (const a of access) db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,NULL)').run(a, id);
  return { id, email: '', name: role, timezone: null, disabled: false, createdAt: 0 } as User;
};
const second = () => {
  const q = (run('projects/create', { name: 'Q', visibility: 'limited' }).payload as any).id;
  const qd = (run('decks/create', { title: 'Q', projectId: q }).payload as any).id;
  return { q, qd };
};


describe('hero / subtasks', () => {
  it('childCards sets parents', () => {
    const p = mk('P'), c1 = mk('C1'), c2 = mk('C2');
    const r = upd(p, { childCards: [c1, c2] });
    expect(raw(c1).parent_card_id).toBe(p);
    expect(raw(c2).parent_card_id).toBe(p);
    expect(r.events.filter((e) => e.model === 'card').map((e: any) => e.row.id).sort()).toEqual([p, c1, c2].sort());
    expect(hist(p).at(-1)).toEqual([{ kind: 'children', from: [], to: [c1, c2].sort((a, b) => raw(a).seq - raw(b).seq) }]);
    expect(hist(c1).at(-1)).toEqual([{ kind: 'parent', from: null, to: p }]);
    upd(p, { childCards: [c2] });
    expect(raw(c1).parent_card_id).toBeNull();
    expect(raw(c2).parent_card_id).toBe(p);
    expect(hist(c1).at(-1)).toEqual([{ kind: 'parent', from: p, to: null }]);
    // seen from the child
    upd(c1, { parentCardId: p });
    expect(raw(c1).parent_card_id).toBe(p);
    upd(c1, { parentCardId: null });
    expect(raw(c1).parent_card_id).toBeNull();
  });

  it('create with parentCardId makes a subtask; docs are refused', () => {
    const p = mk('P');
    const c = mk('C', { parentCardId: p });
    expect(raw(c).parent_card_id).toBe(p);
    expect(hist(p).at(-1)).toEqual([{ kind: 'children', from: [], to: [c] }]);
    const doc = mk('Doc', { isDoc: true });
    expect(code(() => mk('X', { parentCardId: doc }))).toBe('409:invalid_hierarchy');
    expect(code(() => upd(doc, { childCards: [c] }))).toBe('409:invalid_hierarchy');
    expect(code(() => upd(p, { childCards: [doc] }))).toBe('409:invalid_hierarchy');
  });

  it('rejects hierarchy cycles', () => {
    const a = mk('A'), b = mk('B'), c = mk('C');
    upd(a, { childCards: [b] });
    upd(b, { childCards: [c] });
    expect(code(() => upd(a, { parentCardId: c }))).toBe('409:hierarchy_cycle');
    expect(code(() => upd(c, { childCards: [a] }))).toBe('409:hierarchy_cycle');
    expect(code(() => upd(a, { childCards: [a] }))).toBe('409:hierarchy_cycle');
    expect(raw(a).parent_card_id).toBeNull();
    expect(raw(b).parent_card_id).toBe(a);
    expect(raw(c).parent_card_id).toBe(b);
  });

  it('hero rules', () => {
    const p = mk('P'), c = mk('C');
    upd(p, { childCards: [c] });
    expect(code(() => run('resolvables/create', { cardId: p, context: 'block', content: 'x' }))).toBe('409:invalid_transition');
    expect(code(() => run('resolvables/create', { cardId: p, context: 'review', content: 'x' }))).toBe('409:invalid_transition');
    expect(code(() => upd(p, { status: 'done' }))).toBe('409:invalid_transition');
    expect(code(() => run('cards/bulkUpdate', { ids: [p], status: 'done' }))).toBe('409:invalid_transition');
    expect(code(() => upd(p, { status: 'started' }))).toBe('no throw');
    expect(code(() => upd(c, { status: 'done' }))).toBe('no throw');
    // a deleted child no longer makes a hero
    upd(c, { visibility: 'deleted' });
    expect(code(() => upd(p, { status: 'done' }))).toBe('no throw');
  });

  describe('hero completion follows its subtasks', () => {
    const st = (id: string) => raw(id).status as string;
    const statusHist = (id: string) => hist(id).flat().filter((c: any) => c.kind === 'status');

    it('done on the last subtask done, with history and events', () => {
      const p = mk('P'), a = mk('A'), b = mk('B');
      upd(p, { childCards: [a, b] });
      upd(p, { status: 'started' });
      const assignee = raw(p).assignee_id;
      upd(a, { status: 'done' });
      expect(st(p)).toBe('started');
      const r = upd(b, { status: 'done' });
      expect(st(p)).toBe('done');
      expect(raw(p).assignee_id).toBe(assignee);
      expect(statusHist(p).at(-1)).toEqual({ kind: 'status', from: 'started', to: 'done' });
      const heroEv = r.events.filter((e) => e.model === 'card' && (e.row as any).id === p);
      expect((heroEv.at(-1)!.row as any).status).toBe('done');
    });

    it('re-emits the hero\'s lock neighbours when it completes', () => {
      flags();
      const p = mk('P'), a = mk('A'), w = mk('Waits');
      upd(p, { childCards: [a] });
      upd(w, { inDeps: [p] });
      expect(raw(w)).toBeTruthy();
      const r = upd(a, { status: 'done' });
      const wEv = r.events.filter((e) => e.model === 'card' && (e.row as any).id === w);
      expect(wEv.length).toBeGreaterThan(0);
      expect((wEv.at(-1)!.row as any).hasBlockingDeps).toBeFalsy();
    });

    it('reopens when a subtask reopens', () => {
      const p = mk('P'), a = mk('A');
      upd(p, { childCards: [a] });
      upd(a, { status: 'done' });
      expect(st(p)).toBe('done');
      upd(a, { status: 'not_started' });
      expect(st(p)).toBe('not_started');
      expect(statusHist(p).at(-1)).toEqual({ kind: 'status', from: 'done', to: 'not_started' });
    });

    it('reopens when a not-done subtask is added (childCards, parentCardId, create)', () => {
      const p = mk('P'), a = mk('A'), b = mk('B'), c = mk('C');
      upd(p, { childCards: [a] });
      upd(a, { status: 'done' });
      expect(st(p)).toBe('done');
      upd(p, { childCards: [a, b] });
      expect(st(p)).toBe('not_started');
      upd(b, { status: 'done' });
      expect(st(p)).toBe('done');
      upd(c, { parentCardId: p });
      expect(st(p)).toBe('not_started');
      upd(c, { status: 'done' });
      expect(st(p)).toBe('done');
      mk('D', { parentCardId: p });
      expect(st(p)).toBe('not_started');
    });

    it('a done task gaining a not-done child goes back to not started', () => {
      const p = mk('P'), a = mk('A');
      upd(p, { status: 'done' });
      upd(p, { childCards: [a] });
      expect(st(p)).toBe('not_started');
    });

    it('follows deletes, restores, review close and list delete', () => {
      const p = mk('P'), a = mk('A'), b = mk('B');
      upd(p, { childCards: [a, b] });
      upd(a, { status: 'done' });
      upd(b, { visibility: 'deleted' });
      expect(st(p)).toBe('done');
      upd(b, { visibility: 'default' });
      expect(st(p)).toBe('not_started');
      const rid = (run('resolvables/create', { cardId: b, context: 'review', content: 'ok?' }).payload as any).id;
      run('resolvables/close', { id: rid, markCardDone: true });
      expect(st(p)).toBe('done');
      // Nested heroes: completion walks up.
      const top = mk('Top');
      upd(top, { childCards: [p] });
      expect(st(top)).toBe('done');
      // Deleting a deck holding the only open sub card completes the hero.
      const d2 = (run('decks/create', { title: 'D2', projectId: pid }).payload as any).id;
      const x = mk('X', {}, d2);
      upd(x, { parentCardId: p });
      expect(st(p)).toBe('not_started');
      expect(st(top)).toBe('not_started');
      run('decks/delete', { id: d2 });
      expect(st(p)).toBe('done');
      expect(st(top)).toBe('done');
    });
  });

  it('hero effort', () => {
    const p = mk('P', { effort: 5 }), c = mk('C');
    upd(p, { childCards: [c] });
    const kids = (buildSnapshot(db, me).cards as any[]).filter((x) => x.parentCardId === p);
    expect(heroEffort(row(p), kids, { fallbackEffort: 1 })).toBe(6);
  });
});

describe('restored hero status', () => {
  const setup = () => {
    const h = mk('H'), a = mk('A'), b = mk('B');
    upd(h, { childCards: [a, b] });
    upd(a, { status: 'done' }); upd(b, { status: 'done' });
    expect(raw(h).status).toBe('done');
    upd(h, { visibility: 'deleted' });
    return { h, a, b };
  };
  for (const via of ['update', 'bulkUpdate'] as const) {
    const restore = (h: string) => via === 'update' ? upd(h, { visibility: 'default' }) : run('cards/bulkUpdate', { ids: [h], visibility: 'default' });
    it(`recomputes its own status when a subtask was reopened while deleted (${via})`, () => {
      const { h, b } = setup();
      upd(b, { status: 'not_started' });
      restore(h);
      expect(raw(h).status).toBe('not_started');
      expect(hist(h).flat()).toContainEqual({ kind: 'status', from: 'done', to: 'not_started' });
    });
    it(`stays done when all subs are done at restore (${via})`, () => {
      const { h } = setup();
      restore(h);
      expect(raw(h).status).toBe('done');
    });
  }
});

describe('dependencies', () => {
  it('needs the feature flag', () => {
    run('accounts/update', { settings: { dependenciesEnabled: false } }); // new workspaces start with it on
    const a = mk('A'), b = mk('B');
    expect(code(() => upd(b, { inDeps: [a] }))).toBe('409:feature_disabled');
  });

  it('flags blocking deps and re-emits locked tasks when the locker is done', () => {
    flags();
    const a = mk('A'), b = mk('B');
    const r = upd(b, { inDeps: [a] });
    expect(row(b).hasBlockingDeps).toBe(true);
    expect(row(a).isBlockingDep).toBe(true);
    expect(row(a).hasBlockingDeps).toBe(false);
    expect(r.events.filter((e) => e.model === 'cardDep')).toEqual([{ model: 'cardDep', op: 'upsert', row: { lockedCardId: b, lockingCardId: a } }]);
    expect(hist(b).at(-1)).toEqual([{ kind: 'deps', from: [], to: [a] }]);
    const d = upd(a, { status: 'done' });
    const bEv: any = d.events.find((e) => e.model === 'card' && (e.row as any).id === b);
    expect(bEv.row.hasBlockingDeps).toBe(false);
    expect(row(b).hasBlockingDeps).toBe(false);
    expect(row(a).isBlockingDep).toBe(true); // still locks B, which is not done
    // reopen re-blocks; bulk and delete paths re-emit too
    const e = run('cards/bulkUpdate', { ids: [a], status: 'not_started' });
    expect((e.events.find((x) => x.model === 'card' && (x.row as any).id === b)!.row as any).hasBlockingDeps).toBe(true);
    const f = upd(a, { visibility: 'deleted' });
    expect((f.events.find((x) => x.model === 'card' && (x.row as any).id === b)!.row as any).hasBlockingDeps).toBe(false);
    // clearing
    upd(b, { inDeps: [] });
    expect(db.prepare('SELECT COUNT(*) n FROM card_deps').get()).toEqual({ n: 0 });
  });

  it('rejects cycles', () => {
    flags();
    const a = mk('A'), b = mk('B'), c = mk('C');
    expect(code(() => upd(a, { inDeps: [a] }))).toBe('409:dependency_cycle');
    upd(b, { inDeps: [a] });
    expect(code(() => upd(a, { inDeps: [b] }))).toBe('409:dependency_cycle');
    upd(c, { inDeps: [b] });
    expect(code(() => upd(a, { inDeps: [c] }))).toBe('409:dependency_cycle');
    expect(db.prepare('SELECT COUNT(*) n FROM card_deps').get()).toEqual({ n: 2 });
  });

  it('locking tasks must be visible to the actor', () => {
    flags();
    const { q, qd } = second();
    const m = mkUser('member', [pid]); // sees P only
    const hidden = mk('H', {}, qd);
    const b = mk('B');
    expect(code(() => upd(b, { inDeps: ['nope'] }))).toBe('404:not_found');
    expect(code(() => upd(b, { inDeps: [hidden] }, m))).toBe('404:not_found');
    expect(code(() => upd(b, { inDeps: [hidden] }))).toBe('409:invalid_dependency'); // other project
    void q;
  });

  it('routes cardDep events to viewers of either project only', () => {
    const { q, qd } = second();
    const hub = new LiveHub(db);
    const got: Record<string, any[]> = { p: [], q: [], both: [], none: [] };
    const add = (k: string, u: User) => hub.add({ send: (s) => got[k].push(JSON.parse(s)), close() {} }, u);
    add('p', mkUser('observer', [pid]));
    add('q', mkUser('observer', [q]));
    add('both', mkUser('observer', [pid, q]));
    add('none', mkUser('observer'));
    const cp = mk('B'), cq = mk('A', {}, qd);
    hub.publish('1', [
      { model: 'cardDep', op: 'upsert', row: { lockedCardId: cp, lockingCardId: cq } },
      { model: 'cardDep', op: 'upsert', row: { lockedCardId: 'ghost', lockingCardId: 'ghost2' } },
    ]);
    const n = (k: string) => got[k].flatMap((m) => m.events).length;
    expect([n('p'), n('q'), n('both'), n('none')]).toEqual([1, 1, 1, 0]);
  });

  it('rejects a deleted locking task', () => {
    flags();
    const a = mk('A'), b = mk('B');
    upd(a, { visibility: 'deleted' });
    expect(code(() => upd(b, { inDeps: [a] }))).toBe('409:invalid_dependency');
  });
});

describe('fix round 1', () => {
  it('a hero cannot be closed done via resolvables/close markCardDone', () => {
    const p = mk('P'), c = mk('C');
    const r = (run('resolvables/create', { cardId: p, context: 'review', content: 'r' }).payload as any).id;
    upd(p, { childCards: [c] });
    expect(code(() => run('resolvables/close', { id: r, markCardDone: true }))).toBe('409:invalid_transition');
    expect(raw(p).status).not.toBe('done');
    expect(db.prepare('SELECT is_closed x FROM resolvables WHERE id=?').get(r)).toEqual({ x: 0 });
  });

  it('doc tasks cannot be put into a hierarchy together with isDoc:true', () => {
    const p = mk('P'), c = mk('C'), q = mk('Q');
    expect(code(() => upd(p, { isDoc: true, childCards: [c] }))).toBe('409:invalid_hierarchy');
    expect(code(() => upd(c, { isDoc: true, parentCardId: q }))).toBe('409:invalid_hierarchy');
    expect(raw(p).is_doc).toBe(0);
    expect(raw(c).is_doc).toBe(0);
    expect(raw(c).parent_card_id).toBeNull();
  });

  it('childCards replace keeps soft-deleted children attached', () => {
    const p = mk('P'), c1 = mk('C1'), c2 = mk('C2');
    upd(p, { childCards: [c1, c2] });
    upd(c1, { visibility: 'deleted' });
    const before = hist(c1).length;
    upd(p, { childCards: [] });
    expect(raw(c1).parent_card_id).toBe(p);
    expect(raw(c2).parent_card_id).toBeNull();
    expect(hist(c1).length).toBe(before);
    expect(hist(p).at(-1)).toEqual([{ kind: 'children', from: [c2], to: [] }]);
  });

  it('deleting a list re-emits dependency neighbours', () => {
    flags();
    const d2 = (run('decks/create', { title: 'D2', projectId: pid }).payload as any).id;
    const a = mk('A', {}, d2), b = mk('B');
    upd(b, { inDeps: [a] });
    expect(row(b).hasBlockingDeps).toBe(true);
    const r = run('decks/delete', { id: d2 });
    const ev: any = r.events.find((e) => e.model === 'card' && e.op === 'upsert' && (e.row as any).id === b);
    expect(ev.row.hasBlockingDeps).toBe(false);
  });

  it('hierarchy is same-project only', () => {
    const { qd } = second();
    const p = mk('P'), other = mk('O', {}, qd);
    expect(code(() => upd(p, { childCards: [other] }))).toBe('409:invalid_hierarchy');
    expect(code(() => upd(other, { parentCardId: p }))).toBe('409:invalid_hierarchy');
    expect(raw(other).parent_card_id).toBeNull();
  });

  it('moving a task to another project clears its relations with history and events', () => {
    flags();
    const { qd } = second();
    const par = mk('Par'), x = mk('X'), kid = mk('Kid'), lockX = mk('L'), lockedByX = mk('M');
    upd(par, { childCards: [x] });
    upd(x, { childCards: [kid], inDeps: [lockX] });
    upd(lockedByX, { inDeps: [x] });
    const r = upd(x, { deckId: qd });
    expect(raw(x).parent_card_id).toBeNull();
    expect(raw(kid).parent_card_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM card_deps').get()).toEqual({ n: 0 });
    const kinds = hist(x).at(-1).map((c: any) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['deck', 'parent', 'children', 'deps']));
    expect(hist(par).at(-1)).toEqual([{ kind: 'children', from: [x], to: [] }]);
    expect(hist(kid).at(-1)).toEqual([{ kind: 'parent', from: x, to: null }]);
    expect(hist(lockedByX).at(-1)).toEqual([{ kind: 'deps', from: [x], to: [] }]);
    const deps = r.events.filter((e) => e.model === 'cardDep');
    expect(deps.map((e) => e.op)).toEqual(['remove', 'remove']);
    const ids = new Set(r.events.filter((e) => e.model === 'card' && e.op === 'upsert').map((e: any) => e.row.id));
    for (const id of [par, kid, lockX, lockedByX, x]) expect(ids.has(id)).toBe(true);
    expect((r.events.find((e) => e.model === 'card' && (e.row as any).id === lockedByX)!.row as any).hasBlockingDeps).toBe(false);
  });
});

describe('live events match the snapshot after delete / restore / move', () => {
  it('deps, files and personal tags of a deleted then restored (and moved) card', async () => {
    const { vi } = await import('vitest');
    const { Store } = await import('../web/src/store');
    flags();
    const a = mk('A'), b = mk('B'), c = mk('C');
    upd(a, { inDeps: [b] });
    upd(c, { inDeps: [a] });
    db.prepare('INSERT INTO files (id,card_id,uploader_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?,?)').run('f1', a, me.id, 'a.txt', 'text/plain', 1, 1);
    run('users/setCardTags', { cardId: a, tags: ['mine', 'later'] });
    const other = mkUser('member', [pid]);
    run('users/setCardTags', { cardId: a, tags: ['theirs'] }, other);

    const load = async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(buildSnapshot(db, me)), { status: 200 })));
      const s = new Store();
      await s.load();
      vi.unstubAllGlobals();
      return s;
    };
    const live = await load();
    const hub = new LiveHub(db);
    hub.add({ send: (m: string) => live.apply(JSON.parse(m).events), close: () => {} }, me);
    const step = (name: string, p: unknown) => { const r = run(name, p); hub.publish('x', r.events); };
    const same = async () => {
      const fresh = (await load()).get();
      const st = live.get();
      for (const k of ['cards', 'cardDeps', 'files', 'userCardTags'] as const) {
        expect([...st[k].keys()].sort(), k).toEqual([...fresh[k].keys()].sort());
        for (const [key, v] of fresh[k]) expect(st[k].get(key), `${k} ${key}`).toMatchObject(v as object);
      }
    };
    await same();
    step('cards/update', { id: a, visibility: 'deleted' });
    expect(live.get().files.has('f1')).toBe(false);
    await same();
    step('cards/update', { id: a, visibility: 'default' });
    expect(live.get().files.has('f1')).toBe(true);
    expect(live.get().cardDeps.size).toBe(2);
    await same();
    step('cards/bulkUpdate', { ids: [a], visibility: 'deleted' });
    await same();
    step('cards/bulkUpdate', { ids: [a], visibility: 'default' });
    await same();
    // Into another project: files and tags travel along (deps are cleared).
    const q = (run('projects/create', { name: 'Q2' }).payload as any).id;
    const qd = (run('decks/create', { title: 'Q2', projectId: q }).payload as any).id;
    step('cards/update', { id: a, deckId: qd });
    await same();
  });
});

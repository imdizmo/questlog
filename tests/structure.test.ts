import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { setupWorkspace } from '../server/auth';
import { dispatch } from '../server/dispatch';
import { AppError } from '../server/errors';
import type { User } from '../shared/types';

let db: Db;
let owner: User;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AppError ? `${e.status}:${e.code}` : String(e); }
  return 'no throw';
};
function mkUser(role: string): User {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,0)').run(id, `${id}@x.io`, role, 'x');
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return { id, email: `${id}@x.io`, name: role, timezone: null, disabled: false, createdAt: 0 };
}
const run = (u: User, name: string, p: unknown) => dispatch(db, u, name, p);
const mkProject = (name = 'P') => (run(owner, 'projects/create', { name }).payload as { id: string }).id;
const spacesOf = (pid: string) => JSON.parse((db.prepare('SELECT spaces_json s FROM projects WHERE id=?').get(pid) as any).s);
const mixed = (id: number) => ({ id, name: null, icon: null, defaultDeckType: 'mixed' });

beforeEach(() => {
  db = openDb(':memory:');
  owner = setupWorkspace(db, { workspaceName: 'W', name: 'O', email: 'o@x.io', password: 'pw' });
});

describe('structure', () => {
  it('new project shape', () => {
    const pid = mkProject();
    expect(spacesOf(pid)).toEqual([mixed(1)]);
    expect((db.prepare('SELECT COUNT(*) c FROM decks WHERE project_id=?').get(pid) as any).c).toBe(0);
  });

  it('list goes to first space and takes its type', () => {
    const pid = mkProject();
    run(owner, 'projects/update', { id: pid, spaces: [{ id: 2, name: 'Knowledge', icon: null, defaultDeckType: 'doc' }, mixed(1)] });
    const { id } = run(owner, 'decks/create', { title: 'D', projectId: pid }).payload as { id: string };
    const d = db.prepare('SELECT space_id, deck_type FROM decks WHERE id=?').get(id) as any;
    expect(d.space_id).toBe(2);
    expect(d.deck_type).toBe('doc');
  });

  it('seq counters', () => {
    const p1 = mkProject();
    const p2 = mkProject();
    const a = (run(owner, 'decks/create', { title: 'A', projectId: p1 }).payload as any).id;
    const b = (run(owner, 'decks/create', { title: 'B', projectId: p2 }).payload as any).id;
    const seq = (id: string) => (db.prepare('SELECT seq FROM decks WHERE id=?').get(id) as any).seq;
    expect([seq(a), seq(b)]).toEqual([1, 2]);
    expect((db.prepare('SELECT seq FROM projects WHERE id=?').get(p2) as any).seq).toBe(2);
  });

  it('space with lists can not be removed', () => {
    const pid = mkProject();
    run(owner, 'projects/update', { id: pid, spaces: [mixed(2), mixed(1)] });
    run(owner, 'decks/create', { title: 'A', projectId: pid, spaceId: 2 });
    expect(code(() => run(owner, 'projects/update', { id: pid, spaces: [mixed(1)] }))).toBe('409:space_not_empty');
  });

  it('stale spaces array', () => {
    const pid = mkProject();
    run(owner, 'projects/update', { id: pid, spaces: [mixed(2), mixed(1)] });
    const stale = spacesOf(pid).filter((s: any) => s.id !== 2);
    const before = spacesOf(pid);
    run(owner, 'decks/create', { title: 'A', projectId: pid, spaceId: 2 });
    expect(code(() => run(owner, 'projects/update', { id: pid, spaces: stale }))).toBe('409:space_not_empty');
    expect(spacesOf(pid)).toEqual(before);
  });

  it('spaces validation', () => {
    const pid = mkProject();
    expect(code(() => run(owner, 'projects/update', { id: pid, spaces: [] }))).toBe('400:invalid_payload');
    expect(code(() => run(owner, 'projects/update', { id: pid, spaces: [mixed(1), mixed(1)] }))).toBe('400:invalid_payload');
    expect(code(() => run(owner, 'projects/update', { id: pid, spaces: [{ ...mixed(1), defaultDeckType: 'x' }] }))).toBe('400:invalid_payload');
  });

  it('list delete soft-deletes tasks', () => {
    const pid = mkProject();
    const did = (run(owner, 'decks/create', { title: 'A', projectId: pid }).payload as any).id;
    for (let i = 1; i <= 2; i++) {
      db.prepare('INSERT INTO cards (id,seq,deck_id,creator_id,created_at,last_updated_at) VALUES (?,?,?,?,0,0)').run(newId(), i, did, owner.id);
    }
    const r = run(owner, 'decks/delete', { id: did });
    const rows = db.prepare('SELECT visibility v, deck_id d FROM cards').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.v === 'deleted' && x.d === null)).toBe(true);
    expect(db.prepare('SELECT 1 FROM decks WHERE id=?').get(did)).toBeUndefined();
    const ev = r.events.filter((e) => e.model === 'card');
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.op === 'remove' && (e.row as any).projectId === pid)).toBe(true);
    expect(ev.map((e) => (e.row as any).id).sort()).toEqual(rows.length ? (db.prepare('SELECT id FROM cards').all() as any[]).map((x) => x.id).sort() : []);
    expect(r.events.find((e) => e.model === 'deck' && e.op === 'remove')?.row).toMatchObject({ id: did });
  });

  it('observer can not create list', () => {
    const pid = mkProject();
    const obs = mkUser('observer');
    db.prepare('INSERT INTO project_access (project_id,user_id) VALUES (?,?)').run(pid, obs.id);
    expect(code(() => run(obs, 'decks/create', { title: 'A', projectId: pid }))).toBe('403:forbidden');
  });

  it('unknown command / bad payload / hand slots', () => {
    expect(code(() => run(owner, 'nope/nothing', {}))).toBe('404:unknown_command');
    expect(code(() => run(owner, 'projects/create', {}))).toBe('400:invalid_payload');
    expect(code(() => run(owner, 'accounts/update', { settings: { maxHandSlots: 30 } }))).toBe('400:invalid_payload');
    expect(code(() => run(owner, 'accounts/update', { settings: { bogus: 1 } }))).toBe('400:invalid_payload');
    const r = run(owner, 'accounts/update', { settings: { maxHandSlots: 20 }, name: 'N' });
    expect(r.events[0]).toMatchObject({ model: 'account', op: 'upsert' });
    expect((r.events[0].row as any).settings.maxHandSlots).toBe(20);
    expect((r.events[0].row as any).settings.staleHours).toBe(120);
  });

  it('owner protection', () => {
    const admin = mkUser('admin');
    const m = mkUser('member');
    expect(code(() => run(admin, 'users/setRole', { userId: owner.id, role: 'member' }))).toBe('403:forbidden');
    expect(code(() => run(admin, 'users/disable', { userId: owner.id, disabled: true }))).toBe('403:forbidden');
    expect(code(() => run(admin, 'users/setRole', { userId: m.id, role: 'owner' }))).toBe('403:forbidden');
    run(admin, 'users/setRole', { userId: m.id, role: 'observer' });
    expect((db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(m.id) as any).role).toBe('observer');
    expect(code(() => run(m, 'users/setRole', { userId: m.id, role: 'admin' }))).toBe('403:forbidden');
  });

  it('users/disable revokes devices and sessions', () => {
    const m = mkUser('member');
    db.prepare("INSERT INTO known_devices (token_hash,user_id,created_at) VALUES ('h',?,0)").run(m.id);
    run(owner, 'users/disable', { userId: m.id, disabled: true });
    expect(db.prepare('SELECT 1 FROM known_devices WHERE user_id=?').get(m.id)).toBeUndefined();
  });

  it('access, prefs, invites, project delete', () => {
    const pid = mkProject();
    const m = mkUser('member');
    const r = run(owner, 'projects/setAccess', { projectId: pid, userId: m.id, access: 'producer' });
    expect(r.events[0]).toMatchObject({ model: 'projectAccess', op: 'upsert', row: { projectId: pid, userId: m.id, projectRole: 'producer' } });
    const r2 = run(owner, 'projects/setAccess', { projectId: pid, userId: m.id, access: null });
    expect(r2.events[0]).toMatchObject({ op: 'remove', row: { projectId: pid, userId: m.id } });
    const pr = run(m, 'missionControl/setVisible', { projectId: pid, visible: false });
    expect(pr.events[0]).toMatchObject({ model: 'projectPref', row: { userId: m.id, projectId: pid, visible: false } });
    const tok = (run(owner, 'invites/create', { role: 'member', projectIds: [pid] }).payload as any).token;
    expect(typeof tok).toBe('string');
    const th = (db.prepare('SELECT token_hash h FROM invites').get() as any).h;
    run(owner, 'invites/disable', { tokenHash: th });
    expect((db.prepare('SELECT disabled d FROM invites').get() as any).d).toBe(1);
    const did = (run(owner, 'decks/create', { title: 'A', projectId: pid }).payload as any).id;
    const cid = newId();
    db.prepare('INSERT INTO cards (id,seq,deck_id,creator_id,created_at,last_updated_at) VALUES (?,?,?,?,0,0)').run(cid, 1, did, owner.id);
    const del = run(owner, 'projects/delete', { id: pid });
    expect(db.prepare('SELECT 1 FROM projects').get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM cards').get()).toBeUndefined();
    expect(del.events).toContainEqual({ model: 'card', op: 'remove', row: { id: cid, projectId: pid } });
  });

  it('list update and move', () => {
    const pid = mkProject();
    run(owner, 'projects/update', { id: pid, spaces: [mixed(2), mixed(1)] });
    const did = (run(owner, 'decks/create', { title: 'A', projectId: pid }).payload as any).id;
    run(owner, 'decks/update', { id: did, title: 'B', deckType: 'doc', spaceId: 1 });
    const d = db.prepare('SELECT * FROM decks WHERE id=?').get(did) as any;
    expect([d.title, d.deck_type, d.space_id]).toEqual(['B', 'doc', 1]);
    expect(code(() => run(owner, 'decks/update', { id: did, spaceId: 9 }))).toBe('400:invalid_payload');
  });
});

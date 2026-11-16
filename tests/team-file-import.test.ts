import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, newId, type Db } from '../server/db';
import { importTeamFile, startTeamFile, writeTeamFile } from '../server/teamFile';

let db: Db;
let dir = '';
let errors: ReturnType<typeof vi.spyOn>;
const file = () => join(dir, 'team.json');
const put = (v: unknown) => writeFileSync(file(), typeof v === 'string' ? v : JSON.stringify(v));
const members = (...m: unknown[]) => ({ version: 1, members: m });

function mkUser(email: string, role = 'member', extra: { tailscale?: string; disabled?: boolean; kind?: string } = {}): string {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at,tailscale_login,disabled,kind) VALUES (?,?,?,?,0,?,?,?)')
    .run(id, email, email.split('@')[0], 'x', extra.tailscale ?? null, extra.disabled ? 1 : 0, extra.kind ?? 'person');
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return id;
}
const row = (id: string) => db.prepare('SELECT u.email, u.name, u.password_hash h, u.tailscale_login t, u.disabled d, r.role FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.id=?').get(id) as any;
const byLogin = (l: string) => db.prepare('SELECT u.id, u.email, u.name, u.password_hash h, r.role FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.tailscale_login=?').get(l) as any;
const snapshot = () => JSON.stringify(db.prepare('SELECT u.id,u.email,u.tailscale_login,u.disabled,r.role FROM users u JOIN account_roles r ON r.user_id=u.id ORDER BY u.id').all());
const written = () => JSON.parse(readFileSync(file(), 'utf8'));

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO account (id,name,settings_json,created_at) VALUES (?,?,?,?)').run('a', 'W', '{}', 0);
  const base = join(homedir(), '.cache/gametracker/scratch');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'team-import-'));
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('importTeamFile: unusable files', () => {
  it('missing file: no change, nothing logged', () => {
    const o = mkUser('o@x.io', 'owner');
    const before = snapshot();
    importTeamFile(db, file());
    expect(snapshot()).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    expect(row(o).t).toBeNull();
  });
  it.each([
    ['bad JSON', '{nope'],
    ['version not 1', JSON.stringify({ version: 2, members: [{ login: 'a@x.io', name: 'A', role: 'member' }] })],
    ['members not an array', JSON.stringify({ version: 1, members: { login: 'a@x.io' } })],
    ['not an object', '[]'],
  ])('%s: no change, one error logged', (_n, text) => {
    mkUser('o@x.io', 'owner');
    put(text);
    const before = snapshot();
    importTeamFile(db, file());
    expect(snapshot()).toBe(before);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('importTeamFile: members', () => {
  it('skips a login already linked to anyone, disabled included', () => {
    const d = mkUser('old@x.io', 'member', { tailscale: 'Ada@Example.com', disabled: true });
    put(members({ login: 'ada@example.com', name: 'Ada', role: 'admin' }));
    const before = snapshot();
    importTeamFile(db, file());
    expect(snapshot()).toBe(before);
    expect(row(d).d).toBe(1);
  });
  it('role owner links the unlinked workspace owner', () => {
    const o = mkUser('o@x.io', 'owner');
    put(members({ login: 'boss@example.com', name: 'Boss', role: 'owner' }));
    importTeamFile(db, file());
    expect(row(o)).toMatchObject({ t: 'boss@example.com', role: 'owner', email: 'o@x.io' });
    expect(db.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 1 });
  });
  it('role owner when the owner is already linked: created as admin', () => {
    mkUser('o@x.io', 'owner', { tailscale: 'boss@example.com' });
    put(members({ login: 'other@example.com', name: 'Other', role: 'owner' }));
    importTeamFile(db, file());
    expect(byLogin('other@example.com')).toMatchObject({ role: 'admin' });
  });
  it('links an unlinked person whose email equals the login, ignoring case', () => {
    const u = mkUser('Mia@Example.com', 'member');
    put(members({ login: 'mia@example.com', name: 'Mia', role: 'admin' }));
    importTeamFile(db, file());
    expect(row(u)).toMatchObject({ t: 'mia@example.com', role: 'member' });
    expect(db.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 1 });
  });
  it('links a disabled matching person and keeps them disabled', () => {
    const u = mkUser('mia@example.com', 'member', { disabled: true });
    put(members({ login: 'mia@example.com', name: 'Mia', role: 'member' }));
    importTeamFile(db, file());
    expect(row(u)).toMatchObject({ t: 'mia@example.com', d: 1 });
  });
  it('does not link a service user by email; logs and skips', () => {
    const s = mkUser('bot@example.com', 'member', { kind: 'service' });
    put(members({ login: 'bot@example.com', name: 'Bot', role: 'member' }));
    importTeamFile(db, file());
    expect(row(s).t).toBeNull();
    expect(errors).toHaveBeenCalled();
  });
  it('does not link an Open Decks guest by email; logs and skips', () => {
    const g = mkUser('gus@example.com', 'guest');
    put(members({ login: 'gus@example.com', name: 'Gus', role: 'member' }));
    importTeamFile(db, file());
    expect(row(g)).toMatchObject({ t: null, role: 'guest' });
    expect(db.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 1 });
    expect(errors).toHaveBeenCalled();
  });
  it("removes the join request of everyone it links or creates, and only theirs", () => {
    const o = mkUser('o@x.io', 'owner');
    mkUser('mia@example.com', 'member');
    const req = db.prepare('INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,1,1)');
    for (const l of ['boss@example.com', 'mia@example.com', 'new@example.com', 'waiting@example.com']) req.run(l, l);
    put(members(
      { login: 'boss@example.com', name: 'Boss', role: 'owner' },
      { login: 'mia@example.com', name: 'Mia', role: 'member' },
      { login: 'new@example.com', name: 'New', role: 'member' },
    ));
    importTeamFile(db, file());
    expect(row(o).t).toBe('boss@example.com');
    expect(byLogin('new@example.com')).toBeTruthy();
    expect(db.prepare('SELECT login FROM access_requests').all()).toEqual([{ login: 'waiting@example.com' }]);
  });
  it('creates the rest like an approval: email = login, unusable hash, login, name, role', () => {
    mkUser('o@x.io', 'owner');
    put(members(
      { login: 'ann@example.com', name: 'Ann', role: 'admin' },
      { login: 'bob@example.com', name: 'Bob', role: 'observer' },
      { login: 'cy@example.com', name: 'Cy', role: 'member' },
      { login: 'dee@example.com', name: 'Dee', role: 'janitor' },
      { login: 'eve@example.com', role: 'member' },
    ));
    importTeamFile(db, file());
    expect(byLogin('ann@example.com')).toMatchObject({ email: 'ann@example.com', name: 'Ann', h: '!', role: 'admin' });
    expect(byLogin('bob@example.com').role).toBe('observer');
    expect(byLogin('cy@example.com').role).toBe('member');
    expect(byLogin('dee@example.com').role).toBe('member');
    expect(byLogin('eve@example.com').name).toBe('eve@example.com');
  });
  it('ignores entries without a non-empty string login', () => {
    mkUser('o@x.io', 'owner');
    put(members({ name: 'x', role: 'member' }, { login: '', name: 'y' }, { login: 5 }, null, 'str', { login: 'ok@example.com', name: 'Ok', role: 'member' }));
    importTeamFile(db, file());
    expect(db.prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 2 });
    expect(byLogin('ok@example.com')).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });
  it('seat limit: logs and skips that one, the rest still come in', () => {
    db.prepare("UPDATE account SET billing_mode='stripe', plan_type='free', plan_status='active', trial_ends_at=NULL").run();
    mkUser('o@x.io', 'owner');
    for (let i = 0; i < 3; i++) mkUser(`m${i}@x.io`);
    put(members(
      { login: 'a@example.com', name: 'A', role: 'member' },
      { login: 'b@example.com', name: 'B', role: 'member' },
      { login: 'c@example.com', name: 'C', role: 'observer' },
    ));
    importTeamFile(db, file());
    expect(byLogin('a@example.com')).toBeTruthy();
    expect(byLogin('b@example.com')).toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2); // b over the seats, c observer feature
    expect(byLogin('c@example.com')).toBeUndefined();
  });
  it('running twice changes nothing the second time', () => {
    mkUser('o@x.io', 'owner');
    mkUser('mia@example.com', 'member');
    put(members(
      { login: 'boss@example.com', name: 'Boss', role: 'owner' },
      { login: 'mia@example.com', name: 'Mia', role: 'member' },
      { login: 'ann@example.com', name: 'Ann', role: 'admin' },
    ));
    importTeamFile(db, file());
    const once = snapshot();
    importTeamFile(db, file());
    expect(snapshot()).toBe(once);
  });
});

describe('start-up', () => {
  it('a hand-written file (no writer) is kept by the first write', () => {
    mkUser('o@x.io', 'owner');
    put({ version: 1, members: [
      { login: 'boss@example.com', name: 'Boss', role: 'owner' },
      { login: 'ann@example.com', name: 'Ann', role: 'member' },
    ] });
    vi.stubEnv('JT_TEAM_FILE', file());
    startTeamFile(db);
    const t = written();
    expect(t.writer).toBe('questlog');
    expect(t.members).toEqual([
      { login: 'ann@example.com', name: 'Ann', role: 'member' },
      { login: 'boss@example.com', name: 'o', role: 'owner' },
    ]);
  });
  it.each([
    ['bad JSON', '{nope'],
    ['version not 1', '{"version":2,"members":[]}'],
    ['members not an array', '{"version":1,"members":{}}'],
    ['not an object', '[]'],
  ])('an unusable file (%s) is left byte for byte, one error names the path, start carries on', (_n, text) => {
    mkUser('o@x.io', 'owner', { tailscale: 'boss@example.com' });
    put(text);
    vi.stubEnv('JT_TEAM_FILE', file());
    expect(() => startTeamFile(db)).not.toThrow();
    expect(readFileSync(file(), 'utf8')).toBe(text);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(file());
    expect(String(errors.mock.calls[0][0])).toContain('will not touch it');
  });
  it('a missing file still gets the normal start write', () => {
    mkUser('o@x.io', 'owner', { tailscale: 'boss@example.com' });
    vi.stubEnv('JT_TEAM_FILE', file());
    startTeamFile(db);
    expect(written().members).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });
  it('writeTeamFile unchanged for a db without a file', () => {
    mkUser('o@x.io', 'owner', { tailscale: 'boss@example.com' });
    writeTeamFile(db, file());
    expect(written().members).toHaveLength(1);
  });
});

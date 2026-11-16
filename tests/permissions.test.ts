import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, newId, type Db } from '../server/db';
import { can, assertCan, visibleProjectIds, type Action } from '../server/permissions';
import { AppError } from '../server/errors';
import type { User } from '../shared/types';

let db: Db;

function mkUser(role: string, disabled = false): User {
  const id = newId();
  db.prepare('INSERT INTO users (id,email,name,password_hash,disabled,created_at) VALUES (?,?,?,?,?,0)')
    .run(id, `${id}@x.io`, role, 'x', disabled ? 1 : 0);
  db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(id, role);
  return { id, email: `${id}@x.io`, name: role, timezone: null, disabled, createdAt: 0 };
}
let seq = 0;
function mkProject(visibility: 'full' | 'limited', archived = false): string {
  const id = newId();
  db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,?,?,?,?,?,0)')
    .run(id, ++seq, 'P', visibility, archived ? 1 : 0, '[]');
  return id;
}
function grant(p: string, u: User, role: string | null = null) {
  db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,?)').run(p, u.id, role);
}

beforeEach(() => { db = openDb(':memory:'); seq = 0; });

type Row = [string, string, Action, boolean];
const rows: Row[] = [
  ['admin', 'limited, no access', 'content.edit', true],
  ['member', 'full', 'content.edit', true],
  ['member', 'limited, no access', 'project.view', false],
  ['member', 'limited, with access', 'project.view', true],
  ['observer', 'full, no access', 'project.view', false],
  ['observer', 'with access', 'project.view', true],
  ['observer', 'with access', 'content.edit', false],
  ['member', 'full', 'project.manage', false],
  ['member (producer)', 'full', 'project.manage', true],
  ['member', '-', 'project.create', false],
  ['member', 'archived', 'content.edit', false],
  ['admin', 'archived', 'content.edit', true],
];

function build(userK: string, projK: string): { u: User; p?: string } {
  const role = userK.startsWith('member') ? 'member' : userK;
  const u = mkUser(role);
  if (projK === '-') return { u };
  const p = mkProject(projK.startsWith('limited') ? 'limited' : 'full', projK === 'archived');
  if (projK.includes('with access') || userK.includes('producer')) grant(p, u, userK.includes('producer') ? 'producer' : null);
  return { u, p };
}

describe('permissions', () => {
  it.each(rows)('%s / %s / %s -> %s', (userK, projK, action, expected) => {
    const { u, p } = build(userK, projK);
    expect(can(db, u, action, p)).toBe(expected);
  });

  it('owner and admin do everything', () => {
    const p = mkProject('limited', true);
    for (const r of ['owner', 'admin']) {
      const u = mkUser(r);
      for (const a of ['account.manage', 'user.manage', 'project.create'] as Action[]) expect(can(db, u, a)).toBe(true);
      for (const a of ['project.view', 'project.manage', 'content.edit'] as Action[]) expect(can(db, u, a, p)).toBe(true);
    }
  });

  it('unknown or missing projectId is false', () => {
    const a = mkUser('admin');
    expect(can(db, a, 'project.view', 'nope')).toBe(false);
    expect(can(db, a, 'content.edit')).toBe(false);
  });

  it('disabled user gets false', () => {
    const u = mkUser('owner', true);
    expect(can(db, u, 'account.manage')).toBe(false);
  });

  it('assertCan throws 403 forbidden', () => {
    const u = mkUser('member');
    try { assertCan(db, u, 'user.manage'); throw new Error('no throw'); } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(403);
      expect((e as AppError).code).toBe('forbidden');
    }
    expect(() => assertCan(db, mkUser('admin'), 'user.manage')).not.toThrow();
  });

  it('visibleProjectIds matches project.view', () => {
    const full = mkProject('full'), lim = mkProject('limited'), lim2 = mkProject('limited');
    const m = mkUser('member'), o = mkUser('observer'), a = mkUser('admin');
    grant(lim2, m); grant(lim2, o); grant(full, o);
    expect(visibleProjectIds(db, m)).toEqual(new Set([full, lim2]));
    expect(visibleProjectIds(db, o)).toEqual(new Set([lim2, full]));
    expect(visibleProjectIds(db, a)).toEqual(new Set([full, lim, lim2]));
    expect(visibleProjectIds(db, mkUser('observer'))).toEqual(new Set());
    expect(visibleProjectIds(db, mkUser('admin', true))).toEqual(new Set());
  });
});

import type { Db } from './db';
import { AppError } from './errors';
import { SYSTEM_ID } from './history';
import type { User } from '../shared/types';

export type Action =
  | 'account.manage' | 'user.manage' | 'project.create'
  | 'project.view' | 'project.manage' | 'content.edit'
  /** Shared workspace-wide content that belongs to no project (card presets): any non-observer member. */
  | 'workspace.edit'
  /** The actor's own workspace-wide rows that belong to no project (timezone, saved searches): any active user. */
  | 'workspace.personal';

export type TokenRole = 'admin' | 'producer' | 'limited';
export type TokenAccess = 'read' | 'write';

/**
 * Whoever acts: a session user, or a user acting through an API token (server/tokens.ts). A token never exceeds its
 * user: every check below is the user's own right AND what the token grants.
 * - `scopes`: 'read' and, for write tokens, 'write'.
 * - `projectIds`: null = no project confinement (sessions, admin-role tokens); else the token's projects. A confined
 *   token sees only those projects (intersected with what the user sees) and no deckless cards, which belong to no
 *   project.
 * - `tokenRole`: an admin-role token keeps the user's admin rights; producer and limited tokens never have them, and
 *   a limited token never manages a project.
 */
export interface Actor extends User {
  /** 'system': the server acting on its own (user reports, see systemActor). */
  via: 'session' | 'token' | 'system';
  scopes: TokenAccess[];
  projectIds: string[] | null;
  tokenRole: TokenRole | null;
  tokenId: string | null;
}

/** Plain `{id}` (another user, a session) or an actor; the token fields are optional so `{ id }` stays a full session check. */
export type Who = Pick<User, 'id'> & Partial<Pick<Actor, 'via' | 'scopes' | 'projectIds' | 'tokenRole'>>;

export function sessionActor(u: User): Actor {
  return { ...u, via: 'session', scopes: ['read', 'write'], projectIds: null, tokenRole: null, tokenId: null };
}
/**
 * The server itself, acting for a public endpoint that did its own authentication (user reports: a report token).
 * Changes are recorded as "System". It may view projects and add content to existing ones, nothing else: no
 * account, member or project management, and no workspace-wide rows. Never built from request input.
 */
export function systemActor(): Actor {
  return { id: SYSTEM_ID, email: '', name: 'System', timezone: null, disabled: false, createdAt: 0, via: 'system', scopes: ['read', 'write'], projectIds: null, tokenRole: null, tokenId: null };
}

/** The user fields of an actor (the snapshot's `me`). */
export function plainUser(a: User | Actor): User {
  const { via: _v, scopes: _s, projectIds: _p, tokenRole: _r, tokenId: _t, ...u } = a as Actor;
  return u;
}

/** A token confined to its projects (producer / limited): no deckless cards, nothing outside its projects. */
export const projectConfined = (who: Who): boolean => who.via === 'token' && !!who.projectIds;

/** What the token itself allows, before the user's own rights are checked. Sessions: everything. */
function tokenAllows(who: Who, action: Action, projectId?: string): boolean {
  if (who.via !== 'token') return true;
  const write = !!who.scopes?.includes('write');
  const inScope = !who.projectIds || (!!projectId && who.projectIds.includes(projectId));
  switch (action) {
    // Admin rights are also read rights (admin-only fields in the snapshot and /api/query), so they don't need 'write'
    // here; a read token never writes anyway, because /dispatch refuses it before any command runs.
    case 'account.manage': case 'user.manage': case 'project.create':
      return who.tokenRole === 'admin';
    // Workspace-wide resources: never for a project-confined token; an admin-role token as its user.
    case 'workspace.edit': case 'workspace.personal':
      return write && !who.projectIds;
    case 'project.view':
      return inScope;
    case 'project.manage':
      return write && inScope && who.tokenRole !== 'limited';
    case 'content.edit':
      return write && inScope;
  }
  return false;
}

/**
 * The workspace role of an enabled user, or null. Guests (Open Decks visitors, see isGuest) hold no workspace role: to
 * every check here they are like someone without an account role, so they see no project and may do nothing.
 */
function roleOf(db: Db, user: Who): string | null {
  const u = db.prepare('SELECT u.disabled d, r.role role FROM users u LEFT JOIN account_roles r ON r.user_id = u.id WHERE u.id = ?')
    .get(user.id) as { d: number; role: string | null } | undefined;
  if (!u || u.d || !u.role || u.role === 'guest') return null;
  return u.role;
}

/** A guest account: an Open Decks visitor with no workspace access, no seat, and no place in member lists. */
export function isGuest(db: Db, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM account_roles WHERE user_id = ? AND role = 'guest'").get(userId);
}

const isAdmin = (role: string) => role === 'owner' || role === 'admin';

function canView(db: Db, userId: string, role: string, projectId: string): boolean {
  const p = db.prepare('SELECT visibility FROM projects WHERE id = ?').get(projectId) as { visibility: string } | undefined;
  if (!p) return false;
  if (isAdmin(role)) return true;
  const hasRow = !!db.prepare('SELECT 1 FROM project_access WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  if (role === 'member') return p.visibility === 'full' || hasRow;
  if (role === 'observer') return hasRow;
  return false;
}

export function can(db: Db, user: Who, action: Action, projectId?: string): boolean {
  if (user.via === 'system') {
    return (action === 'project.view' || action === 'content.edit') && !!projectId
      && !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  }
  if (!tokenAllows(user, action, projectId)) return false;
  const role = roleOf(db, user);
  if (!role) return false;
  switch (action) {
    case 'account.manage':
    case 'user.manage':
    case 'project.create':
      return isAdmin(role);
    case 'workspace.edit':
      return role !== 'observer';
    case 'workspace.personal':
      return true;
    case 'project.view':
      return !!projectId && canView(db, user.id, role, projectId);
    case 'project.manage': {
      if (!projectId || !canView(db, user.id, role, projectId)) return false;
      if (isAdmin(role)) return true;
      const r = db.prepare('SELECT project_role pr FROM project_access WHERE project_id = ? AND user_id = ?')
        .get(projectId, user.id) as { pr: string | null } | undefined;
      return role === 'member' && r?.pr === 'producer';
    }
    case 'content.edit': {
      if (!projectId || !canView(db, user.id, role, projectId)) return false;
      if (isAdmin(role)) return true;
      if (role !== 'member') return false;
      const p = db.prepare('SELECT is_archived a FROM projects WHERE id = ?').get(projectId) as { a: number };
      return !p.a;
    }
  }
  return false;
}

export function assertCan(db: Db, user: Who, action: Action, projectId?: string): void {
  if (!can(db, user, action, projectId)) throw new AppError(403, 'forbidden');
}

export function visibleProjectIds(db: Db, user: Who): Set<string> {
  const ids = (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id);
  const role = roleOf(db, user);
  if (!role) return new Set();
  return new Set(ids.filter((id) => canView(db, user.id, role, id) && tokenAllows(user, 'project.view', id)));
}

/** Holds an active account role (enabled user with a role): the "may read anything at all" check. */
export function isActiveMember(db: Db, user: Who): boolean {
  return roleOf(db, user) !== null;
}

/**
 * API tokens: `Authorization: Bearer jtat_…` (org) / `jtut_…` (personal).
 *
 * - Only the SHA-256 hash of a token is stored; the plain token is returned once, by apiTokens/create.
 * - A token acts as its user (the owner of a personal token, the service user of an org token) and never exceeds that
 *   user: permissions are the user's own rights intersected with the token's role, access and projects
 *   (server/permissions.ts, Actor).
 * - Token requests are rate limited per IP (TokenRateLimiter), before any lookup.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db';
import { toCamel } from './db';
import { AppError } from './errors';
import { now } from './auth';
import type { Actor, TokenAccess, TokenRole } from './permissions';
import type { ApiToken, User } from '../shared/types';

export const TOKEN_PREFIX = { org: 'jtat_', user: 'jtut_' } as const;
/** Live (not revoked, not expired) tokens: org tokens per account, personal tokens per user. */
export const TOKEN_LIMITS = { org: 50, user: 20 } as const;
export const TOKEN_RATE = { max: 40, windowMs: 5000, maxIps: 10_000 } as const;
/** Characters kept in `prefix` for recognising a token in lists: the kind prefix plus 4 secret characters. */
const SHOWN_CHARS = 9;
const SECRET = /^jt[au]t_[A-Za-z0-9_-]{43}$/;
/** last_used_at is written at most this often per token. */
const LAST_USED_MS = 60_000;

/**
 * Commands a token can never run, whatever its role and access: token management, billing, integrations and the
 * Danger Zone, plus invites (minting a new login is managing credentials), user report settings (access key and
 * report tokens), onboarding progress (a person's own card log, not something a token does), a person's email
 * preferences (emailPrefs), and Open Decks: making a project public (openDecks) and a person's own votes and update
 * subscriptions (open), and removing guest accounts (guests).
 * Namespaces, i.e. the part of the command name before '/'.
 * accounts/update stays available to admin write tokens, except its userApiTokensEnabled switch (checked there).
 */
export const TOKEN_DENIED_NAMESPACES: ReadonlySet<string> = new Set(['apiTokens', 'billing', 'dangerZone', 'integrations', 'invites', 'teamRequests', 'userReports', 'onboarding', 'emailPrefs', 'open', 'openDecks', 'guests']);

/**
 * Single commands a token can never run, inside namespaces that are otherwise open to it. users/unlinkTailscale
 * ends Tailscale sessions and the link, so it is credential management like invites (and a token never uses its
 * "clear my own link" shortcut either). users/setRole and users/disable stay open to admin tokens (user.manage).
 */
export const TOKEN_DENIED_COMMANDS: ReadonlySet<string> = new Set(['users/unlinkTailscale']);

export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

export function newTokenSecret(kind: 'org' | 'user'): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX[kind] + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, SHOWN_CHARS) };
}

/** Client shape of a token row: never the hash. */
export function apiTokenRow(r: Record<string, unknown>): ApiToken {
  const { tokenHash: _h, projectIds, mayDelete, ...rest } = toCamel<Record<string, unknown>>(r);
  return { ...rest, mayDelete: !!mayDelete, projectIds: JSON.parse(String(projectIds ?? '[]')) } as ApiToken;
}

/**
 * The Bearer token of a request: null when there is no `Authorization: Bearer` header (no header, or another scheme
 * such as Basic from a reverse proxy: the cookie decides), '' for a malformed Bearer value (401 invalid_token).
 */
export function bearerOf(header: string | undefined): string | null {
  if (header === undefined || !/^Bearer(\s|$)/i.test(header)) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : '';
}

/**
 * The actor for a Bearer token, or 401: invalid_token (unknown, malformed or revoked), token_expired, not_a_member
 * (its user is disabled, has no role or is a guest), user_api_tokens_disabled (personal tokens switched off for the account).
 */
export function tokenActor(db: Db, token: string): Actor {
  const invalid = () => new AppError(401, 'invalid_token');
  if (!SECRET.test(token)) throw invalid();
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash=?').get(hash) as Record<string, any> | undefined;
  // Lookup by the SHA-256 of the secret: timing of the index probe reveals nothing usable about the secret itself.
  if (!row || row.revoked_at !== null) throw invalid();
  if (!token.startsWith(TOKEN_PREFIX[row.kind as 'org' | 'user'])) throw invalid();
  const t = now();
  if (row.expires_at !== null && row.expires_at <= t) throw new AppError(401, 'token_expired');
  const u = db.prepare("SELECT u.id, u.email, u.name, u.timezone, u.disabled, u.kind, u.created_at FROM users u JOIN account_roles r ON r.user_id=u.id WHERE u.id=? AND r.role != 'guest'")
    .get(row.user_id) as Record<string, unknown> | undefined;
  if (!u || u.disabled) throw new AppError(401, 'not_a_member');
  if (row.kind === 'user') {
    const acc = db.prepare('SELECT user_api_tokens_enabled e FROM account').get() as { e: number } | undefined;
    if (!acc?.e) throw new AppError(401, 'user_api_tokens_disabled');
  }
  if (row.last_used_at === null || t - row.last_used_at >= LAST_USED_MS) {
    db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(t, row.id);
  }
  const role = row.role as TokenRole;
  return {
    ...toCamel<User>(u),
    via: 'token',
    scopes: (row.access as TokenAccess) === 'write' ? ['read', 'write'] : ['read'],
    projectIds: role === 'admin' ? null : (JSON.parse(row.project_ids) as string[]),
    tokenRole: role,
    tokenId: row.id as string,
  };
}

/**
 * Whether a token was created with "May delete" (reported by MCP get_context; the rule itself is tokenCanDelete).
 * False for unknown tokens and for every token made before the option existed.
 */
export function tokenMayDelete(db: Db, tokenId: string | null): boolean {
  if (!tokenId) return false;
  const r = db.prepare('SELECT may_delete m FROM api_tokens WHERE id=?').get(tokenId) as { m: number } | undefined;
  return r?.m === 1;
}

/**
 * The one "May delete" rule (dispatch.ts assertTokenMayDelete for every deleting command, mcp.ts for its delete
 * tools): a personal token deletes only when created with "May delete". Sessions and the system always pass; org
 * (integration) tokens are not affected and delete as their role and access allow.
 */
export function tokenCanDelete(db: Db, actor: Pick<Actor, 'via' | 'tokenId'>): boolean {
  if (actor.via !== 'token') return true;
  const r = actor.tokenId ? db.prepare('SELECT kind, may_delete m FROM api_tokens WHERE id=?').get(actor.tokenId) as { kind: string; m: number } | undefined : undefined;
  if (!r) return false;
  return r.kind === 'org' || r.m === 1;
}

/**
 * Sliding-window limiter: at most `max` requests per `windowMs` per key. The map is LRU-bounded at `maxKeys`
 * (least recently seen key evicted first), and each entry holds at most `max` timestamps.
 */
export class TokenRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number = TOKEN_RATE.max, private windowMs: number = TOKEN_RATE.windowMs, private maxKeys: number = TOKEN_RATE.maxIps) {}

  get size(): number {
    return this.hits.size;
  }

  /** Records a request; returns 0 when allowed, else the seconds until the next one would be (rejected ones are not recorded). */
  hit(key: string, t: number = now()): number {
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    this.hits.delete(key); // re-inserted below: most recently used last
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil((list[0] + this.windowMs - t) / 1000));
    }
    list.push(t);
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return 0;
  }
}

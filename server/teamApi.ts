import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db';
import { AppError } from './errors';
import { now, publicUser, SESSION_MS } from './auth';
import { dispatchAll, registry, runAction, type ChangeEvent } from './dispatch';
import { sessionActor, type Actor } from './permissions';
import { peerAddress, viaProxy, type TailscalePerson } from './tailscale';
import type { LiveHub } from './live';

/**
 * The team members API for the Jatify Launcher's Server tab (TEAM-SERVER.md, README "Team server"):
 *   GET    /team/members                  any member: enabled people, their role, since and last sign-in
 *   GET    /team/requests                 owner/admin: pending join requests, newest first
 *   POST   /team/members                  owner/admin: add a login (or re-enable a disabled one)
 *   PATCH  /team/members/:login           owner/admin: change a role
 *   DELETE /team/members/:login           owner/admin: disable (sessions end, leaves team.json)
 *   POST   /team/requests/:login/approve  owner/admin
 *   POST   /team/requests/:login/deny     owner/admin
 *
 * The caller is their Tailscale identity, exactly as /team/whoami (socket peer, never a header), or the owner through
 * JATIFY_ADMIN_TOKEN from loopback. Every change runs the Members page's own commands (server/commands/account.ts:
 * users/setRole, users/disable, teamRequests/approve, teamRequests/dismiss) as the caller, so permission, observer
 * feature and seat rules, live events and the team.json sync are theirs. On top, this API adds the rules agreed with
 * the Launcher: role owner is never given here (409 owner_transfer), the owner is never changed or removed here
 * (409 last_owner), and only the owner makes or unmakes an admin (403 forbidden).
 * Errors: {error, message}; the Launcher shows `message` as is.
 */

type Role = 'owner' | 'admin' | 'member' | 'observer';
export interface TeamMember { login: string | null; name: string; role: Role; since: string; lastSeen: string | null }

export interface TeamApiOptions {
  db: Db;
  hub: LiveHub;
  /** The connection's Tailscale person (server/app.ts): null when the switch is off, through a proxy, off the tailnet. */
  tailscalePeer: (req: FastifyRequest) => Promise<TailscalePerson | null>;
}

const MESSAGES: Record<string, string> = {
  not_member: "You're not on this team.",
  forbidden: 'Only the owner and admins can manage members.',
  owner_transfer: "Ownership moves in Questlog's settings (Danger zone).",
  last_owner: "The owner can't be changed or removed here.",
  already_member: 'That person is already on the team.',
  disabled_member: 'That login belongs to a disabled person.',
  not_found: 'No such member or request.',
  plan_limit: 'No seat left on this plan.',
  plan_feature: "This plan doesn't include that role.",
  invalid_payload: 'The request is missing a valid login or role.',
  cross_origin: 'Requests from web pages are refused.',
  workspace_disabled: 'This workspace is disabled.',
  bad_host: "This server doesn't answer to that host name.",
};

const fail = (status: number, code: string, message?: string) => new AppError(status, code, message === undefined ? undefined : { message });

/**
 * An error answered outside this module's routes (server/app.ts: the Host/Origin hook, the disabled-workspace gate,
 * the not-found handler): under /team/ it carries a `message` like every other error of this API.
 */
export function teamErrorBody(url: string, code: string, message?: string): { error: string; message?: string } {
  if (!url.toLowerCase().startsWith('/team/')) return { error: code };
  return { error: code, message: message ?? MESSAGES[code] ?? 'The request was refused.' };
}

const ROLES = ['owner', 'admin', 'member', 'observer'] as const;
const loginSchema = z.string().trim().min(1).max(320);
const roleBody = z.object({ role: z.enum(ROLES) });
const addBody = z.object({ login: loginSchema, name: z.string().trim().max(200).optional(), role: z.enum(ROLES) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw fail(400, 'invalid_payload');
  return r.data;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** True when JATIFY_ADMIN_TOKEN is non-empty and the request's X-Jatify-Token equals it (constant time). Any peer. */
export function adminTokenSent(req: FastifyRequest): boolean {
  const expected = process.env.JATIFY_ADMIN_TOKEN ?? '';
  const sent = req.headers['x-jatify-token'];
  if (!expected || typeof sent !== 'string') return false;
  return timingSafeEqual(sha(sent), sha(expected));
}

/**
 * A request straight from this machine: loopback socket peer (127.0.0.1 or ::1) and no proxy headers. Never with
 * JT_LOOPBACK_TRUST=0 (the Docker image sets it): in a container, a userspace Tailscale sidecar or rootless port
 * forwarding can hand over remote callers from 127.0.0.1, so loopback says nothing about who is calling.
 */
export function directLoopback(req: FastifyRequest): boolean {
  if (process.env.JT_LOOPBACK_TRUST === '0' || viaProxy(req.headers)) return false;
  const addr = peerAddress(req.socket.remoteAddress);
  return !!addr && LOOPBACK.has(addr);
}

export function registerTeamApi(app: FastifyInstance, opts: TeamApiOptions): void {
  const { db, hub, tailscalePeer } = opts;

  const iso = (ms: number) => new Date(ms).toISOString();
  const MEMBER_SELECT = `SELECT u.id, u.tailscale_login AS login, u.name, r.role, u.created_at,
      (SELECT MAX(s.expires_at) FROM sessions s WHERE s.user_id=u.id) AS last_exp
    FROM users u JOIN account_roles r ON r.user_id=u.id
    WHERE u.disabled=0 AND u.kind='person' AND r.role IN ('owner','admin','member','observer')`;
  type Row = { id: string; login: string | null; name: string; role: Role; created_at: number; last_exp: number | null };
  const entry = (r: Row): TeamMember => ({
    login: r.login, name: r.name, role: r.role, since: iso(r.created_at),
    // A session lives SESSION_MS from its sign-in, so the newest one tells when they last signed in.
    lastSeen: r.last_exp === null ? null : iso(r.last_exp - SESSION_MS),
  });
  const memberById = (id: string) => entry(db.prepare(`${MEMBER_SELECT} AND u.id=?`).get(id) as Row);
  /** An enabled team member by Tailscale login, or 404. */
  const memberByLogin = (login: string) => {
    const r = db.prepare(`${MEMBER_SELECT} AND u.tailscale_login=?`).get(login) as Row | undefined;
    if (!r) throw fail(404, 'not_found', 'No team member has that login.');
    return r;
  };

  /** JATIFY_ADMIN_TOKEN: a loopback request (no proxy headers) with the matching X-Jatify-Token acts as the owner. */
  const tokenOwner = (req: FastifyRequest): string | null => {
    // Here the token is loopback-only; POST /api/setup (server/app.ts) is the one place it is taken from any peer.
    if (!directLoopback(req) || !adminTokenSent(req)) return null;
    const o = db.prepare(`SELECT u.id FROM users u JOIN account_roles r ON r.user_id=u.id
      WHERE r.role='owner' AND u.disabled=0 ORDER BY u.created_at LIMIT 1`).get() as { id: string } | undefined;
    return o?.id ?? null;
  };

  /** The caller as an actor with their workspace role; 403 not_member for anyone not an enabled team person. */
  const caller = async (req: FastifyRequest): Promise<{ actor: Actor; role: Role }> => {
    let id = tokenOwner(req);
    if (!id) {
      const person = await tailscalePeer(req);
      if (!person) throw fail(403, 'not_member');
      id = (db.prepare(`${MEMBER_SELECT} AND u.tailscale_login=?`).get(person.login) as Row | undefined)?.id ?? null;
      if (!id) throw fail(403, 'not_member');
    }
    const row = db.prepare(`${MEMBER_SELECT} AND u.id=?`).get(id) as Row | undefined;
    if (!row) throw fail(403, 'not_member');
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id) as Record<string, unknown>);
    return { actor: sessionActor(user), role: row.role };
  };
  const manager = async (req: FastifyRequest) => {
    const c = await caller(req);
    if (c.role !== 'owner' && c.role !== 'admin') throw fail(403, 'forbidden');
    return c;
  };
  /**
   * The role of the person teamRequests/approve would relink for this login (an unlinked passwordless person whose
   * email is the login), so the admin rule covers them too.
   */
  const relinkRole = (login: string) =>
    (db.prepare(`SELECT r.role FROM users u JOIN account_roles r ON r.user_id=u.id
      WHERE u.email=? COLLATE NOCASE AND u.tailscale_login IS NULL AND u.password_hash='!'`).get(login) as { role: string } | undefined)?.role ?? '';
  const noOwnerRole = (role: Role) => { if (role === 'owner') throw fail(409, 'owner_transfer'); };
  /** Only the owner makes or unmakes an admin. */
  const adminRule = (who: Role, ...roles: (Role | string)[]) => {
    if (who !== 'owner' && roles.includes('admin')) throw fail(403, 'forbidden', 'Only the owner can make or unmake an admin.');
  };
  const publish = (r: { actionId: string; events: ChangeEvent[] }) => {
    if (!r.events.length) return;
    try { hub.publish(r.actionId, r.events); } catch (e) { console.error('live publish failed', e); }
  };
  const run = (actor: Actor, calls: { name: string; payload: unknown }[]) => publish(dispatchAll(db, actor, calls));

  app.register(async (inst) => {
    // Bodiless writes (DELETE, deny) still carry Content-Type: application/json; an empty body is {}.
    inst.removeContentTypeParser('application/json');
    inst.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, text, done) => {
      const s = String(text);
      if (!s.trim()) return done(null, {});
      try { done(null, JSON.parse(s)); } catch { done(fail(400, 'invalid_payload', 'The request body is not valid JSON.'), undefined); }
    });

    inst.setErrorHandler((err: any, req, reply) => {
      if (err instanceof AppError) {
        const d = err.data as { message?: unknown } | undefined;
        const message = typeof d?.message === 'string' ? d.message : MESSAGES[err.code] ?? 'The request was refused.';
        return reply.code(err.status).send({ error: err.code, message });
      }
      if (err?.statusCode >= 400 && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ error: 'bad_request', message: 'The request could not be read.' });
      }
      console.error('[jt] unhandled error', req.method, req.routeOptions?.url ?? '(no route)', String(err?.message ?? err));
      return reply.code(500).send({ error: 'internal', message: 'Something went wrong on the server.' });
    });

    // Writes: no Origin at all (a web page always sends one), X-Jatify: 1 and a JSON content type (neither of which a
    // page can send cross-origin without a preflight this server never answers). Before any identity lookup.
    inst.addHook('onRequest', async (req) => {
      if (req.method === 'GET' || req.method === 'HEAD') return;
      if (req.headers.origin !== undefined) throw fail(403, 'cross_origin');
      if (req.headers['x-jatify'] !== '1') throw fail(403, 'cross_origin', 'Writes need the X-Jatify: 1 header.');
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw fail(403, 'cross_origin', 'Writes need Content-Type: application/json.');
    });

    inst.get('/team/members', async (req) => {
      await caller(req);
      const rows = db.prepare(`${MEMBER_SELECT}
        ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name COLLATE NOCASE, u.id`).all() as Row[];
      return { members: rows.map(entry) };
    });

    inst.get('/team/requests', async (req) => {
      await manager(req);
      const rows = db.prepare('SELECT login, display_name, last_seen FROM access_requests ORDER BY last_seen DESC, login').all() as
        { login: string; display_name: string; last_seen: number }[];
      return { requests: rows.map((r) => ({ login: r.login, name: r.display_name, at: iso(r.last_seen) })) };
    });

    inst.post('/team/members', async (req, reply) => {
      const { actor, role: who } = await manager(req);
      const { login, name, role } = parse(addBody, req.body);
      noOwnerRole(role);
      const known = db.prepare(`SELECT u.id, u.disabled, r.role FROM users u LEFT JOIN account_roles r ON r.user_id=u.id
        WHERE u.tailscale_login=?`).get(login) as { id: string; disabled: number; role: string | null } | undefined;
      if (known && !known.disabled) throw fail(409, 'already_member');
      if (known) {
        // Re-enable a removed person with the role: the role first (no seat check while disabled), then users/disable
        // checks the seat for the new role. One transaction.
        if (known.role === 'owner') throw fail(409, 'last_owner');
        adminRule(who, role, known.role ?? '');
        run(actor, [
          { name: 'users/setRole', payload: { userId: known.id, role } },
          { name: 'users/disable', payload: { userId: known.id, disabled: false } },
        ]);
        return reply.code(200).send(memberById(known.id));
      }
      const relink = relinkRole(login);
      if (relink === 'owner') throw fail(409, 'last_owner');
      adminRule(who, role, relink);
      // Someone who hasn't asked: their request is made here and approved at once, by the approve command itself
      // (relink of an unlinked passwordless person, observer feature, seats, live events, team.json). Rolled back
      // together on any refusal.
      const approve = registry['teamRequests/approve'];
      const input = parse(approve.schema, { login, role });
      const at = now();
      // No name given: a pending request's Tailscale display name, else the login.
      const asked = (db.prepare('SELECT display_name FROM access_requests WHERE login=?').get(login) as { display_name: string } | undefined)?.display_name;
      const display = name || asked || login;
      const r = runAction(db, actor, (ctx) => {
        ctx.db.prepare(`INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)
          ON CONFLICT(login) DO UPDATE SET display_name=excluded.display_name`).run(login, display, at, at);
        approve.run(ctx, input);
      });
      publish(r);
      return reply.code(201).send(memberById(memberByLogin(login).id));
    });

    inst.patch('/team/members/:login', async (req) => {
      const { actor, role: who } = await manager(req);
      const { role } = parse(roleBody, req.body);
      noOwnerRole(role);
      const target = memberByLogin((req.params as { login: string }).login);
      if (target.role === 'owner') throw fail(409, 'last_owner');
      adminRule(who, role, target.role);
      run(actor, [{ name: 'users/setRole', payload: { userId: target.id, role } }]);
      return memberById(target.id);
    });

    inst.delete('/team/members/:login', async (req, reply) => {
      const { actor, role: who } = await manager(req);
      const target = memberByLogin((req.params as { login: string }).login);
      if (target.role === 'owner') throw fail(409, 'last_owner');
      adminRule(who, target.role);
      // users/disable deletes their sessions (live sockets and rooms check the session row on every message) and
      // known devices, and syncs team.json.
      run(actor, [{ name: 'users/disable', payload: { userId: target.id, disabled: true } }]);
      return reply.code(204).send();
    });

    inst.post('/team/requests/:login/approve', async (req, reply) => {
      const { actor, role: who } = await manager(req);
      const { role } = parse(roleBody, req.body);
      noOwnerRole(role);
      const login = (req.params as { login: string }).login;
      const relink = relinkRole(login);
      if (relink === 'owner') throw fail(409, 'last_owner');
      adminRule(who, role, relink);
      if (!db.prepare('SELECT 1 FROM access_requests WHERE login=?').get(login)) throw fail(404, 'not_found', 'No join request from that login.');
      run(actor, [{ name: 'teamRequests/approve', payload: { login, role } }]);
      return reply.code(201).send(memberById(memberByLogin(login).id));
    });

    inst.post('/team/requests/:login/deny', async (req, reply) => {
      const { actor } = await manager(req);
      run(actor, [{ name: 'teamRequests/dismiss', payload: { login: (req.params as { login: string }).login } }]);
      return reply.code(204).send();
    });
  });
}

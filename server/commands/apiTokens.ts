import { z } from 'zod';
import { newId, toCamel } from '../db';
import { AppError } from '../errors';
import { now } from '../auth';
import { can } from '../permissions';
import { apiTokenRow, newTokenSecret, TOKEN_LIMITS } from '../tokens';
import { userRow } from './rows';
import type { Command, Ctx } from '../dispatch';

/** Token commands are for session users only (dispatch refuses token actors first; this is the backstop). */
function sessionOnly(ctx: Ctx): void {
  if (ctx.actor.via !== 'session') throw new AppError(403, 'missing_scope', { requiredScope: 'session' });
}

const tokenRow = (ctx: Ctx, id: string) => ctx.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(id) as Record<string, any> | undefined;

/** Service users never log in: an unusable password hash (no scheme verifyPassword accepts) and an unroutable address. */
const SERVICE_PASSWORD = '!service';

const createSchema = z.object({
  kind: z.enum(['org', 'user']),
  label: z.string().trim().min(1).max(80),
  role: z.enum(['admin', 'producer', 'limited']),
  access: z.enum(['read', 'write']),
  projectIds: z.array(z.string()).max(500),
  expiresAt: z.number().int().nullable().optional(),
  /** MCP may delete tasks, lists and milestones: personal write tokens only (MCP takes personal tokens only). */
  mayDelete: z.boolean().optional(),
});

export const apiTokenCommands: Record<string, Command> = {
  /**
   * Returns `{id, token}`: the only time the plain token exists outside the caller. Personal tokens act as the creator;
   * an org token gets its own service user (name = label) holding the token's role and explicit project access.
   */
  'apiTokens/create': {
    schema: createSchema,
    run(ctx, input: z.infer<typeof createSchema>) {
      sessionOnly(ctx);
      const { db, actor } = ctx;
      const t = now();
      const admin = can(db, actor, 'account.manage');
      // Org tokens are account-level; an admin-role token needs an admin behind it.
      if ((input.kind === 'org' || input.role === 'admin') && !admin) throw new AppError(403, 'forbidden');
      if (input.kind === 'user') {
        const acc = db.prepare('SELECT user_api_tokens_enabled e FROM account').get() as { e: number } | undefined;
        if (!acc?.e) throw new AppError(403, 'user_api_tokens_disabled');
      }
      if (input.mayDelete && (input.kind !== 'user' || input.access !== 'write')) throw new AppError(400, 'invalid_payload', { field: 'mayDelete' });
      if (input.expiresAt != null && input.expiresAt <= t) throw new AppError(400, 'invalid_payload', { field: 'expiresAt' });
      // Admin-role tokens are not confined to projects; the others need at least one project their creator can see.
      const projectIds = input.role === 'admin' ? [] : [...new Set(input.projectIds)];
      if (input.role !== 'admin' && projectIds.length === 0) throw new AppError(400, 'invalid_payload', { field: 'projectIds' });
      for (const p of projectIds) {
        if (!can(db, actor, 'project.view', p)) throw new AppError(400, 'invalid_payload', { field: 'projectIds' });
      }
      const live = input.kind === 'org'
        ? db.prepare("SELECT COUNT(*) n FROM api_tokens WHERE kind='org' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").get(t)
        : db.prepare("SELECT COUNT(*) n FROM api_tokens WHERE kind='user' AND user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").get(actor.id, t);
      if ((live as { n: number }).n >= TOKEN_LIMITS[input.kind]) throw new AppError(409, 'limit_reached', { limit: TOKEN_LIMITS[input.kind] });

      let userId = actor.id;
      if (input.kind === 'org') {
        userId = newId();
        db.prepare("INSERT INTO users (id,email,name,password_hash,kind,created_at) VALUES (?,?,?,?,'service',?)")
          .run(userId, `${userId}@service.invalid`, input.label, SERVICE_PASSWORD, t);
        const role = input.role === 'admin' ? 'admin' : 'member';
        db.prepare('INSERT INTO account_roles (user_id, role) VALUES (?,?)').run(userId, role);
        ctx.emit('user', 'upsert', userRow(db, userId)!);
        ctx.emit('accountRole', 'upsert', { userId, role });
        const grant = db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,?)');
        for (const p of projectIds) {
          grant.run(p, userId, input.role === 'producer' ? 'producer' : null);
          ctx.emit('projectAccess', 'upsert', toCamel(db.prepare('SELECT * FROM project_access WHERE project_id=? AND user_id=?').get(p, userId) as Record<string, unknown>));
        }
      }
      const id = newId();
      const secret = newTokenSecret(input.kind);
      db.prepare(`INSERT INTO api_tokens (id,kind,label,token_hash,prefix,role,access,project_ids,user_id,creator_id,created_at,expires_at,may_delete)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.kind, input.label, secret.hash, secret.prefix, input.role, input.access, JSON.stringify(projectIds), userId, actor.id, t, input.expiresAt ?? null, input.mayDelete ? 1 : 0);
      ctx.emit('apiToken', 'upsert', apiTokenRow(tokenRow(ctx, id)!));
      return { id, token: secret.token };
    },
  },
  /** The token's owner, or an admin (org tokens and other members' tokens). Revoking an org token disables its service user. */
  'apiTokens/revoke': {
    schema: z.object({ id: z.string() }),
    run(ctx, { id }) {
      sessionOnly(ctx);
      const { db, actor } = ctx;
      const row = tokenRow(ctx, id);
      const mine = row?.kind === 'user' && row.user_id === actor.id;
      if (!row) throw new AppError(404, 'not_found');
      if (!mine && !can(db, actor, 'account.manage')) throw new AppError(403, 'forbidden');
      if (row.revoked_at !== null) return;
      db.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').run(now(), id);
      if (row.kind === 'org') {
        db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(row.user_id);
        ctx.emit('user', 'upsert', userRow(db, row.user_id)!);
      }
      ctx.emit('apiToken', 'upsert', apiTokenRow(tokenRow(ctx, id)!));
    },
  },
};

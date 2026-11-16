/**
 * Git commit references: GitHub, GitLab and BitBucket webhooks (also Gitea and self-hosted GitLab).
 *
 * - Hooks (integrations/createGitHook, deleteGitHook; admins with a session, never API tokens): each generated URL
 *   belongs to the workspace and stores its creator, created date and last delivery. GitHub and GitLab secrets are
 *   generated here, shown once and kept encrypted (common.ts); a BitBucket secret is part of the URL, shown once, and
 *   only its SHA-256 is kept (compared timing-safe).
 * - Endpoints, all server to server (raw body, at most 1 MB):
 *     POST /integrations/github/:hookId            X-Hub-Signature-256 (HMAC-SHA256 of the raw body), `push`
 *     POST /integrations/gitlab/:hookId            X-Gitlab-Token, `Push Hook`
 *     POST /integrations/bitbucket/:hookId/:secret per-URL secret, `repo:push`
 *   Unknown hook or wrong BitBucket secret 404, bad signature or token 401. Per IP before the hook is looked at and per
 *   hook after it verified, so junk can't use up a real hook's allowance. A delivery id is handled once.
 * - A push is capped at MAX_COMMITS commits (and MAX_REFS_PER_PUSH references). Each `$code` in a message adds a history
 *   row "referenced in commit <sha> by <author>" (with the commit's http(s) link) to that card; `closes $code` and
 *   `review $code` run through the command pipeline as the hook's creator, with the creator's rights. A card the
 *   creator can't see (or outside the hook's project), a creator who is disabled, no longer a member or has no right to
 *   do it: skipped silently. Author emails are never stored.
 */
import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import { newId } from '../db';
import { AppError } from '../errors';
import { now } from '../auth';
import { dispatchAll, runAction, type Command } from '../dispatch';
import { can, sessionActor, systemActor, type Actor } from '../permissions';
import { canSeeCard } from '../access';
import { TokenRateLimiter } from '../tokens';
import { emitCard } from '../commands/cards';
import { projectRow, userRow } from '../commands/rows';
import { recordHistory, SYSTEM_ID } from '../history';
import { publicUrlOf } from '../email';
import { seqFromCode } from '../../shared/cards';
import { parseCommitRefs } from '../../shared/commitRefs';
import type { User } from '../../shared/types';
import type { LiveHub } from '../live';
import { firstSeen, openFor, sealFor, wasSeen } from './common';

export type GitKind = 'github' | 'gitlab' | 'bitbucket';
export const BODY_MAX = 1024 * 1024;
export const MAX_COMMITS = 50;
const MAX_REFS_PER_PUSH = 200;
const MAX_HOOKS = 50;
/** Handled commits remembered per database: this long, and at most this many (newest kept). */
const SEEN_KEEP_MS = 90 * 86_400_000;
const SEEN_MAX = 20_000;
const MESSAGE_MAX = 10_000;
const AUTHOR_MAX = 100;
const URL_MAX = 500;
/** Requests per minute: per IP before a hook is looked at, per hook once its signature checked out. */
const IP_RATE = { max: 120, windowMs: 60_000 };
const HOOK_RATE = { max: 60, windowMs: 60_000 };

interface HookRow {
  id: string; kind: GitKind; secret_sealed: string | null; secret_hash: string | null;
  creator_id: string; project_id: string | null; created_at: number; last_delivery_at: number | null;
}
const hookRow = (db: Db, id: string) => db.prepare('SELECT * FROM git_hooks WHERE id=?').get(id) as HookRow | undefined;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hookSlot = (id: string) => `git:${id}`;
/** Constant-time equality of two strings of any length (compared as SHA-256 digests). */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// ---------------------------------------------------------------------------------------------------------------
// Settings

const createSchema = z.object({ kind: z.enum(['github', 'gitlab', 'bitbucket']), projectId: z.string().nullable().optional() });
const assertAdmin = (db: Db, actor: Actor) => { if (!can(db, actor, 'account.manage')) throw new AppError(403, 'forbidden'); };

export const gitCommands: Record<string, Command> = {
  'integrations/createGitHook': {
    schema: createSchema,
    run(ctx, input: z.infer<typeof createSchema>) {
      const { db } = ctx;
      assertAdmin(db, ctx.actor);
      if (input.projectId && !projectRow(db, input.projectId)) throw new AppError(400, 'invalid_payload', { field: 'projectId' });
      if ((db.prepare('SELECT COUNT(*) n FROM git_hooks').get() as { n: number }).n >= MAX_HOOKS) throw new AppError(409, 'too_many_hooks');
      const id = newId();
      const secret = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO git_hooks (id, kind, secret_sealed, secret_hash, creator_id, project_id, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.kind, input.kind === 'bitbucket' ? null : sealFor(db, hookSlot(id), secret), input.kind === 'bitbucket' ? sha256hex(secret) : null, ctx.actor.id, input.projectId ?? null, now());
      const base = `${publicUrlOf(db)}/integrations/${input.kind}/${id}`;
      // The only time the secret leaves the server.
      return input.kind === 'bitbucket' ? { id, url: `${base}/${secret}` } : { id, url: base, secret };
    },
  },
  'integrations/deleteGitHook': {
    schema: z.object({ id: z.string() }),
    run(ctx, { id }: { id: string }) {
      assertAdmin(ctx.db, ctx.actor);
      if (ctx.db.prepare('DELETE FROM git_hooks WHERE id=?').run(id).changes === 0) throw new AppError(404, 'not_found');
      ctx.db.prepare('DELETE FROM git_commit_seen WHERE hook_id=?').run(id);
    },
  },
};

/** The hooks as admins see them: never a secret; a BitBucket URL is shown without its secret. */
export function gitHookList(db: Db) {
  const base = publicUrlOf(db);
  return (db.prepare('SELECT * FROM git_hooks ORDER BY created_at, id').all() as unknown as HookRow[]).map((h) => ({
    id: h.id, kind: h.kind, projectId: h.project_id, creatorId: h.creator_id, createdAt: h.created_at, lastDeliveryAt: h.last_delivery_at,
    url: `${base}/integrations/${h.kind}/${h.id}${h.kind === 'bitbucket' ? '/…' : ''}`,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Payloads

interface PushCommit { sha: string; message: string; author: string; url: string | null }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
/** The link only when it is an http(s) URL. */
export function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > URL_MAX) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
/** A display name: no control characters, and an `email` part of "Name <email>" is dropped. */
const cleanAuthor = (v: unknown): string =>
  // eslint-disable-next-line no-control-regex
  str(v, 300).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, AUTHOR_MAX);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function commitOf(sha: unknown, message: unknown, url: unknown, author: unknown): PushCommit | null {
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{7,64}$/.test(sha)) return null;
  return { sha: sha.toLowerCase(), message: str(message, MESSAGE_MAX), author: cleanAuthor(author) || 'someone', url: safeHttpUrl(url) };
}

/** The commits of a GitHub or GitLab push body (`commits: [{id, message, url, author: {name}}]`). */
export function listedCommits(body: unknown): PushCommit[] {
  const list = isObj(body) && Array.isArray(body.commits) ? body.commits.slice(0, MAX_COMMITS) : [];
  return list.flatMap((c) => (isObj(c) ? [commitOf(c.id, c.message, c.url, isObj(c.author) ? c.author.name ?? c.author.username : null)] : [])).filter((c): c is PushCommit => !!c);
}

/** The commits of a BitBucket `repo:push` body (`push.changes[].commits[]`). */
export function bitbucketCommits(body: unknown): PushCommit[] {
  const out: PushCommit[] = [];
  const changes = isObj(body) && isObj(body.push) && Array.isArray(body.push.changes) ? body.push.changes.slice(0, MAX_COMMITS) : [];
  for (const ch of changes) {
    for (const c of isObj(ch) && Array.isArray(ch.commits) ? ch.commits : []) {
      if (out.length >= MAX_COMMITS) return out;
      if (!isObj(c)) continue;
      const k = commitOf(c.hash, c.message, isObj(c.links) && isObj(c.links.html) ? c.links.html.href : null, isObj(c.author) ? c.author.user?.display_name ?? c.author.raw : null);
      if (k && !out.some((x) => x.sha === k.sha)) out.push(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Effects

interface CardRef { id: string; deckId: string | null; creatorId: string; visibility: string; projectId: string | null }
const cardBySeq = (db: Db, seq: number) => db.prepare(`SELECT c.id, c.deck_id deckId, c.creator_id creatorId, c.visibility, d.project_id projectId
  FROM cards c LEFT JOIN decks d ON d.id=c.deck_id WHERE c.seq=?`).get(seq) as CardRef | undefined;

/** Applies a push: history rows (as System) and commands (as the hook's creator). Returns how many cards were touched. */
export function applyPush(db: Db, hub: Pick<LiveHub, 'publish'>, hook: HookRow, commits: PushCommit[]): number {
  const creator = userRow(db, hook.creator_id) as User | undefined;
  // A creator who is gone, disabled or no longer a member of the workspace: nothing happens.
  if (!creator || creator.disabled || !db.prepare("SELECT 1 FROM account_roles WHERE user_id=? AND role!='guest'").get(creator.id)) return 0;
  const actor = sessionActor(creator);
  const publish = (r: { actionId: string; events: any[] }) => { try { hub.publish(r.actionId, r.events); } catch (e) { console.error('live publish failed', e); } };
  const seen = db.prepare(`SELECT 1 FROM card_history WHERE card_id=? AND changes_json LIKE '%"kind":"commit"%' AND changes_json LIKE ?`);
  const seenCommit = db.prepare('SELECT 1 FROM git_commit_seen WHERE hook_id=? AND sha=?');
  const markCommit = db.prepare('INSERT OR IGNORE INTO git_commit_seen (hook_id, sha, seen_at) VALUES (?,?,?)');
  db.prepare('DELETE FROM git_commit_seen WHERE rowid IN (SELECT rowid FROM git_commit_seen WHERE seen_at < ? LIMIT 200)').run(now() - SEEN_KEEP_MS);
  const cut = db.prepare('SELECT rowid r FROM git_commit_seen ORDER BY rowid DESC LIMIT 1 OFFSET ?').get(SEEN_MAX) as { r: number } | undefined;
  if (cut) db.prepare('DELETE FROM git_commit_seen WHERE rowid <= ?').run(cut.r);
  let refsLeft = MAX_REFS_PER_PUSH;
  let touched = 0;
  for (const c of commits) {
    // A commit this hook has handled (listed again by a merge or a replayed body): nothing more happens for it.
    if (seenCommit.get(hook.id, c.sha)) continue;
    markCommit.run(hook.id, c.sha, now());
    const { refs, commands } = parseCommitRefs(c.message);
    const usable = (code: string): CardRef | null => {
      const seq = seqFromCode(code);
      const card = seq === null ? undefined : cardBySeq(db, seq);
      if (!card || card.visibility === 'deleted') return null;
      if (hook.project_id && card.projectId !== hook.project_id) return null;
      return canSeeCard(db, actor, card, card.projectId) ? card : null;
    };
    const cards = new Map<string, CardRef>();
    for (const code of refs) {
      if (refsLeft-- <= 0) break;
      const card = usable(code);
      if (card) cards.set(code, card);
    }
    const fresh = [...cards.values()].filter((card) => !seen.get(card.id, `%"sha":"${c.sha}"%`));
    if (fresh.length) {
      publish(runAction(db, systemActor(), (ctx) => {
        for (const card of fresh) {
          recordHistory(db, card.id, SYSTEM_ID, [{ kind: 'commit', to: { sha: c.sha, author: c.author, url: c.url } }]);
          emitCard(ctx, card.id);
        }
      }));
      touched += fresh.length;
    }
    for (const cmd of commands) {
      const card = cards.get(cmd.code);
      if (!card) continue;
      try {
        publish(dispatchAll(db, actor, [cmd.action === 'close'
          ? { name: 'cards/update', payload: { id: card.id, status: 'done' } }
          : { name: 'resolvables/create', payload: { cardId: card.id, context: 'review', content: `Review requested in commit ${c.sha.slice(0, 7)} by ${c.author}` } }]));
      } catch (e) {
        if (!(e instanceof AppError)) throw e; // no right, wrong state: skipped silently
      }
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------------------------------------------
// Endpoints

export interface GitRouteDeps { db: Db; hub: Pick<LiveHub, 'publish'> }

export function registerGitRoutes(app: FastifyInstance, d: GitRouteDeps): void {
  const { db } = d;
  const ipLimiter = new TokenRateLimiter(IP_RATE.max, IP_RATE.windowMs);
  const hookLimiter = new TokenRateLimiter(HOOK_RATE.max, HOOK_RATE.windowMs, 1000);

  /** The rest of a delivery once the caller proved itself. */
  const deliver = (hook: HookRow, rawBody: Buffer, delivery: string, wanted: boolean, parse: (b: unknown) => PushCommit[]) => {
    const wait = hookLimiter.hit(hook.id);
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    db.prepare('UPDATE git_hooks SET last_delivery_at=? WHERE id=?').run(now(), hook.id);
    if (!wanted) return { ok: true, ignored: true };
    let body: unknown;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new AppError(400, 'invalid_payload'); }
    const key = `${hook.id}:${delivery.slice(0, 200)}`;
    if (delivery && wasSeen(db, 'git', key)) return { ok: true, duplicate: true };
    const cards = applyPush(db, d.hub, hook, parse(body));
    // Marked once applied: a failed delivery is retried by the host (handled commits are skipped by sha).
    if (delivery) firstSeen(db, 'git', key, now());
    return { ok: true, cards };
  };
  const header = (v: unknown) => (typeof v === 'string' ? v : '');
  const hookOf = (id: string, kind: GitKind): HookRow => {
    const hook = hookRow(db, id);
    if (!hook || hook.kind !== kind) throw new AppError(404, 'not_found');
    return hook;
  };

  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_req, b, done) => done(null, b));
    const limits = { bodyLimit: BODY_MAX };
    const rawOf = (req: { body: unknown }) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const ipHit = (req: { socket: { remoteAddress?: string } }) => {
      const wait = ipLimiter.hit(req.socket.remoteAddress ?? 'unknown');
      if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    };

    inst.post('/integrations/github/:hookId', limits, async (req) => {
      ipHit(req);
      const hook = hookOf((req.params as { hookId: string }).hookId, 'github');
      const secret = hook.secret_sealed ? openFor(db, hookSlot(hook.id), hook.secret_sealed) : null;
      const raw = rawOf(req);
      const given = header(req.headers['x-hub-signature-256']);
      if (!secret || !/^sha256=[0-9a-f]{64}$/.test(given)
        || !timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(given.slice(7), 'hex'))) throw new AppError(401, 'invalid_signature');
      return deliver(hook, raw, header(req.headers['x-github-delivery']), header(req.headers['x-github-event']) === 'push', listedCommits);
    });

    inst.post('/integrations/gitlab/:hookId', limits, async (req) => {
      ipHit(req);
      const hook = hookOf((req.params as { hookId: string }).hookId, 'gitlab');
      const secret = hook.secret_sealed ? openFor(db, hookSlot(hook.id), hook.secret_sealed) : null;
      if (!secret || !sameSecret(header(req.headers['x-gitlab-token']), secret)) throw new AppError(401, 'invalid_token');
      return deliver(hook, rawOf(req), header(req.headers['x-gitlab-event-uuid']), header(req.headers['x-gitlab-event']) === 'Push Hook', listedCommits);
    });

    inst.post('/integrations/bitbucket/:hookId/:secret', limits, async (req) => {
      ipHit(req);
      const { hookId, secret } = req.params as { hookId: string; secret: string };
      const hook = hookOf(hookId, 'bitbucket');
      if (!hook.secret_hash || !sameSecret(sha256hex(secret), hook.secret_hash)) throw new AppError(404, 'not_found');
      return deliver(hook, rawOf(req), header(req.headers['x-request-uuid']), header(req.headers['x-event-key']) === 'repo:push', bitbucketCommits);
    });
  });
}

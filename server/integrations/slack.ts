/**
 * Slack.
 *
 * - Settings (integrations/updateSlack, admins with a session): an incoming webhook URL (hooks.slack.com) for card,
 *   comment and milestone news of the chosen projects, the signing secret, a bot token (users:read.email, used only to
 *   look up the email of whoever runs /addcard), the Slack workspace (team id) /addcard is accepted from, and the deck
 *   /addcard creates cards in. Secrets are encrypted at rest
 *   (common.ts).
 * - `POST /integrations/slack/commands`: Slack's slash command endpoint. X-Slack-Signature (v0 HMAC-SHA256 of
 *   `v0:<timestamp>:<raw body>`, timing-safe, at most 5 minutes old) is checked before anything is read. /addcard
 *   <text> is accepted only from the configured team, once per trigger id. The Slack user's email is looked up with
 *   users.info and trusted only for a full member of that same team (not a guest, bot, deleted user or someone from
 *   another team or enterprise) whose email Slack has confirmed. The card is made as the workspace member with that
 *   email and bookmarked for them; anyone else gets a polite refusal and nothing is created. Answers are ephemeral.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { now } from '../auth';
import { runAction, type Command } from '../dispatch';
import { can, isGuest, sessionActor, type Actor } from '../permissions';
import { TokenRateLimiter } from '../tokens';
import { deckRow, projectRow, userRow } from '../commands/rows';
import { createCard } from '../commands/cards';
import { bookmarkCommands } from '../commands/hand';
import { publicUrlOf } from '../email';
import { cardCode } from '../../shared/cards';
import type { LiveHub } from '../live';
import type { User } from '../../shared/types';
import { firstSeen, getSecret, putSecret, readConfig, secretIsSet, writeConfig, type ChatEvent, type ChatTarget } from './common';
import type { OutboundClient } from './http';

export const SLACK_API = 'https://slack.com/api';
export const SIGNATURE_TOLERANCE_S = 300;
const BODY_MAX = 16 * 1024;
const CARD_TEXT_MAX = 4000;
const WEBHOOK_URL = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{1,20}\/B[A-Z0-9]{1,20}\/[A-Za-z0-9]{10,64}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_TEAM = /^T[A-Z0-9]{2,20}$/;
/** Slack user → email lookups kept in memory (least recently used dropped first) and for how long. */
const EMAIL_CACHE_MAX = 1000;
const EMAIL_CACHE_MS = 10 * 60_000;

export interface SlackConfig {
  /** The Slack workspace /addcard is accepted from (commands from any other team are refused). */
  teamId: string | null;
  /** The deck /addcard creates cards in. */
  addCardDeckId: string | null;
  /** Projects whose news goes to the webhook. */
  projectIds: string[];
}
const DEFAULTS: SlackConfig = { teamId: null, addCardDeckId: null, projectIds: [] };
export const slackConfig = (db: Db): SlackConfig => readConfig(db, 'slack', DEFAULTS);

const updateSchema = z.object({
  webhookUrl: z.string().regex(WEBHOOK_URL).nullable().optional(),
  signingSecret: z.string().regex(/^[A-Za-z0-9]{16,128}$/).nullable().optional(),
  botToken: z.string().regex(/^xox[bp]-[A-Za-z0-9-]{10,250}$/).nullable().optional(),
  teamId: z.string().regex(SLACK_TEAM).nullable().optional(),
  addCardDeckId: z.string().nullable().optional(),
  projectIds: z.array(z.string()).max(200).optional(),
});

const assertAdmin = (db: Db, actor: Actor) => { if (!can(db, actor, 'account.manage')) throw new AppError(403, 'forbidden'); };

export const slackCommands: Record<string, Command> = {
  'integrations/updateSlack': {
    schema: updateSchema,
    run(ctx, input: z.infer<typeof updateSchema>) {
      const { db } = ctx;
      assertAdmin(db, ctx.actor);
      const t = now();
      const cfg = slackConfig(db);
      if (input.teamId !== undefined) cfg.teamId = input.teamId;
      if (input.addCardDeckId !== undefined) {
        const deck = input.addCardDeckId ? deckRow(db, input.addCardDeckId) : null;
        if (input.addCardDeckId && (!deck || deck.deckType === 'doc')) throw new AppError(400, 'invalid_payload', { field: 'addCardDeckId' });
        cfg.addCardDeckId = input.addCardDeckId;
      }
      if (input.projectIds) {
        const ids = [...new Set(input.projectIds)];
        if (ids.some((p) => !projectRow(db, p))) throw new AppError(400, 'invalid_payload', { field: 'projectIds' });
        cfg.projectIds = ids;
      }
      putSecret(db, 'slack', 'webhookUrl', input.webhookUrl, t);
      putSecret(db, 'slack', 'signingSecret', input.signingSecret, t);
      putSecret(db, 'slack', 'botToken', input.botToken, t);
      writeConfig(db, 'slack', cfg, t);
    },
  },
};

/** The settings as admins see them: secrets only as set / not set. */
export function slackSettings(db: Db) {
  const c = slackConfig(db);
  return {
    teamId: c.teamId, addCardDeckId: c.addCardDeckId, projectIds: c.projectIds,
    webhookSet: secretIsSet(db, 'slack', 'webhookUrl'),
    signingSecretSet: secretIsSet(db, 'slack', 'signingSecret'),
    botTokenSet: secretIsSet(db, 'slack', 'botToken'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications

/** Slack's control characters in our text are shown literally (no <!channel>, no links of our users' making). */
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const link = (title: string, url: string) => `<${url}|${esc(title)}>`;

export const slackTarget: ChatTarget = {
  kind: 'slack',
  router(db: Db) {
    const projects = new Set(slackConfig(db).projectIds);
    return (e: ChatEvent) => {
      if (e.type === 'milestone') return projects.size && (e.global || e.projectIds.some((p) => projects.has(p))) ? [null] : [];
      return projects.has(e.projectId) ? [null] : [];
    };
  },
  format(e: ChatEvent) {
    switch (e.type) {
      case 'cardCreated': return { text: `*New task* in ${esc(e.deck)}: ${link(e.title, e.url)}` };
      case 'cardDone': return { text: `*Done*: ${link(e.title, e.url)}` };
      case 'comment': return { text: `*Comment* by ${esc(e.author)} on ${link(e.title, e.url)}:\n>${esc(e.text).replace(/\n/g, '\n>')}` };
      case 'milestone': return { text: `*New milestone*: ${esc(e.name)}${e.date ? ` (${e.date})` : ''}` };
    }
  },
  webhook: (db: Db) => getSecret(db, 'slack', 'webhookUrl'),
};

// ---------------------------------------------------------------------------------------------------------------
// Slash commands

/** True when the request carries a valid, fresh v0 signature of the raw body. */
export function verifySlack(secret: string, sig: unknown, ts: unknown, body: Buffer, nowS: number): boolean {
  if (typeof sig !== 'string' || typeof ts !== 'string' || !/^v0=[0-9a-f]{64}$/.test(sig) || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowS - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const want = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`v0:${ts}:`), body])).digest();
  return timingSafeEqual(want, Buffer.from(sig.slice(3), 'hex'));
}

/**
 * The email of a users.info `user` only when Slack vouches for it and the user is a full member of `team`: the email
 * is confirmed, the user is not deleted, a bot, or a (multi- or single-channel) guest, belongs to `team` and, when the
 * command came from an Enterprise Grid org, to that enterprise.
 */
export function trustedEmail(u: any, team: string, enterprise: string | null, slackUser: string): string | null {
  if (!u || typeof u !== 'object' || u.id !== slackUser) return null;
  if (u.is_email_confirmed !== true || u.deleted === true || u.is_bot === true || u.is_restricted === true || u.is_ultra_restricted === true) return null;
  if (u.team_id !== team) return null;
  const userEnterprise = u.enterprise_user?.enterprise_id ?? null;
  if ((enterprise ?? null) !== userEnterprise) return null;
  const email = u.profile?.email;
  return typeof email === 'string' && email.length <= 254 ? email : null;
}

export interface SlackRouteDeps { db: Db; hub: Pick<LiveHub, 'publish'>; http: OutboundClient }

const ephemeral = (text: string) => ({ response_type: 'ephemeral', text });

export function registerSlackRoutes(app: FastifyInstance, d: SlackRouteDeps): void {
  const { db } = d;
  const ipLimiter = new TokenRateLimiter();
  const emails = new Map<string, { email: string; at: number }>();

  /**
   * The confirmed email of a full member of `team`, from users.info (bot token); null for anyone else or when Slack
   * doesn't answer. Cached by team + user (only accepted answers).
   */
  const emailOf = async (team: string, enterprise: string | null, slackUser: string, token: string): Promise<string | null> => {
    const key = `${team}:${slackUser}`;
    const hit = emails.get(key);
    if (hit && now() - hit.at < EMAIL_CACHE_MS) {
      emails.delete(key);
      emails.set(key, hit);
      return hit.email;
    }
    let res;
    try {
      res = await d.http.request(`${SLACK_API}/users.info?user=${encodeURIComponent(slackUser)}`, { method: 'GET', headers: { authorization: `Bearer ${token}` }, timeoutMs: 2500, maxBytes: 256 * 1024 });
    } catch {
      return null;
    }
    let j: any;
    try { j = JSON.parse(res.text); } catch { return null; }
    const u = j?.ok === true ? j.user : null;
    const email = trustedEmail(u, team, enterprise, slackUser);
    if (!email) return null;
    emails.delete(key);
    emails.set(key, { email, at: now() });
    while (emails.size > EMAIL_CACHE_MAX) emails.delete(emails.keys().next().value!);
    return email;
  };

  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_req, b, done) => done(null, b));
    inst.post('/integrations/slack/commands', { bodyLimit: BODY_MAX }, async (req) => {
      const wait = ipLimiter.hit(req.socket.remoteAddress ?? 'unknown');
      if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
      const secret = getSecret(db, 'slack', 'signingSecret');
      if (!secret) throw new AppError(404, 'not_found');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifySlack(secret, req.headers['x-slack-signature'], req.headers['x-slack-request-timestamp'], body, Math.floor(now() / 1000))) {
        throw new AppError(401, 'invalid_signature');
      }
      const f = new URLSearchParams(body.toString('utf8'));
      if (f.get('command') !== '/addcard') return ephemeral('This command is not supported.');
      const cfgTeam = slackConfig(db).teamId;
      const team = f.get('team_id') ?? '';
      if (!cfgTeam) return ephemeral('/addcard is not set up yet. An admin can enter the Slack workspace id in the workspace settings.');
      if (team !== cfgTeam) return ephemeral('This Slack workspace is not connected to the workspace.');
      // Without a trigger id a signed body could be replayed within the 5 minutes: refused.
      const trigger = f.get('trigger_id') ?? '';
      if (!trigger) return ephemeral('This command is not supported.');
      if (!firstSeen(db, 'slack', trigger.slice(0, 200), now())) return ephemeral('Already handled.');
      const text = (f.get('text') ?? '').trim().slice(0, CARD_TEXT_MAX);
      if (!text) return ephemeral('Add some text after /addcard.');
      const cfg = slackConfig(db);
      const deck = cfg.addCardDeckId ? deckRow(db, cfg.addCardDeckId) : undefined;
      if (!deck || deck.deckType === 'doc') return ephemeral('/addcard is not set up yet. An admin can pick its deck in the workspace settings.');
      const token = getSecret(db, 'slack', 'botToken');
      const slackUser = f.get('user_id') ?? '';
      const email = token && SLACK_USER.test(slackUser) ? await emailOf(team, f.get('enterprise_id') || null, slackUser, token) : null;
      const member = email ? db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE AND disabled=0').get(email) as { id: string } | undefined : undefined;
      if (!member || isGuest(db, member.id)) return ephemeral('Sorry, /addcard is only for members of this workspace: there is no member with your confirmed Slack email address. Nothing was created.');
      const user = userRow(db, member.id) as User;
      let r;
      try {
        r = runAction(db, sessionActor(user), (ctx) => {
          const { id } = createCard(ctx, { deckId: deck.id as string, content: text });
          const add = bookmarkCommands['bookmarks/addCards'];
          add.run(ctx, add.schema.parse({ userId: user.id, ids: [id] }));
          return id;
        });
      } catch (e) {
        if (e instanceof AppError) return ephemeral("Couldn't add the task: you can't add tasks to that list.");
        throw e;
      }
      try { d.hub.publish(r.actionId, r.events); } catch (e) { console.error('live publish failed', e); }
      const seq = (db.prepare('SELECT seq FROM cards WHERE id=?').get(r.result) as { seq: number }).seq;
      return ephemeral(`Task ${cardCode(seq)} is in your bookmarks: ${publicUrlOf(db)}/card/${cardCode(seq)}`);
    });
  });
}

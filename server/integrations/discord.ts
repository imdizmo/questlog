/**
 * Discord, over HTTP interactions (no gateway bot).
 *
 * - Settings (integrations/updateDiscord, admins with a session): application id, public key, guild id, the bot token
 *   (encrypted, server/integrations/common.ts), which deck each channel's /bug and /card commands create cards in, a
 *   channel webhook per project for notifications, and karma role thresholds (stored and shown, but inactive: message
 *   upvotes and roles need a gateway bot).
 * - `POST /integrations/discord/interactions`: Discord's interactions endpoint. The Ed25519 signature
 *   (X-Signature-Ed25519 over X-Signature-Timestamp + the raw body, at most 5 minutes old) is checked before anything is
 *   read; PING answers PONG; /bug and /card create a card in the deck mapped for that channel and command, as the
 *   system actor, once per interaction id. Answers are ephemeral and never mention anyone.
 * - "Register commands" (POST /dispatch/integrations/registerDiscordCommands) is the only call to Discord's API, made
 *   when an admin asks for it. Notifications post to the project's webhook through the notifier (common.ts).
 */
import { createPublicKey, verify } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import { AppError } from '../errors';
import { now } from '../auth';
import type { Command, ChangeEvent } from '../dispatch';
import { dispatchAll, nextActionId } from '../dispatch';
import { can, systemActor, type Actor } from '../permissions';
import { TokenRateLimiter } from '../tokens';
import { deckRow, projectRow } from '../commands/rows';
import { publicUrlOf } from '../email';
import { cardCode } from '../../shared/cards';
import type { LiveHub } from '../live';
import { dropSecrets, firstSeen, getSecret, wasSeen, putSecret, readConfig, secretIsSet, writeConfig, type ChatEvent, type ChatTarget } from './common';
import { OutboundError, type OutboundClient } from './http';

export const DISCORD_API = 'https://discord.com/api/v10';
/** Signed requests older or newer than this are refused. */
export const SIGNATURE_TOLERANCE_S = 300;
const BODY_MAX = 64 * 1024;
const CARD_TEXT_MAX = 4000;
const MESSAGE_MAX = 2000;
const SNOWFLAKE = /^\d{17,20}$/;
const WEBHOOK_URL = /^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{30,100}$/;
export const DISCORD_COMMANDS = ['bug', 'card'] as const;
const WEBHOOK_PREFIX = 'webhook:';

export interface DiscordConfig {
  applicationId: string | null;
  publicKey: string | null;
  guildId: string | null;
  /** Which deck each channel's command creates cards in. */
  commands: { channelId: string; name: (typeof DISCORD_COMMANDS)[number]; deckId: string }[];
  /** Projects whose card and comment news goes to a channel webhook (the URL is a secret: "webhook:<projectId>"). */
  projectNotifications: { projectId: string }[];
  /** Stored and shown only: roles for message upvotes need a gateway bot. */
  karmaRoleThresholds: { roleId: string; upvotes: number }[];
}
const DEFAULTS: DiscordConfig = { applicationId: null, publicKey: null, guildId: null, commands: [], projectNotifications: [], karmaRoleThresholds: [] };
export const discordConfig = (db: Db): DiscordConfig => readConfig(db, 'discord', DEFAULTS);

const snowflake = z.string().regex(SNOWFLAKE);
const updateSchema = z.object({
  applicationId: snowflake.nullable().optional(),
  publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/).nullable().optional(),
  guildId: snowflake.nullable().optional(),
  botToken: z.string().regex(/^[A-Za-z0-9._-]{30,200}$/).nullable().optional(),
  commands: z.array(z.object({ channelId: snowflake, name: z.enum(DISCORD_COMMANDS), deckId: z.string() })).max(100).optional(),
  /** webhookUrl: a new URL; null removes it; left out keeps the stored one. */
  projectNotifications: z.array(z.object({ projectId: z.string(), webhookUrl: z.string().regex(WEBHOOK_URL).nullable().optional() })).max(100).optional(),
  karmaRoleThresholds: z.array(z.object({ roleId: snowflake, upvotes: z.number().int().min(1).max(1_000_000) })).max(20).optional(),
});

const assertAdmin = (db: Db, actor: Actor) => { if (!can(db, actor, 'account.manage')) throw new AppError(403, 'forbidden'); };

export const discordCommands: Record<string, Command> = {
  'integrations/updateDiscord': {
    schema: updateSchema,
    run(ctx, input: z.infer<typeof updateSchema>) {
      const { db } = ctx;
      assertAdmin(db, ctx.actor);
      const t = now();
      const cfg = discordConfig(db);
      if (input.applicationId !== undefined) cfg.applicationId = input.applicationId;
      if (input.publicKey !== undefined) cfg.publicKey = input.publicKey?.toLowerCase() ?? null;
      if (input.guildId !== undefined) cfg.guildId = input.guildId;
      if (input.karmaRoleThresholds) cfg.karmaRoleThresholds = input.karmaRoleThresholds;
      if (input.commands) {
        const seen = new Set<string>();
        for (const c of input.commands) {
          const deck = deckRow(db, c.deckId);
          if (!deck || deck.deckType === 'doc') throw new AppError(400, 'invalid_payload', { field: 'commands' });
          const k = `${c.channelId}/${c.name}`;
          if (seen.has(k)) throw new AppError(400, 'invalid_payload', { field: 'commands' });
          seen.add(k);
        }
        cfg.commands = input.commands;
      }
      if (input.projectNotifications) {
        const keep = new Set<string>();
        for (const p of input.projectNotifications) {
          if (!projectRow(db, p.projectId) || keep.has(WEBHOOK_PREFIX + p.projectId)) throw new AppError(400, 'invalid_payload', { field: 'projectNotifications' });
          keep.add(WEBHOOK_PREFIX + p.projectId);
          putSecret(db, 'discord', WEBHOOK_PREFIX + p.projectId, p.webhookUrl, t);
        }
        dropSecrets(db, 'discord', WEBHOOK_PREFIX, keep);
        cfg.projectNotifications = input.projectNotifications.map((p) => ({ projectId: p.projectId }));
      }
      putSecret(db, 'discord', 'botToken', input.botToken, t);
      writeConfig(db, 'discord', cfg, t);
    },
  },
};

/** The settings as admins see them: secrets only as set / not set. */
export function discordSettings(db: Db) {
  const c = discordConfig(db);
  return {
    applicationId: c.applicationId, publicKey: c.publicKey, guildId: c.guildId,
    botTokenSet: secretIsSet(db, 'discord', 'botToken'),
    commands: c.commands,
    projectNotifications: c.projectNotifications.map((p) => ({ projectId: p.projectId, webhookSet: secretIsSet(db, 'discord', WEBHOOK_PREFIX + p.projectId) })),
    karmaRoleThresholds: c.karmaRoleThresholds,
    /** Message upvotes and karma roles need a gateway bot, which this server doesn't run. */
    karmaActive: false,
  };
}

/** Registers /bug and /card with Discord (the guild's commands, or the application's without a guild id). */
export async function registerDiscordCommands(db: Db, http: OutboundClient): Promise<{ registered: string[] }> {
  const c = discordConfig(db);
  const token = getSecret(db, 'discord', 'botToken');
  if (!c.applicationId || !token) throw new AppError(409, 'not_configured');
  const text = (description: string) => [{ type: 3, name: 'text', description, required: true, max_length: CARD_TEXT_MAX }];
  const body = [
    { name: 'bug', type: 1, description: 'Report a bug to the team', options: text('What went wrong?') },
    { name: 'card', type: 1, description: 'Add a task for the team', options: text('What should the task say?') },
  ];
  const url = c.guildId ? `${DISCORD_API}/applications/${c.applicationId}/guilds/${c.guildId}/commands` : `${DISCORD_API}/applications/${c.applicationId}/commands`;
  let res;
  try {
    res = await http.request(url, { method: 'PUT', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 10_000 });
  } catch (e) {
    throw new AppError(502, e instanceof OutboundError && e.kind === 'too_large' ? 'discord_error' : 'discord_unavailable');
  }
  if (!res.ok) {
    console.error('[jt] discord command registration failed', res.status);
    throw new AppError(502, 'discord_error', { status: res.status });
  }
  return { registered: body.map((b) => b.name) };
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications

/** Discord markdown in our text is shown literally. */
const esc = (s: string) => s.replace(/[\\*_~`|>[\]()#]/g, (c) => `\\${c}`);
const link = (title: string, url: string) => `[${esc(title)}](${url})`;

export const discordTarget: ChatTarget = {
  kind: 'discord',
  router(db: Db) {
    const projects = new Set(discordConfig(db).projectNotifications.map((p) => p.projectId));
    return (e: ChatEvent) => {
      if (e.type === 'milestone') return e.global ? [...projects] : e.projectIds.filter((p) => projects.has(p));
      return projects.has(e.projectId) ? [e.projectId] : [];
    };
  },
  format(e: ChatEvent) {
    let content: string;
    switch (e.type) {
      case 'cardCreated': content = `**New task** in ${esc(e.deck)}: ${link(e.title, e.url)}`; break;
      case 'cardDone': content = `**Done**: ${link(e.title, e.url)}`; break;
      case 'comment': content = `**Comment** by ${esc(e.author)} on ${link(e.title, e.url)}:\n> ${esc(e.text).replace(/\n/g, '\n> ')}`; break;
      case 'milestone': content = `**New milestone**: ${esc(e.name)}${e.date ? ` (${e.date})` : ''}`; break;
    }
    return { content: content.slice(0, MESSAGE_MAX), allowed_mentions: { parse: [] } };
  },
  webhook: (db: Db, projectId: string | null) => (projectId ? getSecret(db, 'discord', WEBHOOK_PREFIX + projectId) : null),
};

// ---------------------------------------------------------------------------------------------------------------
// Interactions endpoint

export interface DiscordRouteDeps { db: Db; hub: Pick<LiveHub, 'publish'> }

const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();
function publicKeyOf(hex: string) {
  let k = keyCache.get(hex);
  if (!k) {
    k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }, format: 'jwk' });
    keyCache.clear(); // one key in use at a time
    keyCache.set(hex, k);
  }
  return k;
}

/** True when the request carries a valid, fresh Ed25519 signature of the raw body. */
export function verifyDiscord(publicKeyHex: string, sig: unknown, ts: unknown, body: Buffer, nowS: number): boolean {
  if (typeof sig !== 'string' || typeof ts !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig) || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowS - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(ts), body]), publicKeyOf(publicKeyHex), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

const reply = (content: string) => ({ type: 4, data: { content: content.slice(0, MESSAGE_MAX), flags: 64, allowed_mentions: { parse: [] } } });

export function registerDiscordRoutes(app: FastifyInstance, d: DiscordRouteDeps): void {
  const { db } = d;
  const ipLimiter = new TokenRateLimiter();
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_MAX }, (_req, b, done) => done(null, b));
    inst.post('/integrations/discord/interactions', { bodyLimit: BODY_MAX }, async (req) => {
      const wait = ipLimiter.hit(req.socket.remoteAddress ?? 'unknown');
      if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
      const cfg = discordConfig(db);
      if (!cfg.publicKey) throw new AppError(404, 'not_found');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyDiscord(cfg.publicKey, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], body, Math.floor(now() / 1000))) {
        throw new AppError(401, 'invalid_signature');
      }
      let i: any;
      try { i = JSON.parse(body.toString('utf8')); } catch { throw new AppError(400, 'invalid_json'); }
      if (i?.type === 1) return { type: 1 };
      if (i?.type !== 2 || typeof i.id !== 'string') return reply('This interaction is not supported.');
      if (cfg.guildId && i.guild_id !== cfg.guildId) return reply('This Discord server is not connected to the workspace.');
      // Marked handled together with the card it made (below), so a failed attempt can be tried again.
      if (wasSeen(db, 'discord', i.id)) return reply('Already handled.');
      const name = String(i.data?.name ?? '');
      const opt = Array.isArray(i.data?.options) ? i.data.options.find((o: any) => o?.name === 'text') : undefined;
      const text = typeof opt?.value === 'string' ? opt.value.trim().slice(0, CARD_TEXT_MAX) : '';
      if (!text) return reply(`Add some text after /${name}.`);
      const map = cfg.commands.find((c) => c.channelId === i.channel_id && c.name === name);
      const deck = map ? deckRow(db, map.deckId) : undefined;
      if (!map || !deck || deck.deckType === 'doc') return reply(`This channel is not linked to a list for /${name}. An admin can link it in the workspace menu (top left) → Connections → Discord.`);
      const who = String(i.member?.user?.username ?? i.user?.username ?? '').slice(0, 100);
      const content = who ? `${text}\n\nReported on Discord by ${who}` : text;
      let events: ChangeEvent[];
      let cardId: string;
      try {
        const r = dispatchAll(db, systemActor(), [{ name: 'cards/create', payload: { deckId: deck.id, content } }], {
          beforeCommit: () => { if (!firstSeen(db, 'discord', i.id, now())) throw new AppError(409, 'already_handled'); },
        });
        events = r.events;
        cardId = (r.payloads[0] as { id: string }).id;
      } catch (e) {
        if (e instanceof AppError) return reply(e.code === 'already_handled' ? 'Already handled.' : "Couldn't create the task.");
        throw e;
      }
      try { d.hub.publish(nextActionId(), events); } catch (e) { console.error('live publish failed', e); }
      const seq = (db.prepare('SELECT seq FROM cards WHERE id=?').get(cardId) as { seq: number }).seq;
      return reply(`Task ${cardCode(seq)} created: ${publicUrlOf(db)}/card/${cardCode(seq)}`);
    });
  });
}

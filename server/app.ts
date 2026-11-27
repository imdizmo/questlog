import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { toCamel, type Db } from './db';
import { AppError } from './errors';
import { prefsOf, putPref } from './prefs';
import { MAX_PREF_BYTES } from '../shared/prefs';
import { acceptInvite, confirmPassword, createSession, login, logout, now, sessionUser, sessionVia, setupWorkspace } from './auth';
import { askOwnerPage, viaProxy, inTailscaleRange, peerAddress, signInExempt, tailscaleSettings, whois, type TailscalePerson } from './tailscale';
import { syncTeamFile } from './teamFile';
import { adminTokenSent, directLoopback, registerTeamApi, teamErrorBody } from './teamApi';
import { assertTokenScope, dispatch, nextActionId, type ChangeEvent } from './dispatch';
import { can, isGuest, sessionActor, visibleProjectIds, type Actor } from './permissions';
import { bearerOf, tokenActor, TokenRateLimiter } from './tokens';
import { CARD_SELECT, userRow } from './commands/rows';
import { buildSnapshot, cardReachSql } from './snapshot';
import { runQuery } from './query';
import { writeWikiExport } from './wikiExport';
import { keyFromName } from '../shared/wiki';
import { titleOf } from '../shared/cards';
import { workspaceKind } from '../shared/workspaceKind';
import { McpServer, mcpUsage } from './mcp';
import { LiveHub } from './live';
import { TranslateQueue, type TranslateQueueOptions } from './translate/queue';
import type { TranslateEngine } from './translate/engine';
import { RoomHub, ROOM_LIMITS } from './rooms';
import { boardHooks, resetBoardHooks } from './boards';
import { canSeeCard, cardProjectId } from './access';
import { registerFileRoutes } from './file-routes';
import { registerAssetRoutes } from './assets';
import { registerLibraryRoutes } from './library';
import { registerReportRoutes } from './reports';
import { registerSuggestionRoutes, type SuggestionRouteDeps } from './suggestions';
import { LIBRARY_PORT, suggestionsVia } from '../shared/suggestions';
import { dispatchWithCoverUrl } from './cover-dispatch';
import { importHacknPlan, importTrello, MAX_TRELLO_BYTES, takeImportSlot } from './commands/imports';
import { cloneProjects } from './commands/clone';
import { setFilesDir } from './files';
import { activityPage } from './activity';
import { recentOf } from './home';
import { shape as timeShape, TIMER_CAP_MS } from './commands/timers';
import { billingConfig, syncBillingMode, handleStripeWebhook, StripeClient, stripeConfigured, STRIPE_API, type BillingConfig } from './billing';
import { runBillingCommand } from './commands/billing';
import { disabledGate, EXIT_OPTIONS, isOwner, isWorkspaceDisabled, runDangerZoneCommand } from './commands/dangerZone';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { checkSecret } from './secret';
import { applyUnsubscribe, EMAIL_KINDS, emailConfig, emailPrefsOf, emailStatus, setEmailEnv, verifyUnsubscribeToken, type EmailConfig } from './email';
import { registerOpenRoutes, type OPEN_LIMITS } from './open';
import { OutboundClient, type AllowedHost } from './integrations/http';
import { IntegrationNotifier, setIntegrationSecret } from './integrations/common';
import { discordSettings, discordTarget, registerDiscordCommands, registerDiscordRoutes } from './integrations/discord';
import { registerSlackRoutes, slackSettings, slackTarget } from './integrations/slack';
import { gitHookList, registerGitRoutes } from './integrations/git';
import type { User } from '../shared/types';
import pkg from '../package.json' with { type: 'json' };

export interface AppOptions {
  db: Db;
  webRoot?: string;
  /** Allowed Host values ("host[:port]"). Default: derived from this machine + `port`, plus env JT_HOSTS. */
  hosts?: string[];
  /** Listening port used to build the default allow-list. */
  port?: number;
  /** Attachment directory. Default: env JT_FILES or data/files. */
  filesDir?: string;
  /** Per-file cap in MB. Default: env JT_MAX_FILE_MB or 250. */
  maxFileMb?: number;
  /** How long an import body may take to arrive while it holds the import slot. Default IMPORT_BODY_MS. */
  importBodyMs?: number;
  /** Stripe settings over the environment's (server/billing.ts). Tests use it to point the client at a local mock. */
  billing?: Partial<BillingConfig>;
  /**
   * Email settings over the environment's (server/email.ts emailConfig), plus the server secret that signs unsubscribe
   * links (server/secret.ts; main.ts passes it). Without a secret, a random one lives as long as the process.
   */
  email?: Partial<EmailConfig> & { secret?: string };
  /** Open Decks per-IP limits over the defaults (server/open.ts OPEN_LIMITS). */
  open?: Partial<typeof OPEN_LIMITS>;
  /**
   * Test seam of the outbound client (server/integrations/http.ts): allowed hosts pointed at loopback mocks. Never set
   * outside tests; the allow-list itself can't be changed.
   */
  outbound?: { mocks?: Partial<Record<AllowedHost, string>> };
  /** Test seam of the suggestion forward (server/suggestions.ts): the library service's port and the name lookup. */
  library?: SuggestionRouteDeps['library'];
  /** Test seam of the library reads (server/library.ts): the first-answer and idle limits. */
  libraryTimeouts?: { firstMs?: number; idleMs?: number };
  /**
   * Translation (server/translate): the engine (main.ts passes a TranslateEngine on the language pack; without one
   * nothing is translated) and queue options. The app closes the engine when it closes.
   */
  translate?: { engine?: Pick<TranslateEngine, 'available' | 'translate'> & { version?(): string | null } & { close?(): Promise<void> }; queue?: TranslateQueueOptions };
  /** Sign-in by Tailscale (server/tailscale.ts). Default from env: JT_TAILSCALE_AUTH=1 turns it on, JT_TAILSCALE_SOCKET. */
  tailscale?: { enabled: boolean; socketPath: string };
  /** The desktop sign-in secret (see /desktop-sign-in). Default from env: JT_DESKTOP_SIGNIN. */
  desktopSignin?: string;
  /** Test seam of the tailscaled lookup. Never set outside tests (and never from env). */
  tailscaleWhois?: (ip: string, port: number) => Promise<TailscalePerson | null>;
}

/** How often the chat notification outbox is sent (server/integrations/common.ts). */
const INTEGRATION_SEND_MS = 5_000;
/** Deleted tasks listed in the workspace menu's Archive section, newest first. */
const DELETED_LIST_MAX = 100;

/** Largest Stripe webhook body accepted. */
const STRIPE_WEBHOOK_MAX_BYTES = 512 * 1024;

/** A Trello export must arrive within this time; past it the connection is dropped and the import slot freed. */
export const IMPORT_BODY_MS = 30_000;

export function defaultHosts(port: number, extra = process.env.JT_HOSTS ?? ''): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '[::1]', hostname(), `${hostname()}.local`]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) names.add(i.family === 'IPv6' ? `[${i.address.split('%')[0]}]` : i.address);
  }
  const out = [...names].map((n) => `${n}:${port}`);
  for (const h of extra.split(',')) if (h.trim()) out.push(h.trim());
  return out;
}

const SESSION_COOKIE = 'jt_session';
const DEVICE_COOKIE = 'jt_device';
const DAY = 24 * 3600;
/** Close code of every websocket when the workspace is disabled (server/commands/dangerZone.ts). */
export const WS_WORKSPACE_DISABLED = 4423;
/** /api/push only ever receives small control messages; the websocket frame cap is raised for the rooms. */
const PUSH_MAX_MESSAGE = 1024;
/** Websocket ping interval; a socket without a pong by the next tick is terminated. */
export const HEARTBEAT_MS = 15_000;
const messageBytes = (d: Buffer | ArrayBuffer | Buffer[]) => (Array.isArray(d) ? d.reduce((n, b) => n + b.byteLength, 0) : d.byteLength);

declare module 'fastify' {
  interface FastifyInstance { hub: LiveHub; rooms: RoomHub; integrations: IntegrationNotifier; translate: TranslateQueue }
}

/**
 * connect-src allows blob: because the 3D viewer's model loader (three.js GLTFLoader) reads a .glb's embedded
 * pictures with fetch() on blob: URLs it made itself from the model's own bytes; nothing outside the page is reached.
 */
export const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
  + "connect-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** The CSP, plus the team's library service as a place the page may send to when it sends suggestions there directly. */
export function cspFor(env: NodeJS.ProcessEnv = process.env): string {
  const s = suggestionsVia(env, VERSION);
  return s?.via === 'direct' ? CSP.replace("connect-src 'self' blob:", `connect-src 'self' blob: http://${s.host}:${LIBRARY_PORT}`) : CSP;
}

/** Questlog's version, read once (inlined by the server bundle). */
const VERSION: string = pkg.version;

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db } = opts;
  const allowed = new Set((opts.hosts ?? defaultHosts(opts.port ?? Number(process.env.PORT ?? 8780))).map((h) => h.toLowerCase()));
  const app = Fastify({ logger: false });
  const billing = billingConfig(opts.billing);
  // The one outbound HTTP client (allow-listed hosts only). Tests reach their mocks through `outbound` (and, for
  // Stripe, `billing.baseUrl`); nothing a request sends changes where it connects.
  const http = new OutboundClient({
    mocks: { ...(billing.baseUrl !== STRIPE_API ? { 'api.stripe.com': billing.baseUrl } : {}), ...opts.outbound?.mocks },
  });
  const stripe = stripeConfigured(billing) ? new StripeClient(billing, http) : null;
  // The mode follows the keys: with them the workspace bills (the first time starting its trial), without them it is off.
  syncBillingMode(db, !!stripe);
  const email = emailConfig(opts.email);
  const secret = checkSecret(opts.email?.secret ?? (process.env.JT_SECRET?.trim() || randomBytes(32).toString('base64url')));
  setEmailEnv(db, { publicUrl: email.publicUrl, secret });
  setIntegrationSecret(db, secret);
  const hub = new LiveHub(db);
  const rooms = new RoomHub(db);
  const integrations = new IntegrationNotifier(db, http, [discordTarget, slackTarget]);
  // Access can change through any committed write (project access, roles, card moves...): rooms re-check on every
  // publish. Chat notifications are queued from the same batches (sent later, never on the request path).
  hub.onPublish = (events) => {
    try { rooms.onEvents(events); } catch (e) { console.error('publish listener failed', e); }
    integrations.onEvents(events);
  };
  const hooks = {
    onChange: (id: string) => rooms.refreshAccess(id),
    onDelete: (id: string) => rooms.closeBoard(id, 4404),
    liveDoc: (id: string) => rooms.liveDoc(id),
    edit: (id: string, write: (doc: import('yjs').Doc) => void) => rooms.edit(id, write),
  };
  Object.assign(boardHooks, hooks);
  // One worker translates saved and opened text in the background; its rows reach clients like any change.
  const translateEngine = opts.translate?.engine ?? { available: () => false, translate: () => Promise.reject(new Error('no language pack')) };
  const translate = new TranslateQueue(db, translateEngine, (model, op, row) => hub.publish(nextActionId(), [{ model, op, row }]), opts.translate?.queue);
  translate.start();

  app.register(cookie);
  // Room messages carry Yjs updates (up to 1 MiB); /api/push closes on anything over PUSH_MAX_MESSAGE itself.
  app.register(websocket, { options: { maxPayload: ROOM_LIMITS.maxMessageBytes } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.status).send(err.data === undefined ? { error: err.code } : { error: err.code, data: err.data });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request' });
    }
    // Route pattern only (never the raw URL, body or headers: URLs can carry invite tokens), plus message and stack.
    const route = req.routeOptions?.url ?? '(no route)';
    const stack = typeof err?.stack === 'string' ? err.stack : '';
    console.error('[jt] unhandled error', req.method, route, String(err?.message ?? err), stack);
    return reply.code(500).send({ error: 'internal' });
  });

  // Host allow-list on every request (API, websocket upgrade, static): defeats DNS rebinding.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowed.has(host)) return reply.code(421).send(teamErrorBody(req.url, 'bad_host'));
    // User report endpoints (server/reports.ts) are called by game builds from anywhere: no Origin check, no cookies.
    const cfg = req.routeOptions?.config as { publicCors?: boolean; tokenOnly?: boolean } | undefined;
    if (cfg?.publicCors) return;
    // POST /email/unsubscribe: mail providers' one-click unsubscribe (RFC 8058) comes without our Origin. The signed
    // token in the request is its only credential, and it can only turn emails off.
    if (cfg?.tokenOnly) return;
    const origin = req.headers.origin;
    // Every websocket upgrade, whatever its path (encoded paths route too): a browser always sends Origin, so require it.
    const isWs = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (req.method !== 'GET' && req.method !== 'HEAD' || isWs) {
      let ok = req.headers['sec-fetch-site'] !== 'cross-site';
      if (isWs && !origin) ok = false;
      if (origin) {
        let o: URL | null = null;
        try { o = new URL(origin); } catch { /* invalid */ }
        ok = ok && !!o && allowed.has(o.host.toLowerCase()) && o.host.toLowerCase() === host && o.protocol === `${req.protocol}:`;
      }
      if (!ok) return reply.code(403).send(teamErrorBody(req.url, 'cross_origin'));
    }
  });

  // ---- the disabled-workspace gate (Danger Zone, server/commands/dangerZone.ts DISABLED_GATE) ----
  // Every request, websocket upgrades included, after the Host and Origin checks: while the workspace is disabled the
  // API, writes, sockets, MCP, user reports and integrations answer 423 workspace_disabled, and public Open Deck pages
  // 404. The path is judged twice, as the matched route pattern (an encoded path such as /api/%73napshot still routes)
  // and as the decoded request path (a wildcard route such as the static files' '/*' hides what was asked for); the
  // stricter answer wins. Future prefixes (/open, /integrations) are covered here without code of their own.
  const rank = { pass: 0, hidden: 1, locked: 2 } as const;
  app.addHook('onRequest', async (req, reply) => {
    if (!isWorkspaceDisabled(db)) return;
    const raw = req.url.split('?')[0];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* malformed: judged as sent */ }
    const route = req.routeOptions?.url;
    const verdicts = [disabledGate(decoded), disabledGate(raw), ...(route ? [disabledGate(route)] : [])];
    const verdict = verdicts.reduce((a, b) => (rank[b] > rank[a] ? b : a));
    if (verdict === 'hidden') return reply.code(404).send({ error: 'not_found' });
    if (verdict === 'locked') return reply.code(423).send(teamErrorBody(req.url, 'workspace_disabled'));
  });

  const secure = (req: FastifyRequest) => req.protocol === 'https';
  const cookieBase = (req: FastifyRequest) => ({ httpOnly: true, sameSite: 'lax' as const, path: '/', secure: secure(req) });
  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase(req), maxAge: 30 * DAY });

  // ---- sign-in by Tailscale (server/tailscale.ts) ----
  // A page load (GET, accepts HTML, no Authorization, no valid session, not an exempt path) from a tailnet address is
  // looked up in tailscaled: a person linked to an enabled user gets an ordinary session; anyone else Tailscale knows
  // gets the "ask the owner" page and a join request. The peer is only ever the socket address, never a header, and a
  // request that came through a proxy (forwarding headers) is never looked up: the socket peer would be the proxy.
  // Switch off, a non-tailnet address, a daemon that does not answer or any failure: the request goes on as if this
  // did not exist.
  const tailscale = opts.tailscale ?? tailscaleSettings();
  const lookUp = opts.tailscaleWhois ?? ((addr: string, port: number) => whois(addr, port, tailscale.socketPath));
  const tailscalePeer = async (req: FastifyRequest): Promise<TailscalePerson | null> => {
    if (!tailscale.enabled || viaProxy(req.headers)) return null;
    const addr = peerAddress(req.socket.remoteAddress);
    if (!addr || !inTailscaleRange(addr)) return null;
    try {
      return await lookUp(addr, req.socket.remotePort ?? 0);
    } catch (e) {
      console.error('[jt] tailscale lookup failed', String((e as Error)?.message ?? e));
      return null;
    }
  };
  const linkedUser = (login: string) =>
    db.prepare('SELECT id, disabled, kind FROM users WHERE tailscale_login=?').get(login) as { id: string; disabled: number; kind: string } | undefined;
  app.addHook('onRequest', async (req, reply) => {
    if (!tailscale.enabled || req.method !== 'GET' || req.headers.authorization !== undefined) return;
    if (!String(req.headers.accept ?? '').includes('text/html')) return;
    const raw = req.url.split('?')[0];
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* malformed: judged as sent */ }
    if (signInExempt(raw) || signInExempt(decoded)) return;
    if (sessionUser(db, req.cookies[SESSION_COOKIE] ?? '')) return;
    const person = await tailscalePeer(req);
    if (!person) return;
    try {
      const user = linkedUser(person.login);
      if (user) {
        // As a password login: disabled people and service users never get in; a disabled workspace only lets its owner in.
        if (user.disabled || user.kind === 'service' || (isWorkspaceDisabled(db) && !isOwner(db, user.id))) return;
        const token = createSession(db, user.id, 'tailscale');
        setSessionCookie(req, reply, token);
        req.cookies[SESSION_COOKIE] = token;
        return;
      }
      const at = now();
      db.prepare(`INSERT INTO access_requests (login, display_name, first_seen, last_seen) VALUES (?,?,?,?)
        ON CONFLICT(login) DO UPDATE SET display_name=excluded.display_name, last_seen=excluded.last_seen`)
        .run(person.login, person.displayName, at, at);
    } catch (e) {
      console.error('[jt] tailscale sign-in failed', String((e as Error)?.message ?? e));
      return;
    }
    return reply.code(403).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(askOwnerPage(person));
  });

  // The app page and its static files: only our own scripts, styles, images and sockets. Card text is
  // rendered as HTML in the browser, so this is the backstop if anything ever slips through.
  app.addHook('onSend', async (req, reply, payload) => {
    if ((req.routeOptions?.config as { publicCors?: boolean } | undefined)?.publicCors) {
      reply.header('access-control-allow-origin', '*');
      return payload;
    }
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/dispatch/')) reply.header('content-security-policy', cspFor());
    return payload;
  });

  // ---- sign-in by the desktop app ----
  // The desktop shell starts its own server with JT_DESKTOP_SIGNIN, a fresh secret per run, and opens
  // /desktop-sign-in?t=<secret>: the workspace owner gets a session without a password ("This computer" is a
  // one-person, offline workspace). Only straight from loopback, and only with the secret, so no other page or
  // machine can use it. A wrong or missing secret just lands on the normal sign-in.
  const desktopSecret = opts.desktopSignin ?? process.env.JT_DESKTOP_SIGNIN ?? '';
  app.get('/desktop-sign-in', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const t = (req.query as Record<string, unknown>)?.t;
    const ok = desktopSecret.length >= 32 && typeof t === 'string' && t.length === desktopSecret.length
      && timingSafeEqual(Buffer.from(t), Buffer.from(desktopSecret)) && directLoopback(req);
    if (!ok) return reply.redirect('/login');
    const owner = db.prepare(`SELECT u.id FROM users u JOIN account_roles r ON r.user_id=u.id
      WHERE r.role='owner' AND NOT u.disabled ORDER BY u.created_at LIMIT 1`).get() as { id: string } | undefined;
    // No workspace yet: the setup page.
    if (!owner) return reply.redirect('/');
    if (sessionUser(db, req.cookies[SESSION_COOKIE] ?? '')?.id !== owner.id) setSessionCookie(req, reply, createSession(db, owner.id, 'desktop'));
    return reply.redirect('/');
  });

  const setCookies = (req: FastifyRequest, reply: FastifyReply, token: string, device: string) => {
    setSessionCookie(req, reply, token);
    reply.setCookie(DEVICE_COOKIE, device, { ...cookieBase(req), maxAge: 365 * DAY });
  };
  const ip = (req: FastifyRequest) => req.socket.remoteAddress ?? 'unknown';
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const body = (req: FastifyRequest) => ((req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>);
  /** The signed-in workspace user: 401 without a session, 403 for a guest (Open Decks visitors have no workspace access). */
  const needUser = (req: FastifyRequest, allowGuest = false): User => {
    const u = sessionUser(db, req.cookies[SESSION_COOKIE] ?? '');
    if (!u) throw new AppError(401, 'unauthenticated');
    if (!allowGuest && isGuest(db, u.id)) throw new AppError(403, 'forbidden');
    return u;
  };
  const tokenLimiter = new TokenRateLimiter();
  /**
   * The actor of /dispatch/*, /api/query and /api/snapshot: a Bearer API token when an Authorization header is sent
   * (rate limited per IP before any lookup, so guessing costs requests too; a bad token is 401 even next to a valid
   * cookie), else the session cookie. Every other route, and the websockets, stay cookie-only. Guests only where
   * `allowGuest` (/dispatch, which lets them run the guest commands only: server/dispatch.ts GUEST_NAMESPACES).
   */
  const resolveActor = (req: FastifyRequest, allowGuest = false): Actor => {
    const bearer = bearerOf(req.headers.authorization);
    if (bearer === null) return sessionActor(needUser(req, allowGuest));
    const wait = tokenLimiter.hit(ip(req));
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    return tokenActor(db, bearer);
  };
  const logIn = (req: FastifyRequest, reply: FastifyReply, email: string, password: string) => {
    // A disabled workspace lets only its owner in (to reactivate it); nobody else gets a session.
    const r = login(db, email, password, ip(req), req.cookies[DEVICE_COOKIE], (id) => {
      if (isWorkspaceDisabled(db) && !isOwner(db, id)) throw new AppError(423, 'workspace_disabled');
    });
    setCookies(req, reply, r.token, r.deviceToken);
    return r.user;
  };

  // Readiness probe for the desktop shell: no auth, no data.
  app.get('/healthz', async (_req, reply) => reply.type('text/plain').send('ok'));

  // ---- auth & setup ----
  app.get('/api/status', async (req) => ({
    setup: (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0,
    // The login screen offers the owner a reactivate button instead of the app.
    disabled: isWorkspaceDisabled(db),
    // This computer (the desktop app's own server, env JT_WORKSPACE_LABEL) or a team server: the badge in the top bar.
    workspace: workspaceKind(process.env, req.headers.host),
    // Where the Suggestion button sends (shared/suggestions.ts); null: no team, no button.
    suggestions: suggestionsVia(process.env, VERSION),
  }));

  /**
   * The first setup. With JATIFY_ADMIN_TOKEN set, it needs X-Jatify-Token equal to it from any peer (the one place the
   * token counts over the network: a fresh server in a container is set up from the tailnet), else 403 setup_token.
   * The owner is linked to a Tailscale login when one is proven: this connection's whois (switch on, no proxy), or else
   * the body's `tailscaleLogin` from loopback with a valid token (never with JT_LOOPBACK_TRUST=0). Any other
   * `tailscaleLogin` is ignored.
   */
  app.post('/api/setup', async (req, reply) => {
    // Already set up: 409 before the token check, so this route never tells whether a token is right.
    if ((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0) throw new AppError(409, 'already_setup');
    const tokenOk = adminTokenSent(req);
    if (process.env.JATIFY_ADMIN_TOKEN && !tokenOk) {
      return reply.code(403).send({ error: 'setup_token', message: 'This server needs its admin token (X-Jatify-Token) to be set up.' });
    }
    const b = body(req);
    const f = { workspaceName: str(b.workspaceName), name: str(b.name), email: str(b.email), password: str(b.password) };
    if (!f.workspaceName.trim()) throw new AppError(400, 'invalid_input');
    let tsLogin = (await tailscalePeer(req))?.login ?? null;
    if (!tsLogin && tokenOk && directLoopback(req) && b.tailscaleLogin !== undefined && b.tailscaleLogin !== null && b.tailscaleLogin !== '') {
      const v = typeof b.tailscaleLogin === 'string' ? b.tailscaleLogin.trim() : '';
      if (!v || v.length > 320) throw new AppError(400, 'invalid_input');
      tsLogin = v;
    }
    setupWorkspace(db, f, tsLogin);
    syncBillingMode(db, !!stripe);
    if (tsLogin) syncTeamFile(db);
    return { user: logIn(req, reply, f.email, f.password) };
  });

  app.post('/api/login', async (req, reply) => {
    const b = body(req);
    const user = logIn(req, reply, str(b.email), str(b.password));
    return isWorkspaceDisabled(db) ? { user, workspaceDisabled: true } : { user };
  });

  app.post('/api/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) {
      logout(db, t);
      const h = createHash('sha256').update(t).digest('hex');
      hub.closeSession(h);
      rooms.closeSession(h);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** This connection's Tailscale person and whether a user is linked to them; how the current session was made. */
  app.get('/api/tailscale', async (req) => {
    needUser(req);
    const person = await tailscalePeer(req);
    return {
      enabled: tailscale.enabled,
      login: person?.login ?? null,
      displayName: person?.displayName ?? null,
      linkedUserId: person ? linkedUser(person.login)?.id ?? null : null,
      sessionVia: sessionVia(db, req.cookies[SESSION_COOKIE] ?? ''),
    };
  });
  /**
   * Links this connection's Tailscale login to the signed-in user, so Tailscale signs them in from now on. Asks for the
   * password (rate limited as a login), so a stolen session alone can't make itself permanent.
   */
  app.post('/api/tailscale/link', async (req) => {
    const user = needUser(req);
    const person = await tailscalePeer(req);
    if (!person) throw new AppError(400, 'not_tailscale');
    confirmPassword(db, user.id, str(body(req).password), ip(req));
    const owner = linkedUser(person.login);
    if (owner && owner.id !== user.id) throw new AppError(409, 'already_linked');
    try {
      db.prepare('UPDATE users SET tailscale_login=? WHERE id=?').run(person.login, user.id);
      db.prepare('DELETE FROM access_requests WHERE login=?').run(person.login);
    } catch (e) {
      if (/UNIQUE/.test(String(e))) throw new AppError(409, 'already_linked');
      throw e;
    }
    syncTeamFile(db);
    try {
      hub.publish(nextActionId(), [{ model: 'user', op: 'upsert', row: userRow(db, user.id)! }]);
    } catch (e) {
      console.error('live publish failed', e);
    }
    return { ok: true, login: person.login };
  });

  /** Pending join requests (people Tailscale knows who asked to join), newest first. For whoever manages people. */
  app.get('/api/team-requests', async (req) => {
    const user = needUser(req);
    if (!can(db, sessionActor(user), 'user.manage')) throw new AppError(403, 'forbidden');
    const rows = db.prepare('SELECT login, display_name, first_seen, last_seen FROM access_requests ORDER BY last_seen DESC, login').all() as
      { login: string; display_name: string; first_seen: number; last_seen: number }[];
    return { requests: rows.map((r) => ({ login: r.login, displayName: r.display_name, firstSeen: r.first_seen, lastSeen: r.last_seen })) };
  });

  /** Who this connection is, for other Jatify tools on the tailnet (shared rule, TEAM-SERVER.md). No cookie needed. */
  app.get('/team/whoami', async (req, reply) => {
    const person = await tailscalePeer(req);
    if (!person) return reply.code(404).send({ error: 'not_tailscale' });
    const u = db.prepare(`SELECT r.role AS role FROM users u JOIN account_roles r ON r.user_id=u.id
      WHERE u.tailscale_login=? AND u.disabled=0 AND u.kind='person'`).get(person.login) as { role: string } | undefined;
    // teamServer: the address of the Jatify team server this Questlog belongs to, when it runs as one (env JATIFY_TEAM_SERVER).
    const teamServer = process.env.JATIFY_TEAM_SERVER;
    return {
      login: person.login, name: person.displayName, role: u?.role ?? null, service: 'questlog', version: VERSION,
      ...(teamServer ? { teamServer } : {}),
    };
  });

  // The team members API for the Jatify Launcher (server/teamApi.ts): same identity as /team/whoami.
  registerTeamApi(app, { db, hub, tailscalePeer });

  const inviteRow = (token: string) => {
    const r = db.prepare('SELECT role, expires_at, disabled FROM invites WHERE token_hash=?')
      .get(createHash('sha256').update(token).digest('hex')) as { role: string; expires_at: number; disabled: number } | undefined;
    if (!r || r.disabled) throw new AppError(404, 'invite_invalid');
    if (r.expires_at <= Date.now()) throw new AppError(410, 'invite_expired');
    return r;
  };
  app.get('/api/invites/:token', async (req) => ({ role: inviteRow((req.params as { token: string }).token).role }));
  app.post('/api/invites/:token/accept', async (req, reply) => {
    const b = body(req);
    const f = { name: str(b.name), email: str(b.email), password: str(b.password) };
    const joined = acceptInvite(db, (req.params as { token: string }).token, f);
    // Everyone's people lists (and the granted projects' access tables) learn about the newcomer.
    const role = (db.prepare('SELECT role FROM account_roles WHERE user_id=?').get(joined.id) as { role: string }).role;
    const events: ChangeEvent[] = [
      { model: 'user', op: 'upsert', row: userRow(db, joined.id)! },
      { model: 'accountRole', op: 'upsert', row: { userId: joined.id, role } },
      ...(db.prepare('SELECT * FROM project_access WHERE user_id=?').all(joined.id) as Record<string, unknown>[])
        .map((r) => ({ model: 'projectAccess' as const, op: 'upsert' as const, row: toCamel<object>(r) })),
    ];
    try {
      hub.publish(`join-${joined.id}`, events);
    } catch (e) {
      console.error('live publish failed', e);
    }
    return { user: logIn(req, reply, f.email, f.password) };
  });

  /** Active (not disabled, not expired) invite links. Only hashes are stored, so no link is returned. */
  app.get('/api/invites', async (req) => {
    const user = needUser(req);
    if (!can(db, user, 'user.manage')) throw new AppError(403, 'forbidden');
    const rows = db.prepare('SELECT token_hash, role, project_ids_json, expires_at, created_by FROM invites WHERE disabled=0 AND expires_at>? ORDER BY expires_at DESC')
      .all(now()) as { token_hash: string; role: string; project_ids_json: string; expires_at: number; created_by: string }[];
    return rows.map((r) => ({
      tokenHash: r.token_hash, role: r.role, projectIds: JSON.parse(r.project_ids_json) as string[],
      expiresAt: r.expires_at, createdBy: r.created_by,
    }));
  });

  // ---- reads ----
  app.get('/api/snapshot', async (req) => buildSnapshot(db, resolveActor(req)));
  // Read query API: same visibility as the snapshot, bounded (server/query.ts). Session or token (read scope suffices).
  app.post('/api/query', async (req) => runQuery(db, resolveActor(req), body(req).query));

  const deckOf = (id: string | null) =>
    id ? (() => { const r = db.prepare('SELECT * FROM decks WHERE id=?').get(id) as Record<string, unknown> | undefined; return r ? toCamel<any>(r) : null; })() : null;
  /** Card the user may see (deleted included), else 404. */
  const visibleCard = (user: User, where: string, arg: string | number) => {
    const r = db.prepare(`SELECT ${CARD_SELECT} FROM cards WHERE ${where}`).get(arg) as Record<string, unknown> | undefined;
    if (!r) throw new AppError(404, 'not_found');
    const card = toCamel<any>(r);
    const deck = deckOf(card.deckId);
    if (!canSeeCard(db, user, card, deck?.projectId ?? null)) throw new AppError(404, 'not_found');
    return { card, deck };
  };

  app.get('/api/cards/:seq', async (req) => {
    const user = needUser(req);
    const seq = Number((req.params as { seq: string }).seq);
    if (!Number.isInteger(seq)) throw new AppError(404, 'not_found');
    const { card, deck } = visibleCard(user, 'seq=?', seq);
    // Same rule as /threads: a deleted card's conversations are for admins only (others still get the card itself).
    const hidden = card.visibility === 'deleted' && !can(db, user, 'account.manage');
    const resolvables = hidden ? [] : (db.prepare('SELECT * FROM resolvables WHERE card_id=? ORDER BY created_at').all(card.id) as any[]).map((r) => toCamel<any>(r));
    const entries = hidden ? [] : (db.prepare('SELECT e.* FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id WHERE r.card_id=? ORDER BY e.created_at').all(card.id) as any[]).map((r) => toCamel<any>(r));
    const reactions = hidden ? [] : (db.prepare('SELECT x.* FROM resolvable_reactions x JOIN resolvable_entries e ON e.id=x.entry_id JOIN resolvables r ON r.id=e.resolvable_id WHERE r.card_id=? ORDER BY x.created_at, x.id').all(card.id) as any[]).map((r) => toCamel<any>(r));
    return { card, deck, resolvables, entries, reactions };
  });

  /**
   * The newest deleted tasks and entries the person could open by link (the workspace menu's Archive section), with the
   * same reach rule as the snapshot minus the visibility test. Titles only; restoring goes through cards/update.
   */
  app.get('/api/cards-deleted', async (req) => {
    const user = needUser(req);
    const reach = cardReachSql(db, user, [...visibleProjectIds(db, user)], 'c');
    const rows = db.prepare(`SELECT c.id, c.seq, substr(c.content, 1, 400) AS content, c.deck_id, c.creator_id, c.is_doc, c.last_updated_at FROM cards c
      WHERE c.visibility = 'deleted' AND ${reach.sql} ORDER BY c.last_updated_at DESC, c.seq DESC LIMIT ${DELETED_LIST_MAX}`).all(...reach.args) as any[];
    return {
      cards: rows.map((r) => ({ id: r.id, seq: r.seq, title: titleOf(r.content ?? ''), deckId: r.deck_id, creatorId: r.creator_id, isDoc: !!r.is_doc, lastUpdatedAt: r.last_updated_at })),
    };
  });

  app.get('/api/activity', async (req) => activityPage(db, needUser(req), req.query as { deckId?: string; projectId?: string; milestoneId?: string; sprintId?: string; before?: string; filters?: string }));

  app.get('/api/cards/:id/history', async (req) => {
    const user = needUser(req);
    const { card } = visibleCard(user, 'id=?', (req.params as { id: string }).id);
    return (db.prepare('SELECT * FROM card_history WHERE card_id=? ORDER BY version DESC').all(card.id) as any[]).map((r) => toCamel<any>(r));
  });

  /** All-time tracked time of a card (running timers count up to now, capped) and its newest 200 segments. */
  app.get('/api/cards/:id/time', async (req) => {
    const user = needUser(req);
    const { card } = visibleCard(user, 'id=?', (req.params as { id: string }).id);
    const at = now();
    const { t } = db.prepare('SELECT COALESCE(SUM(COALESCE(duration_ms, MIN(MAX(0, ?-started_at), ?))), 0) t FROM time_segments WHERE card_id=?').get(at, TIMER_CAP_MS, card.id) as { t: number };
    const segments = (db.prepare('SELECT * FROM time_segments WHERE card_id=? ORDER BY started_at DESC, id LIMIT 200').all(card.id) as Record<string, unknown>[]).map(timeShape);
    return { totalMs: t, segments };
  });

  /** Closed comment/block/review threads of a card with entries and reactions, newest first (hard cap 50). */
  app.get('/api/cards/:id/threads', async (req) => {
    const user = needUser(req);
    const { card } = visibleCard(user, 'id=?', (req.params as { id: string }).id);
    if (card.visibility === 'deleted' && !can(db, user, 'account.manage')) throw new AppError(404, 'not_found');
    const all = (db.prepare('SELECT * FROM resolvables WHERE card_id=? AND is_closed=1 ORDER BY closed_at DESC, created_at DESC, rowid DESC LIMIT 50').all(card.id) as any[])
      .map((r) => toCamel<any>(r));
    const threads = all.map((resolvable) => {
      const entries = (db.prepare('SELECT * FROM resolvable_entries WHERE resolvable_id=? ORDER BY created_at, rowid').all(resolvable.id) as any[]).map((r) => toCamel<any>(r));
      const reactions = (db.prepare('SELECT x.* FROM resolvable_reactions x JOIN resolvable_entries e ON e.id=x.entry_id WHERE e.resolvable_id=? ORDER BY x.created_at, x.id').all(resolvable.id) as any[]).map((r) => toCamel<any>(r));
      return { resolvable, entries, reactions };
    });
    return { threads };
  });

  const filesDir = resolve(opts.filesDir ?? process.env.JT_FILES ?? 'data/files');
  setFilesDir(db, filesDir);
  const maxMb = opts.maxFileMb ?? (Number(process.env.JT_MAX_FILE_MB) || 250);
  registerFileRoutes(app, { db, hub, dir: filesDir, maxBytes: Math.floor(maxMb * 1024 * 1024), needUser, visibleCard });
  // ---- user reports (server/reports.ts): public, report-token endpoints plus the admin settings read ----
  registerReportRoutes(app, { db, hub, dir: filesDir, maxBytes: Math.floor(maxMb * 1024 * 1024), needUser });
  // ---- suggestions (server/suggestions.ts): the desktop's own server forwards them to the team's library service ----
  registerSuggestionRoutes(app, { needUser, version: VERSION, library: opts.library });
  // ---- assets (server/assets.ts): the Assets page's library of pictures and models ----
  registerAssetRoutes(app, { db, hub, maxBytes: Math.floor(maxMb * 1024 * 1024), needUser });
  // ---- library reads (server/library.ts): the desktop's own server forwards the Assets page's reads ----
  registerLibraryRoutes(app, { needUser, version: VERSION, library: opts.library, timeouts: opts.libraryTimeouts });

  // ---- game wiki export (server/wikiExport.ts): session or token (read scope suffices), as /api/query ----
  // Written to an unlinked scratch file in the files directory, then streamed from it: memory stays bounded however big
  // the project. A crash between open and unlink leaves a `.tmp-` file, which sweepFilesDir removes at startup.
  app.get('/api/wiki/:projectId/export', async (req, reply) => {
    const actor = resolveActor(req);
    const { projectId } = req.params as { projectId: string };
    if (!visibleProjectIds(db, actor).has(projectId)) throw new AppError(404, 'not_found');
    const q = req.query as Record<string, string | undefined>;
    const flag = (v: string | undefined) => v === '1' || v === 'true';
    mkdirSync(filesDir, { recursive: true });
    const path = join(filesDir, `.tmp-export-${randomUUID()}.json`);
    const fd = openSync(path, 'w+');
    try { unlinkSync(path); } catch (e) { closeSync(fd); throw e; }
    let wrote = 0;
    try {
      let buf: string[] = [];
      let size = 0;
      const flush = () => {
        const b = Buffer.from(buf.join(''));
        for (let off = 0; off < b.length; ) off += writeSync(fd, b, off);
        wrote += b.length;
        buf = [];
        size = 0;
      };
      const checks = writeWikiExport(db, projectId, { strict: flag(q.strict), includePages: flag(q.includePages) }, (chunk) => {
        buf.push(chunk);
        size += chunk.length;
        if (size >= 64 * 1024) flush();
      });
      flush();
      if (flag(q.strict) && checks.total > 0) {
        closeSync(fd);
        const cut = checks.total > checks.checks.length ? { checksTotal: checks.total, checksTruncated: true } : {};
        return reply.code(422).send({ error: 'checks_failed', checks: checks.checks, ...cut });
      }
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    const name = (db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as { name: string }).name;
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-length', wrote)
      .header('cache-control', 'private, no-cache')
      .header('content-disposition', `attachment; filename="${keyFromName(name, new Set())}-gamedata.json"`)
      .send(createReadStream('', { fd, start: 0, autoClose: true }));
  });
  // ---- Open Decks (server/open.ts): public read-only pages, guest sign-up, and the team's upvote stats ----
  registerOpenRoutes(app, {
    db, needUser, visibleCard, ip, limits: opts.open,
    viewer: (req) => sessionUser(db, req.cookies[SESSION_COOKIE] ?? ''),
  });

  // ---- Discord and Slack (server/integrations/*): signed server-to-server endpoints, admin settings ----
  registerDiscordRoutes(app, { db, hub });
  registerSlackRoutes(app, { db, hub, http });
  registerGitRoutes(app, { db, hub });
  app.get('/api/integrations', async (req) => {
    const user = needUser(req);
    if (!can(db, user, 'account.manage')) throw new AppError(403, 'forbidden');
    return { discord: discordSettings(db), slack: slackSettings(db), gitHooks: gitHookList(db) };
  });
  app.post('/dispatch/integrations/registerDiscordCommands', async (req) => {
    const actor = resolveActor(req);
    assertTokenScope(actor, 'integrations/registerDiscordCommands');
    if (!can(db, actor, 'account.manage')) throw new AppError(403, 'forbidden');
    return { payload: await registerDiscordCommands(db, http), actionId: nextActionId() };
  });

  // ---- translation (server/translate): status for the settings page, and "someone opened this" for the queue ----
  app.get('/translate/status', async (req) => {
    needUser(req);
    const on = (JSON.parse((db.prepare('SELECT settings_json s FROM account').get() as { s: string }).s) as { translationEnabled?: boolean }).translationEnabled === true;
    return { pack: translate.packAvailable(), version: translate.packVersion(), enabled: on, queued: translate.queued() };
  });
  // Cheap on every card view: a read as far as access goes, so no write scope; the queue ignores what is already current.
  app.post('/dispatch/translate/open', async (req) => {
    const actor = resolveActor(req);
    const { kind, id } = body(req);
    if ((kind !== 'card' && kind !== 'entry' && kind !== 'fields') || typeof id !== 'string') throw new AppError(400, 'invalid_payload');
    const row = (kind !== 'entry'
      ? db.prepare('SELECT c.id, c.deck_id, c.creator_id FROM cards c WHERE c.id=?').get(id)
      : db.prepare('SELECT c.id, c.deck_id, c.creator_id FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id JOIN cards c ON c.id=r.card_id WHERE e.id=?').get(id)) as
      { id: string; deck_id: string | null; creator_id: string } | undefined;
    if (!row || !canSeeCard(db, actor, { deckId: row.deck_id, creatorId: row.creator_id }, row.deck_id ? cardProjectId(db, row.id) : null)) throw new AppError(404, 'not_found');
    translate.open(kind, id);
    return {};
  });

  // ---- writes ----
  app.post('/dispatch/:ns/:action', async (req) => {
    const user = resolveActor(req, true);
    const { ns, action } = req.params as { ns: string; action: string };
    const r = await dispatchWithCoverUrl(db, user, `${ns}/${action}`, req.body ?? {}, (x) => {
      try {
        hub.publish(x.actionId, x.events);
      } catch (e) {
        console.error('live publish failed', e); // the write is already committed
      }
    });
    return { payload: r.payload, actionId: r.actionId };
  });

  // ---- billing (server/commands/billing.ts, server/billing.ts): commands call Stripe, so they are async ----
  app.post('/dispatch/billing/:action', async (req) => {
    const actor = resolveActor(req);
    const returnUrl = `${req.protocol}://${req.headers.host}/?menu=billing`;
    const r = await runBillingCommand(db, actor, `billing/${(req.params as { action: string }).action}`, req.body ?? {}, { cfg: billing, client: stripe, returnUrl });
    if (r.events.length) {
      try { hub.publish(r.actionId, r.events); } catch (e) { console.error('live publish failed', e); }
    }
    return { payload: r.payload, actionId: r.actionId };
  });
  // ---- Danger Zone (server/commands/dangerZone.ts): owner only, sessions only; reactivate passes the disabled gate ----
  app.get('/api/exit-options', async (req) => {
    needUser(req);
    return { options: EXIT_OPTIONS };
  });
  const closeAllSockets = () => {
    for (const s of app.websocketServer?.clients ?? []) {
      try { s.close(WS_WORKSPACE_DISABLED, 'workspace_disabled'); } catch { s.terminate(); }
    }
  };
  const dangerZone = async (req: FastifyRequest, action: string) => {
    const r = await runDangerZoneCommand(db, resolveActor(req), `dangerZone/${action}`, req.body ?? {}, { client: stripe, closeSockets: closeAllSockets });
    return { payload: r.payload, actionId: r.actionId };
  };
  // Its own static route, so the gate (which also judges the route pattern) lets exactly this one through.
  app.post('/dispatch/dangerZone/reactivate', async (req) => dangerZone(req, 'reactivate'));
  app.post('/dispatch/dangerZone/:action', async (req) => dangerZone(req, (req.params as { action: string }).action));
  // Stripe's webhook: the signature covers the exact bytes, so the body stays raw. No cookies, no Origin (server to server).
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: STRIPE_WEBHOOK_MAX_BYTES }, (_req, b, done) => done(null, b));
    inst.post('/api/billing/stripe-webhook', { bodyLimit: STRIPE_WEBHOOK_MAX_BYTES }, async (req) => {
      if (!stripe) throw new AppError(404, 'not_found');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['stripe-signature'];
      const events = handleStripeWebhook(db, billing, body, typeof sig === 'string' ? sig : undefined);
      if (events.length) {
        try { hub.publish(nextActionId(), events); } catch (e) { console.error('live publish failed', e); }
      }
      return { received: true };
    });
  });

  // ---- imports and clone (server/commands/imports.ts, clone.ts): signed-in people only, never API tokens ----
  const publish = (x: { actionId: string; events: ChangeEvent[] }) => {
    try {
      hub.publish(x.actionId, x.events);
    } catch (e) {
      console.error('live publish failed', e); // the write is already committed
    }
  };
  // The Trello export travels in the request: its own JSON parser with a 20 MB cap (the other routes keep 1 MiB).
  const slots = new WeakMap<FastifyRequest, () => void>();
  const bodyTimers = new WeakMap<FastifyRequest, ReturnType<typeof setTimeout>>();
  const importBodyMs = opts.importBodyMs ?? IMPORT_BODY_MS;
  const releaseSlot = async (req: FastifyRequest) => {
    clearTimeout(bodyTimers.get(req));
    slots.get(req)?.();
  };
  /** The project the import targets, from `?projectId=` (the body is not read yet); '' when not given. */
  const targetOf = (req: FastifyRequest) => {
    const q = (req.query as { projectId?: unknown }).projectId;
    return typeof q === 'string' ? q : '';
  };
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    // Before a byte of the body is read: signed in, allowed to import (project.manage on `?projectId=`, or on some
    // project when it is not given; the import checks the body's project again), then holding the workspace's single
    // import slot. The body must arrive within importBodyMs. The slot is released when the response is sent, the
    // client goes away, or the body times out.
    inst.addHook('preParsing', async (req) => {
      const user = needUser(req);
      const target = targetOf(req);
      const allowed = target
        ? can(db, user, 'project.manage', target)
        : [...visibleProjectIds(db, user)].some((p) => can(db, user, 'project.manage', p));
      if (!allowed) throw new AppError(403, 'forbidden');
      slots.set(req, takeImportSlot());
      bodyTimers.set(req, setTimeout(() => {
        slots.get(req)?.();
        req.raw.destroy();
      }, importBodyMs));
    });
    inst.addHook('onResponse', releaseSlot);
    inst.addHook('onRequestAbort', releaseSlot);
    inst.addContentTypeParser('application/json', async (req: FastifyRequest, body: NodeJS.ReadableStream) => {
      const tooLarge = () => new AppError(400, 'file_too_large', { maxBytes: MAX_TRELLO_BYTES });
      if (Number(req.headers['content-length'] ?? 0) > MAX_TRELLO_BYTES) throw tooLarge();
      let chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_TRELLO_BYTES) throw tooLarge();
        chunks.push(chunk);
      }
      clearTimeout(bodyTimers.get(req)); // all of it arrived in time
      const text = Buffer.concat(chunks).toString('utf8');
      chunks = []; // the raw bytes go before the parsed board is built
      try { return JSON.parse(text); } catch { throw new AppError(400, 'invalid_json'); }
    });
    inst.post('/dispatch/imports/trello', async (req) => {
      const target = targetOf(req);
      if (target && (req.body as { projectId?: unknown } | null)?.projectId !== target) throw new AppError(400, 'invalid_payload', { field: 'projectId' });
      const r = importTrello(db, needUser(req), req.body);
      publish(r);
      return { payload: r.payload, actionId: r.actionId };
    });
  });
  app.post('/dispatch/imports/hacknplan', async (req) => {
    const r = await importHacknPlan(db, needUser(req), req.body, http);
    publish(r);
    return { payload: r.payload, actionId: r.actionId };
  });
  app.post('/dispatch/clone/projects', async (req) => {
    const r = await cloneProjects(db, needUser(req), req.body);
    publish(r);
    return { payload: r.payload, actionId: r.actionId };
  });

  // ---- MCP (server/mcp.ts): JSON-RPC over POST, personal tokens only ----
  const mcp = new McpServer(db, (x) => hub.publish(x.actionId, x.events));
  app.post('/mcp', async (req, reply) => {
    const r = mcp.handle(ip(req), req.headers.authorization, req.body);
    if (r.body === undefined) return reply.code(r.status).send();
    return reply.code(r.status).type('application/json').send(r.body);
  });
  // No server-to-client stream (Streamable HTTP without SSE) and no sessions to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }) });
  }
  // ---- email (server/email.ts) ----
  /** Transport and the newest 200 outbox rows (no bodies): admins. */
  app.get('/api/email/status', async (req) => {
    const user = needUser(req);
    if (!can(db, user, 'account.manage')) throw new AppError(403, 'forbidden');
    return emailStatus(db, email);
  });
  app.get('/api/email/prefs', async (req) => ({ notifications: emailPrefsOf(db, needUser(req).id) }));

  // Home's "Recently worked on": the cards this person changed or commented on lately (server/home.ts).
  app.get('/api/me/recent', async (req) => ({ items: recentOf(db, needUser(req)) }));

  // ---- per-person preferences (server/prefs.ts): the sidebar, its folds, the tabs. Session only, own rows only. ----
  app.get('/api/prefs', async (req) => prefsOf(db, needUser(req).id));
  app.put('/api/prefs/:key', { bodyLimit: MAX_PREF_BYTES + 1024 }, async (req) => {
    putPref(db, needUser(req).id, (req.params as { key: string }).key, body(req).value);
    return { ok: true };
  });
  /**
   * The signed link at the bottom of an email (no session needed). GET only shows a confirm page, so link scanners and
   * prefetchers change nothing; the POST (its form, or a mail provider's one-click POST with the token in the URL and
   * the body `List-Unsubscribe=One-Click`) unsubscribes. Both work while the workspace is disabled too: an opt-out must
   * always work, and it only ever turns emails off.
   */
  const unsubscribeHeaders = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8');
  const badLink = () => unsubscribePage('This link is not valid', 'The unsubscribe link is incomplete or was changed. Please use the link from the email exactly as it is.');
  app.get('/email/unsubscribe', async (req, reply) => {
    const t = str((req.query as Record<string, unknown>).t);
    const hit = t ? verifyUnsubscribeToken(db, t) : null;
    unsubscribeHeaders(reply);
    if (!hit) return reply.code(400).send(badLink());
    return unsubscribePage('Unsubscribe?', `Stop sending ${EMAIL_KINDS[hit.kind].label.toLowerCase()} from this workspace to ${hit.addr}?`, t);
  });
  app.register(async (scope) => {
    // Small form bodies only, here and nowhere else. A multipart one-click body carries nothing we need (the token is
    // in the URL), so it is read and dropped.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 },
      (_req, b, done) => done(null, Object.fromEntries(new URLSearchParams(String(b)))));
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'string', bodyLimit: 4096 }, (_req, _b, done) => done(null, {}));
    scope.post('/email/unsubscribe', { config: { tokenOnly: true } }, async (req, reply) => {
      const t = str(body(req).t) || str((req.query as Record<string, unknown>).t);
      const hit = t ? verifyUnsubscribeToken(db, t) : null;
      unsubscribeHeaders(reply);
      if (!hit) return reply.code(400).send(badLink());
      applyUnsubscribe(db, hit.addr, hit.kind);
      return unsubscribePage('You are unsubscribed', `${hit.addr} gets no more ${EMAIL_KINDS[hit.kind].label.toLowerCase()} from this workspace.`
        + (hit.kind === 'notifications' ? ' You can turn them back on under Email notifications in the account menu.' : ''));
    });
  });

  app.get('/api/mcp/usage', async (req) => mcpUsage(db, sessionActor(needUser(req))));

  // ---- live ----
  app.register(async (inst) => {
    inst.get('/api/push', { websocket: true }, (socket, req) => {
      const user = sessionUser(db, req.cookies[SESSION_COOKIE] ?? '');
      if (!user) return socket.close(4401, 'unauthenticated');
      if (isGuest(db, user.id)) return socket.close(4403, 'forbidden');
      const t = req.cookies[SESSION_COOKIE] ?? '';
      if (!hub.add(socket, user, createHash('sha256').update(t).digest('hex'))) return;
      socket.on('close', () => hub.remove(socket));
      socket.on('error', () => hub.remove(socket));
      // Clients never need to send more than a small control message here.
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (messageBytes(data) > PUSH_MAX_MESSAGE) socket.close(1009, 'message_too_big');
      });
      socket.send(JSON.stringify({ type: 'uuid', payload: randomUUID() }));
    });
  });

  // ---- vision board rooms (Yjs over binary websocket messages) ----
  app.register(async (inst) => {
    inst.get('/api/rooms/vision-board/:id', { websocket: true }, (socket, req) => {
      const t = req.cookies[SESSION_COOKIE] ?? '';
      const user = sessionUser(db, t);
      const session = user ? createHash('sha256').update(t).digest('hex') : null;
      socket.on('close', () => rooms.leave(socket));
      socket.on('error', () => rooms.leave(socket));
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) return socket.close(1003, 'binary_only');
        const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        rooms.message(socket, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      });
      rooms.connect(socket, user, session, (req.params as { id: string }).id);
    });
  });

  // ---- static + SPA fallback ----
  /** An unknown Team API route says so in its own code, so a client can tell an older server from a missing member. */
  const routeMissing = (url: string) => (url.toLowerCase().startsWith('/team/') ? 'no_route' : 'not_found');
  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.register(fastifyStatic, { root: opts.webRoot });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/dispatch/') && !req.url.startsWith('/user-report/') && !req.url.toLowerCase().startsWith('/team/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send(teamErrorBody(req.url, routeMissing(req.url), 'No such Team API route.'));
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send(teamErrorBody(req.url, routeMissing(req.url), 'No such Team API route.')));
  }

  const sweeper = setInterval(() => { hub.sweep(); rooms.refreshAll(); }, 60_000);
  sweeper.unref();
  const integrationSender = setInterval(() => {
    integrations.flush().catch((e) => console.error('[jt] integration sending failed', String((e as Error)?.message ?? e)));
  }, INTEGRATION_SEND_MS);
  integrationSender.unref();
  // Heartbeat on every websocket (/api/push and the rooms): a socket that did not answer the previous ping is cut, so
  // silently dead connections (sleep, network change) do not hold room slots or awareness ids.
  const pongs = new WeakMap<object, boolean>();
  const heartbeat = setInterval(() => {
    for (const s of app.websocketServer?.clients ?? []) {
      if (!pongs.has(s)) s.on('pong', () => pongs.set(s, true));
      else if (!pongs.get(s)) { s.terminate(); continue; }
      pongs.set(s, false);
      try { s.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  app.decorate('hub', hub);
  app.decorate('rooms', rooms);
  app.decorate('integrations', integrations);
  app.decorate('translate', translate);
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    clearInterval(integrationSender);
    clearInterval(heartbeat);
    rooms.closeAll(); // saves every loaded doc
    await translate.stop();
    await translateEngine.close?.();
    if (boardHooks.onChange === hooks.onChange) resetBoardHooks();
    for (const s of app.websocketServer?.clients ?? []) s.terminate();
  });
  return app;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** The small pages of the unsubscribe link (no scripts; the CSP applies). With `token`, a confirm button that POSTs it. */
function unsubscribePage(title: string, text: string, token?: string): string {
  const form = token === undefined ? '' : '<form method="post" action="/email/unsubscribe">'
    + `<input type="hidden" name="t" value="${escHtml(token)}">`
    + '<button type="submit" style="font:inherit;background:#b4472b;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer">Unsubscribe</button></form>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;background:#f4f2ee;color:#22201c;margin:0;padding:48px 16px">'
    + `<main style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;padding:24px 28px"><h1 style="font-size:20px;margin:0 0 12px">${escHtml(title)}</h1><p>${escHtml(text)}</p>${form}</main></body></html>`;
}

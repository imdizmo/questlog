/**
 * Open Decks: a project's public, read-only pages (`/open/<urlName>` in the web app, `/api/open/...` here), served
 * without a session. Visitors who want to upvote or get update emails sign up as guests (role 'guest': no workspace
 * access, no seat, server/permissions.ts).
 *
 * What a public response may hold (Review Focus 3): every shape below is built from an explicit list of fields, never
 * by spreading a row.
 * - Only projects with an enabled open_decks row that are not archived. Anything else is 404, as is every route while
 *   the workspace is disabled (the gate in app.ts).
 * - Every deck of a public project ([guess]: no per-deck switch). Its cards with visibility 'default' (archived and
 *   deleted cards never show); doc cards show, marked `isDoc`. Deckless cards belong to no project and never show.
 * - Card fields: id (to upvote), code, title, a coarse status, priority, effort, tags, upvote count, deck seq; on the
 *   card page also its text, its owner's (assignee's) display name and its deck title.
 * - Comments only with show_comments, and only threads of the 'comment' context (block and review threads are team
 *   talk), each entry as {author display name, content, createdAt}.
 * - Never an email address, a user id, the project's own name or any other id but the project's (to subscribe) and
 *   the cards' (to upvote).
 * - Images: only the banner and promo image an enabled open deck points at (GET /api/open/:urlName/images/:id); the
 *   normal cover and file routes still need a session.
 *
 * Reads are rate limited per IP, sign-ups too (bounded maps). Visits are counted once per IP, project and UTC day.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { newId, tx, type Db } from './db';
import { AppError } from './errors';
import { hashPassword, now } from './auth';
import { cardCode, seqFromCode, titleOf } from '../shared/cards';
import { coverPath, coverRow, coversDirOf } from './covers';
import { can, isGuest, visibleProjectIds } from './permissions';
import { enqueueEmail, isAddress, publicUrlOf } from './email';
import { guestConfirmEmail, signUpNoticeEmail } from './email-templates';
import type { DeckView } from '../shared/order';
import type { User } from '../shared/types';

/** Default limits per IP; buildApp takes overrides (AppOptions.open). */
export const OPEN_LIMITS = { readsPerMinute: 120, signUpsPerHour: 5 };
/** Most IPs each limiter remembers (the oldest entry goes first). */
const LIMITER_CAP = 5000;
/** Visitors remembered per day for the visit count. */
const VISIT_CAP = 20_000;
/** Visit rows kept. */
const VISIT_KEEP_DAYS = 90;
/** How long a sign-up link works. */
export const SIGNUP_MS = 24 * 3600e3;
const DAY_MS = 24 * 3600e3;
/** Sign-up emails (confirmations and notices) the whole workspace queues per 24 h at most. */
export const SIGNUP_EMAILS_PER_DAY = 100;
/** Pending sign-ups held at most. */
export const PENDING_MAX = 2000;
const MAX_COMMENTS = 200;

// ---- URL names ----
/** Words a URL name can't be: our own routes under /open and /api/open, and names that read as official. */
export const RESERVED_URL_NAMES = new Set(['api', 'gallery', 'confirm', 'images', 'open', 'admin', 'login', 'logout', 'signup', 'sign-up', 'signin', 'sign-in', 'settings', 'static', 'assets', 'new', 'www', 'help', 'about', 'support', 'jatify']);
const URL_NAME = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
/** Lowercase a-z, 0-9 and hyphens, 3 to 40 characters, not starting or ending with a hyphen, not reserved. */
export const validUrlName = (s: string): boolean => URL_NAME.test(s) && !s.includes('--') && !RESERVED_URL_NAMES.has(s);

// ---- settings rows ----
export interface OpenDeckSettings {
  projectId: string; enabled: boolean; urlName: string; displayName: string; bannerFileId: string | null; welcome: string;
  showComments: boolean; upvoting: boolean; listed: boolean; promoFileId: string | null; createdAt: number;
}
interface Row {
  project_id: string; url_name: string; display_name: string; banner_file_id: string | null; welcome: string;
  show_comments: number; upvoting: number; listed: number; promo_file_id: string | null; enabled: number; created_at: number;
}
const settingsOf = (r: Row): OpenDeckSettings => ({
  projectId: r.project_id, enabled: r.enabled === 1, urlName: r.url_name, displayName: r.display_name, bannerFileId: r.banner_file_id,
  welcome: r.welcome, showComments: r.show_comments === 1, upvoting: r.upvoting === 1, listed: r.listed === 1, promoFileId: r.promo_file_id, createdAt: r.created_at,
});
export function openDeckSettings(db: Db, projectId: string): OpenDeckSettings | null {
  const r = db.prepare('SELECT * FROM open_decks WHERE project_id=?').get(projectId) as Row | undefined;
  return r ? settingsOf(r) : null;
}
/** The open deck of a project while it is public (enabled, project not archived), else null. */
export function publicDeckOf(db: Db, projectId: string): OpenDeckSettings | null {
  const r = db.prepare('SELECT o.* FROM open_decks o JOIN projects p ON p.id=o.project_id WHERE o.project_id=? AND o.enabled=1 AND p.is_archived=0').get(projectId) as Row | undefined;
  return r ? settingsOf(r) : null;
}
function publicDeckByUrl(db: Db, urlName: string): OpenDeckSettings | null {
  const r = db.prepare('SELECT o.* FROM open_decks o JOIN projects p ON p.id=o.project_id WHERE o.url_name=? AND o.enabled=1 AND p.is_archived=0').get(urlName) as Row | undefined;
  return r ? settingsOf(r) : null;
}


// ---- public shapes ----
export type PublicStatus = 'notStarted' | 'started' | 'blocked' | 'review' | 'done' | null;
export interface PublicCard {
  id: string; code: string; title: string; status: PublicStatus; priority: string | null; effort: number | null;
  tags: string[]; upvotes: number; upvoted: boolean; deckSeq: number; isDoc: boolean;
}
interface CardRow {
  id: string; seq: number; content: string; status: string; is_doc: number; priority: string | null; effort: number | null;
  tags_json: string; master_tags_json: string; sort_index: number; created_at: number; last_updated_at: number; assignee_id: string | null;
}
const CARD_COLS = 'c.id, c.seq, c.content, c.status, c.is_doc, c.priority, c.effort, c.tags_json, c.master_tags_json, c.sort_index, c.created_at, c.last_updated_at, c.assignee_id';

function openContexts(db: Db, ids: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT card_id, context FROM resolvables WHERE is_closed=0 AND context IN ('block','review') AND card_id IN (${part.map(() => '?').join(',')})`).all(...part) as { card_id: string; context: string }[];
    for (const r of rows) (out.get(r.card_id) ?? out.set(r.card_id, new Set()).get(r.card_id)!).add(r.context);
  }
  return out;
}
function upvoteCounts(db: Db, ids: string[], viewerId: string | null): { counts: Map<string, number>; mine: Set<string> } {
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const marks = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT card_id, COUNT(*) n FROM upvotes WHERE card_id IN (${marks}) GROUP BY card_id`).all(...part) as { card_id: string; n: number }[]) counts.set(r.card_id, r.n);
    if (viewerId) for (const r of db.prepare(`SELECT card_id FROM upvotes WHERE user_id=? AND card_id IN (${marks})`).all(viewerId, ...part) as { card_id: string }[]) mine.add(r.card_id);
  }
  return { counts, mine };
}
function statusOf(c: CardRow, open: Set<string> | undefined): PublicStatus {
  if (c.is_doc) return null;
  if (c.status === 'done') return 'done';
  if (open?.has('block')) return 'blocked';
  if (open?.has('review')) return 'review';
  return c.status === 'started' ? 'started' : 'notStarted';
}
const tagsOf = (c: CardRow): string[] => [...new Set([...(JSON.parse(c.tags_json) as string[]), ...(JSON.parse(c.master_tags_json) as string[])])];

function toPublic(db: Db, rows: CardRow[], deckSeq: (c: CardRow) => number, viewerId: string | null): (PublicCard & { _row: CardRow })[] {
  const ids = rows.map((r) => r.id);
  const open = openContexts(db, ids);
  const { counts, mine } = upvoteCounts(db, ids, viewerId);
  return rows.map((c) => ({
    id: c.id, code: cardCode(c.seq), title: titleOf(c.content), status: statusOf(c, open.get(c.id)), priority: c.priority, effort: c.effort,
    tags: tagsOf(c), upvotes: counts.get(c.id) ?? 0, upvoted: mine.has(c.id), deckSeq: deckSeq(c), isDoc: c.is_doc === 1, _row: c,
  }));
}
const strip = ({ _row: _r, ...card }: PublicCard & { _row: CardRow }): PublicCard => card;

const STATUS_RANK: Record<string, number> = { notStarted: 0, started: 1, blocked: 2, review: 3, done: 4 };
/**
 * The deck's order for visitors: the "Default for visitors" view's first key when it is one a visitor can see
 * (priority, effort, status, title, created, updated); anything else, and no view, is the deck's manual order.
 */
export function sortPublic<T extends PublicCard & { _row: CardRow }>(cards: T[], view: DeckView | null): T[] {
  const manual = (a: T, b: T) => a._row.sort_index - b._row.sort_index || a._row.seq - b._row.seq;
  const key: ((c: T) => number | string) | null = (() => {
    switch (view?.prop) {
      case 'priority': return (c: T) => (c.priority ? c.priority.charCodeAt(0) : 1000);
      case 'effort': return (c: T) => (c.isDoc ? 1e6 - 1 : c.effort ?? 1e6);
      case 'status': return (c: T) => (c.status === null ? 99 : STATUS_RANK[c.status]);
      case 'title': return (c: T) => c.title.toLowerCase();
      case 'createdAt': return (c: T) => c._row.created_at;
      case 'lastUpdatedAt': return (c: T) => c._row.last_updated_at;
      default: return null;
    }
  })();
  const dir = view?.isReversed ? -1 : 1;
  return [...cards].sort((a, b) => {
    if (key) {
      const x = key(a), y = key(b);
      if (x < y) return -dir;
      if (x > y) return dir;
    }
    return manual(a, b);
  });
}

// ---- bounded per-key window limiter ----
/** At most `max` hits per key per window; the map holds at most LIMITER_CAP keys (oldest first out). */
export class WindowLimiter {
  private hits = new Map<string, { n: number; start: number }>();
  constructor(private max: number, private windowMs: number, private cap = LIMITER_CAP) {}
  /** 0 when allowed (and counted), else the seconds until the window ends. */
  hit(key: string, at: number): number {
    let e = this.hits.get(key);
    if (e && at - e.start >= this.windowMs) { this.hits.delete(key); e = undefined; }
    if (!e) {
      if (this.hits.size >= this.cap) this.hits.delete(this.hits.keys().next().value!);
      this.hits.set(key, { n: 1, start: at });
      return 0;
    }
    if (e.n >= this.max) return Math.max(1, Math.ceil((e.start + this.windowMs - at) / 1000));
    e.n++;
    return 0;
  }
  get size(): number { return this.hits.size; }
}

/** Distinct visitors per project page per UTC day, with the day's set of visitors held in memory (bounded). */
class VisitCounter {
  private day = '';
  private seen = new Set<string>();
  constructor(private db: Db) {}
  note(projectId: string, ip: string, at: number): void {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.seen.clear();
      const cutoff = new Date(at - VISIT_KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
      this.db.prepare('DELETE FROM open_visits WHERE day < ?').run(cutoff);
    }
    const key = `${projectId}|${ip}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= VISIT_CAP) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(key);
    this.db.prepare('INSERT INTO open_visits (day, project_id, count) VALUES (?,?,1) ON CONFLICT(day, project_id) DO UPDATE SET count=count+1').run(day, projectId);
  }
}

/** First day (UTC, YYYY-MM-DD) of the last seven days, today included. */
export const weekStartDay = (at: number): string => new Date(at - 6 * 86400e3).toISOString().slice(0, 10);

/** Visits of the last seven days and the most upvoted live cards of the given projects with an open deck. */
export function upvoteStats(db: Db, projectIds: string[], at: number, limit = 10) {
  const ids = projectIds.filter((p) => db.prepare('SELECT 1 FROM open_decks WHERE project_id=?').get(p));
  if (!ids.length) return { visitsThisWeek: 0, top: [] as { cardId: string; seq: number; title: string; upvotes: number; projectId: string }[] };
  const marks = ids.map(() => '?').join(',');
  const visits = (db.prepare(`SELECT COALESCE(SUM(count),0) n FROM open_visits WHERE day >= ? AND project_id IN (${marks})`).get(weekStartDay(at), ...ids) as { n: number }).n;
  const top = (db.prepare(`SELECT c.id, c.seq, c.content, d.project_id, COUNT(*) n FROM upvotes u JOIN cards c ON c.id=u.card_id JOIN decks d ON d.id=c.deck_id
      WHERE c.visibility='default' AND d.project_id IN (${marks}) GROUP BY c.id ORDER BY n DESC, c.seq LIMIT ?`).all(...ids, limit) as { id: string; seq: number; content: string; project_id: string; n: number }[])
    .map((r) => ({ cardId: r.id, seq: r.seq, title: titleOf(r.content), upvotes: r.n, projectId: r.project_id }));
  return { visitsThisWeek: visits, top };
}

// ---- routes ----
export interface OpenRouteDeps {
  db: Db;
  /** The signed-in workspace user (401 / 403 for guests), as app.ts needUser. */
  needUser(req: FastifyRequest): User;
  /** Whoever the session cookie belongs to (guests included), or null. */
  viewer(req: FastifyRequest): User | null;
  /** A card the user may see, else 404 (app.ts visibleCard). */
  visibleCard(user: User, where: string, arg: string): { card: { id: string } };
  ip(req: FastifyRequest): string;
  limits?: Partial<typeof OPEN_LIMITS>;
}

const signUpSchema = z.object({
  email: z.string().trim().max(254).refine(isAddress),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  /** The public project the visitor signed up from (a strict slug): emails and the confirm page link back to it. */
  urlName: z.string().max(40).refine(validUrlName).optional(),
});

export function registerOpenRoutes(app: FastifyInstance, d: OpenRouteDeps): void {
  const { db } = d;
  const limits = { ...OPEN_LIMITS, ...d.limits };
  const reads = new WindowLimiter(limits.readsPerMinute, 60_000);
  const signUps = new WindowLimiter(limits.signUpsPerHour, 3600_000);
  const visits = new VisitCounter(db);
  const limited = (lim: WindowLimiter, req: FastifyRequest) => {
    const wait = lim.hit(d.ip(req), now());
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
  };
  const viewerId = (req: FastifyRequest) => d.viewer(req)?.id ?? null;
  const imageUrl = (o: OpenDeckSettings, id: string | null) => (id ? `/api/open/${o.urlName}/images/${id}` : null);
  const byUrl = (req: FastifyRequest) => {
    const o = publicDeckByUrl(db, String((req.params as { urlName?: unknown }).urlName ?? ''));
    if (!o) throw new AppError(404, 'not_found');
    return o;
  };
  const projectHead = (o: OpenDeckSettings) => ({ id: o.projectId, urlName: o.urlName, displayName: o.displayName, upvoting: o.upvoting, showComments: o.showComments });
  const liveCount = db.prepare("SELECT COUNT(*) n FROM cards WHERE deck_id=? AND visibility='default'");

  app.register(async (scope) => {
    // Every public read: per-IP limit first (the disabled gate already ran in app.ts), never cached by proxies.
    scope.addHook('onRequest', async (req, reply) => {
      if (req.method === 'GET' || req.method === 'HEAD') limited(reads, req);
      reply.header('cache-control', 'no-store');
    });

    scope.get('/api/open/gallery', async () => {
      const rows = db.prepare(`SELECT o.* FROM open_decks o JOIN projects p ON p.id=o.project_id
          WHERE o.enabled=1 AND o.listed=1 AND p.is_archived=0 ORDER BY o.display_name COLLATE NOCASE LIMIT 200`).all() as unknown as Row[];
      return {
        projects: rows.map(settingsOf).map((o) => ({
          urlName: o.urlName, displayName: o.displayName, welcome: o.welcome.slice(0, 280), promoUrl: imageUrl(o, o.promoFileId),
          deckCount: (db.prepare('SELECT COUNT(*) n FROM decks WHERE project_id=?').get(o.projectId) as { n: number }).n,
          cardCount: (db.prepare("SELECT COUNT(*) n FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND c.visibility='default'").get(o.projectId) as { n: number }).n,
        })),
      };
    });

    scope.get('/api/open/:urlName', async (req) => {
      const o = byUrl(req);
      visits.note(o.projectId, d.ip(req), now());
      const decks = (db.prepare('SELECT id, seq, title FROM decks WHERE project_id=? ORDER BY space_id, sort_index, seq').all(o.projectId) as { id: string; seq: number; title: string }[])
        .map((x) => ({ seq: x.seq, title: x.title, cardCount: (liveCount.get(x.id) as { n: number }).n }));
      const v = d.viewer(req);
      const viewer = v ? {
        name: v.name, guest: isGuest(db, v.id),
        subscription: ((db.prepare('SELECT cadence FROM open_subscriptions WHERE project_id=? AND user_id=?').get(o.projectId, v.id) as { cadence: string } | undefined)?.cadence ?? null),
      } : null;
      return { project: { ...projectHead(o), welcome: o.welcome, bannerUrl: imageUrl(o, o.bannerFileId), decks }, viewer };
    });

    scope.get('/api/open/:urlName/decks/:seq', async (req) => {
      const o = byUrl(req);
      const seq = Number((req.params as { seq: string }).seq);
      const deck = Number.isSafeInteger(seq) ? db.prepare('SELECT id, seq, title, public_order FROM decks WHERE seq=? AND project_id=?').get(seq, o.projectId) as { id: string; seq: number; title: string; public_order: string | null } | undefined : undefined;
      if (!deck) throw new AppError(404, 'not_found');
      const rows = db.prepare(`SELECT ${CARD_COLS} FROM cards c WHERE c.deck_id=? AND c.visibility='default' LIMIT 2000`).all(deck.id) as unknown as CardRow[];
      const cards = sortPublic(toPublic(db, rows, () => deck.seq, viewerId(req)), deck.public_order ? JSON.parse(deck.public_order) as DeckView : null).map(strip);
      return { project: projectHead(o), deck: { seq: deck.seq, title: deck.title, cards } };
    });

    scope.get('/api/open/:urlName/cards/:code', async (req) => {
      const o = byUrl(req);
      const seq = seqFromCode(String((req.params as { code: string }).code));
      const row = seq === null ? undefined : db.prepare(`SELECT ${CARD_COLS}, d.seq deck_seq, d.title deck_title FROM cards c JOIN decks d ON d.id=c.deck_id
          WHERE c.seq=? AND d.project_id=? AND c.visibility='default'`).get(seq, o.projectId) as unknown as (CardRow & { deck_seq: number; deck_title: string }) | undefined;
      if (!row) throw new AppError(404, 'not_found');
      const [pc] = toPublic(db, [row], () => row.deck_seq, viewerId(req)).map(strip);
      const owner = row.assignee_id ? (db.prepare('SELECT name FROM users WHERE id=?').get(row.assignee_id) as { name: string } | undefined)?.name ?? null : null;
      const card: Record<string, unknown> = { ...pc, content: row.content, owner, deckTitle: row.deck_title };
      if (o.showComments) {
        card.comments = (db.prepare(`SELECT e.content, e.created_at, u.name FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id
            LEFT JOIN users u ON u.id=e.author_id WHERE r.card_id=? AND r.context='comment' ORDER BY e.created_at, e.rowid LIMIT ${MAX_COMMENTS}`).all(row.id) as { content: string; created_at: number; name: string | null }[])
          .map((e) => ({ author: e.name ?? 'Someone', content: e.content, createdAt: e.created_at }));
      }
      return { project: projectHead(o), card };
    });

    /** The banner or promo image of a public project; nothing else of its covers. */
    scope.get('/api/open/:urlName/images/:id', async (req, reply) => {
      const o = byUrl(req);
      const id = String((req.params as { id: string }).id);
      if (id !== o.bannerFileId && id !== o.promoFileId) throw new AppError(404, 'not_found');
      const c = coverRow(db, id);
      const dir = coversDirOf(db);
      if (!c || c.projectId !== o.projectId || !dir) throw new AppError(404, 'not_found');
      const path = coverPath(dir, c.id);
      const st = await stat(path).catch(() => null);
      if (!st) throw new AppError(404, 'not_found');
      const etag = `"${c.id}"`;
      const inm = req.headers['if-none-match'];
      reply.header('cache-control', 'no-cache').header('etag', etag);
      if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return reply.code(304).send();
      return reply.header('content-type', c.mime).header('content-length', st.size).header('x-content-type-options', 'nosniff').send(createReadStream(path));
    });

    /**
     * The link from the sign-up email: makes the guest account from the pending sign-up (only now does a user exist).
     * 400 for an unknown or expired link, and when the address got an account in the meantime (an invite).
     */
    scope.post('/api/open/confirm', async (req) => {
      const token = String((req.body as { token?: unknown } | null)?.token ?? '');
      const hash = createHash('sha256').update(token).digest('hex');
      const out = tx(db, () => {
        const r = token ? db.prepare('SELECT * FROM open_signups WHERE token_hash=?').get(hash) as
          { email: string; name: string; password_hash: string; url_name: string | null; expires_at: number } | undefined : undefined;
        if (!r || r.expires_at <= now()) return null;
        // Used up either way: a taken address (an invite came first) drops the pending row too, committed.
        db.prepare('DELETE FROM open_signups WHERE token_hash=?').run(hash);
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(r.email)) return null;
        const id = newId();
        db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)').run(id, r.email, r.name, r.password_hash, now());
        db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?, 'guest')").run(id);
        const back = r.url_name && publicDeckByUrl(db, r.url_name) ? r.url_name : null;
        return { ok: true as const, urlName: back };
      });
      if (!out) throw new AppError(400, 'invalid_token');
      return out;
    });
  });

  /**
   * Guest sign-up from a public page. Nothing about the address is revealed and nothing is reserved:
   * - the answer is always the same ({pending: true}: "check your email"), whatever happened;
   * - a new address gets a pending sign-up (open_signups, 24 h) and an email with the link that makes the account;
   * - an address that already has an account (member or guest) gets a notice instead, and nothing changes;
   * - an address with a live pending sign-up gets nothing more (its first link still works; nobody can swap the
   *   password of someone else's pending sign-up).
   * Emails go to addresses a stranger typed, so they hold fixed text only, at most one notice per address a day, and
   * at most SIGNUP_EMAILS_PER_DAY of either kind for the whole workspace; beyond that nothing is queued (same answer).
   * The pending table holds at most PENDING_MAX rows. Rate limited per IP. Only while some project is public (also
   * keeps a fresh install from ever getting a row before its owner). A static route, so it wins over /dispatch/:ns/:action.
   */
  app.post('/dispatch/open/signUp', async (req) => {
    limited(signUps, req);
    if (!db.prepare('SELECT 1 FROM open_decks o JOIN projects p ON p.id=o.project_id WHERE o.enabled=1 AND p.is_archived=0').get()) throw new AppError(404, 'not_found');
    const parsed = signUpSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues });
    const f = parsed.data;
    // Hashed on every path, so the answer takes as long whether or not the address is known.
    const passwordHash = hashPassword(f.password);
    const at = now();
    const token = randomBytes(32).toString('base64url');
    // Only a project that is public right now is linked back to (the same rule as the confirm page).
    const backTo = f.urlName && publicDeckByUrl(db, f.urlName) ? f.urlName : null;
    tx(db, () => {
      const sentToday = (db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE kind IN ('openDeckConfirm','openDeckNotice') AND created_at > ?").get(at - DAY_MS) as { n: number }).n;
      if (sentToday >= SIGNUP_EMAILS_PER_DAY) return;
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(f.email)) {
        const told = db.prepare("SELECT 1 FROM email_outbox WHERE kind='openDeckNotice' AND to_addr=? COLLATE NOCASE AND created_at > ?").get(f.email, at - DAY_MS);
        if (!told) enqueueEmail(db, { to: f.email, ...signUpNoticeEmail({ signInUrl: `${publicUrlOf(db)}/open${backTo ? `/${backTo}` : ''}` }), kind: 'openDeckNotice' }, at);
        return;
      }
      db.prepare('DELETE FROM open_signups WHERE email=? AND expires_at <= ?').run(f.email, at);
      if (db.prepare('SELECT 1 FROM open_signups WHERE email=?').get(f.email)) return;
      if ((db.prepare('SELECT COUNT(*) n FROM open_signups').get() as { n: number }).n >= PENDING_MAX) return;
      db.prepare('INSERT INTO open_signups (token_hash, email, name, password_hash, url_name, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(createHash('sha256').update(token).digest('hex'), f.email, f.name, passwordHash, backTo, at, at + SIGNUP_MS);
      enqueueEmail(db, { to: f.email, ...guestConfirmEmail({ url: `${publicUrlOf(db)}/open/confirm/${token}`, hours: SIGNUP_MS / 3600e3 }), kind: 'openDeckConfirm' }, at);
    });
    return { pending: true };
  });

  /** Admins: the guest accounts (Open Decks visitors), newest first, at most 500. */
  app.get('/api/guests', async (req) => {
    const user = d.needUser(req);
    if (!can(db, user, 'user.manage')) throw new AppError(403, 'forbidden');
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.created_at, (SELECT COUNT(*) FROM upvotes v WHERE v.user_id=u.id) upvotes
        FROM users u JOIN account_roles r ON r.user_id=u.id WHERE r.role='guest' ORDER BY u.created_at DESC, u.id LIMIT 500`).all() as
      { id: string; name: string; email: string; created_at: number; upvotes: number }[];
    return { guests: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, createdAt: r.created_at, upvotes: r.upvotes })) };
  });

  // ---- for the team (sessions; guests get 403 from needUser) ----
  /** Open Deck settings of every project the person can see (enabled or not). */
  app.get('/api/open-decks', async (req) => {
    const user = d.needUser(req);
    const ids = [...visibleProjectIds(db, user)];
    return { openDecks: ids.map((id) => openDeckSettings(db, id)).filter((x): x is OpenDeckSettings => !!x) };
  });
  /** The Hand's Upvote Stats widget. */
  app.get('/api/open-stats', async (req) => upvoteStats(db, [...visibleProjectIds(db, d.needUser(req))], now()));
  app.get('/api/cards/:id/upvotes', async (req) => {
    const user = d.needUser(req);
    const { card } = d.visibleCard(user, 'id=?', (req.params as { id: string }).id);
    const n = (db.prepare('SELECT COUNT(*) n FROM upvotes WHERE card_id=?').get(card.id) as { n: number }).n;
    return { count: n, mine: !!db.prepare('SELECT 1 FROM upvotes WHERE card_id=? AND user_id=?').get(card.id, user.id) };
  });
}

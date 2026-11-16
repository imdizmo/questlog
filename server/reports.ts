/**
 * User reports: public endpoints for game builds (the Unity plugin, or any HTTP client).
 *
 * The report token goes in an `X-Report-Token` header and the access key in `X-Access-Key` (preferred); the
 * `?token=` / `?accessKey=` query parameters still work for parity with the documented API.
 *
 * - `POST /user-report/v1/create-report?token=<report token>` `{content, severity?, fileNames?, userEmail?}` →
 *   `{ok, cardId, uploadUrls:[{fileName, url, fields}]}`. The card is made by cards/bulkImport (the cards/create path
 *   plus missing project tags) as the system actor, in the deck mapped by severity; the token label is its tag.
 * - `PUT /user-report/v1/upload/<id>`: the raw bytes of one announced file; single use, valid 15 minutes.
 * - `POST /user-report/v1/create-report-token?accessKey=<access key>` `{label}` → `{ok, token}`.
 *
 * These routes are marked `config.publicCors` (server/app.ts): CORS `*`, no Origin check, no CSP, and they never read
 * cookies. The Host allow-list still applies. Abuse limits: 40 requests / 5 s per IP before any lookup (all three paths), 30 reports a
 * minute per token, JSON bodies up to 64 KB, content up to 10,000 characters, 5 files of 10 MB each, and a daily
 * budget per token (REPORT_BUDGET: 500 reports and 1 GB of files per UTC day, kept in report_token_usage), past which
 * create-report and uploads answer 429 report_budget with Retry-After until the next UTC midnight.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db';
import { AppError } from './errors';
import { now } from './auth';
import { dispatchAll, nextActionId, type ChangeEvent, type Ctx } from './dispatch';
import { can, systemActor } from './permissions';
import { TokenRateLimiter } from './tokens';
import { cleanMime, cleanName, storeCardFile } from './file-routes';
import { deckRow, projectRow } from './commands/rows';
import {
  ACCESS_KEY_PREFIX, labelSchema, insertReportToken, newSecret, REPORT_SECRET, REPORT_TOKEN_PREFIX, reportApp, reportTokens,
  SEVERITIES, sha256, type Severity,
} from './commands/userReports';
import { normalizeTagName } from '../shared/csv';
import type { LiveHub } from './live';
import type { ProjectTag, User } from '../shared/types';

export const REPORT_LIMITS = {
  perMinute: 30,
  contentChars: 10_000,
  files: 5,
  fileBytes: 10 * 1024 * 1024,
  bodyBytes: 64 * 1024,
  uploadMs: 15 * 60_000,
  /** Tokens tracked by the per-token limiter (least recently used dropped first). */
  trackedTokens: 10_000,
} as const;
/** Per report token per UTC day; past either, 429 report_budget until the next UTC day. */
export const REPORT_BUDGET = { reports: 500, bytes: 1024 ** 3 } as const;
/** Usage rows are kept for this many days back (yesterday's still answers a request that straddles midnight). */
const USAGE_KEEP_DAYS = 2;
const DAY_MS = 86_400_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const budgetError = (t: number) => new AppError(429, 'report_budget', REPORT_BUDGET, {
  'retry-after': String(Math.max(1, Math.ceil(((Math.floor(t / DAY_MS) + 1) * DAY_MS - t) / 1000))),
});

/** Project tags a project may hold (cards/bulkImport refuses more); past it a report is filed without its tag. */
const MAX_PROJECT_TAGS = 100;
/** Used and expired upload rows are dropped this long after they expire (until then a late PUT gets 410, not 404). */
const UPLOAD_KEEP_MS = 24 * 3600e3;
const UPLOAD_ID = /^[A-Za-z0-9_-]{43}$/;
const PREFIX = '/user-report/v1';

const PRIORITY: Record<Severity, 'a' | 'c'> = { critical: 'a', high: 'a', low: 'c' };

const reportSchema = z.object({
  content: z.string().max(REPORT_LIMITS.contentChars).refine((s) => s.trim() !== '', 'empty'),
  severity: z.enum(SEVERITIES).nullable().optional(),
  fileNames: z.array(z.string().max(1000)).max(REPORT_LIMITS.files).optional(),
  userEmail: z.email().max(254).nullable().optional(),
});

export interface ReportRouteDeps {
  db: Db;
  hub: Pick<LiveHub, 'publish'>;
  /** Attachment directory and the workspace's per-file cap (report files are capped lower, at REPORT_LIMITS.fileBytes). */
  dir: string;
  maxBytes: number;
  needUser(req: FastifyRequest): User;
}

/** Cards whose reporter left an address, are done, and haven't been told yet (Phase 8's daily email reads these). */
export function pendingReportEmails(db: Db, limit = 500): { cardId: string; email: string }[] {
  return (db.prepare(`SELECT e.card_id, e.email FROM report_emails e JOIN cards c ON c.id=e.card_id
      WHERE e.notified_at IS NULL AND c.status='done' AND c.visibility!='deleted' ORDER BY c.done_at, c.id LIMIT ?`).all(limit) as { card_id: string; email: string }[])
    .map((r) => ({ cardId: r.card_id, email: r.email }));
}

const publicCors = { publicCors: true };
/**
 * A secret from its header (preferred: headers stay out of access logs and proxies' URL logs), else from the
 * documented query parameter. Nothing here ever logs a request URL (server/app.ts logs route patterns only).
 */
const secretOf = (req: FastifyRequest, header: string, param: string): string => {
  const h = req.headers[header];
  if (typeof h === 'string' && h !== '') return h.trim();
  const v = (req.query as Record<string, unknown>)[param];
  return typeof v === 'string' ? v : '';
};

export function registerReportRoutes(app: FastifyInstance, d: ReportRouteDeps): void {
  const { db } = d;
  const ipLimiter = new TokenRateLimiter();
  const tokenLimiter = new TokenRateLimiter(REPORT_LIMITS.perMinute, 60_000, REPORT_LIMITS.trackedTokens);
  const fileCap = Math.min(REPORT_LIMITS.fileBytes, d.maxBytes);

  // ---- daily budget per token (report_token_usage) ----
  const usageOf = (tokenId: string, day: string) =>
    (db.prepare('SELECT reports, bytes FROM report_token_usage WHERE token_id=? AND day=?').get(tokenId, day) as { reports: number; bytes: number } | undefined)
    ?? { reports: 0, bytes: 0 };
  /** Adds to a token's counters for `day`; a new day's row first prunes rows older than USAGE_KEEP_DAYS. */
  const addUsage = (tokenId: string, day: string, reports: number, bytes: number) => {
    const r = db.prepare('UPDATE report_token_usage SET reports=reports+?, bytes=MAX(0, bytes+?) WHERE token_id=? AND day=?').run(reports, bytes, tokenId, day);
    if (r.changes) return;
    db.prepare('DELETE FROM report_token_usage WHERE day < ?').run(utcDay(Date.parse(`${day}T00:00:00Z`) - USAGE_KEEP_DAYS * DAY_MS));
    db.prepare('INSERT INTO report_token_usage (token_id, day, reports, bytes) VALUES (?,?,?,?)').run(tokenId, day, reports, Math.max(0, bytes));
  };

  const limitIp = (req: FastifyRequest) => {
    const wait = ipLimiter.hit(req.socket.remoteAddress ?? 'unknown');
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
  };
  const publish = (events: ChangeEvent[]) => {
    if (!events.length) return;
    try { d.hub.publish(nextActionId(), events); } catch (e) { console.error('live publish failed', e); }
  };

  // ---- settings (admins, session cookie) ----
  app.get('/api/user-reports', async (req) => {
    const user = d.needUser(req);
    if (!can(db, user, 'account.manage')) throw new AppError(403, 'forbidden');
    const a = reportApp(db);
    return { app: a, tokens: a ? reportTokens(db, a.id) : [] };
  });

  // ---- public endpoints ----
  for (const url of [`${PREFIX}/create-report`, `${PREFIX}/create-report-token`, `${PREFIX}/upload/:id`]) {
    app.options(url, { config: publicCors }, async (_req, reply) => reply.code(204)
      .header('access-control-allow-methods', 'POST, PUT, OPTIONS')
      .header('access-control-allow-headers', 'content-type, x-report-token, x-access-key')
      .header('access-control-max-age', '600')
      .send());
  }

  app.post(`${PREFIX}/create-report`, { config: publicCors, bodyLimit: REPORT_LIMITS.bodyBytes }, async (req) => {
    limitIp(req);
    const token = secretOf(req, 'x-report-token', 'token');
    if (!REPORT_SECRET.test(token) || !token.startsWith(REPORT_TOKEN_PREFIX)) throw new AppError(401, 'invalid_token');
    const t = db.prepare('SELECT id, label, enabled FROM report_tokens WHERE token_hash=?').get(sha256(token)) as { id: string; label: string; enabled: number } | undefined;
    if (!t) throw new AppError(401, 'invalid_token');
    if (!t.enabled) throw new AppError(403, 'token_disabled');
    const wait = tokenLimiter.hit(t.id);
    if (wait) throw new AppError(429, 'rate_limit', undefined, { 'retry-after': String(wait) });
    const at = now();
    const day = utcDay(at);
    const used = usageOf(t.id, day);
    if (used.reports >= REPORT_BUDGET.reports || used.bytes >= REPORT_BUDGET.bytes) throw budgetError(at);
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'invalid_payload', { issues: parsed.error.issues });
    const input = parsed.data;
    const cfg = reportApp(db)!;

    // The severity's deck when it still takes reports, else the main deck.
    const usable = (id: string | null | undefined) => {
      const deck = id ? deckRow(db, id) : undefined;
      return deck && deck.deckType !== 'doc' ? deck : undefined;
    };
    const deck = usable(input.severity ? cfg.severityDecks[input.severity] : null) ?? usable(cfg.deckId);
    if (!deck) throw new AppError(409, 'not_configured');
    let tag = normalizeTagName(t.label);
    const tags = (projectRow(db, deck.projectId as string)?.tags ?? []) as ProjectTag[];
    if (tag && !tags.some((x) => x.name === tag) && tags.length >= MAX_PROJECT_TAGS) tag = null;
    const priority = cfg.severityPriority && input.severity ? PRIORITY[input.severity] : null;

    const uploads = (input.fileNames ?? []).map((n) => ({ fileName: cleanName(n), secret: newSecret('') }));
    let cardId = '';
    const r = dispatchAll(db, systemActor(), [{
      name: 'cards/bulkImport',
      payload: { deckId: deck.id, cards: [{ content: input.content, priority, masterTags: tag ? [tag] : [] }] },
    }], {
      beforeCommit: ([out]) => {
        cardId = (out as { ids: string[] }).ids[0];
        db.prepare('DELETE FROM report_uploads WHERE id IN (SELECT id FROM report_uploads WHERE expires_at <= ? LIMIT 500)').run(at - UPLOAD_KEEP_MS);
        const add = db.prepare('INSERT INTO report_uploads (id, card_id, file_name, expires_at, token_id) VALUES (?,?,?,?,?)');
        for (const u of uploads) add.run(sha256(u.secret), cardId, u.fileName, at + REPORT_LIMITS.uploadMs, t.id);
        addUsage(t.id, day, 1, 0);
        if (input.userEmail) db.prepare('INSERT INTO report_emails (card_id, email) VALUES (?,?)').run(cardId, input.userEmail);
      },
    });
    publish(r.events);
    return { ok: true, cardId, uploadUrls: uploads.map((u) => ({ fileName: u.fileName, url: `${PREFIX}/upload/${u.secret}`, fields: {} })) };
  });

  app.post(`${PREFIX}/create-report-token`, { config: publicCors, bodyLimit: REPORT_LIMITS.bodyBytes }, async (req) => {
    limitIp(req);
    const key = secretOf(req, 'x-access-key', 'accessKey');
    const a = REPORT_SECRET.test(key) && key.startsWith(ACCESS_KEY_PREFIX)
      ? db.prepare('SELECT id FROM report_apps WHERE access_key_hash=?').get(sha256(key)) as { id: string } | undefined
      : undefined;
    if (!a) throw new AppError(403, 'invalid_access_key');
    const label = labelSchema.safeParse((req.body as { label?: unknown } | undefined)?.label);
    if (!label.success) throw new AppError(400, 'invalid_payload', { field: 'label' });
    return { ok: true, token: insertReportToken(db, a.id, label.data).token };
  });

  // Raw-body route, encapsulated so its catch-all parser doesn't reach the JSON routes.
  app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    inst.put(`${PREFIX}/upload/:id`, { config: publicCors, bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const refuse = (e: unknown) => {
        // Stop reading the rest of a refused upload: close the connection once the error response is out.
        reply.header('connection', 'close');
        reply.raw.once('finish', () => req.raw.destroy());
        return e;
      };
      try { limitIp(req); } catch (e) { throw refuse(e); }
      const secret = (req.params as { id: string }).id;
      if (!UPLOAD_ID.test(secret)) throw refuse(new AppError(404, 'not_found'));
      const id = sha256(secret);
      const row = db.prepare('SELECT card_id, file_name, expires_at, used_at, token_id FROM report_uploads WHERE id=?').get(id) as
        { card_id: string; file_name: string; expires_at: number; used_at: number | null; token_id: string | null } | undefined;
      const at = now();
      if (!row) throw refuse(new AppError(404, 'not_found'));
      if (row.used_at !== null) throw refuse(new AppError(409, 'upload_used'));
      if (row.expires_at <= at) throw refuse(new AppError(410, 'upload_expired'));
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > fileCap) throw refuse(new AppError(413, 'file_too_large'));
      const stream = req.body as NodeJS.ReadableStream | undefined;
      if (!stream || typeof (stream as any).pipe !== 'function') throw refuse(new AppError(400, 'invalid_input'));
      // The token's daily byte budget: this upload may take at most what is left of it. That much is reserved up
      // front (so concurrent uploads can't overshoot) and settled to the stored size afterwards.
      const day = utcDay(at);
      let cap = fileCap;
      if (row.token_id) {
        const left = REPORT_BUDGET.bytes - usageOf(row.token_id, day).bytes;
        if (left <= 0 || (Number.isFinite(declared) && declared > left)) throw refuse(budgetError(at));
        cap = Math.min(fileCap, left, Number.isFinite(declared) && declared > 0 ? declared : Infinity);
      }
      // Claimed before the bytes stream in, so two concurrent PUTs can't both attach; released if the upload fails.
      if (!db.prepare('UPDATE report_uploads SET used_at=? WHERE id=? AND used_at IS NULL').run(at, id).changes) throw refuse(new AppError(409, 'upload_used'));
      if (row.token_id) addUsage(row.token_id, day, 0, cap);
      const events: ChangeEvent[] = [];
      const ctx: Ctx = { db, actor: systemActor(), events, emit: (model, op, r) => { events.push({ model, op, row: r }); }, afterCommit: () => {} };
      let fileId: string;
      try {
        fileId = await storeCardFile({ db, dir: d.dir, maxBytes: cap, ctx, cardId: row.card_id, stream, name: row.file_name, mime: cleanMime(req.headers['content-type']), checkImage: true });
      } catch (e) {
        db.prepare('UPDATE report_uploads SET used_at=NULL WHERE id=?').run(id);
        if (row.token_id) addUsage(row.token_id, day, 0, -cap);
        // Over what was left of the day's budget (but within the per-file cap): the budget is what refused it.
        if (cap < fileCap && !Number.isFinite(declared) && e instanceof AppError && e.code === 'file_too_large') throw refuse(budgetError(now()));
        throw refuse(e);
      }
      // Settle the reservation to the bytes actually stored.
      if (row.token_id) addUsage(row.token_id, day, 0, (db.prepare('SELECT size FROM files WHERE id=?').get(fileId) as { size: number }).size - cap);
      publish(events);
      return { ok: true };
    });
  });
}


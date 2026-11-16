/**
 * Email: the outbox, the two transports and a minimal SMTP client.
 *
 * Every email is a row in email_outbox (enqueueEmail, inside the caller's transaction). The scheduler hands the due rows
 * to sendPendingEmails once a minute: at most SEND_PER_TICK, each tried up to MAX_ATTEMPTS times with BACKOFF_MS between
 * tries (a permanent 5xx answer to MAIL, RCPT or DATA fails at once; a refused sign-in is retried, as it is a setup
 * problem the admin can fix). The outbox keeps the newest OUTBOX_MAX rows.
 *
 * Transports (emailConfig): 'log' (the default) sends nothing; rows are marked "not sent (log mode)". 'smtp' talks to
 * SMTP_HOST:SMTP_PORT with STARTTLS (required unless SMTP_STARTTLS=false) and AUTH PLAIN when SMTP_USER is set.
 * A disabled workspace (Danger Zone) sends nothing.
 *
 * Kinds (EMAIL_KINDS) say what an email is for; unsubscribable kinds carry a signed link (GET /email/unsubscribe) and
 * List-Unsubscribe and List-Unsubscribe-Post (RFC 8058 one-click) headers, and an address that unsubscribed from a kind is skipped at enqueue.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { hostname } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { Db } from './db';
import { toCamel } from './db';
import { deriveKey } from './secret';

export interface EmailKindInfo {
  /** Shown in the outbox and on the unsubscribe page. */
  label: string;
  /** Carries an unsubscribe link; the recipient can turn this kind off. */
  unsubscribe: boolean;
  /** The body holds a credential (an invite link): it is cleared from the outbox once the row is handled. */
  sensitive?: boolean;
  /**
   * In log mode (nothing is sent) the body is kept despite `sensitive`, and admins see the link in the outbox
   * (emailStatus `link`), so a LAN install can still finish the flow by hand.
   */
  keepInLogMode?: boolean;
}
/** What each email is for. New kinds (Open Deck updates, ...) are added here. */
export const EMAIL_KINDS = {
  notifications: { label: 'Notification emails', unsubscribe: true },
  reportDone: { label: 'Emails about your reports', unsubscribe: true },
  invite: { label: 'Invites', unsubscribe: false, sensitive: true },
  /** Open Decks: what's new in a public project, daily or weekly as each subscriber picked (server/jobs.ts). */
  openDeckUpdates: { label: 'Public list update emails', unsubscribe: true },
  /** Open Decks: the weekly upvote digest for workspace admins. */
  openDeckDigest: { label: 'Weekly upvote digests', unsubscribe: true },
  /** Open Decks: the link that finishes a visitor's sign-up (no account exists before it is used). */
  openDeckConfirm: { label: 'Sign-up confirmations', unsubscribe: false, sensitive: true, keepInLogMode: true },
  /** Open Decks: told to an existing account's address when someone tries to sign up with it. */
  openDeckNotice: { label: 'Sign-up notices', unsubscribe: false },
} as const satisfies Record<string, EmailKindInfo>;
export type EmailKind = keyof typeof EMAIL_KINDS;
const kindInfo = (kind: string): EmailKindInfo | undefined => (Object.hasOwn(EMAIL_KINDS, kind) ? (EMAIL_KINDS as Record<string, EmailKindInfo>)[kind] : undefined);

export const OUTBOX_MAX = 10_000;
export const SEND_PER_TICK = 20;
export const MAX_ATTEMPTS = 5;
/** Wait after attempt n (1-based) before attempt n + 1. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const LOG_MODE_NOTE = 'not sent (log mode)';
const REDACTED = '(removed from the outbox once handled)';
/** Rows marked per call in log mode. */
const LOG_BATCH = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
/** One email, start to end, whatever each step takes. */
const DEFAULT_DEADLINE_MS = 120_000;
/** An SMTP reply longer than this is a broken server. */
const MAX_REPLY_BYTES = 64 * 1024;

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** Envelope sender and From address. */
  from: string;
  /** Upgrade with STARTTLS; when true and the server doesn't offer it, nothing is sent. */
  starttls: boolean;
  /** Per step (connect, each reply). Default 30 s. */
  timeoutMs?: number;
  /** Whole email. Default 2 min. */
  deadlineMs?: number;
  /** Extra TLS options for the upgrade (tests trust their own certificate with `ca`). */
  tls?: ConnectionOptions;
}
export interface EmailConfig {
  transport: 'log' | 'smtp';
  smtp: SmtpConfig | null;
  /** Base of links in emails (JT_PUBLIC_URL), without a trailing slash. */
  publicUrl: string;
}

const isOff = (v: string | undefined) => /^(0|false|no|off)$/i.test(v?.trim() ?? '');

/** The email settings from the environment, with overrides (tests) on top. Throws on an incomplete SMTP setup. */
export function emailConfig(over: Partial<EmailConfig> = {}, env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const transport = over.transport ?? ((env.EMAIL_TRANSPORT ?? 'log').trim().toLowerCase() as EmailConfig['transport']);
  if (transport !== 'log' && transport !== 'smtp') throw new Error(`EMAIL_TRANSPORT must be "log" or "smtp", not "${transport}"`);
  let smtp = over.smtp ?? null;
  if (!smtp && transport === 'smtp') {
    const host = env.SMTP_HOST?.trim() ?? '';
    const from = env.SMTP_FROM?.trim() ?? '';
    if (!host || !isAddress(from)) throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_HOST and SMTP_FROM (an email address)');
    smtp = {
      host, port: Number(env.SMTP_PORT ?? 587) || 587, from, starttls: !isOff(env.SMTP_STARTTLS),
      user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined,
    };
  }
  const publicUrl = (over.publicUrl ?? env.JT_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8780}`).trim().replace(/\/+$/, '');
  return { transport, smtp, publicUrl };
}

// ---- per-database link settings (set by buildApp) ----
interface LinkEnv { publicUrl: string; unsubscribeKey: Buffer }
const linkEnvs = new WeakMap<Db, LinkEnv>();
/** Where links in emails point, and the server secret that signs unsubscribe links. */
export function setEmailEnv(db: Db, e: { publicUrl: string; secret: string }): void {
  linkEnvs.set(db, { publicUrl: e.publicUrl.replace(/\/+$/, ''), unsubscribeKey: deriveKey(e.secret, 'email-unsubscribe') });
}
function linkEnv(db: Db): LinkEnv {
  let e = linkEnvs.get(db);
  if (!e) linkEnvs.set(db, (e = { publicUrl: emailConfig().publicUrl, unsubscribeKey: randomBytes(32) }));
  return e;
}
export const publicUrlOf = (db: Db): string => linkEnv(db).publicUrl;

// ---- addresses and headers ----
const ADDRESS = /^[^\s<>()[\]\\,;:"@]{1,64}@[^\s<>()[\]\\,;:"@]{1,253}$/;
/** A bare address that is safe in a header and an SMTP command: no spaces, brackets, quotes or line breaks. */
export const isAddress = (s: string): boolean => s.length <= 254 && ADDRESS.test(s) && !/[\x00-\x1f\x7f]/.test(s);
const normAddr = (s: string) => s.trim().toLowerCase();
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();

// ---- the outbox ----
export interface OutgoingEmail { to: string; subject: string; text: string; html?: string | null; kind: EmailKind; userId?: string | null }

const isDisabled = (db: Db) => (db.prepare('SELECT is_disabled d FROM account').get() as { d: number } | undefined)?.d === 1;

export const isUnsubscribed = (db: Db, to: string, kind: string): boolean =>
  !!db.prepare('SELECT 1 FROM email_unsubscribes WHERE addr=? AND kind=?').get(normAddr(to), kind);

/**
 * Queues an email (in the caller's transaction). Returns the row id, or null when the address is unusable or has
 * unsubscribed from this kind. Line breaks in the subject become spaces.
 */
export function enqueueEmail(db: Db, m: OutgoingEmail, now = Date.now()): number | null {
  const info = kindInfo(m.kind);
  if (!info) throw new Error(`unknown email kind ${m.kind}`);
  const to = m.to.trim();
  if (!isAddress(to)) return null;
  if (info.unsubscribe && isUnsubscribed(db, to, m.kind)) return null;
  const r = db.prepare(`INSERT INTO email_outbox (to_addr, subject, text, html, kind, user_id, status, created_at, next_attempt_at)
    VALUES (?,?,?,?,?,?,'pending',?,?)`).run(to, [...oneLine(m.subject)].slice(0, 250).join(''), m.text, m.html ?? null, m.kind, m.userId ?? null, now, now);
  return Number(r.lastInsertRowid);
}

/** Keeps at most OUTBOX_MAX rows: the oldest finished (sent, failed, log) rows go first, pending ones only when nothing else is left. */
export function pruneOutbox(db: Db): void {
  const { n } = db.prepare('SELECT COUNT(*) n FROM email_outbox').get() as { n: number };
  if (n <= OUTBOX_MAX) return;
  const { changes } = db.prepare("DELETE FROM email_outbox WHERE id IN (SELECT id FROM email_outbox WHERE status!='pending' ORDER BY id LIMIT ?)").run(n - OUTBOX_MAX);
  const left = n - Number(changes);
  if (left > OUTBOX_MAX) db.prepare('DELETE FROM email_outbox WHERE id IN (SELECT id FROM email_outbox ORDER BY id LIMIT ?)').run(left - OUTBOX_MAX);
}

function finish(db: Db, id: number, kind: string, set: string, args: (string | number | null)[], logMode = false): void {
  const info = kindInfo(kind);
  const redact = info?.sensitive && !(logMode && info.keepInLogMode) ? `, text='${REDACTED}', html=NULL` : '';
  db.prepare(`UPDATE email_outbox SET ${set}${redact} WHERE id=?`).run(...args, id);
}

/**
 * Sends (or, in log mode, marks) the due rows: at most SEND_PER_TICK over SMTP, one connection each, one after the
 * other. Nothing at all while the workspace is disabled. Never throws for a single email's failure.
 */
export async function sendPendingEmails(db: Db, cfg: EmailConfig, now: number): Promise<{ sent: number; failed: number; logged: number }> {
  const out = { sent: 0, failed: 0, logged: 0 };
  pruneOutbox(db);
  if (isDisabled(db)) return out;
  if (cfg.transport === 'log' || !cfg.smtp) {
    const rows = db.prepare(`SELECT id, kind FROM email_outbox WHERE status='pending' ORDER BY id LIMIT ${LOG_BATCH}`).all() as { id: number; kind: string }[];
    for (const r of rows) finish(db, r.id, r.kind, "status='log', last_error=?", [LOG_MODE_NOTE], true);
    out.logged = rows.length;
    return out;
  }
  const rows = db.prepare(`SELECT id, to_addr, subject, text, html, kind, attempts FROM email_outbox
    WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ${SEND_PER_TICK}`).all(now) as
    { id: number; to_addr: string; subject: string; text: string; html: string | null; kind: string; attempts: number }[];
  for (const r of rows) {
    // The workspace may be disabled while a batch is under way.
    if (isDisabled(db)) break;
    const attempts = r.attempts + 1;
    try {
      const listUnsubscribe = kindInfo(r.kind)?.unsubscribe ? unsubscribeUrl(db, r.to_addr, r.kind) : undefined;
      await smtpSend(cfg.smtp, { to: r.to_addr, subject: r.subject, text: r.text, html: r.html, listUnsubscribe });
      finish(db, r.id, r.kind, "status='sent', sent_at=?, attempts=?, last_error=NULL", [now, attempts]);
      out.sent++;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      // Only the message's own steps are final; a 5xx at sign-in or STARTTLS is a server setup problem.
      const permanent = e instanceof SmtpError && e.code >= 500 && MESSAGE_STEPS.has(e.step);
      if (permanent || attempts >= MAX_ATTEMPTS) finish(db, r.id, r.kind, "status='failed', attempts=?, last_error=?", [attempts, msg]);
      else db.prepare('UPDATE email_outbox SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?').run(attempts, msg, now + BACKOFF_MS[attempts - 1], r.id);
      out.failed++;
    }
  }
  return out;
}

/** What admins see in Settings > Email: the transport (never the password) and the newest 200 rows without bodies. */
export function emailStatus(db: Db, cfg: EmailConfig) {
  const counts = Object.fromEntries((db.prepare('SELECT status, COUNT(*) c FROM email_outbox GROUP BY status').all() as { status: string; c: number }[]).map((r) => [r.status, r.c]));
  // No bodies, except the one link of a kind kept in log mode (sign-up confirmations), for admins to pass on by hand.
  const keep = Object.entries(EMAIL_KINDS).filter(([, i]) => (i as EmailKindInfo).keepInLogMode).map(([k]) => k);
  const outbox = (db.prepare('SELECT id, to_addr, subject, kind, status, created_at, sent_at, attempts, last_error, text FROM email_outbox ORDER BY id DESC LIMIT 200').all() as Record<string, unknown>[])
    .map(({ text, ...r }) => {
      const link = (r.status === 'log' || (cfg.transport === 'log' && r.status === 'pending')) && keep.includes(String(r.kind)) ? /https?:\/\/\S+/.exec(String(text ?? ''))?.[0] ?? null : null;
      return { ...toCamel(r), ...(link ? { link } : {}) };
    });
  return {
    transport: cfg.transport,
    smtp: cfg.transport === 'smtp' && cfg.smtp ? { host: cfg.smtp.host, port: cfg.smtp.port, from: cfg.smtp.from, starttls: cfg.smtp.starttls, auth: !!cfg.smtp.user } : null,
    publicUrl: cfg.publicUrl,
    counts: { pending: counts.pending ?? 0, sent: counts.sent ?? 0, failed: counts.failed ?? 0, log: counts.log ?? 0 },
    outbox,
  };
}

// ---- preferences and unsubscribes ----
export type NotificationPref = 'off' | 'daily' | 'instant';
export const NOTIFICATION_PREFS = ['off', 'daily', 'instant'] as const;

export const emailPrefsOf = (db: Db, userId: string): NotificationPref =>
  ((db.prepare('SELECT notifications n FROM email_prefs WHERE user_id=?').get(userId) as { n: NotificationPref } | undefined)?.n ?? 'daily');

/** Sets a person's notification emails. Turning them back on also lifts an earlier unsubscribe of that kind. */
export function setEmailPrefs(db: Db, userId: string, notifications: NotificationPref, now = Date.now()): void {
  db.prepare(`INSERT INTO email_prefs (user_id, notifications, updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET notifications=excluded.notifications, updated_at=excluded.updated_at`).run(userId, notifications, now);
  if (notifications !== 'off') {
    const u = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email: string } | undefined;
    if (u) db.prepare("DELETE FROM email_unsubscribes WHERE addr=? AND kind='notifications'").run(normAddr(u.email));
  }
}

const mac = (db: Db, data: string) => createHmac('sha256', linkEnv(db).unsubscribeKey).update(data).digest();

/** `<base64url address>.<kind>.<HMAC>`: signed per recipient and kind with a key derived from the server secret. */
export function unsubscribeToken(db: Db, to: string, kind: string): string {
  const a = Buffer.from(normAddr(to)).toString('base64url');
  return `${a}.${kind}.${mac(db, `${a}.${kind}`).toString('base64url')}`;
}
export const unsubscribeUrl = (db: Db, to: string, kind: string): string =>
  `${publicUrlOf(db)}/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(db, to, kind))}`;

export function verifyUnsubscribeToken(db: Db, token: string): { addr: string; kind: EmailKind } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [a, kind, sig] = parts;
  if (!kindInfo(kind)?.unsubscribe) return null;
  const want = mac(db, `${a}.${kind}`);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || got.toString('base64url') !== sig || !timingSafeEqual(got, want)) return null;
  const addr = Buffer.from(a, 'base64url').toString('utf8');
  return isAddress(addr) && normAddr(addr) === addr ? { addr, kind: kind as EmailKind } : null;
}

/** Records the unsubscribe; for notification emails the matching people's preference is set to 'off' too. */
export function applyUnsubscribe(db: Db, addr: string, kind: EmailKind, now = Date.now()): void {
  db.prepare('INSERT OR IGNORE INTO email_unsubscribes (addr, kind, created_at) VALUES (?,?,?)').run(normAddr(addr), kind, now);
  if (kind === 'notifications') {
    for (const u of db.prepare('SELECT id FROM users WHERE lower(email)=?').all(normAddr(addr)) as { id: string }[]) {
      db.prepare(`INSERT INTO email_prefs (user_id, notifications, updated_at) VALUES (?, 'off', ?)
        ON CONFLICT(user_id) DO UPDATE SET notifications='off', updated_at=excluded.updated_at`).run(u.id, now);
    }
  }
}

// ---- schedule slots ----
/** Local hour at which daily and weekly emails go out. */
export const SEND_HOUR = 8;
const T = () => (globalThis as any).Temporal;
function zoned(zone: string | null | undefined, now: number): any {
  const inst = T().Instant.fromEpochMilliseconds(now);
  try { return inst.toZonedDateTimeISO(zone || 'UTC'); } catch { return inst.toZonedDateTimeISO('UTC'); }
}
/**
 * The send slot that is due now in `zone` (unknown zones count as UTC), or null: 'daily' gives the local date from
 * 08:00 until midnight, 'weekly' the ISO week ("2026-W47") on Mondays from 08:00. A job sends once per slot.
 */
export function dueSlot(zone: string | null | undefined, now: number, cadence: 'daily' | 'weekly', hour = SEND_HOUR): string | null {
  const z = zoned(zone, now);
  if (z.hour < hour) return null;
  const d = z.toPlainDate();
  if (cadence === 'daily') return d.toString();
  if (z.dayOfWeek !== 1) return null;
  return `${d.yearOfWeek}-W${String(d.weekOfYear).padStart(2, '0')}`;
}
/** Today's send time (08:00 local) in `zone`, as epoch ms. */
export function slotStart(zone: string | null | undefined, now: number, hour = SEND_HOUR): number {
  const z = zoned(zone, now);
  return z.with({ hour, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }).epochMilliseconds;
}

// ---- message building ----
const MESSAGE_STEPS = new Set(['MAIL FROM', 'RCPT TO', 'DATA', 'end of DATA']);
export class SmtpError extends Error {
  constructor(public code: number, text: string, public step: string) { super(`SMTP ${step}: ${code} ${text}`.slice(0, 500)); }
}

function assertHeader(name: string, v: string): void {
  if (/[\r\n\0]/.test(v)) throw new Error(`the ${name} header contains a line break`);
}

/** RFC 2047 encoded words (UTF-8, base64) for a non-ASCII subject, folded so each word stays within 75 characters. */
export function encodeHeaderWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s) && s.length <= 900) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** Quoted-printable (RFC 2045) with CRLF line ends; lines stay within 76 characters. */
export function quotedPrintable(s: string): string {
  return s.replace(/\r\n|\r|\n/g, '\n').split('\n').map((line) => {
    const bytes = Buffer.from(line, 'utf8');
    let out = '';
    let cur = '';
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const tok = ((b === 0x20 || b === 0x09) && !last) || (b >= 33 && b <= 126 && b !== 61)
        ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cur.length + tok.length > 75) { out += `${cur}=\r\n`; cur = ''; }
      cur += tok;
    });
    return out + cur;
  }).join('\r\n');
}

const part = (type: string, body: string) =>
  `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(body)}\r\n`;

/** The full message (headers and body, CRLF, not yet dot-stuffed): text, or multipart/alternative text + HTML. */
export function buildMessage(m: { from: string; to: string; subject: string; text: string; html?: string | null; listUnsubscribe?: string; now?: number }): string {
  for (const [name, v] of [['From', m.from], ['To', m.to], ['Subject', m.subject], ['List-Unsubscribe', m.listUnsubscribe ?? '']] as const) assertHeader(name, v);
  if (!isAddress(m.from) || !isAddress(m.to)) throw new Error('invalid address');
  const domain = m.from.split('@')[1];
  const headers = [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${new Date(m.now ?? Date.now()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`, 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated',
  ];
  if (m.listUnsubscribe) headers.push(`List-Unsubscribe: <${m.listUnsubscribe}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  if (!m.html) return `${headers.join('\r\n')}\r\n${part('text/plain', m.text)}`;
  const boundary = `jt-${randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return `${headers.join('\r\n')}\r\n\r\n--${boundary}\r\n${part('text/plain', m.text)}--${boundary}\r\n${part('text/html', m.html)}--${boundary}--\r\n`;
}

/** SMTP transparency (RFC 5321 4.5.2): a line starting with '.' gets one more. */
export const dotStuff = (msg: string): string => msg.replace(/\r\n|\r|\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');

// ---- the SMTP client ----
/** One connection: reads complete (possibly multi-line) replies with a timeout per reply. */
class SmtpConnection {
  private buf = '';
  private decoder = new StringDecoder('utf8');
  /** Bytes of the reply being read (all its lines), capped at MAX_REPLY_BYTES. */
  private replyBytes = 0;
  private lines: string[] = [];
  private replies: { code: number; lines: string[] }[] = [];
  private waiter: ((r: { code: number; lines: string[] } | Error) => void) | null = null;
  private failure: Error | null = null;
  constructor(public sock: Socket | TLSSocket, private timeoutMs: number) { this.attach(sock); }

  private onData = (d: Buffer) => {
    this.replyBytes += d.length;
    if (this.replyBytes > MAX_REPLY_BYTES) { this.fail(new Error('SMTP reply too long')); this.sock.destroy(); return; }
    this.buf += this.decoder.write(d);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) { this.fail(new Error('SMTP reply not understood')); return; }
      this.lines.push(m[3]);
      if (m[2] !== '-') {
        this.replies.push({ code: Number(m[1]), lines: this.lines });
        this.lines = [];
        this.replyBytes = Buffer.byteLength(this.buf);
      }
    }
    this.flush();
  };
  private onError = (e: Error) => this.fail(e);
  private onClose = () => this.fail(new Error('SMTP connection closed'));

  /** Ends the connection: the pending and every later read fail with `e`. */
  abort(e: Error) {
    this.fail(e);
    this.sock.destroy();
  }
  private fail(e: Error) {
    if (!this.failure) this.failure = e;
    this.flush();
  }
  private flush() {
    if (!this.waiter) return;
    const r = this.replies.shift() ?? this.failure;
    if (!r) return;
    const w = this.waiter;
    this.waiter = null;
    w(r);
  }
  attach(sock: Socket | TLSSocket) {
    this.sock = sock;
    sock.on('data', this.onData);
    sock.on('error', this.onError);
    sock.on('close', this.onClose);
  }
  detach() {
    this.sock.removeListener('data', this.onData);
    this.sock.removeListener('error', this.onError);
    this.sock.removeListener('close', this.onClose);
    this.buf = '';
    this.decoder = new StringDecoder('utf8');
    this.replyBytes = 0;
    this.lines = [];
    this.replies = [];
  }
  read(step: string): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error(`SMTP timeout waiting for the ${step} reply`)); }, this.timeoutMs);
      this.waiter = (r) => { clearTimeout(timer); if (r instanceof Error) reject(r); else resolve(r); };
      this.flush();
    });
  }
  async cmd(line: string, ok: number[], step: string): Promise<string[]> {
    this.sock.write(`${line}\r\n`);
    return this.expect(ok, step);
  }
  async expect(ok: number[], step: string): Promise<string[]> {
    const r = await this.read(step);
    if (!ok.includes(r.code)) throw new SmtpError(r.code, r.lines.join(' '), step);
    return r.lines;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const withTimeout = <T>(p: Promise<T>, ms: number, what: string, onTimeout: () => void): Promise<T> => new Promise((resolve, reject) => {
  const t = setTimeout(() => { onTimeout(); reject(new Error(`SMTP timeout: ${what}`)); }, ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * Sends one email: EHLO, STARTTLS (when configured; required then), AUTH PLAIN (when a user is set; never in the
 * clear except to a loopback host), MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT. Each step has a timeout, and the
 * whole email a deadline.
 */
export async function smtpSend(cfg: SmtpConfig, m: { to: string; subject: string; text: string; html?: string | null; listUnsubscribe?: string }): Promise<void> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const message = buildMessage({ from: cfg.from, ...m });
  const raw = netConnect({ host: cfg.host, port: cfg.port });
  raw.on('error', () => {}); // reported through the connection's reads
  let conn: SmtpConnection | null = null;
  let tls: TLSSocket | null = null;
  const deadlineMs = cfg.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = setTimeout(() => {
    const e = new Error(`SMTP timeout: the email took longer than ${Math.round(deadlineMs / 1000)} s`);
    if (conn) conn.abort(e); else raw.destroy(e);
    tls?.destroy();
  }, deadlineMs);
  try {
    await withTimeout(new Promise<void>((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); }), timeoutMs, 'connect', () => raw.destroy());
    conn = new SmtpConnection(raw, timeoutMs);
    const helo = hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    await conn.expect([220], 'greeting');
    let ext = await conn.cmd(`EHLO ${helo}`, [250], 'EHLO');
    let secure = false;
    if (cfg.starttls) {
      if (!ext.some((l) => /^STARTTLS\b/i.test(l))) throw new Error('SMTP server does not offer STARTTLS');
      await conn.cmd('STARTTLS', [220], 'STARTTLS');
      conn.detach();
      const t = tlsConnect({ ...cfg.tls, socket: raw, ...(isIP(cfg.host) ? {} : { servername: cfg.host }) });
      tls = t;
      t.on('error', () => {});
      await withTimeout(new Promise<void>((resolve, reject) => { t.once('secureConnect', resolve); t.once('error', reject); }), timeoutMs, 'TLS handshake', () => t.destroy());
      conn.attach(t);
      secure = true;
      ext = await conn.cmd(`EHLO ${helo}`, [250], 'EHLO');
    }
    if (cfg.user) {
      if (!secure && !LOOPBACK.has(cfg.host)) throw new Error('refusing to send the SMTP password without TLS');
      if (!ext.some((l) => /^AUTH\b.*\bPLAIN\b/i.test(l))) throw new Error('SMTP server does not offer AUTH PLAIN');
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ''}`).toString('base64');
      await conn.cmd(`AUTH PLAIN ${plain}`, [235], 'AUTH');
    }
    await conn.cmd(`MAIL FROM:<${cfg.from}>`, [250], 'MAIL FROM');
    await conn.cmd(`RCPT TO:<${m.to}>`, [250, 251], 'RCPT TO');
    await conn.cmd('DATA', [354], 'DATA');
    conn.sock.write(`${dotStuff(message).replace(/\r\n$/, '')}\r\n.\r\n`);
    await conn.expect([250], 'end of DATA');
    try { await conn.cmd('QUIT', [221], 'QUIT'); } catch { /* sent already */ }
    conn.sock.destroy();
  } finally {
    clearTimeout(deadline);
    tls?.destroy();
    raw.destroy();
  }
}

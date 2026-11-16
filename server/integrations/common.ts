/**
 * What Discord and Slack share: secrets at rest, the settings rows, replay protection and the notification outbox.
 *
 * - Secrets (bot tokens, signing secrets, webhook URLs) are AES-256-GCM encrypted with a key derived from the server
 *   secret (server/secret.ts deriveKey, purpose "integration-secrets"); the slot is bound in as additional data. A value
 *   that no longer decrypts (the server secret changed) reads as not set. Secrets are never logged or sent to browsers:
 *   the settings read says only whether each one is set.
 * - Notifications: every published batch of change events (LiveHub.onPublish) is turned into outbox rows for the
 *   configured webhooks (card created, card done, comment, milestone created), at most ENQUEUE_PER_BATCH per batch,
 *   one row per event (dedupe_key). Nothing is sent on the request path: IntegrationNotifier.flush posts at most
 *   SEND_PER_TICK due rows per call through the allow-list client, retrying with BACKOFF_MS up to MAX_ATTEMPTS. Nothing
 *   is queued or sent while the workspace is disabled. The outbox keeps at most OUTBOX_MAX rows.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from '../db';
import { AppError } from '../errors';
import { deriveKey } from '../secret';
import { publicUrlOf } from '../email';
import { isWorkspaceDisabled } from '../commands/dangerZone';
import { cardCode, titleOf } from '../../shared/cards';
import type { ChangeEvent } from '../dispatch';
import { OutboundError, type OutboundClient } from './http';

export type IntegrationKind = 'discord' | 'slack';

// ---------------------------------------------------------------------------------------------------------------
// Secrets at rest

const keys = new WeakMap<Db, Buffer>();
/** Called by buildApp with the server secret. */
export function setIntegrationSecret(db: Db, secret: string): void {
  keys.set(db, deriveKey(secret, 'integration-secrets'));
}
function keyOf(db: Db): Buffer {
  const k = keys.get(db);
  if (!k) throw new AppError(500, 'internal');
  return k;
}

const VERSION = 'v1.';
export function sealSecret(key: Buffer, slot: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(slot));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return VERSION + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function openSecret(key: Buffer, slot: string, sealed: string): string | null {
  if (!sealed.startsWith(VERSION)) return null;
  const raw = Buffer.from(sealed.slice(VERSION.length), 'base64url');
  if (raw.length < 29) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(slot));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Seals / opens a value kept in a table of its own (git hooks), bound to `slot`, with this database's key. */
export const sealFor = (db: Db, slot: string, plain: string): string => sealSecret(keyOf(db), slot, plain);
export const openFor = (db: Db, slot: string, sealed: string): string | null => openSecret(keyOf(db), slot, sealed);

/** The plain secret, or null when it is not set or can't be decrypted with this server's secret. */
export function getSecret(db: Db, kind: IntegrationKind, name: string): string | null {
  const r = db.prepare('SELECT value FROM integration_secrets WHERE kind=? AND name=?').get(kind, name) as { value: string } | undefined;
  return r ? openSecret(keyOf(db), `${kind}:${name}`, r.value) : null;
}
/** Stores (string) or removes (null) a secret; undefined leaves it as it is. */
export function putSecret(db: Db, kind: IntegrationKind, name: string, value: string | null | undefined, now: number): void {
  if (value === undefined) return;
  if (value === null) {
    db.prepare('DELETE FROM integration_secrets WHERE kind=? AND name=?').run(kind, name);
    return;
  }
  db.prepare('INSERT INTO integration_secrets (kind, name, value, updated_at) VALUES (?,?,?,?) ON CONFLICT(kind, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run(kind, name, sealSecret(keyOf(db), `${kind}:${name}`, value), now);
}
export const secretIsSet = (db: Db, kind: IntegrationKind, name: string): boolean => getSecret(db, kind, name) !== null;
/** Removes the secrets of `kind` whose names start with `prefix` and are not in `keep`. */
export function dropSecrets(db: Db, kind: IntegrationKind, prefix: string, keep: Set<string>): void {
  const names = db.prepare("SELECT name FROM integration_secrets WHERE kind=? AND substr(name, 1, ?)=?").all(kind, prefix.length, prefix) as { name: string }[];
  for (const { name } of names) if (!keep.has(name)) db.prepare('DELETE FROM integration_secrets WHERE kind=? AND name=?').run(kind, name);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings (no secrets)

export function readConfig<T extends object>(db: Db, kind: IntegrationKind, defaults: T): T {
  const r = db.prepare('SELECT config_json c FROM integration_settings WHERE kind=?').get(kind) as { c: string } | undefined;
  return { ...defaults, ...(r ? JSON.parse(r.c) : {}) };
}
export function writeConfig(db: Db, kind: IntegrationKind, config: object, now: number): void {
  db.prepare('INSERT INTO integration_settings (kind, config_json, updated_at) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at')
    .run(kind, JSON.stringify(config), now);
}

// ---------------------------------------------------------------------------------------------------------------
// Replay protection for inbound interactions

const SEEN_KEEP_MS = 86_400_000;
/** True when (kind, id) was handled already. */
export const wasSeen = (db: Db, kind: string, id: string): boolean =>
  !!db.prepare('SELECT 1 FROM integration_seen WHERE kind=? AND event_id=?').get(kind, id);

/** True the first time (kind, id) is seen; false for a replay. Old ids are pruned in small batches. */
export function firstSeen(db: Db, kind: string, id: string, now: number): boolean {
  db.prepare('DELETE FROM integration_seen WHERE rowid IN (SELECT rowid FROM integration_seen WHERE seen_at < ? LIMIT 200)').run(now - SEEN_KEEP_MS);
  return db.prepare('INSERT OR IGNORE INTO integration_seen (kind, event_id, seen_at) VALUES (?,?,?)').run(kind, id, now).changes === 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications

export const OUTBOX_MAX = 10_000;
export const SEND_PER_TICK = 20;
export const ENQUEUE_PER_BATCH = 20;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** An event counts as new for this long after it happened (a later edit of the same card is not a "new card"). */
const FRESH_MS = 2 * 60_000;
const KEEP_HANDLED_MS = 86_400_000;
/** Change events looked at per published batch (a large import doesn't make the request path read every card). */
const EXAMINE_PER_BATCH = 500;
const SEND_TIMEOUT_MS = 10_000;
const TITLE_MAX = 200;
const COMMENT_MAX = 300;

/** What happened, in plain fields; each integration formats it for its chat. */
export type ChatEvent =
  | { type: 'cardCreated' | 'cardDone'; projectId: string; deck: string; title: string; url: string }
  | { type: 'comment'; projectId: string; title: string; url: string; author: string; text: string }
  | { type: 'milestone'; projectIds: string[]; global: boolean; name: string; date: string | null };

/** One integration's side of the notifications. */
export interface ChatTarget {
  kind: IntegrationKind;
  /**
   * Reads the settings once and returns where each event goes: outbox `project_id` values (null = the integration's
   * single webhook); empty to skip.
   */
  router(db: Db): (e: ChatEvent) => (string | null)[];
  /** The webhook body for an event. */
  format(e: ChatEvent): object;
  /** The webhook URL for a row's `project_id`, or null when it is not configured (any more). */
  webhook(db: Db, projectId: string | null): string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The chat events in one published batch (re-read from the database: the rows are the committed truth). */
function chatEvents(db: Db, events: ChangeEvent[], now: number): { key: string; e: ChatEvent }[] {
  const out: { key: string; e: ChatEvent }[] = [];
  const base = publicUrlOf(db);
  // Prepared once per batch (this runs on the request path, inside LiveHub.onPublish).
  const cardStmt = db.prepare(`SELECT c.id, c.seq, c.content, c.status, c.done_at, c.created_at, c.is_doc, c.visibility, d.title deck, d.project_id
    FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.id=?`);
  // Comment threads only (not blockers or reviews), on live cards only: the same filter as card news.
  const entryStmt = db.prepare(`SELECT e.id, e.content, e.created_at, u.name author, c.seq, c.content card, d.project_id
    FROM resolvable_entries e JOIN resolvables r ON r.id=e.resolvable_id JOIN cards c ON c.id=r.card_id JOIN decks d ON d.id=c.deck_id
    LEFT JOIN users u ON u.id=e.author_id WHERE e.id=? AND r.context='comment' AND c.is_doc=0 AND c.visibility='default'`);
  const milestoneStmt = db.prepare('SELECT id, name, date, is_global, created_at FROM milestones WHERE id=?');
  const milestoneProjects = db.prepare('SELECT project_id p FROM milestone_projects WHERE milestone_id=?');
  const seenIds = new Set<string>();
  for (const ev of events.slice(0, EXAMINE_PER_BATCH)) {
    if (ev.op !== 'upsert') continue;
    const row = ev.row as { id?: string };
    if (!row.id || seenIds.has(`${ev.model}:${row.id}`)) continue;
    seenIds.add(`${ev.model}:${row.id}`);
    if (ev.model === 'card') {
      const c = cardStmt.get(row.id) as { id: string; seq: number; content: string; status: string; done_at: number | null; created_at: number; is_doc: number; visibility: string; deck: string; project_id: string } | undefined;
      if (!c || c.is_doc || c.visibility !== 'default') continue;
      const card = { projectId: c.project_id, deck: c.deck, title: clip(titleOf(c.content), TITLE_MAX), url: `${base}/card/${cardCode(c.seq)}` };
      if (now - c.created_at <= FRESH_MS) out.push({ key: `created:${c.id}`, e: { type: 'cardCreated', ...card } });
      if (c.status === 'done' && c.done_at !== null && now - c.done_at <= FRESH_MS) out.push({ key: `done:${c.id}:${c.done_at}`, e: { type: 'cardDone', ...card } });
    } else if (ev.model === 'resolvableEntry') {
      const x = entryStmt.get(row.id) as
        { id: string; content: string; created_at: number; author: string | null; seq: number; card: string; project_id: string } | undefined;
      if (!x || now - x.created_at > FRESH_MS) continue;
      out.push({ key: `comment:${x.id}`, e: {
        type: 'comment', projectId: x.project_id, title: clip(titleOf(x.card), TITLE_MAX), url: `${base}/card/${cardCode(x.seq)}`,
        author: x.author ?? 'Someone', text: clip(x.content.trim(), COMMENT_MAX),
      } });
    } else if (ev.model === 'milestone') {
      const m = milestoneStmt.get(row.id) as
        { id: string; name: string; date: string | null; is_global: number; created_at: number } | undefined;
      if (!m || now - m.created_at > FRESH_MS) continue;
      const projectIds = (milestoneProjects.all(m.id) as { p: string }[]).map((r) => r.p);
      out.push({ key: `milestone:${m.id}`, e: { type: 'milestone', projectIds, global: !!m.is_global, name: clip(m.name, TITLE_MAX), date: m.date } });
    }
  }
  return out;
}

export class IntegrationNotifier {
  private running: Promise<void> | null = null;

  constructor(private db: Db, private http: OutboundClient, private targets: ChatTarget[], private clock: () => number = Date.now) {}

  /** LiveHub.onPublish: queue what the configured webhooks want of this batch. Never throws, never sends. */
  onEvents(events: ChangeEvent[]): void {
    const { db } = this;
    try {
      if (isWorkspaceDisabled(db)) return;
      if (!db.prepare('SELECT 1 FROM integration_settings LIMIT 1').get()) return;
      const now = this.clock();
      const add = db.prepare('INSERT OR IGNORE INTO integration_outbox (kind, project_id, dedupe_key, body_json, next_attempt_at, created_at) VALUES (?,?,?,?,?,?)');
      const found = chatEvents(db, events, now);
      if (!found.length) return;
      // Each integration gets up to ENQUEUE_PER_BATCH rows of its own (one can't use up the other's share).
      for (const t of this.targets) {
        const routes = t.router(db);
        let added = 0;
        for (const { key, e } of found) {
          for (const route of routes(e)) {
            if (added >= ENQUEUE_PER_BATCH) break;
            added += Number(add.run(t.kind, route, route === null ? key : `${key}@${route}`, JSON.stringify(t.format(e)), now, now).changes);
          }
        }
      }
    } catch (e) {
      console.error('[jt] integration notifications failed', String((e as Error)?.message ?? e));
    }
  }

  private prune(): void {
    try {
      const { db } = this;
      db.prepare("DELETE FROM integration_outbox WHERE id IN (SELECT id FROM integration_outbox WHERE status!='pending' AND created_at < ? LIMIT 500)").run(this.clock() - KEEP_HANDLED_MS);
      const cut = db.prepare('SELECT id FROM integration_outbox ORDER BY id DESC LIMIT 1 OFFSET ?').get(OUTBOX_MAX) as { id: number } | undefined;
      if (cut) db.prepare('DELETE FROM integration_outbox WHERE id <= ?').run(cut.id);
    } catch (e) {
      console.error('[jt] integration outbox prune failed', String((e as Error)?.message ?? e));
    }
  }

  /**
   * Posts the due rows (at most SEND_PER_TICK). One flush at a time: a call while one runs gets that one's promise.
   * Nothing while the workspace is disabled.
   */
  flush(now = this.clock()): Promise<void> {
    this.running ??= this.send(now).finally(() => { this.running = null; });
    return this.running;
  }

  private async send(now: number): Promise<void> {
    const { db } = this;
    this.prune();
    if (isWorkspaceDisabled(db)) return;
    const rows = db.prepare(`SELECT id, kind, project_id, body_json, attempts FROM integration_outbox
      WHERE status='pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ${SEND_PER_TICK}`).all(now) as
      { id: number; kind: IntegrationKind; project_id: string | null; body_json: string; attempts: number }[];
    for (const r of rows) {
      if (isWorkspaceDisabled(db)) break;
      const url = this.targets.find((t) => t.kind === r.kind)?.webhook(db, r.project_id) ?? null;
      if (!url) {
        db.prepare("UPDATE integration_outbox SET status='failed', last_error='not configured' WHERE id=?").run(r.id);
        continue;
      }
      const attempts = r.attempts + 1;
      let error: string;
      let retry = true;
      try {
        const res = await this.http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.body_json, timeoutMs: SEND_TIMEOUT_MS, maxBytes: 64 * 1024 });
        if (res.ok) {
          db.prepare("UPDATE integration_outbox SET status='sent', attempts=?, last_error=NULL WHERE id=?").run(attempts, r.id);
          continue;
        }
        error = `HTTP ${res.status}`;
        retry = res.status === 429 || res.status >= 500;
      } catch (e) {
        error = e instanceof OutboundError ? e.kind : 'error';
        retry = !(e instanceof OutboundError && e.kind === 'refused');
      }
      if (!retry || attempts >= MAX_ATTEMPTS) db.prepare("UPDATE integration_outbox SET status='failed', attempts=?, last_error=? WHERE id=?").run(attempts, error, r.id);
      else db.prepare('UPDATE integration_outbox SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?').run(attempts, error, now + BACKOFF_MS[attempts - 1], r.id);
    }
  }
}

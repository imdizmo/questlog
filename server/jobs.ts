import { tx, type Db } from './db';
import { accountRow, cardRow } from './commands/rows';
import { recordHistory, SYSTEM_ID } from './history';
import { DEFAULT_SETTINGS } from '../shared/types';
import { nextActionId, type ChangeEvent, type Ctx } from './dispatch';
import { sessionActor } from './permissions';
import { flushProgress, refreshProgress, todayLocal } from './commands/milestones';
import { appendRun, configRow, flushSprintProgress, markSprint, refreshSprintProgress, sprintRow, topUpRuns } from './commands/sprints';
import { emitCard } from './commands/cards';
import { segmentRow, stopCardTimers, TIMER_CAP_MS } from './commands/timers';
import { STRIPE_EVENT_KEEP_MS } from './billing';
import { cardCode } from '../shared/cards';
import { unseenThreadsSince } from './notifications';
import { pendingReportEmails } from './reports';
import { dueSlot, enqueueEmail, publicUrlOf, sendPendingEmails, slotStart, unsubscribeUrl, type EmailConfig } from './email';
import { digestEmail, openDeckDigestEmail, openDeckUpdateEmail, reportDoneEmail, type DigestProject } from './email-templates';
import { titleOf } from '../shared/cards';
import type { LiveHub } from './live';
import type { AccountSettings, User } from '../shared/types';

const BATCH = 200;
/** Rollover limits per tick: runs finished, and cards moved. */
const MAX_RUNS = 50;
const MAX_MOVES = 500;
const DEFAULT_INTERVAL_MS = 60_000;

const SYSTEM_USER: User = { id: SYSTEM_ID, email: '', name: 'System', timezone: null, disabled: false, createdAt: 0 };

const settings = (db: Db): AccountSettings => ({ ...DEFAULT_SETTINGS, ...(accountRow(db).settings as object) } as AccountSettings);

/** One transaction as the system actor; events go out through the hub after the commit, like a command's. */
export function runJob(db: Db, hub: Pick<LiveHub, 'publish'>, fn: (ctx: Ctx) => void): void {
  const events: ChangeEvent[] = [];
  const after: (() => void)[] = [];
  const ctx: Ctx = { db, actor: sessionActor(SYSTEM_USER), events, emit: (model, op, row) => { events.push({ model, op, row }); }, afterCommit: (f) => { after.push(f); }, dirtyMilestones: new Set(), dirtySprints: new Set() };
  tx(db, () => { fn(ctx); flushProgress(ctx); flushSprintProgress(ctx); });
  // Like dispatch: callbacks run once the transaction committed; a failing one is logged and doesn't stop the rest.
  for (const f of after) {
    try { f(); } catch (e) { console.error('[jt] after-commit step failed', String((e as Error)?.message ?? e)); }
  }
  if (events.length === 0) return;
  try {
    hub.publish(nextActionId(), events);
  } catch (e) {
    console.error('[jt] job live publish failed', String((e as Error)?.message ?? e));
  }
}

/** Started cards nobody touched for staleHours, with no open thread, get snoozed (at most 200 per call). */
export function runStaleSnooze(ctx: Ctx, now: number): void {
  const { db } = ctx;
  const cutoff = now - settings(db).staleHours * 3600e3;
  const ids = db.prepare(
    `SELECT id FROM cards WHERE status='started' AND snoozed_at IS NULL AND is_doc=0 AND visibility='default'
       AND last_updated_at <= ?
       AND NOT EXISTS (SELECT 1 FROM resolvables r WHERE r.card_id=cards.id AND r.is_closed=0)
     ORDER BY last_updated_at, id LIMIT ${BATCH}`).all(cutoff) as { id: string }[];
  for (const { id } of ids) {
    db.prepare('UPDATE cards SET snoozed_at=? WHERE id=?').run(now, id);
    recordHistory(db, id, SYSTEM_ID, [{ kind: 'snoozed' }]);
    ctx.emit('card', 'upsert', cardRow(db, id)!);
  }
}

/** Done cards older than autoArchiveHours are archived (at most 200 per call). */
export function runAutoArchive(ctx: Ctx, now: number): void {
  const { db } = ctx;
  const hours = settings(db).autoArchiveHours;
  if (hours === null || hours === undefined) return;
  const ids = db.prepare(
    `SELECT id FROM cards WHERE status='done' AND visibility='default' AND is_doc=0 AND done_at IS NOT NULL AND done_at <= ?
     ORDER BY done_at, id LIMIT ${BATCH}`).all(now - hours * 3600e3) as { id: string }[];
  for (const { id } of ids) {
    db.prepare("UPDATE cards SET visibility='archived' WHERE id=?").run(id);
    stopCardTimers(ctx, id, now);
    recordHistory(db, id, SYSTEM_ID, [{ kind: 'visibility', from: 'default', to: 'archived', by: 'system' }]);
    ctx.emit('card', 'upsert', cardRow(db, id)!);
  }
}

/** Open milestones (no date, or not yet past) with at least one counted card and no progress row for today get one (at most 200 per call). */
export function runDailyProgress(ctx: Ctx): void {
  const day = todayLocal();
  const ids = ctx.db.prepare(
    `SELECT id FROM milestones m WHERE (m.date IS NULL OR m.date >= ?)
       AND EXISTS (SELECT 1 FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.milestone_id=m.id AND c.visibility!='deleted' AND c.is_doc=0)
       AND NOT EXISTS (SELECT 1 FROM milestone_progress p WHERE p.milestone_id=m.id AND p.day=?)
     ORDER BY account_seq LIMIT ${BATCH}`).all(day, day) as { id: string }[];
  refreshProgress(ctx, ids.map((r) => r.id), day);
}

/** Started runs without a progress row for today get one (at most 200 per call), so burn charts have a point per day. */
export function runDailySprintProgress(ctx: Ctx): void {
  const day = todayLocal();
  const ids = ctx.db.prepare(
    `SELECT id FROM sprints s WHERE s.is_finished=0 AND s.start_day <= ?
       AND EXISTS (SELECT 1 FROM cards c JOIN decks d ON d.id=c.deck_id WHERE c.sprint_id=s.id AND c.visibility!='deleted' AND c.is_doc=0)
       AND NOT EXISTS (SELECT 1 FROM sprint_progress p WHERE p.sprint_id=s.id AND p.day=?)
     ORDER BY account_seq LIMIT ${BATCH}`).all(day, day) as { id: string }[];
  refreshSprintProgress(ctx, ids.map((r) => r.id), day);
}

/** Timers running longer than 8 h are stopped at started_at + 8 h (at most 200 per call; the rest follow next tick). */
export function runTimerCap(ctx: Ctx, now: number): void {
  const { db } = ctx;
  const ids = db.prepare(
    `SELECT id FROM time_segments WHERE duration_ms IS NULL AND started_at <= ? ORDER BY started_at, id LIMIT ${BATCH}`).all(now - TIMER_CAP_MS) as { id: string }[];
  for (const { id } of ids) {
    db.prepare('UPDATE time_segments SET duration_ms=? WHERE id=?').run(TIMER_CAP_MS, id);
    ctx.emit('timeSegment', 'upsert', segmentRow(db, id)!);
  }
}

const MOVE_SQL: Record<string, string> = {
  review: "EXISTS (SELECT 1 FROM resolvables r WHERE r.card_id=cards.id AND r.context='review' AND r.is_closed=0)",
  blocked: "EXISTS (SELECT 1 FROM resolvables r WHERE r.card_id=cards.id AND r.context='block' AND r.is_closed=0)",
  undone: "NOT EXISTS (SELECT 1 FROM resolvables r WHERE r.card_id=cards.id AND r.context IN ('review','block') AND r.is_closed=0)",
};

/**
 * Finishes runs whose end has passed: oldest first, at most one run per config per tick (so a later run never
 * finishes before an earlier one has handed over its cards), at most 50 runs and 500 card moves per tick.
 * A run with more cards to carry than the budget stays unfinished and continues next tick.
 */
export function runRollover(ctx: Ctx, now: number): void {
  const { db } = ctx;
  const due = db.prepare(
    `SELECT s.id, s.config_id, s.run_nr FROM sprints s WHERE s.is_finished=0 AND s.ends_at <= ?
       AND NOT EXISTS (SELECT 1 FROM sprints e WHERE e.config_id=s.config_id AND e.is_finished=0 AND e.run_nr < s.run_nr)
     ORDER BY s.ends_at, s.run_nr LIMIT ${MAX_RUNS}`).all(now) as { id: string; config_id: string; run_nr: number }[];
  let budget = MAX_MOVES;
  for (const run of due) {
    const cfg = configRow(db, run.config_id)!;
    const kinds = cfg.moveOnFinish.filter((k) => MOVE_SQL[k]);
    if (kinds.length) {
      let target = db.prepare('SELECT id FROM sprints WHERE config_id=? AND run_nr > ? ORDER BY run_nr LIMIT 1').get(run.config_id, run.run_nr) as { id: string } | undefined;
      if (!target && !cfg.isArchived) target = appendRun(ctx, cfg);
      if (target) {
        const where = `sprint_id=? AND status!='done' AND visibility='default' AND is_doc=0 AND (${kinds.map((k) => MOVE_SQL[k]).join(' OR ')})`;
        const ids = (db.prepare(`SELECT id FROM cards WHERE ${where} ORDER BY id LIMIT ${budget}`).all(run.id) as { id: string }[]).map((r) => r.id);
        for (const id of ids) {
          db.prepare('UPDATE cards SET sprint_id=?, carry_count=carry_count+1, sprint_joined_at=? WHERE id=?').run(target.id, now, id);
          recordHistory(db, id, SYSTEM_ID, [{ kind: 'sprint', from: run.id, to: target.id, by: 'system' }]);
          emitCard(ctx, id);
        }
        budget -= ids.length;
        markSprint(ctx, run.id);
        const left = (db.prepare(`SELECT 1 FROM cards WHERE ${where} LIMIT 1`).get(run.id));
        if (left) { if (budget <= 0) break; continue; }
      }
    }
    // Idempotent: only the update that flips the flag counts as the finish.
    const done = db.prepare('UPDATE sprints SET is_finished=1 WHERE id=? AND is_finished=0').run(run.id);
    if (!done.changes) continue;
    markSprint(ctx, run.id);
    ctx.emit('sprint', 'upsert', sprintRow(db, run.id)!);
    topUpRuns(ctx, run.config_id);
    if (budget <= 0) break;
  }
}

/**
 * A trial that ended without a subscription drops to Free (Pro gates close; existing data stays readable).
 * Also prunes applied Stripe event ids past STRIPE_EVENT_KEEP_MS, at most 200 per call.
 */
export function runTrialExpiry(ctx: Ctx, now: number): void {
  const { db } = ctx;
  const r = db.prepare(`UPDATE account SET plan_type='free', plan_status='active', trial_ends_at=NULL
    WHERE billing_mode='stripe' AND plan_status='trialing' AND trial_ends_at <= ? AND stripe_subscription_id IS NULL`).run(now);
  if (r.changes) ctx.emit('account', 'upsert', accountRow(db));
  db.prepare(`DELETE FROM stripe_events WHERE id IN (SELECT id FROM stripe_events WHERE received_at < ? ORDER BY received_at LIMIT ${BATCH})`)
    .run(now - STRIPE_EVENT_KEEP_MS);
}

// ---- emails ----
/** Notification and report emails queued per tick at most (the rest follow next minute). */
const EMAILS_PER_TICK = 50;
/** 'instant' notification emails: at most one per person in this time. */
export const INSTANT_GAP_MS = 5 * 60_000;
const workspaceDisabled = (db: Db) => (db.prepare('SELECT is_disabled d FROM account').get() as { d: number } | undefined)?.d === 1;

/**
 * Notification emails (email_prefs): a 'daily' round-up once per local day from 08:00 in each person's timezone, and
 * 'instant' emails at most every INSTANT_GAP_MS. Each lists the unseen threads that changed since the person's last
 * email. No row means 'daily'. Nothing while the workspace is disabled.
 */
export function runEmailDigests(ctx: Ctx, now: number): void {
  const { db } = ctx;
  if (workspaceDisabled(db)) return;
  const users = db.prepare(`SELECT u.id, u.email, u.name, u.timezone, COALESCE(p.notifications, 'daily') pref, p.last_sent_at, p.digest_day
      FROM users u JOIN account_roles r ON r.user_id=u.id LEFT JOIN email_prefs p ON p.user_id=u.id
     WHERE u.disabled=0 AND u.email != '' AND r.role != 'guest' AND COALESCE(p.notifications, 'daily') != 'off'
     ORDER BY u.id`).all() as { id: string; email: string; name: string; timezone: string | null; pref: 'daily' | 'instant'; last_sent_at: number | null; digest_day: string | null }[];
  if (!users.length) return;
  const workspace = accountRow(db).name;
  const base = publicUrlOf(db);
  const nameOf = db.prepare('SELECT name FROM users WHERE id=?');
  const mark = db.prepare(`INSERT INTO email_prefs (user_id, notifications, updated_at, last_sent_at, digest_day) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_sent_at=excluded.last_sent_at, digest_day=excluded.digest_day`);
  let queued = 0;
  for (const u of users) {
    if (queued >= EMAILS_PER_TICK) break;
    const day = u.pref === 'daily' ? dueSlot(u.timezone, now, 'daily') : null;
    if (u.pref === 'daily' && (!day || day === u.digest_day)) continue;
    if (u.pref === 'instant' && u.last_sent_at !== null && now - u.last_sent_at < INSTANT_GAP_MS) continue;
    const { threads, more } = unseenThreadsSince(db, u.id, u.last_sent_at ?? 0, now);
    if (threads.length) {
      const mail = digestEmail({
        workspace, name: u.name, more, instant: u.pref === 'instant',
        threads: threads.map((t) => ({
          cardTitle: t.cardTitle, cardUrl: `${base}/card/${cardCode(t.cardSeq)}`, unseen: t.unseen, context: t.context,
          authors: t.authorIds.map((id) => (nameOf.get(id) as { name: string } | undefined)?.name).filter((n): n is string => !!n),
        })),
        inboxUrl: `${base}/inbox`, settingsUrl: `${base}/?show=emailSettings`, unsubscribeUrl: unsubscribeUrl(db, u.email, 'notifications'),
      });
      enqueueEmail(db, { to: u.email, ...mail, kind: 'notifications', userId: u.id }, now);
      queued++;
    }
    // A daily slot counts as done even when there was nothing to tell; an instant check without news writes nothing.
    if (u.pref === 'daily') mark.run(u.id, u.pref, now, now, day);
    else if (threads.length) mark.run(u.id, u.pref, now, now, u.digest_day);
  }
}

/** Report emails the whole workspace sends per day at most: the addresses are unverified (left with a report). */
export const REPORT_EMAILS_PER_DAY = 200;

/**
 * "Your report was resolved" emails to the addresses reporters left (Phase 7 report_emails): from 08:00 in the owner's
 * timezone, one email per address per day listing the codes of its reports that are done and not yet told; reports
 * done after an address's email of the day wait for the next day. At most REPORT_EMAILS_PER_DAY a day for the
 * workspace (the rest wait). Fixed text only (server/email-templates.ts reportDoneEmail): no report text, no titles.
 * Sets notified_at (also when the address unsubscribed).
 */
export function runReportEmails(ctx: Ctx, now: number): void {
  const { db } = ctx;
  if (workspaceDisabled(db)) return;
  const zone = (db.prepare("SELECT u.timezone tz FROM users u JOIN account_roles r ON r.user_id=u.id WHERE r.role='owner' LIMIT 1").get() as { tz: string | null } | undefined)?.tz ?? 'UTC';
  if (!dueSlot(zone, now, 'daily')) return;
  const start = slotStart(zone, now);
  const byAddr = new Map<string, string[]>();
  for (const p of pendingReportEmails(db)) {
    const k = p.email.trim().toLowerCase();
    byAddr.set(k, [...(byAddr.get(k) ?? []), p.cardId]);
  }
  if (!byAddr.size) return;
  let budget = REPORT_EMAILS_PER_DAY - (db.prepare("SELECT COUNT(*) c FROM email_outbox WHERE kind='reportDone' AND created_at >= ?").get(start) as { c: number }).c;
  if (budget <= 0) return;
  const appName = (db.prepare('SELECT name FROM report_apps ORDER BY created_at LIMIT 1').get() as { name: string } | undefined)?.name ?? accountRow(db).name;
  const lastSent = db.prepare('SELECT MAX(notified_at) t FROM report_emails WHERE email=? COLLATE NOCASE');
  const seqStmt = db.prepare('SELECT seq FROM cards WHERE id=?');
  const done = db.prepare('UPDATE report_emails SET notified_at=? WHERE card_id=?');
  let queued = 0;
  for (const [addr, cardIds] of byAddr) {
    if (queued >= EMAILS_PER_TICK || budget <= 0) break;
    const last = (lastSent.get(addr) as { t: number | null }).t;
    if (last !== null && last >= start) continue;
    const codes = cardIds.map((id) => cardCode((seqStmt.get(id) as { seq: number }).seq));
    if (enqueueEmail(db, { to: addr, ...reportDoneEmail({ appName, codes, unsubscribeUrl: unsubscribeUrl(db, addr, 'reportDone') }), kind: 'reportDone' }, now) !== null) budget--;
    for (const id of cardIds) done.run(now, id);
    queued++;
  }
}

// ---- Open Decks emails ----
/** Cards listed per section of an update email, and top cards per project in the admin digest. */
const UPDATE_CARDS = 20;
const DIGEST_TOP = 5;
const WEEK_MS = 7 * 86_400_000;

/** Subscriptions looked at per tick (keyset batches; the next tick goes on where this one stopped). */
export const OPEN_UPDATE_BATCH = 200;
/** Where the update job stopped, per database: the last (project_id, user_id) looked at, or null to start over. */
const updateCursor = new WeakMap<Db, [string, string] | null>();

/**
 * Open Deck update emails: each subscriber of a public project gets, in their own timezone, a daily (08:00) or weekly
 * (Monday 08:00) email listing the project's cards that were added or finished since their last one; nothing when
 * nothing changed. Only live cards (visibility 'default'), titles and links. Skips disabled people and projects that
 * are no longer public. Nothing while the workspace is disabled.
 * Each tick looks at `batch` subscriptions in key order from where the last tick stopped (memory stays flat however many
 * there are), and queues at most EMAILS_PER_TICK; a full pass over 10,000 subscriptions takes under an hour.
 */
export function runOpenDeckUpdates(ctx: Ctx, now: number, batch = OPEN_UPDATE_BATCH): void {
  const { db } = ctx;
  if (workspaceDisabled(db)) return;
  const after = updateCursor.get(db) ?? null;
  const subs = db.prepare(`SELECT s.project_id, s.user_id, s.cadence, s.created_at, s.last_sent_at, s.last_slot, u.email, u.name, u.timezone, o.url_name, o.display_name
      FROM open_subscriptions s JOIN users u ON u.id=s.user_id JOIN open_decks o ON o.project_id=s.project_id JOIN projects p ON p.id=s.project_id
     WHERE (s.project_id, s.user_id) > (?, ?) AND u.disabled=0 AND o.enabled=1 AND p.is_archived=0
     ORDER BY s.project_id, s.user_id LIMIT ?`).all(after?.[0] ?? '', after?.[1] ?? '', batch) as {
    project_id: string; user_id: string; cadence: 'daily' | 'weekly'; created_at: number; last_sent_at: number | null; last_slot: string | null;
    email: string; name: string; timezone: string | null; url_name: string; display_name: string;
  }[];
  // A short batch reached the end: the next tick starts over.
  updateCursor.set(db, subs.length < batch ? null : [subs[subs.length - 1].project_id, subs[subs.length - 1].user_id]);
  if (!subs.length) return;
  const base = publicUrlOf(db);
  const added = db.prepare(`SELECT c.seq, c.content FROM cards c JOIN decks d ON d.id=c.deck_id
     WHERE d.project_id=? AND c.visibility='default' AND c.created_at > ? AND c.created_at <= ? ORDER BY c.created_at, c.seq LIMIT ${UPDATE_CARDS + 1}`);
  const done = db.prepare(`SELECT c.seq, c.content FROM cards c JOIN decks d ON d.id=c.deck_id
     WHERE d.project_id=? AND c.visibility='default' AND c.status='done' AND c.done_at > ? AND c.done_at <= ? ORDER BY c.done_at, c.seq LIMIT ${UPDATE_CARDS + 1}`);
  const mark = db.prepare('UPDATE open_subscriptions SET last_slot=?, last_sent_at=? WHERE project_id=? AND user_id=?');
  let queued = 0;
  for (const s of subs) {
    if (queued >= EMAILS_PER_TICK) {
      // Out of email budget: the rest of this batch comes first next tick.
      const i = subs.indexOf(s);
      updateCursor.set(db, i > 0 ? [subs[i - 1].project_id, subs[i - 1].user_id] : after);
      break;
    }
    const slot = dueSlot(s.timezone, now, s.cadence);
    if (!slot || slot === s.last_slot) continue;
    const since = s.last_sent_at ?? s.created_at;
    const projectUrl = `${base}/open/${s.url_name}`;
    const list = (rows: { seq: number; content: string }[]) => rows.slice(0, UPDATE_CARDS).map((r) => ({ title: titleOf(r.content), url: `${projectUrl}/card/${cardCode(r.seq)}` }));
    const a = added.all(s.project_id, since, now) as { seq: number; content: string }[];
    const d = done.all(s.project_id, since, now) as { seq: number; content: string }[];
    // The slot counts as done even when there was nothing to tell.
    mark.run(slot, now, s.project_id, s.user_id);
    if (!a.length && !d.length) continue;
    const more = Math.max(0, a.length - UPDATE_CARDS) + Math.max(0, d.length - UPDATE_CARDS);
    const mail = openDeckUpdateEmail({
      project: s.display_name, name: s.name, cadence: s.cadence, added: list(a), done: list(d), more, projectUrl,
      unsubscribeUrl: unsubscribeUrl(db, s.email, 'openDeckUpdates'),
    });
    enqueueEmail(db, { to: s.email, ...mail, kind: 'openDeckUpdates', userId: s.user_id }, now);
    queued++;
  }
}
/** Pending Open Deck sign-ups past their 24 h, removed in batches of 500 per tick. */
export function runOpenSignupPurge(ctx: Ctx, now: number): void {
  ctx.db.prepare('DELETE FROM open_signups WHERE token_hash IN (SELECT token_hash FROM open_signups WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)').run(now);
}

/**
 * The weekly upvote digest: on Mondays from 08:00 in each admin's timezone, the last seven days of every public project
 * (upvotes, visits, new followers, the most upvoted cards). Not sent when nothing happened. Once per ISO week per admin.
 * Nothing while the workspace is disabled.
 */
export function runOpenDeckDigest(ctx: Ctx, now: number): void {
  const { db } = ctx;
  if (workspaceDisabled(db)) return;
  const decks = db.prepare(`SELECT o.project_id, o.url_name, o.display_name FROM open_decks o JOIN projects p ON p.id=o.project_id
     WHERE o.enabled=1 AND p.is_archived=0 ORDER BY o.display_name COLLATE NOCASE LIMIT 50`).all() as { project_id: string; url_name: string; display_name: string }[];
  if (!decks.length) return;
  const admins = db.prepare(`SELECT u.id, u.email, u.name, u.timezone, g.slot FROM users u JOIN account_roles r ON r.user_id=u.id
      LEFT JOIN open_digests g ON g.user_id=u.id WHERE r.role IN ('owner','admin') AND u.disabled=0 ORDER BY u.id`).all() as
    { id: string; email: string; name: string; timezone: string | null; slot: string | null }[];
  const base = publicUrlOf(db);
  const since = now - WEEK_MS;
  const firstDay = new Date(since).toISOString().slice(0, 10);
  let projects: DigestProject[] | null = null;
  const summary = (): DigestProject[] => decks.map((o) => {
    const url = `${base}/open/${o.url_name}`;
    const upvotes = (db.prepare('SELECT COUNT(*) n FROM upvotes u JOIN cards c ON c.id=u.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id=? AND u.created_at > ? AND u.created_at <= ?')
      .get(o.project_id, since, now) as { n: number }).n;
    const visits = (db.prepare('SELECT COALESCE(SUM(count),0) n FROM open_visits WHERE project_id=? AND day > ?').get(o.project_id, firstDay) as { n: number }).n;
    const subscribers = (db.prepare('SELECT COUNT(*) n FROM open_subscriptions WHERE project_id=? AND created_at > ? AND created_at <= ?').get(o.project_id, since, now) as { n: number }).n;
    const top = (db.prepare(`SELECT c.seq, c.content, COUNT(*) n FROM upvotes u JOIN cards c ON c.id=u.card_id JOIN decks d ON d.id=c.deck_id
        WHERE d.project_id=? AND c.visibility='default' AND u.created_at > ? AND u.created_at <= ? GROUP BY c.id ORDER BY n DESC, c.seq LIMIT ${DIGEST_TOP}`)
      .all(o.project_id, since, now) as { seq: number; content: string; n: number }[])
      .map((r) => ({ title: titleOf(r.content), upvotes: r.n, url: `${url}/card/${cardCode(r.seq)}` }));
    return { name: o.display_name, url, upvotes, visits, subscribers, top };
  }).filter((x) => x.upvotes || x.visits || x.subscribers);
  const mark = db.prepare('INSERT INTO open_digests (user_id, slot, sent_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET slot=excluded.slot, sent_at=excluded.sent_at');
  const workspace = accountRow(db).name;
  let queued = 0;
  for (const a of admins) {
    if (queued >= EMAILS_PER_TICK) break;
    const slot = dueSlot(a.timezone, now, 'weekly');
    if (!slot || slot === a.slot) continue;
    mark.run(a.id, slot, now);
    projects ??= summary();
    if (!projects.length) continue;
    enqueueEmail(db, { to: a.email, ...openDeckDigestEmail({ workspace, name: a.name, projects, unsubscribeUrl: unsubscribeUrl(db, a.email, 'openDeckDigest') }), kind: 'openDeckDigest', userId: a.id }, now);
    queued++;
  }
}

/**
 * Runs every job once per interval, each in its own transaction, then hands the due outbox rows to the email transport
 * (`email`, default log mode; one send batch at a time). Returns the stop function.
 */
export function startScheduler(db: Db, hub: Pick<LiveHub, 'publish'>, opts: { intervalMs?: number; now?: () => number; extraJobs?: [string, (ctx: Ctx, now: number) => void][]; email?: EmailConfig } = {}): () => void {
  const now = opts.now ?? Date.now;
  const email: EmailConfig = opts.email ?? { transport: 'log', smtp: null, publicUrl: '' };
  const jobs: [string, (ctx: Ctx, now: number) => void][] = [['stale-snooze', runStaleSnooze], ['auto-archive', runAutoArchive], ['daily-progress', (ctx) => runDailyProgress(ctx)], ['daily-sprint-progress', (ctx) => runDailySprintProgress(ctx)], ['rollover', runRollover], ['timer-cap', runTimerCap], ['trial-expiry', runTrialExpiry], ['email-digests', runEmailDigests], ['report-emails', runReportEmails], ['open-deck-updates', (ctx, now) => runOpenDeckUpdates(ctx, now)], ['open-deck-digest', runOpenDeckDigest], ['open-signup-purge', runOpenSignupPurge], ...(opts.extraJobs ?? [])];
  let sending = false;
  const tick = () => {
    // A fresh install has no workspace until /api/setup runs: there is nothing for the jobs to act on yet.
    if (!db.prepare('SELECT 1 FROM account LIMIT 1').get()) return;
    for (const [name, job] of jobs) {
      try { runJob(db, hub, (ctx) => job(ctx, now())); }
      catch (e) { console.error(`[jt] job ${name} failed`, String((e as Error)?.message ?? e)); }
    }
    if (sending) return;
    sending = true;
    sendPendingEmails(db, email, now())
      .catch((e) => console.error('[jt] email sending failed', String((e as Error)?.message ?? e)))
      .finally(() => { sending = false; });
  };
  const timer = setInterval(tick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

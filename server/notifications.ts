import type { Db } from './db';
import { toCamel } from './db';
import type { Ctx } from './dispatch';
import { canSeeCard, cardProjectId, handleMap } from './access';
import { activeGuardians } from './guardians';
import { parseContent } from '../shared/content';
import { titleOf } from '../shared/cards';

export const REMIND_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export const notificationRow = (db: Db, userId: string, resolvableId: string) => {
  const r = db.prepare('SELECT * FROM resolvable_notifications WHERE user_id=? AND resolvable_id=?').get(userId, resolvableId) as Record<string, unknown> | undefined;
  return r ? toCamel<any>(r) : undefined;
};

/** User ids @mentioned in the text, by the same handle rule as card content. */
function mentionedIn(db: Db, texts: string[]): string[] {
  const byHandle = handleMap(db);
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of parseContent(t).mentions) {
      const id = byHandle.get(m.normalize('NFC').toLowerCase());
      if (id) out.add(id);
    }
  }
  return [...out];
}

/**
 * Everyone who follows a thread: creator, entry authors, mentioned users, the card's assignee,
 * plus the sets Task 6 fills in (card watchers, deck subscribers, guardians of a guardian deck's reviews).
 * Filtered to active users who can see the card. Opt-outs are applied by onEntry, not here.
 */
export function participantsFor(db: Db, resolvableId: string): string[] {
  const r = db.prepare('SELECT card_id, context, creator_id FROM resolvables WHERE id=?').get(resolvableId) as
    { card_id: string; context: string; creator_id: string } | undefined;
  if (!r) return [];
  const card = db.prepare('SELECT id, deck_id, creator_id, assignee_id FROM cards WHERE id=?').get(r.card_id) as
    { id: string; deck_id: string | null; creator_id: string; assignee_id: string | null } | undefined;
  if (!card) return [];
  const entries = db.prepare('SELECT author_id, content FROM resolvable_entries WHERE resolvable_id=?').all(resolvableId) as { author_id: string; content: string }[];
  const ids = new Set<string>([r.creator_id, ...entries.map((e) => e.author_id), ...mentionedIn(db, entries.map((e) => e.content))]);
  if (card.assignee_id) ids.add(card.assignee_id);
  // Task 6 adds card watchers, deck subscribers and (reviews only) deck guardians here.
  for (const id of extraFollowers(db, card, r.context)) ids.add(id);
  const projectId = cardProjectId(db, card.id);
  const shape = { deckId: card.deck_id, creatorId: card.creator_id };
  return [...ids].filter((id) => {
    const u = db.prepare('SELECT disabled d FROM users WHERE id=?').get(id) as { d: number } | undefined;
    return !!u && !u.d && canSeeCard(db, { id }, shape, projectId);
  });
}

function extraFollowers(db: Db, card: { id: string; deck_id: string | null }, context: string): string[] {
  const out = (db.prepare('SELECT user_id u FROM card_subscriptions WHERE card_id=?').all(card.id) as { u: string }[]).map((r) => r.u);
  if (card.deck_id) {
    out.push(...(db.prepare('SELECT user_id u FROM deck_subscriptions WHERE deck_id=?').all(card.deck_id) as { u: string }[]).map((r) => r.u));
    if (context === 'review') out.push(...activeGuardians(db, card.deck_id));
  }
  return out;
}

const write = (ctx: Ctx, userId: string, resolvableId: string) =>
  ctx.emit('resolvableNotification', 'upsert', notificationRow(ctx.db, userId, resolvableId)!);

/**
 * A new entry landed on a thread. Upserts a row per participant (opted-out users stay out),
 * bumps unseen counts for everyone but the author and emits every changed row to its owner.
 */
export function onEntry(ctx: Ctx, resolvableId: string, entryId: string, authorId: string, created = false): void {
  const { db } = ctx;
  const now = Date.now();
  const createdAt = (db.prepare('SELECT created_at t FROM resolvables WHERE id=?').get(resolvableId) as { t: number }).t;
  for (const uid of participantsFor(db, resolvableId)) {
    const row = db.prepare('SELECT * FROM resolvable_notifications WHERE user_id=? AND resolvable_id=?').get(uid, resolvableId) as
      Record<string, any> | undefined;
    if (row && !row.is_participating && uid !== authorId) continue; // opted out: no bumps, but the author's own pointers still move
    if (uid === authorId) {
      if (row) {
        db.prepare("UPDATE resolvable_notifications SET unseen_entry_count=0, unseen_authors_json='[]', latest_entry_id=?, latest_seen_entry_id=?, last_updated_at=? WHERE user_id=? AND resolvable_id=?")
          .run(entryId, entryId, now, uid, resolvableId);
      } else {
        db.prepare('INSERT INTO resolvable_notifications (user_id,resolvable_id,is_participating,is_muted,remind_me_on,unseen_entry_count,unseen_authors_json,latest_entry_id,latest_seen_entry_id,created_at,last_updated_at) VALUES (?,?,1,?,?,0,?,?,?,?,?)')
          .run(uid, resolvableId, created ? 1 : 0, created ? createdAt + REMIND_AFTER_MS : null, '[]', entryId, entryId, now, now);
      }
    } else if (row) {
      const authors: string[] = JSON.parse(row.unseen_authors_json);
      if (!authors.includes(authorId)) authors.push(authorId);
      db.prepare('UPDATE resolvable_notifications SET unseen_entry_count=unseen_entry_count+1, unseen_authors_json=?, latest_entry_id=?, last_updated_at=? WHERE user_id=? AND resolvable_id=?')
        .run(JSON.stringify(authors), entryId, now, uid, resolvableId);
    } else {
      db.prepare('INSERT INTO resolvable_notifications (user_id,resolvable_id,is_participating,is_muted,remind_me_on,unseen_entry_count,unseen_authors_json,latest_entry_id,created_at,last_updated_at) VALUES (?,?,1,0,?,1,?,?,?,?)')
        .run(uid, resolvableId, created ? createdAt + REMIND_AFTER_MS : null, JSON.stringify([authorId]), entryId, now, now);
    }
    write(ctx, uid, resolvableId);
  }
}

/** An entry was edited: anyone newly mentioned (or otherwise newly a participant) gets a row, without an unseen bump. */
export function onEntryEdited(ctx: Ctx, resolvableId: string): void {
  const { db } = ctx;
  const now = Date.now();
  for (const uid of participantsFor(db, resolvableId)) {
    if (notificationRow(db, uid, resolvableId)) continue;
    db.prepare('INSERT INTO resolvable_notifications (user_id,resolvable_id,is_participating,is_muted,unseen_entry_count,unseen_authors_json,created_at,last_updated_at) VALUES (?,?,1,0,0,?,?,?)')
      .run(uid, resolvableId, '[]', now, now);
    write(ctx, uid, resolvableId);
  }
}

const OWN_UPDATES = {
  markSeen: "unseen_entry_count=0, unseen_authors_json='[]', latest_seen_entry_id=latest_entry_id",
  snooze: 'snooze_until=?',
  participation: 'is_participating=?',
  muted: 'is_muted=?',
} as const;

/** Update the actor's own row with one of the fixed updates; false when they have none. */
export function updateOwn(ctx: Ctx, resolvableId: string, kind: keyof typeof OWN_UPDATES, value?: number | null): boolean {
  const args = kind === 'markSeen' ? [] : [value ?? null];
  const res = ctx.db.prepare(`UPDATE resolvable_notifications SET ${OWN_UPDATES[kind]}, last_updated_at=? WHERE user_id=? AND resolvable_id=?`)
    .run(...args, Date.now(), ctx.actor.id, resolvableId);
  if (!res.changes) return false;
  write(ctx, ctx.actor.id, resolvableId);
  return true;
}

export interface UnseenThread { resolvableId: string; cardSeq: number; cardTitle: string; context: string; unseen: number; authorIds: string[] }

/**
 * For notification emails: threads with unseen entries that changed after `since`, as the inbox shows them (taking
 * part, not muted, not snoozed, open, card not deleted and still visible to the person). Newest first; `limit` rows
 * plus the number left out.
 */
export function unseenThreadsSince(db: Db, userId: string, since: number, now: number, limit = 25): { threads: UnseenThread[]; more: number } {
  const rows = db.prepare(`SELECT n.resolvable_id, n.unseen_entry_count, n.unseen_authors_json, r.context, c.id card_id, c.seq, c.content, c.deck_id, c.creator_id
      FROM resolvable_notifications n JOIN resolvables r ON r.id=n.resolvable_id JOIN cards c ON c.id=r.card_id
     WHERE n.user_id=? AND n.is_participating=1 AND n.is_muted=0 AND n.unseen_entry_count>0
       AND (n.snooze_until IS NULL OR n.snooze_until<=?) AND n.last_updated_at>? AND r.is_closed=0 AND c.visibility!='deleted'
     ORDER BY n.last_updated_at DESC, n.resolvable_id LIMIT 500`).all(userId, now, since) as Record<string, any>[];
  const visible = rows.filter((r) => canSeeCard(db, { id: userId }, { deckId: r.deck_id, creatorId: r.creator_id }, cardProjectId(db, r.card_id)));
  const threads = visible.slice(0, limit).map((r) => ({
    resolvableId: r.resolvable_id as string, cardSeq: r.seq as number, cardTitle: titleOf(r.content as string), context: r.context as string,
    unseen: r.unseen_entry_count as number, authorIds: JSON.parse(r.unseen_authors_json) as string[],
  }));
  return { threads, more: visible.length - threads.length };
}

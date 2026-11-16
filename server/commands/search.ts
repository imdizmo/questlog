import { z } from 'zod';
import { assertCan } from '../permissions';
import { newId } from '../db';
import { AppError } from '../errors';
import type { Command } from '../dispatch';
import type { Db } from '../db';
import { CATEGORIES, MAX_CHIPS, OPS } from '../../shared/search';
import type { SearchCategory } from '../../shared/search';
import type { SavedSearch } from '../../shared/types';

/** Saved searches one user may keep. */
export const MAX_SAVED_SEARCHES = 50;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const oneOf = (...vs: string[]) => (v: string | null) => v !== null && vs.includes(v);
const id = (v: string | null) => v !== null && ID.test(v);
const idOrNull = (v: string | null) => v === null || ID.test(v);
const text = (v: string | null) => v !== null;

/**
 * The value each category accepts (what the search UI can produce). Stored tokens are read by every viewer of a
 * saved search or Smart Node, so the server only keeps shapes the client knows how to match.
 */
const VALUE_OK: Record<SearchCategory, (v: string | null) => boolean> = {
  content: text,
  status: oneOf('unassigned', 'assigned', 'started', 'snoozing', 'blocked', 'review', 'done', 'undone'),
  projectTag: text,
  personalTag: text,
  owner: idOrNull,
  creator: id,
  mentioned: id,
  priority: (v) => v === null || ['a', 'b', 'c'].includes(v),
  // Any finite non-negative number the matcher's Number() reads (0.125, 10000, 1e-7), short enough to be a number.
  effort: (v) => v === null || (v.length <= 20 && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0),
  due: oneOf('today', 'week', 'any'),
  milestone: idOrNull,
  sprint: idOrNull,
  sprintConfig: (v) => v !== null && /^[A-Za-z0-9_-]{1,64}:(current|future|past)$/.test(v),
  card: oneOf('hero', 'sub', 'locked', 'locking', 'cover', 'doc'),
  deck: id,
};
/** Only priority and effort compare; others take no op. */
const HAS_OP = new Set<SearchCategory>(['priority', 'effort']);

export const searchTokenSchema = z.object({
  category: z.enum(CATEGORIES),
  value: z.string().max(200).nullable(),
  isNegated: z.boolean(),
  op: z.enum(OPS).optional(),
}).refine((t) => VALUE_OK[t.category](t.value), { message: 'bad value for category', path: ['value'] })
  .refine((t) => t.op === undefined || HAS_OP.has(t.category), { message: 'op not allowed for category', path: ['op'] });

const rowOf = (r: { id: string; user_id: string; tokens: string; force_or: number; created_at: number }): SavedSearch =>
  ({ id: r.id, userId: r.user_id, tokens: JSON.parse(r.tokens), forceOr: r.force_or !== 0, createdAt: r.created_at });

export const savedSearchRow = (db: Db, id: string): SavedSearch | undefined => {
  const r = db.prepare('SELECT * FROM saved_searches WHERE id=?').get(id) as Parameters<typeof rowOf>[0] | undefined;
  return r && rowOf(r);
};

export const searchCommands: Record<string, Command> = {
  'search/save': {
    schema: z.object({ tokens: z.array(searchTokenSchema).max(MAX_CHIPS), forceOr: z.boolean() }),
    run(ctx, input) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'workspace.personal');
      const n = (db.prepare('SELECT COUNT(*) n FROM saved_searches WHERE user_id=?').get(ctx.actor.id) as { n: number }).n;
      if (n >= MAX_SAVED_SEARCHES) throw new AppError(409, 'limit_reached');
      const id = newId();
      db.prepare('INSERT INTO saved_searches (id, user_id, tokens, force_or, created_at) VALUES (?,?,?,?,?)')
        .run(id, ctx.actor.id, JSON.stringify(input.tokens), input.forceOr ? 1 : 0, Date.now());
      ctx.emit('savedSearch', 'upsert', savedSearchRow(db, id)!);
      return { id };
    },
  },
  'search/delete': {
    schema: z.object({ id: z.string() }),
    run(ctx, { id }) {
      assertCan(ctx.db, ctx.actor, 'workspace.personal');
      const row = savedSearchRow(ctx.db, id);
      // Someone else's search looks the same as a missing one.
      if (!row || row.userId !== ctx.actor.id) throw new AppError(404, 'not_found');
      ctx.db.prepare('DELETE FROM saved_searches WHERE id=?').run(id);
      ctx.emit('savedSearch', 'remove', { id, userId: row.userId });
    },
  },
};

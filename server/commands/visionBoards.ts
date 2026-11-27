import { z } from 'zod';
import { newId } from '../db';
import type { Db } from '../db';
import { AppError } from '../errors';
import { can } from '../permissions';
import { accountRow, cardRow } from './rows';
import { assertCardAccess, assertNotDeleted } from './cards';
import { boardAccess, canEditHostCard, boardHooks, homeAccess, homeBoardId, homeProjectAllowed, referencedQueryIds, visionBoardRow, visionQueryRow } from '../boards';
import { cardProjectId } from '../access';
import { searchTokenSchema } from './search';
import type { Command, Ctx } from '../dispatch';
import type { VisionBoard } from '../../shared/types';

export const MAX_QUERY_TOKENS = 20;
/** Queries kept per host card, and per project on Home (unused ones are collected first, see collectQueries). */
export const MAX_QUERIES_PER_CARD = 500;
/**
 * How long an unreferenced query is kept: a superseded queryId can come back through undo, so it stays live this
 * long. An undo in a tab open longer than this can bring back a collected id: that node shows "Filter not available".
 */
export const QUERY_UNDO_WINDOW_MS = 60 * 60 * 1000;

function assertEnabled(db: Db): void {
  if ((accountRow(db).settings as { visionBoardEnabled?: boolean }).visionBoardEnabled === false) throw new AppError(409, 'feature_disabled');
}

/** The board, or 404 when it is missing or its host card is not visible to the actor (hidden, deleted). */
function loadBoard(ctx: Ctx, id: string): VisionBoard {
  const b = visionBoardRow(ctx.db, id);
  if (!b) throw new AppError(404, 'not_found');
  if (boardAccess(ctx.db, ctx.actor, b) === 'none') throw new AppError(404, 'not_found');
  return b;
}

/** A creator who can still edit the host card, or a manager of its project (a deckless card has no project: an admin). */
function assertManage(ctx: Ctx, b: VisionBoard): void {
  if (b.creatorId === ctx.actor.id && canEditHostCard(ctx.db, ctx.actor, b.cardId)) return;
  const p = cardProjectId(ctx.db, b.cardId);
  if (p ? can(ctx.db, ctx.actor, 'project.manage', p) : can(ctx.db, ctx.actor, 'account.manage')) return;
  throw new AppError(403, 'forbidden');
}

/** Owner of a query: a card board's host card, or a project on Home. */
type QueryOwner = { col: 'card_id' | 'project_id'; id: string };

/** Delete the owner's queries that no filter node of the board points at and that are older than the undo window. */
function collectQueries(ctx: Ctx, boardId: string, owner: QueryOwner): void {
  const old = ctx.db.prepare(`SELECT id FROM vision_queries WHERE ${owner.col}=? AND created_at<?`)
    .all(owner.id, Date.now() - QUERY_UNDO_WINDOW_MS) as { id: string }[];
  if (old.length === 0) return; // spares decoding the doc
  const used = referencedQueryIds(ctx.db, boardId);
  for (const { id } of old) if (!used.has(id)) deleteQuery(ctx, id);
}

function deleteQuery(ctx: Ctx, id: string): void {
  const row = visionQueryRow(ctx.db, id);
  if (!row) return;
  ctx.db.prepare('DELETE FROM vision_queries WHERE id=?').run(id);
  ctx.emit('visionQuery', 'remove', row);
}

export const visionBoardCommands: Record<string, Command> = {
  /** The workspace's Home board: made on first use, then always the same one. Not behind the vision-board setting. */
  'visionBoard/openHome': {
    schema: z.object({}),
    run(ctx) {
      const level = homeAccess(ctx.db, ctx.actor);
      if (level === 'none') throw new AppError(404, 'not_found');
      return { id: homeBoardId(ctx.db, ctx.actor.id), canEdit: level === 'edit' };
    },
  },
  'visionBoard/createBoard': {
    schema: z.object({ cardId: z.string() }),
    run(ctx, { cardId }) {
      const { db, actor } = ctx;
      assertEnabled(db);
      const card = cardRow(db, cardId);
      if (!card) throw new AppError(404, 'not_found');
      assertCardAccess(ctx, card);
      assertNotDeleted(card);
      const existing = db.prepare('SELECT id FROM vision_boards WHERE card_id=?').get(cardId) as { id: string } | undefined;
      if (existing) throw new AppError(409, 'already_exists', { id: existing.id });
      db.prepare('UPDATE account SET vision_seq = vision_seq + 1').run();
      const accountSeq = (db.prepare('SELECT vision_seq s FROM account').get() as { s: number }).s;
      const id = newId();
      const now = Date.now();
      db.prepare('INSERT INTO vision_boards (id, account_seq, card_id, creator_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, accountSeq, cardId, actor.id, 'default', now, now);
      ctx.emit('visionBoard', 'upsert', visionBoardRow(db, id)!);
      return { id, accountSeq };
    },
  },
  'visionBoard/updateBoard': {
    schema: z.object({ id: z.string(), state: z.enum(['default', 'read_only', 'locked']) }),
    run(ctx, { id, state }) {
      const { db } = ctx;
      assertEnabled(db);
      const b = loadBoard(ctx, id);
      assertManage(ctx, b);
      db.prepare('UPDATE vision_boards SET state=?, updated_at=? WHERE id=?').run(state, Date.now(), id);
      ctx.emit('visionBoard', 'upsert', visionBoardRow(db, id)!);
      ctx.afterCommit(() => boardHooks.onChange(id));
    },
  },
  'visionBoard/deleteBoard': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const { db } = ctx;
      assertEnabled(db);
      const b = loadBoard(ctx, id);
      assertManage(ctx, b);
      // Queries belong to the board's card: a new board on the same card starts empty.
      for (const q of db.prepare('SELECT id FROM vision_queries WHERE card_id=?').all(b.cardId) as { id: string }[]) deleteQuery(ctx, q.id);
      db.prepare('DELETE FROM vision_boards WHERE id=?').run(id);
      ctx.emit('visionBoard', 'remove', b);
      ctx.afterCommit(() => boardHooks.onDelete(id));
    },
  },
  'visionBoard/createQuery': {
    /** cardId: the query of a card board's Smart Node. projectId: of a Smart Node on Home, for the project picked for it. */
    schema: z.object({
      cardId: z.string().optional(),
      projectId: z.string().optional(),
      query: z.object({ type: z.literal('filter'), tokens: z.array(searchTokenSchema).max(MAX_QUERY_TOKENS), forceOr: z.boolean() }),
    }).refine((x) => (x.cardId === undefined) !== (x.projectId === undefined), { message: 'cardId or projectId', path: ['cardId'] }),
    run(ctx, { cardId, projectId, query }) {
      const { db, actor } = ctx;
      let boardId: string;
      let owner: QueryOwner;
      if (projectId !== undefined) {
        // Home is not behind the vision-board setting. Its doc goes to the whole workspace: only a project every member sees.
        const level = homeAccess(db, actor);
        if (level === 'none') throw new AppError(404, 'not_found');
        if (level !== 'edit') throw new AppError(403, 'forbidden');
        if (!homeProjectAllowed(db, actor, projectId)) throw new AppError(404, 'not_found');
        boardId = homeBoardId(db, actor.id);
        owner = { col: 'project_id', id: projectId };
      } else {
        assertEnabled(db);
        const bid = db.prepare('SELECT id FROM vision_boards WHERE card_id=?').get(cardId) as { id: string } | undefined;
        const b = bid && visionBoardRow(db, bid.id);
        const level = b ? boardAccess(db, actor, b) : 'none';
        if (!b || level === 'none') throw new AppError(404, 'not_found');
        if (level !== 'edit') throw new AppError(403, 'forbidden');
        boardId = b.id;
        owner = { col: 'card_id', id: cardId! };
      }
      // Never deleted on request (a query another node still uses would vanish): unused old ones are collected here.
      collectQueries(ctx, boardId, owner);
      const n = (db.prepare(`SELECT COUNT(*) n FROM vision_queries WHERE ${owner.col}=?`).get(owner.id) as { n: number }).n;
      if (n >= MAX_QUERIES_PER_CARD) throw new AppError(409, 'limit_reached');
      const id = newId();
      db.prepare(`INSERT INTO vision_queries (id, ${owner.col}, creator_id, query, created_at) VALUES (?,?,?,?,?)`)
        .run(id, owner.id, actor.id, JSON.stringify(query), Date.now());
      ctx.emit('visionQuery', 'upsert', visionQueryRow(db, id)!);
      return { id };
    },
  },
};

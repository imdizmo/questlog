import { assertGuestScope, assertTokenScope, dispatch, toActor, type ChangeEvent, type Ctx } from './dispatch';
import { AppError } from './errors';
import { assertCan, type Actor } from './permissions';
import { deckRow } from './commands/rows';
import { fetchCoverUrl, releaseCover, unlinkCovers } from './covers';
import type { Db } from './db';
import type { User } from '../shared/types';
import type { Cover } from '../shared/covers';

type Result = ReturnType<typeof dispatch>;
const COVER_URL_COMMANDS = new Set(['decks/create', 'decks/update', 'projects/create', 'projects/update']);

/**
 * Commands run synchronously inside a transaction, so a `coverUrl` is fetched here first (after the permission
 * check, so only people who may edit the cover can make the server fetch) and handed on as a `file` cover.
 * Every dispatch result is passed to `publish` as it is committed.
 */
export async function dispatchWithCoverUrl(db: Db, user: User | Actor, name: string, payload: unknown, publish: (r: Result) => void): Promise<Result> {
  const actor = toActor(user);
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!body || !COVER_URL_COMMANDS.has(name) || body.coverUrl === undefined) {
    const r = dispatch(db, actor, name, payload);
    publish(r);
    return r;
  }
  // Scope first: a token that may not run the command must not make the server fetch anything either.
  assertTokenScope(actor, name);
  assertGuestScope(db, actor, name);
  const { coverUrl, ...rest } = body;
  if (typeof coverUrl !== 'string') throw new AppError(400, 'invalid_payload');
  const events: ChangeEvent[] = [];
  const ctx: Ctx = { db, actor, events, emit: () => {}, afterCommit: () => {} };

  if (name === 'projects/create') {
    // The cover belongs to the project, so the project is made first and removed again if the fetch fails.
    assertCan(db, actor, 'project.create');
    const created = dispatch(db, actor, name, { ...rest, cover: undefined });
    publish(created);
    const id = (created.payload as { id: string }).id;
    try {
      const fileId = await fetchCoverUrl(ctx, id, coverUrl);
      try {
        const r = dispatch(db, actor, 'projects/update', { id, cover: { kind: 'file', fileId } satisfies Cover });
        publish(r);
        return created;
      } catch (e) { unlinkCovers(db, [fileId]); throw e; }
    } catch (e) {
      // Undoing this request's own create: allowed for a token without "May delete" too.
      publish(dispatch(db, actor, 'projects/delete', { id }, { undoOwnCreate: true }));
      throw e;
    }
  }

  let projectId: string;
  if (name === 'decks/create') {
    projectId = typeof rest.projectId === 'string' ? rest.projectId : '';
    assertCan(db, actor, 'content.edit', projectId);
  } else if (name === 'decks/update') {
    const d = typeof rest.id === 'string' ? deckRow(db, rest.id) : undefined;
    if (!d) throw new AppError(404, 'not_found');
    projectId = d.projectId;
    assertCan(db, actor, 'content.edit', projectId);
  } else {
    projectId = typeof rest.id === 'string' ? rest.id : '';
    assertCan(db, actor, 'project.manage', projectId);
  }
  const fileId = await fetchCoverUrl(ctx, projectId, coverUrl);
  try {
    const r = dispatch(db, actor, name, { ...rest, cover: { kind: 'file', fileId } satisfies Cover });
    publish(r);
    return r;
  } catch (e) {
    // The command refused (bad input): drop the fetched file again.
    const cover = { kind: 'file', fileId } as const;
    releaseCover({ ...ctx, afterCommit: (fn) => fn() }, cover);
    throw e;
  }
}

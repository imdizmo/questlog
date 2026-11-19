/** Rename, retag and delete an asset (server/assets.ts holds the rows, the copies and the routes). */
import { z } from 'zod';
import { AppError } from '../errors';
import type { Command, Ctx } from '../dispatch';
import { can } from '../permissions';
import { assetRow, cleanTitle, modelAllowed, rawRow, unlinkAssetBlobs } from '../assets';
import { ASSET_FORS, ASSET_KINDS } from '../../shared/assets';

const forSchema = z.enum(ASSET_FORS).nullable();

/** The asset when the actor may change it: 404 when they can't see its project, 403 when they can't edit there. */
function editable(ctx: Ctx, id: string): Record<string, any> {
  const r = rawRow(ctx.db, id);
  if (!r || !can(ctx.db, ctx.actor, 'project.view', r.project_id)) throw new AppError(404, 'not_found');
  if (!can(ctx.db, ctx.actor, 'content.edit', r.project_id)) throw new AppError(403, 'forbidden');
  return r;
}

export const assetCommands: Record<string, Command> = {
  'assets/update': {
    schema: z.strictObject({ id: z.string(), title: z.string().max(2000).optional(), kind: z.enum(ASSET_KINDS).optional(), for: forSchema.optional() }),
    run(ctx, input) {
      const r = editable(ctx, input.id);
      const kind = input.kind ?? r.kind;
      if (r.model_id && kind !== 'model') throw new AppError(400, 'invalid_input'); // a .glb stays a model
      if (kind === 'model' && !modelAllowed(r.source, !!r.model_id)) throw new AppError(400, 'invalid_input');
      ctx.db.prepare('UPDATE assets SET title=?, kind=?, for_tag=?, updated_at=? WHERE id=?').run(
        input.title === undefined ? r.title : cleanTitle(input.title), kind, input.for === undefined ? r.for_tag : input.for, Date.now(), r.id,
      );
      const a = assetRow(ctx.db, r.id)!;
      ctx.emit('asset', 'upsert', a);
      return a;
    },
  },
  'assets/delete': {
    schema: z.strictObject({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      const r = editable(ctx, id);
      ctx.db.prepare('DELETE FROM assets WHERE id=?').run(id);
      ctx.emit('asset', 'remove', { id, projectId: r.project_id });
      const blobs = [r.picture_id, r.model_id].filter((x): x is string => !!x);
      ctx.afterCommit(() => unlinkAssetBlobs(ctx.db, blobs));
    },
  },
};

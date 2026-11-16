import { z } from 'zod';
import { newId } from '../db';
import { AppError } from '../errors';
import { assertCan } from '../permissions';
import { prioritySchema, effortSchema } from './cards';
import { presetRow } from './rows';
import type { Command, Ctx } from '../dispatch';

const dataSchema = z.strictObject({
  content: z.string().optional(),
  priority: prioritySchema.nullable().optional(),
  effort: effortSchema.nullable().optional(),
  masterTags: z.array(z.string().regex(/^[\p{L}\p{N}_-]{1,32}$/u)).max(100).optional(),
  assigneeId: z.string().nullable().optional(),
});
const name = z.string().trim().min(1).max(100);

/** Presets are workspace-wide: any member (owner, admin, member), never an observer or a project-confined token. */
function assertMember(ctx: Ctx): void {
  assertCan(ctx.db, ctx.actor, 'workspace.edit');
}

export const presetCommands: Record<string, Command> = {
  'presets/create': {
    schema: z.object({ name, data: dataSchema }),
    run(ctx, input) {
      assertMember(ctx);
      const id = newId();
      ctx.db.prepare('INSERT INTO card_presets (id,name,data_json,created_by,created_at) VALUES (?,?,?,?,?)')
        .run(id, input.name, JSON.stringify(input.data), ctx.actor.id, Date.now());
      ctx.emit('preset', 'upsert', presetRow(ctx.db, id)!);
      return { id };
    },
  },
  'presets/update': {
    schema: z.object({ id: z.string(), name: name.optional(), data: dataSchema.optional() }),
    run(ctx, input) {
      assertMember(ctx);
      const p = presetRow(ctx.db, input.id);
      if (!p) throw new AppError(404, 'not_found');
      ctx.db.prepare('UPDATE card_presets SET name=?, data_json=? WHERE id=?')
        .run(input.name ?? p.name, JSON.stringify(input.data ?? p.data), input.id);
      ctx.emit('preset', 'upsert', presetRow(ctx.db, input.id)!);
    },
  },
  'presets/delete': {
    schema: z.object({ id: z.string() }),
    run(ctx, { id }) {
      assertMember(ctx);
      if (!presetRow(ctx.db, id)) throw new AppError(404, 'not_found');
      ctx.db.prepare('DELETE FROM card_presets WHERE id=?').run(id);
      ctx.emit('preset', 'remove', { id });
    },
  },
};

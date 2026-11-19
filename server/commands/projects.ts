import { z } from 'zod';
import { newId } from '../db';
import { AppError } from '../errors';
import { assertCan, isGuest } from '../permissions';
import { recordHistory } from '../history';
import { projectRow, deckRow } from './rows';
import { createCard, emitCard } from './cards';
import { deckCommands } from './decks';
import { TEMPLATE_IDS, templateById } from '../../shared/templates';
import { milestoneRow } from './milestones';
import { configRow } from './sprints';
import { DEFAULT_PROJECT_TAGS } from '../../shared/types';
import { projectFileIds, unlinkFiles } from '../files';
import { projectAssetBlobIds, unlinkAssetBlobs } from '../assets';
import type { Command, Ctx } from '../dispatch';
import { assertFeature, assertProjectSlots } from '../billing';
import { assertCoverUsable, coverSchema, projectCoverIds, releaseCover, unlinkCovers } from '../covers';
import type { Cover } from '../../shared/covers';

const deckType = z.enum(['asset', 'task', 'doc', 'mixed']);
const visibility = z.enum(['full', 'limited']);
const spaceSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().nullable(),
  icon: z.string().nullable(),
  defaultDeckType: deckType,
});
const tagsSchema = z.array(z.strictObject({
  name: z.string().regex(/^[\p{L}\p{N}_-]{1,32}$/u).refine((n) => n === n.toLowerCase(), 'lowercase'),
  emoji: z.string().max(8).nullable(),
})).max(100).refine((a) => new Set(a.map((t) => t.name)).size === a.length, 'duplicate tag names');
const spacesSchema = z.array(spaceSchema).min(1).refine(
  (a) => new Set(a.map((s) => s.id)).size === a.length,
  'duplicate space ids',
);

function removeProject(ctx: Ctx, id: string) {
  const { db } = ctx;
  const decks = db.prepare('SELECT id FROM decks WHERE project_id=?').all(id) as { id: string }[];
  const fileIds = projectFileIds(db, id);
  const coverIds = projectCoverIds(db, id);
  const assetBlobs = projectAssetBlobIds(db, id);
  for (const d of decks) {
    const cards = db.prepare('SELECT id FROM cards WHERE deck_id=?').all(d.id) as { id: string }[];
    db.prepare('DELETE FROM cards WHERE deck_id=?').run(d.id);
    for (const c of cards) ctx.emit('card', 'remove', { id: c.id, projectId: id });
    ctx.emit('deck', 'remove', { id: d.id, projectId: id });
  }
  // Non-global milestones and run configs left with no project would be invisible and unmanageable (configs would keep making runs).
  const orphan = (link: string, owner: string, table: string): string[] => (db.prepare(
    `SELECT t.id id FROM ${table} t WHERE t.is_global=0 AND EXISTS (SELECT 1 FROM ${link} l WHERE l.${owner}=t.id AND l.project_id=?)
       AND NOT EXISTS (SELECT 1 FROM ${link} l WHERE l.${owner}=t.id AND l.project_id!=?)`).all(id, id) as { id: string }[]).map((r) => r.id);
  const lostMilestones = orphan('milestone_projects', 'milestone_id', 'milestones').map((m) => milestoneRow(db, m)!);
  const lostConfigs = orphan('sprint_config_projects', 'config_id', 'sprint_configs').map((c) => configRow(db, c)!);
  const access = db.prepare('SELECT user_id u FROM project_access WHERE project_id=?').all(id) as { u: string }[];
  db.prepare('DELETE FROM project_prefs WHERE project_id=?').run(id);
  // Trashed cards of deleted decks have no deck any more but may still hold one of the project's entry types.
  db.prepare('UPDATE cards SET entry_type_id=NULL WHERE entry_type_id IN (SELECT id FROM entry_types WHERE project_id=?)').run(id);
  db.prepare('DELETE FROM projects WHERE id=?').run(id);
  for (const m of lostMilestones) { db.prepare('DELETE FROM milestones WHERE id=?').run(m.id); ctx.emit('milestone', 'remove', m); }
  for (const c of lostConfigs) { db.prepare('DELETE FROM sprint_configs WHERE id=?').run(c.id); ctx.emit('sprintConfig', 'remove', c); }
  for (const a of access) ctx.emit('projectAccess', 'remove', { projectId: id, userId: a.u });
  ctx.emit('project', 'remove', { id });
  ctx.afterCommit(() => { unlinkFiles(db, fileIds); unlinkCovers(db, coverIds); unlinkAssetBlobs(db, assetBlobs); });
}

export const projectCommands: Record<string, Command> = {
  'projects/create': {
    schema: z.object({ name: z.string().trim().min(1), visibility: visibility.optional(), cover: coverSchema.optional(), coverUrl: z.string().optional(), template: z.enum(TEMPLATE_IDS as [string, ...string[]]).optional() }),
    run(ctx, input) {
      assertCan(ctx.db, ctx.actor, 'project.create');
      if (input.coverUrl !== undefined) throw new AppError(400, 'invalid_input');
      if (input.cover?.kind === 'file') throw new AppError(400, 'bad_cover'); // a new project owns no uploads yet
      assertProjectSlots(ctx.db);
      if (input.visibility === 'limited') assertFeature(ctx.db, 'limitedVisibility');
      ctx.db.prepare('UPDATE account SET project_seq = project_seq + 1').run();
      const seq = (ctx.db.prepare('SELECT project_seq s FROM account').get() as { s: number }).s;
      const id = newId();
      const tpl = input.template ? templateById(input.template) : undefined;
      ctx.db.prepare('INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,tags_json,created_at,cover_json) VALUES (?,?,?,?,0,?,?,?,?)')
        .run(id, seq, input.name, input.visibility ?? 'full',
          JSON.stringify(tpl?.spaces ?? [{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]), JSON.stringify(tpl?.tags ?? DEFAULT_PROJECT_TAGS), Date.now(), input.cover ? JSON.stringify(input.cover) : null);
      ctx.emit('project', 'upsert', projectRow(ctx.db, id)!);
      // The template's decks and cards go through the normal create paths, in this same transaction.
      for (const d of tpl?.decks ?? []) {
        const { id: deckId } = deckCommands['decks/create'].run(ctx, { title: d.title, projectId: id, spaceId: d.space }) as { id: string };
        deckCommands['decks/update'].run(ctx, { id: deckId, deckType: d.deckType });
        for (const c of d.cards) createCard(ctx, { deckId, content: c.content, priority: c.priority, effort: c.effort, masterTags: c.tags });
      }
      return { id };
    },
  },
  'projects/update': {
    schema: z.object({
      id: z.string(),
      name: z.string().trim().min(1).optional(),
      visibility: visibility.optional(),
      isArchived: z.boolean().optional(),
      spaces: spacesSchema.optional(),
      tags: tagsSchema.optional(),
      cover: coverSchema.optional(),
      coverUrl: z.string().optional(),
    }),
    run(ctx, input) {
      const { db } = ctx;
      const needsManage = input.name !== undefined || input.visibility !== undefined || input.isArchived !== undefined || input.cover !== undefined || input.coverUrl !== undefined;
      if (needsManage || (input.spaces === undefined && input.tags === undefined)) assertCan(db, ctx.actor, 'project.manage', input.id);
      if (input.spaces !== undefined || input.tags !== undefined) assertCan(db, ctx.actor, 'content.edit', input.id);
      const p = projectRow(db, input.id);
      if (!p) throw new AppError(404, 'not_found');
      if (input.coverUrl !== undefined) throw new AppError(400, 'invalid_input');
      if (input.cover !== undefined) assertCoverUsable(db, input.id, input.cover);
      if (input.visibility === 'limited' && p.visibility !== 'limited') assertFeature(db, 'limitedVisibility');
      if (input.isArchived === false && p.isArchived) assertProjectSlots(db);
      if (input.spaces) {
        const keep = new Set(input.spaces.map((s: { id: number }) => s.id));
        const used = db.prepare('SELECT DISTINCT space_id s FROM decks WHERE project_id=?').all(input.id) as { s: number }[];
        const blocked = used.map((r) => r.s).filter((s) => !keep.has(s));
        if (blocked.length) throw new AppError(409, 'space_not_empty', { spaceIds: blocked });
      }
      if (input.tags) {
        // Renaming is delete + add; a removed tag leaves every card of the project.
        const keepNames = new Set(input.tags.map((t: { name: string }) => t.name));
        const gone = new Set((p.tags as { name: string }[]).map((t: { name: string }) => t.name).filter((n) => !keepNames.has(n)));
        if (gone.size) {
          const ds = db.prepare('SELECT id, auto_tag a FROM decks WHERE project_id=?').all(input.id) as { id: string; a: string | null }[];
          for (const dk of ds) {
            if (dk.a && gone.has(dk.a)) {
              db.prepare('UPDATE decks SET auto_tag=NULL WHERE id=?').run(dk.id);
              ctx.emit('deck', 'upsert', deckRow(db, dk.id)!);
            }
          }
          const rows = db.prepare('SELECT c.id id, c.master_tags_json m FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id=?')
            .all(input.id) as { id: string; m: string }[];
          for (const r of rows) {
            const old: string[] = JSON.parse(r.m);
            if (!old.some((t) => gone.has(t))) continue;
            const next = old.filter((t) => !gone.has(t));
            db.prepare('UPDATE cards SET master_tags_json=? WHERE id=?').run(JSON.stringify(next), r.id);
            recordHistory(db, r.id, ctx.actor.id, [{ kind: 'tags', from: old, to: next }]);
            emitCard(ctx, r.id);
          }
        }
      }
      db.prepare('UPDATE projects SET name=?, visibility=?, is_archived=?, spaces_json=?, tags_json=?, cover_json=? WHERE id=?').run(
        input.name ?? p.name,
        input.visibility ?? p.visibility,
        (input.isArchived ?? p.isArchived) ? 1 : 0,
        JSON.stringify(input.spaces ?? p.spaces),
        JSON.stringify(input.tags ?? p.tags),
        input.cover === undefined ? (p.cover ? JSON.stringify(p.cover) : null) : input.cover && JSON.stringify(input.cover),
        input.id,
      );
      if (input.cover !== undefined) releaseCover(ctx, p.cover as Cover);
      ctx.emit('project', 'upsert', projectRow(db, input.id)!);
      if (input.visibility !== undefined && input.visibility !== p.visibility) ctx.emit('project', 'access', { id: input.id });
    },
  },
  'projects/delete': {
    schema: z.object({ id: z.string() }),
    deletes: true,
    run(ctx, { id }) {
      assertCan(ctx.db, ctx.actor, 'project.manage', id);
      removeProject(ctx, id);
    },
  },
  'projects/setAccess': {
    schema: z.object({ projectId: z.string(), userId: z.string(), access: z.enum(['member', 'producer']).nullable() }),
    run(ctx, { projectId, userId, access }) {
      const { db } = ctx;
      assertCan(db, ctx.actor, 'project.manage', projectId);
      // Guests (Open Decks visitors) are never given project access.
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId) || isGuest(db, userId)) throw new AppError(404, 'not_found');
      if (access === null) {
        db.prepare('DELETE FROM project_access WHERE project_id=? AND user_id=?').run(projectId, userId);
        ctx.emit('projectAccess', 'remove', { projectId, userId });
        return;
      }
      const projectRole = access === 'producer' ? 'producer' : null;
      db.prepare('INSERT INTO project_access (project_id,user_id,project_role) VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET project_role=excluded.project_role')
        .run(projectId, userId, projectRole);
      ctx.emit('projectAccess', 'upsert', { projectId, userId, projectRole });
    },
  },
  'missionControl/setVisible': {
    schema: z.object({ projectId: z.string(), visible: z.boolean() }),
    run(ctx, { projectId, visible }) {
      assertCan(ctx.db, ctx.actor, 'project.view', projectId);
      ctx.db.prepare('INSERT INTO project_prefs (user_id,project_id,visible) VALUES (?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET visible=excluded.visible')
        .run(ctx.actor.id, projectId, visible ? 1 : 0);
      ctx.emit('projectPref', 'upsert', { userId: ctx.actor.id, projectId, visible });
    },
  },
};

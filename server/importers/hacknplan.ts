/**
 * HacknPlan project → ImportPlan, read over HacknPlan's public REST API v0 with the person's API key
 * (`Authorization: ApiKey <key>`).
 *
 * UNVERIFIED: written from HacknPlan's published API description, never run against the real service (tests use a
 * local mock server). Endpoint paths, paging and field names below may need fixes on the first real import.
 *
 * Endpoints read (all GET, under /v0/projects/{id}): the project itself, categories, boards, milestones and workitems
 * (paged with offset/limit). Assignees are taken from the work items, so the users list is not read. Mapping:
 * - categories (or boards, by choice) become decks; only those holding work items;
 * - work items become cards; user stories become hero cards and their tasks sub cards;
 * - subtasks become a checklist; attachments and the cover become links (nothing is downloaded);
 * - tags become project tags; importance becomes priority; estimated cost becomes effort; due dates are kept;
 * - the first assigned user owns the card when a member has the same email or name;
 * - a board's milestone becomes a milestone of the project; work items in a completed stage are done.
 *
 * Security: the server only ever calls HACKNPLAN_BASE (a fixed https host; the request names a project number, never
 * a URL), through the allow-list client (server/integrations/http.ts). Redirects are refused; one import reads at most
 * HACKNPLAN_BUDGET_BYTES in all and finishes within DEADLINE_MS (each request also has its own timeout). Tests point
 * api.hacknplan.com at a local mock through buildApp's `outbound` option, which no request can reach.
 */
import { z } from 'zod';
import { AppError } from '../errors';
import { cardContent, dayOf, type ImportPlan, type PlanCard } from './plan';
import { OutboundError, type OutboundClient, type OutboundResponse } from '../integrations/http';

export const HACKNPLAN_BASE = 'https://api.hacknplan.com/v0';

const TIMEOUT_MS = 20_000;
/** One import may take this long in all; past it the import fails (a slow host can't hold the import slot for long). */
const DEADLINE_MS = 120_000;
/** Bytes one import may read from HacknPlan in all requests together (the same size as a Trello export). */
export const HACKNPLAN_BUDGET_BYTES = 20 * 1024 * 1024;
const PAGE = 100;

/** What one import may still spend: bytes read and time. */
interface Budget { bytesLeft: number; deadline: number }

/** One GET, JSON body. Boards HacknPlan's answers to our errors; the key never appears in an error or a log. */
async function get(http: OutboundClient, apiKey: string, path: string, budget: Budget): Promise<unknown> {
  const wait = Math.min(TIMEOUT_MS, budget.deadline - Date.now());
  if (wait <= 0) throw new AppError(502, 'hacknplan_unavailable');
  if (budget.bytesLeft <= 0) throw new AppError(400, 'hacknplan_too_large', { maxBytes: HACKNPLAN_BUDGET_BYTES });
  let res: OutboundResponse;
  try {
    // The response may take at most what is left of the import's budget (the client stops reading past it).
    res = await http.request(HACKNPLAN_BASE + path, {
      method: 'GET',
      headers: { authorization: `ApiKey ${apiKey}`, accept: 'application/json' },
      timeoutMs: wait,
      maxBytes: budget.bytesLeft,
    });
  } catch (e) {
    if (e instanceof OutboundError && e.kind === 'too_large') throw new AppError(400, 'hacknplan_too_large', { maxBytes: HACKNPLAN_BUDGET_BYTES });
    throw new AppError(502, 'hacknplan_unavailable');
  }
  budget.bytesLeft -= res.bytes;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AppError(400, 'hacknplan_auth');
    if (res.status === 404) throw new AppError(400, 'hacknplan_not_found');
    throw new AppError(502, 'hacknplan_unavailable');
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new AppError(502, 'hacknplan_unavailable');
  }
}

const str = z.string().max(200_000).catch('');
const num = z.number().nullish().catch(null);
const named = z.object({ name: str });
const userSchema = z.object({ id: num, username: str, name: str, email: str }).partial();
const list = <T extends z.ZodTypeAny>(item: T) => z.array(z.unknown()).max(10_000).catch([])
  .transform((a) => a.flatMap((x) => { const r = item.safeParse(x); return r.success ? [r.data as z.infer<T>] : []; }));

const categorySchema = z.object({ categoryId: z.number(), name: str });
const boardSchema = z.object({ boardId: z.number(), name: str, milestoneId: num });
const milestoneSchema = z.object({ milestoneId: z.number(), name: str, dueDate: z.string().max(100).nullish().catch(null) });
const workItemSchema = z.object({
  workItemId: z.number(),
  title: str,
  description: str.nullish(),
  isStory: z.boolean().catch(false),
  parentStoryId: num,
  parentStory: z.object({ workItemId: num }).nullish().catch(null),
  category: z.object({ categoryId: num, name: str }).nullish().catch(null),
  board: z.object({ boardId: num, name: str }).nullish().catch(null),
  milestone: z.object({ milestoneId: num }).nullish().catch(null),
  stage: z.object({ name: str, status: str }).partial().nullish().catch(null),
  isCompleted: z.boolean().catch(false),
  importanceLevel: named.nullish().catch(null),
  estimatedCost: num,
  dueDate: z.string().max(100).nullish().catch(null),
  assignedUsers: list(z.object({ user: userSchema })),
  tags: list(named),
  subTasks: list(z.object({ title: str, isCompleted: z.boolean().catch(false) })),
  attachments: list(z.object({ name: str, url: str })),
  coverImageUrl: z.string().max(5000).nullish().catch(null),
});
const pageSchema = z.object({ totalCount: z.number().catch(0), items: list(workItemSchema) });

export interface HacknPlanProject {
  categories: z.infer<typeof categorySchema>[];
  boards: z.infer<typeof boardSchema>[];
  milestones: z.infer<typeof milestoneSchema>[];
  workItems: z.infer<typeof workItemSchema>[];
}

/** Reads one project. 400 too_many_cards when it holds more work items than `maxItems`. */
export async function fetchHacknPlanProject(http: OutboundClient, apiKey: string, hpProjectId: number, maxItems: number): Promise<HacknPlanProject> {
  const p = `/projects/${encodeURIComponent(String(hpProjectId))}`;
  const budget: Budget = { bytesLeft: HACKNPLAN_BUDGET_BYTES, deadline: Date.now() + DEADLINE_MS };
  await get(http, apiKey, p, budget); // 404 / 401 before anything else
  const categories = list(categorySchema).parse(await get(http, apiKey, `${p}/categories`, budget));
  const boards = list(boardSchema).parse(await get(http, apiKey, `${p}/boards`, budget));
  const milestones = list(milestoneSchema).parse(await get(http, apiKey, `${p}/milestones`, budget));
  const workItems: HacknPlanProject['workItems'] = [];
  for (let offset = 0, pages = 0; pages <= Math.ceil(maxItems / PAGE); pages++) {
    const parsed = pageSchema.safeParse(await get(http, apiKey, `${p}/workitems?offset=${offset}&limit=${PAGE}`, budget));
    if (!parsed.success) throw new AppError(502, 'hacknplan_unavailable');
    const page = parsed.data;
    if (page.totalCount > maxItems) throw new AppError(400, 'too_many_cards', { max: maxItems });
    workItems.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || offset >= page.totalCount) break;
  }
  if (workItems.length > maxItems) throw new AppError(400, 'too_many_cards', { max: maxItems });
  return { categories, boards, milestones, workItems };
}

/** HacknPlan importance names → priority (a high, b medium, c low). */
export function priorityOf(name: string | undefined): PlanCard['priority'] {
  const n = (name ?? '').trim().toLowerCase();
  if (['urgent', 'critical', 'high', 'very high', 'blocker'].includes(n)) return 'a';
  if (['normal', 'medium'].includes(n)) return 'b';
  if (['low', 'very low', 'trivial'].includes(n)) return 'c';
  return null;
}

export function planHacknPlan(data: HacknPlanProject, groupBy: 'category' | 'board'): ImportPlan {
  const groupOf = (w: HacknPlanProject['workItems'][number]): string =>
    groupBy === 'category' ? `c${w.category?.categoryId ?? 'none'}` : `b${w.board?.boardId ?? 'none'}`;
  const groups: { key: string; title: string }[] = groupBy === 'category'
    ? [...data.categories.map((c) => ({ key: `c${c.categoryId}`, title: c.name })), { key: 'cnone', title: 'No category' }]
    : [...data.boards.map((b) => ({ key: `b${b.boardId}`, title: b.name })), { key: 'bnone', title: 'Backlog' }];
  // Groups the project lists come first in its order; a work item naming an unlisted one adds it.
  for (const w of data.workItems) {
    const k = groupOf(w);
    if (!groups.some((g) => g.key === k)) groups.push({ key: k, title: (groupBy === 'category' ? w.category?.name : w.board?.name) || 'Untitled' });
  }
  const used = new Set(data.workItems.map(groupOf));
  const boardMilestone = new Map(data.boards.map((b) => [b.boardId, b.milestoneId ?? null]));
  const stories = new Set(data.workItems.filter((w) => w.isStory).map((w) => w.workItemId));
  const cards: PlanCard[] = data.workItems.map((w) => {
    const parent = w.parentStoryId ?? w.parentStory?.workItemId ?? null;
    const ms = w.milestone?.milestoneId ?? (w.board?.boardId != null ? boardMilestone.get(w.board.boardId) ?? null : null);
    const u = w.assignedUsers[0]?.user;
    const status = `${w.stage?.status ?? ''}`.toLowerCase();
    return {
      key: String(w.workItemId),
      deckKey: groupOf(w),
      content: cardContent({
        title: w.title,
        description: w.description,
        checklists: [{ name: 'Subtasks', items: w.subTasks.map((s) => ({ text: s.title, done: s.isCompleted })) }],
        links: [...w.attachments, ...(w.coverImageUrl ? [{ name: 'Cover', url: w.coverImageUrl }] : [])],
      }),
      tags: w.tags.map((t) => t.name).filter(Boolean),
      owner: u ? { names: [u.name ?? '', u.username ?? ''], emails: [u.email ?? ''] } : null,
      dueDate: dayOf(w.dueDate),
      priority: priorityOf(w.importanceLevel?.name),
      effort: typeof w.estimatedCost === 'number' && w.estimatedCost > 0 ? w.estimatedCost : null,
      parentKey: parent !== null && stories.has(parent) && parent !== w.workItemId ? String(parent) : null,
      milestoneKey: ms != null ? String(ms) : null,
      done: w.isCompleted || status === 'completed' || status === 'closed',
    };
  });
  return {
    decks: groups.filter((g) => used.has(g.key)),
    cards,
    milestones: data.milestones.map((m) => ({ key: String(m.milestoneId), name: m.name, date: dayOf(m.dueDate) })),
  };
}

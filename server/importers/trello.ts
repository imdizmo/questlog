/**
 * Trello board export (Board menu → Print, export and share → Export as JSON) → ImportPlan.
 * - open lists become decks, in list order; archived lists and their cards are skipped;
 * - open cards become cards, in position order; archived cards are skipped;
 * - labels become project tags (an unnamed label is named after its colour);
 * - checklists become Markdown checkboxes, attachments become links (nothing is downloaded);
 * - the card's first member becomes its owner when a member's email or name matches exactly;
 * - due dates are kept (applyImportPlan drops them when the workspace has due dates off);
 * - comments (the board's actions) are not imported.
 * Only the fields used here are read; everything else in the export is ignored.
 */
import { z } from 'zod';
import { cardContent, dayOf, type ImportPlan, type PlanCard } from './plan';

const str = z.string().max(200_000).catch('');
const pos = z.number().catch(0);
const ids = z.array(z.string().max(100)).max(1000).catch([]);

export const trelloBoardSchema = z.object({
  name: str.optional(),
  lists: z.array(z.object({ id: z.string().max(100), name: str, closed: z.boolean().catch(false), pos })).max(5000),
  cards: z.array(z.object({
    id: z.string().max(100),
    name: str,
    desc: str,
    closed: z.boolean().catch(false),
    idList: z.string().max(100),
    pos,
    idLabels: ids,
    idMembers: ids,
    due: z.string().max(100).nullish().catch(null),
    attachments: z.array(z.object({ name: str, url: str })).max(1000).catch([]),
  })).max(100_000),
  labels: z.array(z.object({ id: z.string().max(100), name: str, color: z.string().max(50).nullish().catch(null) })).max(5000).catch([]),
  checklists: z.array(z.object({
    id: z.string().max(100),
    name: str,
    idCard: z.string().max(100),
    pos,
    checkItems: z.array(z.object({ name: str, state: z.string().max(50).catch('incomplete'), pos })).max(5000).catch([]),
  })).max(100_000).catch([]),
  members: z.array(z.object({ id: z.string().max(100), fullName: str, username: str, email: str.optional() })).max(5000).catch([]),
});
export type TrelloBoard = z.infer<typeof trelloBoardSchema>;

const byPos = <T extends { pos: number }>(a: T[]) => [...a].sort((x, y) => x.pos - y.pos);

export function planTrello(board: TrelloBoard): ImportPlan {
  const lists = byPos(board.lists.filter((l) => !l.closed));
  const open = new Set(lists.map((l) => l.id));
  const labels = new Map(board.labels.map((l) => [l.id, l.name.trim() || l.color || '']));
  const members = new Map(board.members.map((m) => [m.id, m]));
  const checklists = new Map<string, TrelloBoard['checklists']>();
  for (const c of byPos(board.checklists)) {
    const a = checklists.get(c.idCard) ?? [];
    a.push(c);
    checklists.set(c.idCard, a);
  }
  const cards: PlanCard[] = byPos(board.cards.filter((c) => !c.closed && open.has(c.idList))).map((c) => {
    const first = c.idMembers.length ? members.get(c.idMembers[0]) : undefined;
    return {
      key: c.id,
      deckKey: c.idList,
      content: cardContent({
        title: c.name,
        description: c.desc,
        checklists: (checklists.get(c.id) ?? []).map((k) => ({
          name: k.name,
          items: byPos(k.checkItems).map((i) => ({ text: i.name, done: i.state === 'complete' })),
        })),
        links: c.attachments.map((a) => ({ name: a.name, url: a.url })),
      }),
      tags: c.idLabels.map((id) => labels.get(id) ?? '').filter(Boolean),
      owner: first ? { names: [first.fullName, first.username], emails: [first.email ?? '', first.username] } : null,
      dueDate: dayOf(c.due),
      priority: null,
      effort: null,
      parentKey: null,
      milestoneKey: null,
      done: false,
    };
  });
  return { decks: lists.map((l) => ({ key: l.id, title: l.name })), cards, milestones: [] };
}

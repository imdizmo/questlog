/**
 * Home's canvas as data: projects, their areas (only when a project has several, as in the sidebar), their lists and,
 * when asked, the lists' quests, with the lines Questlog already has (a project has areas, an area has lists, a list
 * has quests; "this locks that" between tasks). Pure over the store, so it is unit tested
 * (tests/web-home-model.test.ts); web/src/homeLayout.ts places the nodes and web/src/views/Home.tsx draws them.
 *
 * A workspace may hold thousands of tasks, so the canvas draws at most MAX_QUESTS_PER_LIST quests of a list (open ones
 * first) and MAX_QUESTS in all, at most MAX_LISTS_PER_AREA lists of an area and MAX_LISTS in all, MAX_AREAS areas and
 * MAX_PROJECTS projects (never more than MAX_NODES nodes); what is left out is one "+N more" pill
 * that opens the list (or the Overview). The counts on lists and in the corner are always the real ones.
 */
import type { Account, Card, CardDep, Deck, Priority, Project, Resolvable } from '../../shared/types';
import type { Cover } from '../../shared/covers';
import { derivedStatus } from '../../shared/cards';
import { cardHref, deckPath, openByCard } from './cards';
import { projectPrefix } from './taskId';

export const MAX_QUESTS_PER_LIST = 12;
export const MAX_QUESTS = 400;
export const MAX_LISTS_PER_AREA = 24;
export const MAX_LISTS = 200;
export const MAX_AREAS = 96;
export const MAX_PROJECTS = 24;
/** Every drawn node and "+N more" pill together, at most. */
export const MAX_NODES = MAX_PROJECTS + MAX_AREAS + MAX_LISTS + MAX_QUESTS + 1 + MAX_PROJECTS + MAX_AREAS + MAX_LISTS;

export type NodeKind = 'proj' | 'area' | 'list' | 'quest' | 'more';
export interface HomeNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Where a click goes. */
  href: string;
  parent: string | null;
  /** Where the node would like to be in the Web view (world pixels); web/src/homeLayout.ts nudges it to a free spot. */
  x: number;
  y: number;
  projectId: string;
  /** Lists: tasks left, done, all. Areas and projects: tasks left in their lists. */
  open?: number;
  done?: number;
  total?: number;
  /** Projects: how many lists. */
  lists?: number;
  /** Quests. */
  status?: Card['status'];
  blocked?: boolean;
  effort?: number | null;
  priority?: Priority | null;
  code?: string;
  text?: string;
  listLabel?: string;
  /** Short words for a card's tags row (lists of an area, areas of a project, open quests of a list). */
  tags?: string[];
  /** Projects: their colour and initials. */
  color?: string;
  initials?: string;
  /** A picture: a task's cover file; a project's or list's cover. */
  fileId?: string | null;
  cover?: Cover;
  /** "+N more": how many are not drawn. */
  hidden?: number;
}
export interface HomeEdge { a: string; b: string; kind: 'has' | 'lock'; /** List locks: how many task locks it stands for. */ n?: number }
export interface HomeModel { nodes: HomeNode[]; edges: HomeEdge[]; totals: { projects: number; lists: number; quests: number } }
export type HomeState = {
  projects: Map<string, Project>; decks: Map<string, Deck>; cards: Map<string, Card>;
  cardDeps: Map<string, CardDep>; resolvables: Map<string, Resolvable>; account: Account | null;
};

/** Project colours, by project order (the first is the accent). */
export const PROJECT_COLORS = ['#ec8219', '#4f8cff', '#3fb950', '#a78bfa', '#2bb3a3', '#e5a03a'];

const BLURB_MAX = 220;
/** The text under a task's title, as plain words: markdown marks, pictures and trailing #tags left out. */
export function cardBlurb(content: string): string {
  const nl = content.indexOf('\n');
  if (nl < 0) return '';
  const t = content.slice(nl + 1)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= BLURB_MAX) return t;
  const cut = t.slice(0, BLURB_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > BLURB_MAX * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const titleLine = (content: string) => (content.split('\n', 1)[0] ?? '').replace(/^[#\s]+/, '').trim() || 'Untitled';

const WEB_GAP = 70;
/** About how far a pill reaches from its point (half a long label), so packed webs do not meet. */
const REACH_X = 110, REACH_Y = 24;

/**
 * Packs the projects' webs (each built around 0, 0) in rows, left to right, the rows about twice as wide as the
 * whole is tall, so a workspace of many small projects fills a page instead of a wide empty grid.
 */
function packWebs(nodes: HomeNode[], webs: { from: number; to: number }[]): void {
  const boxes = webs.map(({ from, to }) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = from; i < to; i++) {
      x0 = Math.min(x0, nodes[i].x); x1 = Math.max(x1, nodes[i].x); y0 = Math.min(y0, nodes[i].y); y1 = Math.max(y1, nodes[i].y);
    }
    return { x0: x0 - REACH_X, y0: y0 - REACH_Y, w: x1 - x0 + 2 * REACH_X, h: y1 - y0 + 2 * REACH_Y };
  });
  const area = boxes.reduce((t, b) => t + (b.w + WEB_GAP) * (b.h + WEB_GAP), 0);
  const rowW = Math.max(...boxes.map((b) => b.w), Math.sqrt(area * 2));
  let x = 0, y = 0, rowH = 0;
  webs.forEach(({ from, to }, k) => {
    const b = boxes[k];
    if (x > 0 && x + b.w > rowW) { x = 0; y += rowH + WEB_GAP; rowH = 0; }
    const dx = x - b.x0, dy = y - b.y0;
    for (let i = from; i < to; i++) { nodes[i].x += dx; nodes[i].y += dy; }
    x += b.w + WEB_GAP;
    rowH = Math.max(rowH, b.h);
  });
}

interface ListInfo { deck: Deck; tasks: Card[]; done: number }

export function buildHomeModel(s: HomeState, opt: { quests: boolean }): HomeModel {
  const nodes: HomeNode[] = [];
  const edges: HomeEdge[] = [];
  let projects = [...s.projects.values()].filter((p) => !p.isArchived).sort((a, b) => a.seq - b.seq);
  if (projects.length > MAX_PROJECTS) {
    // Over the cap, draw the most recently active projects (a new project counts as active), still in their usual
    // order, so a project someone just made or worked on is never the one left out.
    const deckProject = new Map<string, string>();
    for (const d of s.decks.values()) deckProject.set(d.id, d.projectId);
    const active = new Map<string, number>();
    for (const p of projects) active.set(p.id, p.createdAt);
    for (const c of s.cards.values()) {
      const pid = c.deckId ? deckProject.get(c.deckId) : undefined;
      if (pid && active.has(pid) && c.lastUpdatedAt > (active.get(pid) ?? 0)) active.set(pid, c.lastUpdatedAt);
    }
    const rank = (id: string) => active.get(id) ?? 0;
    const keep = new Set([...projects].sort((a, b) => rank(b.id) - rank(a.id) || b.seq - a.seq).slice(0, MAX_PROJECTS).map((p) => p.id));
    projects = [...projects.filter((p) => keep.has(p.id)), ...projects.filter((p) => !keep.has(p.id))];
  }
  const shownProjects = new Set(projects.map((p) => p.id));

  // One pass over the tasks: per list, its tasks and how many are done.
  const lists = new Map<string, ListInfo>();
  for (const d of s.decks.values()) if (d.deckType !== 'doc' && shownProjects.has(d.projectId)) lists.set(d.id, { deck: d, tasks: [], done: 0 });
  const open = openByCard(s.resolvables.values());
  const listOfCard = new Map<string, string>();
  for (const c of s.cards.values()) {
    if (c.isDoc || c.visibility !== 'default' || !c.deckId) continue;
    const l = lists.get(c.deckId);
    if (!l) continue;
    l.tasks.push(c);
    listOfCard.set(c.id, c.deckId);
    if (c.status === 'done') l.done++;
  }
  let questTotal = 0;
  for (const l of lists.values()) questTotal += l.tasks.length;

  let budget = MAX_QUESTS;
  let listBudget = MAX_LISTS;
  const drawnQuest = new Set<string>();
  const drawnList = new Set<string>();

  const addQuests = (l: ListInfo, lid: string, lx: number, ly: number, out: number) => {
    if (!opt.quests || !l.tasks.length) return;
    const sorted = [...l.tasks].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.sortIndex - b.sortIndex || a.seq - b.seq);
    const take = Math.min(MAX_QUESTS_PER_LIST, budget, sorted.length);
    budget -= take;
    const n = take;
    for (let i = 0; i < take; i++) {
      const c = sorted[i];
      const a = out + (n === 1 ? 0 : (i - (n - 1) / 2) * Math.min(0.42, 2.4 / n));
      const r = 80 + (i % 2) * 40;
      const id = `q${c.id}`;
      drawnQuest.add(c.id);
      nodes.push({
        id, kind: 'quest', label: titleLine(c.content), href: cardHref(c, l.deck), parent: lid, x: lx + r * Math.cos(a), y: ly + r * Math.sin(a),
        projectId: l.deck.projectId, status: c.status, blocked: !!c.hasBlockingDeps || derivedStatus(c, open.get(c.id) ?? new Set()) === 'blocked',
        effort: c.effort, priority: c.priority, code: `${projectPrefix(s.projects.get(l.deck.projectId)?.name ?? '')}-${c.seq + 1}`,
        text: cardBlurb(c.content), listLabel: l.deck.title, fileId: c.coverFileId,
      });
      edges.push({ a: lid, b: id, kind: 'has' });
    }
    if (sorted.length > take) {
      const id = `m${l.deck.id}`;
      nodes.push({ id, kind: 'more', label: `${sorted.length - take} more`, href: deckPath(l.deck), parent: lid, x: lx + 150 * Math.cos(out), y: ly + 150 * Math.sin(out), projectId: l.deck.projectId, hidden: sorted.length - take });
      edges.push({ a: lid, b: id, kind: 'has' });
    }
  };

  const addLists = (decks: ListInfo[], parent: string, px: number, py: number, out: number, fan: number, radius: number, project: Project) => {
    const shown = decks.slice(0, Math.min(MAX_LISTS_PER_AREA, listBudget));
    listBudget -= shown.length;
    const n = shown.length;
    const step = n > 1 ? Math.min(rad(fan) / (n - 1), rad(44)) : 0;
    shown.forEach((l, j) => {
      const a = out + (j - (n - 1) / 2) * step;
      const r = radius + (n > 2 ? (j % 2) * 40 : 0);
      const x = px + r * Math.cos(a), y = py + r * Math.sin(a), id = `l${l.deck.id}`;
      const openN = l.tasks.length - l.done;
      drawnList.add(l.deck.id);
      nodes.push({
        id, kind: 'list', label: l.deck.title, href: deckPath(l.deck), parent, x, y, projectId: project.id, open: openN, done: l.done, total: l.tasks.length,
        tags: l.tasks.filter((c) => c.status !== 'done').slice(0, 3).map((c) => short(titleLine(c.content), 22)),
      });
      edges.push({ a: parent, b: id, kind: 'has' });
      addQuests(l, id, x, y, Math.atan2(y - py, x - px) * 0.5 + a * 0.5);
    });
    if (decks.length > n) {
      const id = `m${parent}`;
      nodes.push({ id, kind: 'more', label: `${decks.length - n} more lists`, href: '/decks', parent, x: px + (radius + 120) * Math.cos(out), y: py + (radius + 120) * Math.sin(out), projectId: project.id, hidden: decks.length - n });
      edges.push({ a: parent, b: id, kind: 'has' });
    }
  };

  // Each project's web is built around (0, 0), then the webs are packed in rows by their own size (packWebs).
  const webs: { from: number; to: number }[] = [];
  const byProject = new Map<string, Map<number, ListInfo[]>>();
  for (const l of lists.values()) {
    let areas = byProject.get(l.deck.projectId);
    if (!areas) byProject.set(l.deck.projectId, (areas = new Map()));
    const arr = areas.get(l.deck.spaceId) ?? [];
    arr.push(l);
    areas.set(l.deck.spaceId, arr);
  }
  let areaBudget = MAX_AREAS;
  projects.slice(0, MAX_PROJECTS).forEach((p, i) => {
    const px = 0, py = 0, from = nodes.length;
    const pid = `p${p.id}`;
    const byArea = byProject.get(p.id) ?? new Map<number, ListInfo[]>();
    for (const arr of byArea.values()) arr.sort((a, b) => a.deck.sortIndex - b.deck.sortIndex || a.deck.seq - b.deck.seq);
    const all = [...byArea.values()].flat();
    const openN = all.reduce((t, l) => t + l.tasks.length - l.done, 0);
    nodes.push({
      id: pid, kind: 'proj', label: p.name, href: '/decks', parent: null, x: px, y: py, projectId: p.id, open: openN, lists: all.length,
      tags: p.spaces.length > 1 ? p.spaces.map((sp) => sp.name ?? 'General') : [], color: PROJECT_COLORS[i % PROJECT_COLORS.length], initials: projectPrefix(p.name), cover: p.cover,
    });
    if (p.spaces.length > 1) {
      const n = p.spaces.length;
      const drawn = p.spaces.slice(0, areaBudget);
      areaBudget -= drawn.length;
      if (drawn.length < n) {
        const id = `m${pid}`;
        nodes.push({ id, kind: 'more', label: `${n - drawn.length} more areas`, href: '/decks', parent: pid, x: px, y: py + 160 + 8 * n, projectId: p.id, hidden: n - drawn.length });
        edges.push({ a: pid, b: id, kind: 'has' });
      }
      drawn.forEach((sp, k) => {
        const ang = rad(-118) + (k * 2 * Math.PI) / n;
        const ar = 140 + 8 * n;
        const ax = px + ar * Math.cos(ang), ay = py + ar * Math.sin(ang), aid = `a${p.id}:${sp.id}`;
        const mine = byArea.get(sp.id) ?? [];
        nodes.push({
          id: aid, kind: 'area', label: sp.name ?? 'General', href: '/decks', parent: pid, x: ax, y: ay, projectId: p.id,
          open: mine.reduce((t, l) => t + l.tasks.length - l.done, 0), tags: mine.slice(0, 4).map((l) => short(l.deck.title, 20)),
        });
        edges.push({ a: pid, b: aid, kind: 'has' });
        addLists(mine, aid, ax, ay, ang, 150, 120, p);
      });
    } else {
      addLists(all, pid, px, py, rad(-90), 300, 150, p);
    }
    webs.push({ from, to: nodes.length });
  });
  if (projects.length > MAX_PROJECTS) {
    const from = nodes.length, hidden = projects.length - MAX_PROJECTS;
    nodes.push({ id: 'mprojects', kind: 'more', label: `${hidden} more projects`, href: '/decks', parent: null, x: 0, y: 0, projectId: '', hidden });
    webs.push({ from, to: nodes.length });
  }
  packWebs(nodes, webs);

  // "This locks that": between the quests when both are drawn, else between their lists (one line per pair of lists).
  const listLocks = new Map<string, HomeEdge>();
  for (const d of s.cardDeps.values()) {
    if (drawnQuest.has(d.lockingCardId) && drawnQuest.has(d.lockedCardId)) {
      edges.push({ a: `q${d.lockingCardId}`, b: `q${d.lockedCardId}`, kind: 'lock' });
      continue;
    }
    const la = listOfCard.get(d.lockingCardId), lb = listOfCard.get(d.lockedCardId);
    if (!la || !lb || la === lb || !drawnList.has(la) || !drawnList.has(lb)) continue;
    const key = `${la}>${lb}`;
    const e = listLocks.get(key);
    if (e) e.n = (e.n ?? 1) + 1;
    else listLocks.set(key, { a: `l${la}`, b: `l${lb}`, kind: 'lock', n: 1 });
  }
  edges.push(...listLocks.values());

  return { nodes, edges, totals: { projects: projects.length, lists: lists.size, quests: questTotal } };
}

/**
 * What the sliders show: hiding areas or lists lifts what is under them to the next shown parent (a list then hangs off
 * its project); lines to a hidden node go.
 */
export function viewOf(m: HomeModel, show: { area: boolean; list: boolean }): { nodes: HomeNode[]; edges: HomeEdge[] } {
  if (show.area && show.list) return { nodes: m.nodes, edges: m.edges };
  const hidden = (n: HomeNode) => (n.kind === 'area' && !show.area) || (n.kind === 'list' && !show.list);
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const lift = (id: string | null): string | null => {
    let p = id;
    while (p) { const n = byId.get(p); if (!n || !hidden(n)) break; p = n.parent; }
    return p;
  };
  const nodes: HomeNode[] = [];
  const edges: HomeEdge[] = [];
  for (const n of m.nodes) {
    if (hidden(n)) continue;
    const parent = lift(n.parent);
    nodes.push(parent === n.parent ? n : { ...n, parent });
    if (parent) edges.push({ a: parent, b: n.id, kind: 'has' });
  }
  const shown = new Set(nodes.map((n) => n.id));
  for (const e of m.edges) if (e.kind === 'lock' && shown.has(e.a) && shown.has(e.b)) edges.push(e);
  return { nodes, edges };
}

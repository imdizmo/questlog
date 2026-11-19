/**
 * Where the sidebar's quick actions (New task, New list, New wiki entry, New milestone) put the new thing, so the
 * buttons never have to ask: the list, area or project of the open page; else the project or area row clicked last in
 * the tree; else the first project the person can add to. Pure, unit tested (tests/web-quick-target.test.ts).
 */
import type { Deck, Project, Space } from '../../shared/types';
import { seqFromCode } from '../../shared/cards';
import type { Route } from './router';
import { canEditContent, type State } from './store';
import { firstTaskList } from './palette';
import { spaceLabel } from './spaces';

export type QuickState = Pick<State, 'me' | 'accountRoles' | 'projectAccess' | 'projects' | 'decks' | 'cards'>;
export type QuickKind = 'task' | 'list' | 'entry' | 'milestone';
export interface QuickTarget { project: Project | null; area: Space | null; deck: Deck | null }
/** The project (and area) row clicked last in the tree. */
export interface Picked { projectId: string; areaId?: number }

const of = (s: QuickState, deck: Deck | undefined | null): QuickTarget | null => {
  const project = deck ? s.projects.get(deck.projectId) : undefined;
  if (!deck || !project) return null;
  return { project, area: project.spaces.find((x) => x.id === deck.spaceId) ?? null, deck };
};

export function quickTarget(s: QuickState, route: Route, picked: Picked | null): QuickTarget {
  if (route.name === 'deck' || route.name === 'deckCard' || route.name === 'deckActivity') {
    const t = of(s, [...s.decks.values()].find((d) => d.seq === route.deckSeq));
    if (t) return t;
  }
  if (route.name === 'card') {
    const seq = seqFromCode(route.code);
    const card = seq === null ? undefined : [...s.cards.values()].find((c) => c.seq === seq);
    const t = of(s, card?.deckId ? s.decks.get(card.deckId) : null);
    if (t) return t;
  }
  if ('projectSeq' in route) {
    const project = [...s.projects.values()].find((p) => p.seq === route.projectSeq);
    if (project) return { project, area: null, deck: null };
  }
  const pickedProject = picked ? s.projects.get(picked.projectId) : undefined;
  if (pickedProject && !pickedProject.isArchived) {
    return { project: pickedProject, area: pickedProject.spaces.find((x) => x.id === picked?.areaId) ?? null, deck: null };
  }
  const project = [...s.projects.values()].filter((p) => !p.isArchived && canEditContent(s as State, p)).sort((a, b) => a.seq - b.seq)[0] ?? null;
  return { project, area: null, deck: null };
}

/** The list a new task goes to: the open task list, else the area's first task list, else the project's. */
export function taskList(s: QuickState, t: QuickTarget): Deck | null {
  if (t.deck && t.deck.deckType !== 'doc') return t.deck;
  if (!t.project) return null;
  if (t.area) {
    const inArea = [...s.decks.values()].filter((d) => d.projectId === t.project!.id && d.spaceId === t.area!.id && d.deckType !== 'doc')
      .sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)[0];
    if (inArea) return inArea;
  }
  return firstTaskList(s.decks, t.project.id);
}

/** The box's "Goes to: …" text; null when there is nowhere to put it. */
export function whereText(kind: QuickKind, s: QuickState, t: QuickTarget): string | null {
  const p = t.project;
  if (!p) return null;
  if (kind === 'task') { const d = taskList(s, t); return d ? `${d.title} (${p.name})` : null; }
  if (kind === 'list') return t.area && p.spaces.length > 1 ? `${p.name}, area ${spaceLabel(t.area)}` : p.name;
  if (kind === 'entry') return `${p.name} wiki`;
  return p.name;
}

import type { BoardEdge, BoardNode } from '../../../shared/board';
import { macroSummary } from './projectFrames';

/**
 * Below this zoom a project board shows its overview: list frames with "N tasks left" and one thick arrow per pair of
 * lists that wait on each other. The keyboard zooms in steps of 0.1 from 1, so 0.4 is the first macro step.
 */
export const MACRO_BELOW = 0.45;

/** Whether the board draws its overview: only a board that follows its project, only below the threshold. */
export const isMacro = (scale: number, followsProject: boolean): boolean => followsProject && scale < MACRO_BELOW;

/** "1 task left", "5 tasks left". */
export const tasksLeft = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'} left`;

export interface MacroView {
  /** Tasks left per list frame (node id). */
  counts: Map<string, number>;
  /** One per ordered pair of list frames with "waits for" lines between their cards. */
  links: Array<{ from: string; to: string; count: number }>;
  /** Cards in a list frame: not drawn in the overview (their frame stands for them). */
  hidden: Set<string>;
  /** The lines still drawn: those touching no hidden card. */
  edges: BoardEdge[];
}

/** What the overview draws, read from the board only (it never writes anything). O(nodes + edges). */
export function macroView(nodes: BoardNode[], edges: BoardEdge[]): MacroView {
  const { counts, links } = macroSummary(nodes, edges);
  const hidden = new Set<string>();
  for (const n of nodes) if (n.type === 'card' && n.pos.parent && counts.has(n.pos.parent)) hidden.add(n.id);
  const shown = edges.filter((e) => !hidden.has(e.value.source.nodeId) && !hidden.has(e.value.target.nodeId));
  return { counts, links, hidden, edges: shown };
}

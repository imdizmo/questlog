import type { Card } from '../../shared/types';
import { store, type State } from './store';

/** "The Lost Harbour" → LH: the first letters of the name's words (articles skipped), at most three; one word gives its first two letters. */
export function projectPrefix(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^(the|a|an)$/i.test(w));
  const p = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 2)).slice(0, 3).toUpperCase();
  return p || 'T';
}

/**
 * The id people see and say: project prefix and the task's number, as in LH-127. The number is the workspace-wide one,
 * so it never changes when a task moves. Links and `$code` references in text keep the short code underneath.
 */
export function taskId(c: Pick<Card, 'seq' | 'deckId'>, s: Pick<State, 'decks' | 'projects'> = store.get()): string {
  const project = c.deckId ? s.projects.get(s.decks.get(c.deckId)?.projectId ?? '') : undefined;
  return `${project ? projectPrefix(project.name) : 'T'}-${c.seq + 1}`;
}

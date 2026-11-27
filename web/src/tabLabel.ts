/** What a tab says for its page: the page's own name (a list, a task, an entry) and an icon of web/src/components/icons.tsx. */
import { seqFromCode, titleOf } from '../../shared/cards';
import type { Card } from '../../shared/types';
import type { IconName } from './components/icons';
import { parse } from './router';
import type { State } from './store';
import { entryBySegment } from './wiki';
import { pathOf } from './tabs';
import { titleNow } from './translate';

export type LabelState = Pick<State, 'projects' | 'decks' | 'cards' | 'milestones' | 'entryTypes'>;
export interface TabLabel { label: string; icon: IconName }

const PAGES: Partial<Record<string, TabLabel>> = {
  home: { label: 'Home', icon: 'home' },
  root: { label: 'My tasks', icon: 'user' },
  inbox: { label: 'Inbox', icon: 'inbox' },
  decks: { label: 'Overview', icon: 'grid' },
  milestones: { label: 'Milestones', icon: 'flag' },
  activity: { label: 'Activity', icon: 'pulse' },
  vision: { label: 'Vision board', icon: 'frame' },
  visionBoard: { label: 'Vision board', icon: 'frame' },
  wiki: { label: 'Wiki', icon: 'book' },
  assets: { label: 'Assets', icon: 'asset' },
  assetsProject: { label: 'Assets', icon: 'asset' },
  newTab: { label: 'New tab', icon: 'plus' },
  run: { label: 'Sprint', icon: 'flag' },
  runActivity: { label: 'Sprint activity', icon: 'pulse' },
  wikiNew: { label: 'New entry', icon: 'book' },
};

const cardBySeq = (cards: Map<string, Card>, code: string): Card | undefined => {
  const seq = seqFromCode(code);
  if (seq === null) return undefined;
  for (const c of cards.values()) if (c.seq === seq) return c;
  return undefined;
};

export function tabLabel(s: LabelState, url: string): TabLabel {
  const r = parse(pathOf(url));
  const page = PAGES[r.name];
  if (page) return page;
  const deckOf = (seq: number) => [...s.decks.values()].find((d) => d.seq === seq);
  const projectOf = (seq: number) => [...s.projects.values()].find((p) => p.seq === seq);
  switch (r.name) {
    case 'deck': return { label: deckOf(r.deckSeq)?.title ?? 'List', icon: 'list' };
    case 'deckActivity': return { label: deckOf(r.deckSeq)?.title ?? 'Activity', icon: 'pulse' };
    case 'deckCard':
    case 'card': {
      const c = cardBySeq(s.cards, r.code);
      return { label: c ? titleNow(c) || 'Task' : 'Task', icon: 'task' };
    }
    case 'milestone':
    case 'milestoneActivity': {
      const m = [...s.milestones.values()].find((x) => x.accountSeq === r.seq);
      return { label: m?.name ?? 'Milestone', icon: r.name === 'milestone' ? 'flag' : 'pulse' };
    }
    case 'wikiProject': {
      const p = projectOf(r.projectSeq);
      return { label: p ? `${p.name} wiki` : 'Wiki', icon: 'book' };
    }
    case 'wikiEntry': {
      const p = projectOf(r.projectSeq);
      const c = p ? entryBySegment(s, p.id, r.entry) : undefined;
      return { label: c ? titleNow(c) || 'Entry' : 'Entry', icon: 'doc' };
    }
    case 'wikiType':
    case 'wikiKind': {
      const p = projectOf(r.projectSeq);
      const t = p ? [...s.entryTypes.values()].find((x) => x.projectId === p.id && x.key === r.typeKey) : undefined;
      return { label: t?.name ?? 'Wiki', icon: 'book' };
    }
    case 'wikiView': return { label: r.view.charAt(0).toUpperCase() + r.view.slice(1), icon: 'book' };
    default: return { label: 'Page not found', icon: 'file' };
  }
}

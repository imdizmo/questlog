import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_SETTINGS } from '../../../shared/types';
import { priorityName } from '../cards';
import { Icon } from '../components/icons';
import { CoverArt } from '../components/CoverArt';
import type { HomeNode } from '../homeModel';

/**
 * How a project, area, list or quest of Home looks: a pill, or (for the kinds the person shows as cards) a scene card
 * as on the vision board: picture, title, text, tags. Used by Home's board (`work` nodes, through WorkContext) and by
 * its Tree View.
 */
export const STATUS: Record<string, [string, string]> = {
  not_started: ['Not started', '#8f877a'], started: ['Started', '#4f8cff'], done: ['Done', '#3fb950'], blocked: ['Blocked', '#e5484d'],
};
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const questState = (n: HomeNode) => (n.status === 'done' ? 'done' : n.blocked ? 'blocked' : n.status ?? 'not_started');
type Labels = typeof DEFAULT_SETTINGS.priorityLabels;

/** What a work node needs from the page: the model's nodes this person sees by their key on the board (homeWork's
 * workHash), which show as cards (model ids), and names. */
export interface WorkInfo {
  nodes: Map<string, HomeNode>;
  cards: Set<string>;
  labels: Labels;
  projectName: (id: string) => string;
}
export const WorkContext = createContext<WorkInfo | null>(null);

/** The accessible name of a work node. */
export function workLabel(n: HomeNode): string {
  switch (n.kind) {
    case 'proj': return `${n.label}, project`;
    case 'area': return `${n.label}, area`;
    case 'list': return `${n.label}, list, ${n.open} open`;
    case 'quest': return `${n.label}, ${STATUS[questState(n)][0]}`;
    default: return n.label;
  }
}

/** The class and inside of a node's face: `chip2 <kind>` (a pill) or `card2 scene2 <kind>` (a card). */
export function workFace(n: HomeNode, card: boolean, labels: Labels, projectName: string): { className: string; style?: CSSProperties; body: ReactNode } {
  if (!card || n.kind === 'more') return { className: `chip2 ${n.kind}`, body: pillBody(n) };
  const prio = (p: NonNullable<HomeNode['priority']>) => priorityName(p, { priorityLabels: labels });
  let pic: ReactNode, text: string, tags: ReactNode[], color: string | undefined;
  if (n.kind === 'quest') {
    const [label, col] = STATUS[questState(n)];
    color = col;
    pic = n.fileId ? <img src={`/api/files/${encodeURIComponent(n.fileId)}`} alt="" loading="lazy" draggable={false} /> : <span className="nopic" title="No picture yet">!</span>;
    text = n.text || 'Nothing written yet.';
    tags = [n.code, n.effort != null && <><Icon name="flag" size={11} /> {n.effort}</>, n.priority && prio(n.priority), <b style={{ color: col }}>{label}</b>, <><Icon name="list" size={11} /> {n.listLabel}</>];
  } else if (n.kind === 'list') {
    color = '#3fb950';
    pic = <span className="bigring" style={{ '--p': n.total ? Math.round(((n.done ?? 0) / n.total) * 100) : 0 } as CSSProperties}><b>{n.open}</b><small>open</small></span>;
    text = `${n.total} ${n.total === 1 ? 'quest' : 'quests'}, ${n.done} done.`;
    tags = n.tags ?? [];
  } else if (n.kind === 'area') {
    pic = <span className="picico"><Icon name="grid" size={30} /></span>;
    text = `An area of ${projectName} with ${n.open} open ${n.open === 1 ? 'quest' : 'quests'}.`;
    tags = (n.tags ?? []).map((t) => <><Icon name="list" size={11} /> {t}</>);
  } else {
    color = n.color;
    pic = n.cover ? <CoverArt cover={n.cover} size="tile" /> : <span className="pav" style={{ background: n.color }}>{n.initials}</span>;
    text = `${n.lists} ${n.lists === 1 ? 'list' : 'lists'}, ${n.open} open ${n.open === 1 ? 'quest' : 'quests'}.`;
    tags = n.tags ?? [];
  }
  return {
    className: `card2 scene2 ${n.kind}`,
    style: color ? ({ '--sc-c': color } as CSSProperties) : undefined,
    body: (
      <>
        <span className="pic">{pic}</span>
        <span className="ttl">{n.label}</span>
        <span className="txt">{text}</span>
        <span className="tags">{tags.filter(Boolean).map((t, i) => <span key={i} className="tg">{t}</span>)}</span>
      </>
    ),
  };
}

function pillBody(n: HomeNode): ReactNode {
  switch (n.kind) {
    case 'proj': return <><span className="av" style={{ background: n.color }}>{n.initials}</span><span>{n.label}</span></>;
    case 'area': return <><span className="dot" /><span>{n.label}</span></>;
    case 'list': return <><span className="rg" style={{ '--p': n.total ? Math.round(((n.done ?? 0) / n.total) * 100) : 0 } as CSSProperties} /><span>{n.label}</span><span className="ct">{n.open}</span></>;
    case 'quest': return <><span className={`qs ${questState(n)}`} /><span>{short(n.label, 34)}</span></>;
    default: return <><Icon name="plus" size={11} /><span>{n.label}</span></>;
  }
}

/** A `work` node's inside on the board (`refId`: its key): its pill or card, from the data. One this person can't see shows nothing. */
export function WorkBody({ refId }: { refId: string }) {
  const info = useContext(WorkContext);
  const n = info?.nodes.get(refId);
  if (!info || !n) return null;
  const f = workFace(n, info.cards.has(n.id), info.labels, info.projectName(n.projectId));
  return <span className={f.className} style={f.style} title={n.kind === 'quest' ? n.label : undefined}>{f.body}</span>;
}

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Card, EntryType, Project } from '../../../../shared/types';
import { titleOf } from '../../../../shared/cards';
import { layout, neighbours, type Graph, type GraphNode, type Layout } from '../../../../shared/graph';
import { store, useStore } from '../../store';
import { Link, navigate } from '../../router';
import { campaignGraphData, campaignTypes, entryExcerpt, entryPath, projectIdOf, safeColor, visibleColor, wikiViewPath } from '../../wiki';
import { GraphCanvas, radiusFor } from './GraphCanvas';
import { TypeBadge } from './Infobox';
import { usePanelOpener, type PanelOpener } from './panelContext';

/**
 * Opens an entry from a graph. One place on purpose: inside the wiki's entry stack (`beside`) it opens as a panel to the
 * right of the column the graph is in; elsewhere (the campaign graph) it goes to the entry's page.
 */
export function openEntry(card: Card, beside?: PanelOpener | null): void {
  if (beside) { beside.openCard(card); return; }
  const s = store.get();
  const projectId = projectIdOf(s.decks, card);
  const project = projectId ? s.projects.get(projectId) : undefined;
  if (project) navigate(entryPath(project.seq, card));
}

/** How many theme colours (`--graph-0` …) a type without its own colour cycles through. */
const PALETTE = 8;
/** A node's fill: its type's own colour (lightened when too dark), else the theme palette by the type's place, pages grey. */
export function useTypeColors(projectId: string): (typeId: string | null) => string {
  const types = useStore((s) => s.entryTypes);
  const colours = useMemo(() => {
    const m = new Map<string, string>();
    campaignTypes(types, projectId).forEach((t, i) => { const c = safeColor(t.color); m.set(t.id, c ? visibleColor(c) : `var(--graph-${i % PALETTE})`); });
    return m;
  }, [types, projectId]);
  return useCallback((typeId) => (typeId && colours.get(typeId)) || 'var(--graph-page)', [colours]);
}

/** A node colour function for GraphCanvas, stable while the type colours stay the same. */
export function useNodeColors(projectId: string): (n: GraphNode) => string {
  const colorOf = useTypeColors(projectId);
  return useCallback((n: GraphNode) => colorOf(n.typeId), [colorOf]);
}

/**
 * Layout of exactly what is shown: keyed on the shown ids and edges (and cluster sizes), and spaced by the degree within
 * the shown graph, so the same picture always gets the same positions and a change elsewhere in the campaign never
 * moves it. Node sizes on screen still follow the campaign-wide degree.
 */
export function useGraphLayout(graph: Graph, spacing: number): Layout {
  const sig = useMemo(() => `${graph.centerId}|${graph.nodes.map((n) => (n.cluster ? `${n.id}:${n.cluster.count}` : n.id)).join(',')}|${graph.edges.map((e) => `${e.id}:${e.weight}`).join(',')}`, [graph]);
  const last = useRef<{ sig: string; layout: Layout } | null>(null);
  if (last.current?.sig !== sig) {
    const local = new Map<string, number>();
    for (const e of graph.edges) { local.set(e.source, (local.get(e.source) ?? 0) + 1); local.set(e.target, (local.get(e.target) ?? 0) + 1); }
    last.current = { sig, layout: layout(graph, { spacing, radius: (n) => radiusFor(n, local.get(n.id) ?? 0, graph.centerId) }) };
  }
  return last.current.layout;
}

export const describeNode = (types: Map<string, EntryType>, centerId: string | null) => (n: GraphNode): string => {
  if (n.cluster) return `${n.label}: open to show them`;
  const type = n.typeId ? types.get(n.typeId)?.name ?? 'Entry' : 'Page';
  return `${n.label}, ${type}, ${n.degree} ${n.degree === 1 ? 'connection' : 'connections'}${n.id === centerId ? ', this entry' : ''}`;
};

/** The small card next to a selected node: picture of what it is, and Open. */
/** The card of a selected node: what it is, and Open. With `at` it floats next to the node; without, it sits in the flow. */
export function GraphPreview({ card, at, relations, onClose }: {
  card: Card; at?: { left: number; top: number; w: number; h: number }; relations?: string[]; onClose: () => void;
}) {
  const type = useStore((s) => (card.entryTypeId ? s.entryTypes.get(card.entryTypeId) ?? null : null));
  const beside = usePanelOpener();
  const title = titleOf(card.content) || 'Untitled';
  const line = entryExcerpt(card);
  let style: CSSProperties | undefined;
  if (at) {
    const width = Math.min(220, at.w - 16);
    const left = Math.max(8, Math.min(at.left - width / 2, at.w - width - 8));
    style = { left, width, ...(at.top < at.h * 0.55 ? { top: at.top + 18 } : { bottom: at.h - at.top + 18 }) };
  }
  return (
    <div className={`graph-preview${at ? ' floating' : ''}`} data-testid="graph-preview" role="group" aria-label={`Preview: ${title}`} style={style}>
      <div className="graph-preview-head">
        <strong>{title}</strong>
        <button type="button" className="icon-btn graph-preview-x" aria-label="Close preview" onClick={onClose}>×</button>
      </div>
      <TypeBadge type={type} />
      {line && <p className="muted graph-preview-line">{line}</p>}
      {relations && relations.length > 0 && <p className="hint">{relations.join(' · ')}</p>}
      <button type="button" className="btn btn-sm btn-primary" onClick={() => openEntry(card, beside)}>Open</button>
    </div>
  );
}

const DEPTH_KEY = 'jt:graphDepth';
const readDepth = (): 1 | 2 => { try { return localStorage.getItem(DEPTH_KEY) === '2' ? 2 : 1; } catch { return 1; } };

/** The tile beside an open entry: its neighbours one or two steps away. */
export function EntryGraph({ card, project }: { card: Card; project: Project }) {
  const s = useStore((x) => x);
  const [depth, setDepthState] = useState<1 | 2>(readDepth);
  const setDepth = (d: 1 | 2) => { setDepthState(d); try { localStorage.setItem(DEPTH_KEY, String(d)); } catch { /* not remembered */ } };
  const [selected, setSelected] = useState<string | null>(null);
  const beside = usePanelOpener();
  const toggle = useRef<HTMLDivElement>(null);
  const data = campaignGraphData(s, project.id);
  const graph = useMemo(() => neighbours(card.id, data, depth), [data, card.id, depth]);
  const pos = useGraphLayout(graph, 52);
  const colorOf = useNodeColors(project.id);
  const describe = useMemo(() => describeNode(s.entryTypes, card.id), [s.entryTypes, card.id]);
  const selectedCard = selected ? s.cards.get(selected) : undefined;
  const between = (id: string) => graph.edges.find((e) => (e.source === id && e.target === card.id) || (e.target === id && e.source === card.id))?.relations.map((r) => r.label);
  const empty = graph.nodes.length <= 1;

  return (
    <section className="entry-graph" aria-label="Graph" data-testid="entry-graph">
      <div className="entry-graph-head">
        <h2 className="entry-graph-title">Graph</h2>
        <div className="seg" role="group" aria-label="Steps" ref={toggle}>
          {([1, 2] as const).map((d) => (
            <button key={d} type="button" className={`seg-btn${depth === d ? ' on' : ''}`} aria-pressed={depth === d} onClick={() => { setDepth(d); setSelected(null); }}>
              {d === 1 ? '1 step' : '2 steps'}
            </button>
          ))}
        </div>
      </div>
      {empty ? (
        <p className="muted entry-graph-empty">No connections yet. Links, entry fields and names written in other pages show up here.</p>
      ) : (
        <GraphCanvas graph={graph} layout={pos} label={`Neighbours of ${titleOf(card.content) || 'this entry'}`} colorOf={colorOf} describe={describe}
          labels={10} selectedId={selected && graph.nodes.some((n) => n.id === selected) ? selected : null}
          onSelect={setSelected}
          onOpen={(id) => { const c = s.cards.get(id); if (c) openEntry(c, beside); }}
          onEscape={() => toggle.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()} />
      )}
      {/* Under the picture, not over it: the centre and the selected node stay in view. */}
      {!empty && selectedCard && selected && graph.nodes.some((n) => n.id === selected) && (
        <GraphPreview card={selectedCard} relations={selected === card.id ? undefined : between(selected)} onClose={() => setSelected(null)} />
      )}
      <p className="hint entry-graph-foot">
        {!empty && <span>{graph.nodes.length - 1} {graph.nodes.length === 2 ? 'neighbour' : 'neighbours'}{graph.dropped > 0 ? `, the best-connected of ${graph.nodes.length - 1 + graph.dropped}` : ''} · </span>}
        <Link href={wikiViewPath(project.seq, 'graph')}>Whole graph</Link>
      </p>
    </section>
  );
}

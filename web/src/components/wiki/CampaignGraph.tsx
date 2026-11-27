import { useMemo, useRef, useState } from 'react';
import type { Project } from '../../../../shared/types';
import { campaignGraph, clusterByType, CLUSTER_ABOVE, isClusterId } from '../../../../shared/graph';
import { useStore } from '../../store';
import { campaignGraphData, campaignTypes } from '../../wiki';
import { GraphCanvas } from './GraphCanvas';
import { describeNode, GraphPreview, openEntry, useGraphLayout, useNodeColors, useTypeColors } from './EntryGraph';
import { useReadLang } from '../../translate';

const PAGE = '';
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The whole campaign as one graph: filter by type; above 50 entries each type is one cluster node until it is opened;
 * wheel and drag (or + / - / 0) to zoom, pan and fit.
 */
export function CampaignGraph({ project }: { project: Project }) {
  const s = useStore((x) => x);
  useReadLang(); // node labels are the reader's titles: another reading language redraws them
  const data = campaignGraphData(s, project.id);
  const types = useMemo(() => campaignTypes(s.entryTypes, project.id), [s.entryTypes, project.id]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string | null>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const zoom = useRef<{ zoom: (f: number) => void; fit: () => void } | null>(null);
  const fitBtn = useRef<HTMLButtonElement>(null);
  const colorOf = useTypeColors(project.id);
  const nodeColor = useNodeColors(project.id);

  const perType = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data.nodes) m.set(n.typeId ?? PAGE, (m.get(n.typeId ?? PAGE) ?? 0) + 1);
    return m;
  }, [data]);
  const filters = [...types.filter((t) => perType.has(t.id)).map((t) => ({ id: t.id, name: t.name, icon: t.icon })), ...(perType.has(PAGE) ? [{ id: PAGE, name: 'Pages', icon: '📄' }] : [])];
  const names = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const full = useMemo(() => campaignGraph(data, (t) => !hidden.has(t ?? PAGE)), [data, hidden]);
  const graph = useMemo(() => clusterByType(full, expanded, (t, n) => `${t ? names.get(t) ?? 'Entries' : 'Pages'} (${count(n)})`), [full, expanded, names]);
  const pos = useGraphLayout(graph, 60);
  const describe = useMemo(() => describeNode(s.entryTypes, null), [s.entryTypes]);
  const clustered = graph.nodes.some((n) => n.cluster);
  const selectedCard = selected && !isClusterId(selected) ? s.cards.get(selected) : undefined;

  const toggleType = (id: string) => {
    setSelected(null);
    setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const open = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (n?.cluster) { setSelected(null); setExpanded((e) => new Set([...e, n.cluster!.typeId])); return; }
    const c = s.cards.get(id);
    if (c) openEntry(c);
  };

  return (
    <section className="wk-kind campaign-graph" aria-label="Graph" data-testid="campaign-graph">
      <div className="wk-head">
        <h2><span aria-hidden>🕸 </span>Graph</h2>
        <span className="hint">{count(full.nodes.length)} {full.nodes.length === 1 ? 'entry' : 'entries'} · {count(full.edges.length)} {full.edges.length === 1 ? 'connection' : 'connections'}{full.dropped ? ` · ${count(full.dropped)} less-connected left out` : ''}</span>
      </div>
      {filters.length > 1 && (
        <div className="graph-filters" role="group" aria-label="Show types">
          {filters.map((f) => (
            <label key={f.id} className="chip graph-filter">
              <input type="checkbox" checked={!hidden.has(f.id)} onChange={() => toggleType(f.id)} />
              <span className="graph-swatch" style={{ background: colorOf(f.id || null) }} aria-hidden />
              {f.icon && <span aria-hidden>{f.icon}</span>}{f.name} <span className="muted">{count(perType.get(f.id) ?? 0)}</span>
            </label>
          ))}
        </div>
      )}
      <div className="graph-tools row">
        <button type="button" className="btn btn-sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom.current?.zoom(1.25)}>+</button>
        <button type="button" className="btn btn-sm" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoom.current?.zoom(0.8)}>−</button>
        <button type="button" className="btn btn-sm" ref={fitBtn} title="Fit (0)" onClick={() => zoom.current?.fit()}>Fit</button>
        {expanded.size > 0 && full.nodes.length > CLUSTER_ABOVE && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setExpanded(new Set()); setSelected(null); }}>Group by type again</button>}
        {clustered && <span className="hint">More than {CLUSTER_ABOVE} entries: each type is one circle. Click one to open it.</span>}
      </div>
      {full.nodes.length === 0 ? <p className="muted">Nothing to show. Add entries, or show more types.</p> : (
        <div className="campaign-graph-box">
          <GraphCanvas graph={graph} layout={pos} label={`Graph of ${project.name}`} colorOf={nodeColor} describe={describe}
            labels={24} zoomable fitKey={`${[...hidden].sort().join(',')}|${[...expanded].map(String).sort().join(',')}`}
            selectedId={selectedCard ? selected : null} onSelect={(id) => setSelected(id)} onOpen={open}
            onEscape={() => fitBtn.current?.focus()}
            controls={(c) => { zoom.current = c; }}
            preview={(_, at) => selectedCard && <GraphPreview card={selectedCard} at={at} onClose={() => setSelected(null)} />} />
        </div>
      )}
      <p className="hint">Wheel or + / − to zoom, drag or Shift+arrow keys to move, 0 to fit. Arrow keys move between connected entries (the view follows), Space shows one, Enter opens it.</p>
    </section>
  );
}

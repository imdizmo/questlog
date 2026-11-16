import { parseLabel } from '../../../shared/story';
import { COLORS, edgePath, type BoardColor, type BoardEdge, type BoardNode, type EdgeEnd, type Point, type Rect, type Side } from '../../../shared/board';
import { InlineEdit, nodeName } from './nodes';

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

export interface EdgeGeometry { d: string; mid: Point; from: BoardNode; to: BoardNode }

/** The curve and its midpoint, or null while an end node is missing (a peer deleted it). */
export function edgeGeometry(edge: BoardEdge, byId: Map<string, BoardNode>, rectOf: (n: BoardNode) => Rect): EdgeGeometry | null {
  const from = byId.get(edge.value.source.nodeId);
  const to = byId.get(edge.value.target.nodeId);
  if (!from || !to) return null;
  const d = edgePath({ rect: rectOf(from), side: edge.value.source.side }, { rect: rectOf(to), side: edge.value.target.side });
  return { d, mid: bezierMid(d), from, to };
}

/** The curve point at t = 0.5, read back from the path string ("M a C c1, c2, b"): (a + 3 c1 + 3 c2 + b) / 8. */
function bezierMid(d: string): Point {
  const [ax, ay, c1x, c1y, c2x, c2y, bx, by] = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return { x: (ax + 3 * c1x + 3 * c2x + bx) / 8, y: (ay + 3 * c1y + 3 * c2y + by) / 8 };
}

export interface ConnectPreview { from: EdgeEnd; fromRect: Rect; to: Point }

export interface EdgesProps {
  edges: BoardEdge[];
  byId: Map<string, BoardNode>;
  /** The rect to draw a node at: its drag or resize preview, else its stored pos. */
  rectOf: (n: BoardNode) => Rect;
  selected: string | null;
  editing: string | null;
  preview: ConnectPreview | null;
  onCommitLabel: (id: string, label: string) => void;
  onEndEdit: (id: string, refocus: boolean) => void;
}

const marker = (c: BoardColor | undefined) => `bedge-arrow-${c ?? 'none'}`;

/** Connectors: one SVG under the leaf nodes, one focusable group per edge, a wide invisible hit path, an arrowhead at the target. */
/** A label as drawn: a storyline's {if …} and {set …} rules become one mark, so the line shows what the player reads. */
const shownLabel = (label: string) => { const p = parseLabel(label); return p.cond || p.sets.length ? `${p.text} ◆`.trim() : label; };

export function Edges({ edges, byId, rectOf, selected, editing, preview, onCommitLabel, onEndEdit }: EdgesProps) {
  const editor = editing ? edges.find((e) => e.id === editing) : undefined;
  const editorAt = editor && edgeGeometry(editor, byId, rectOf)?.mid;
  return (
    <>
      <svg className="bedges" width="1" height="1">
        <defs>
          {[undefined, ...COLORS].map((c) => (
            <marker key={c ?? 'none'} id={marker(c)} className={`bedge-marker${c ? ` bc-${c}` : ''}`} viewBox="0 0 8 8" refX="7" refY="4"
              markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const g = edgeGeometry(e, byId, rectOf);
          if (!g) return null;
          const name = `Connector from ${nodeName(g.from)} to ${nodeName(g.to)}${e.label ? `: ${e.label}` : ''}`;
          return (
            <g key={e.id} className={`bedge${e.color ? ` bc-${e.color}` : ''}${e.id === selected ? ' is-selected' : ''}`}
              role="group" aria-label={name} tabIndex={0}
              data-edge-id={e.id} data-source={e.value.source.nodeId} data-target={e.value.target.nodeId}
              data-source-side={e.value.source.side} data-target-side={e.value.target.side}
              data-label={e.label ?? ''} data-color={e.color ?? ''}>
              <path className="bedge-hit" d={g.d} />
              <path className="bedge-line" d={g.d} markerEnd={`url(#${marker(e.color)})`} />
              {e.label && e.id !== editing && <text className="bedge-label" x={g.mid.x} y={g.mid.y}>{shownLabel(e.label)}</text>}
            </g>
          );
        })}
        {preview && (
          <path className="bedge-preview"
            d={edgePath({ rect: preview.fromRect, side: preview.from.side }, { rect: { ...preview.to, w: 0, h: 0 }, side: OPPOSITE[preview.from.side] })} />
        )}
      </svg>
      {editor && editorAt && (
        <div className="bedge-edit" style={{ transform: `translate(${editorAt.x}px, ${editorAt.y}px)` }}>
          <InlineEdit label="Connector label" initial={editor.label ?? ''} onDone={(t, key) => {
            if (t !== null && t.trim() !== (editor.label ?? '')) onCommitLabel(editor.id, t.trim());
            onEndEdit(editor.id, key);
          }} />
        </div>
      )}
    </>
  );
}

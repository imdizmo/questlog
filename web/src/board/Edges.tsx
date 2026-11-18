import { parseLabel } from '../../../shared/story';
import { autoSides, COLORS, edgePath, type BoardColor, type BoardEdge, type BoardNode, type EdgeEnd, type Point, type Rect, type Side } from '../../../shared/board';
import { InlineEdit, nodeName } from './nodes';
import { SUBTASK, WAITS_FOR } from './projectTree';

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

export interface EdgeGeometry { d: string; mid: Point; from: BoardNode; to: BoardNode }

/** Lines a project board draws by where their ends are now, not by their stored sides. */
const autoSided = (edge: BoardEdge) => edge.label === WAITS_FOR || edge.label === SUBTASK;

/**
 * The curve and its midpoint, or null while an end node is missing (a peer deleted it). On a project board a "waits
 * for" or subtask line takes its sides from `autoSides` (drawn only: the stored sides stay as they are).
 */
export function edgeGeometry(edge: BoardEdge, byId: Map<string, BoardNode>, rectOf: (n: BoardNode) => Rect, projectBoard = false): EdgeGeometry | null {
  const from = byId.get(edge.value.source.nodeId);
  const to = byId.get(edge.value.target.nodeId);
  if (!from || !to) return null;
  const a = rectOf(from), b = rectOf(to);
  const sides = projectBoard && autoSided(edge) ? autoSides(a, b) : { from: edge.value.source.side, to: edge.value.target.side };
  const d = edgePath({ rect: a, side: sides.from }, { rect: b, side: sides.to });
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
  /** A project board: "waits for" and subtask lines are drawn by `autoSides`, and "waits for" is dashed in the accent. */
  projectBoard?: boolean;
  /** Draw each label on its line (default). False: EdgeLabels draws them in a layer of their own. */
  labels?: boolean;
}

const marker = (c: BoardColor | undefined) => `bedge-arrow-${c ?? 'none'}`;

/** Connectors: one SVG under the leaf nodes, one focusable group per edge, a wide invisible hit path, an arrowhead at the target. */
/** A label as drawn: a storyline's {if …} and {set …} rules become one mark, so the line shows what the player reads. */
const shownLabel = (label: string) => { const p = parseLabel(label); return p.cond || p.sets.length ? `${p.text} ◆`.trim() : label; };

export function Edges({ edges, byId, rectOf, selected, editing, preview, onCommitLabel, onEndEdit, projectBoard = false, labels = true }: EdgesProps) {
  const editor = editing ? edges.find((e) => e.id === editing) : undefined;
  const editorAt = editor && edgeGeometry(editor, byId, rectOf, projectBoard)?.mid;
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
          const g = edgeGeometry(e, byId, rectOf, projectBoard);
          if (!g) return null;
          const name = `Connector from ${nodeName(g.from)} to ${nodeName(g.to)}${e.label ? `: ${e.label}` : ''}`;
          // On a project board "waits for" is dashed, in the accent unless the user picked a colour (drawn only).
          const waits = projectBoard && e.label === WAITS_FOR;
          const color = e.color ?? (waits ? 'orange' : undefined);
          return (
            <g key={e.id} className={`bedge${color ? ` bc-${color}` : ''}${waits ? ' is-waits' : ''}${e.id === selected ? ' is-selected' : ''}`}
              role="group" aria-label={name} tabIndex={0}
              data-edge-id={e.id} data-source={e.value.source.nodeId} data-target={e.value.target.nodeId}
              data-source-side={e.value.source.side} data-target-side={e.value.target.side}
              data-label={e.label ?? ''} data-color={e.color ?? ''}>
              <path className="bedge-hit" d={g.d} />
              <path className="bedge-line" d={g.d} markerEnd={`url(#${marker(color)})`} />
              {labels && e.label && e.id !== editing && <text className="bedge-label" x={g.mid.x} y={g.mid.y}>{shownLabel(e.label)}</text>}
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

/**
 * The lines' labels in an SVG of their own, drawn after every node so a card never hides one (project boards, where
 * lines between lists run under the cards). The layer lets the pointer through; each label takes it and stands for its
 * line (`data-label-of`), so a press on it selects the line as before.
 */
export function EdgeLabels({ edges, byId, rectOf, editing, selected }: {
  edges: BoardEdge[]; byId: Map<string, BoardNode>; rectOf: (n: BoardNode) => Rect; editing: string | null; selected: string | null;
}) {
  return (
    <svg className="bedges bedge-labels" width="1" height="1" aria-hidden="true">
      {edges.map((e) => {
        if (!e.label || e.id === editing) return null;
        const g = edgeGeometry(e, byId, rectOf, true);
        return g && (
          <text key={e.id} className={`bedge-label${e.id === selected ? ' is-selected' : ''}`} x={g.mid.x} y={g.mid.y} data-label-of={e.id}>{shownLabel(e.label)}</text>
        );
      })}
    </svg>
  );
}

export interface MacroLink { from: string; to: string; count: number }

/** How far apart (board units) the two arrows of a pair of lists waiting on each other run from the shared line. */
const REVERSE_GAP = 44;
/** The rect moved along its side, so the anchor at that side's midpoint moves by `off`. */
const shifted = (r: Rect, side: Side, off: number): Rect =>
  (side === 'left' || side === 'right' ? { ...r, y: r.y + off } : { ...r, x: r.x + off });

/**
 * The overview's thick arrows: one per pair of list frames, labelled with how many "waits for" lines it stands for.
 * Drawn only, never hit: they can't be selected, edited or deleted, and clicks go through to what is under them.
 */
export function MacroLinks({ links, byId, rectOf, nameOf }: {
  links: MacroLink[]; byId: Map<string, BoardNode>; rectOf: (n: BoardNode) => Rect; nameOf: (n: BoardNode) => string;
}) {
  const pairs = new Set(links.map((l) => `${l.from}>${l.to}`));
  return (
    <svg className="bedges bmacro-links" width="1" height="1">
      <defs>
        <marker id="bmacro-arrow" className="bmacro-marker" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="3.5" markerHeight="3.5" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
      {links.map((l) => {
        const from = byId.get(l.from), to = byId.get(l.to);
        if (!from || !to) return null;
        const a = rectOf(from), b = rectOf(to);
        // Lists stacked in one area sit a grid step apart: the arrow loops out on their right, where it has room.
        const stacked = a.x < b.x + b.w && b.x < a.x + a.w;
        const sides = stacked ? { from: 'right' as const, to: 'right' as const } : autoSides(a, b);
        // Two lists waiting on each other: the two arrows run either side of the shared line, so the counts don't meet.
        const off = pairs.has(`${l.to}>${l.from}`) ? (l.from < l.to ? -REVERSE_GAP : REVERSE_GAP) : 0;
        const d = edgePath({ rect: shifted(a, sides.from, off), side: sides.from }, { rect: shifted(b, sides.to, off), side: sides.to });
        const mid = bezierMid(d);
        return (
          <g key={`${l.from}>${l.to}`} className="bmacro-link" role="img" data-macro-from={l.from} data-macro-to={l.to} data-count={l.count}
            aria-label={`${nameOf(from)} waits for ${nameOf(to)}: ${l.count} ${l.count === 1 ? 'task' : 'tasks'}`}>
            <path className="bmacro-line" d={d} markerEnd="url(#bmacro-arrow)" />
            <text className="bmacro-count" x={mid.x} y={mid.y} dy="-0.8em">{l.count}</text>
          </g>
        );
      })}
    </svg>
  );
}

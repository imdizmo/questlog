import type { BurnPoint } from '../planning';
import { dayMon } from '../planning';

const W = 640;
const H = 200;
const PAD = { l: 34, r: 12, t: 12, b: 26 };

/** Done vs total cards by day, as inline SVG (no chart library). Colours are shape-backed: total is dashed, done is solid. */
export function BurnChart({ points, name }: { points: BurnPoint[]; name: string }) {
  const last = points[points.length - 1];
  const summary = last
    ? `${name} burn chart: ${last.done} of ${last.total} tasks done on ${dayMon(last.day)}, ${points.length} day${points.length === 1 ? '' : 's'} shown.`
    : `${name} burn chart: no data yet.`;
  const max = Math.max(1, ...points.map((p) => p.total));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const line = (pick: (p: BurnPoint) => number) => points.map((p, i) => `${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');
  return (
    <figure className="burn" data-testid="burn-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="burn-svg">
        <title>{summary}</title>
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + ih} className="burn-axis" />
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="burn-axis" />
        <text x={PAD.l - 6} y={PAD.t + 4} textAnchor="end" className="burn-tick">{max}</text>
        <text x={PAD.l - 6} y={PAD.t + ih} textAnchor="end" className="burn-tick">0</text>
        {points.length > 0 && (
          <>
            <text x={PAD.l} y={H - 8} className="burn-tick">{dayMon(points[0].day)}</text>
            <text x={W - PAD.r} y={H - 8} textAnchor="end" className="burn-tick">{dayMon(last.day)}</text>
            <polyline points={line((p) => p.total)} className="burn-total" />
            <polyline points={line((p) => p.done)} className="burn-done" />
            {points.length === 1 && <circle cx={x(0)} cy={y(points[0].done)} r={3} className="burn-dot" />}
          </>
        )}
        {points.length === 0 && <text x={W / 2} y={H / 2} textAnchor="middle" className="burn-tick">No data yet</text>}
      </svg>
      <figcaption className="burn-legend"><span className="burn-key total" /> Total <span className="burn-key done" /> Done</figcaption>
    </figure>
  );
}

import { useId, type ReactNode } from 'react';
import type { Cover } from '../../../shared/covers';

/** Jatify's accent and status hues; every artwork is drawn from these. */
const HUES = ['#ec8219', '#4f8cff', '#2bb3a3', '#3fb950', '#8b6cf0', '#e0557a', '#e8b84a'];
const BG = '#0f0f10';
const RAISED = '#1a1a1e';
const LINE = '#2a2a30';

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 240;
const H = 100;

/** The shapes for one artwork: family by id, parameters by a seeded generator. */
function shapes(id: number, c1: string, c2: string, r: () => number): ReactNode[] {
  const out: ReactNode[] = [];
  switch (id % 6) {
    case 0: // ridges: layered mountain silhouettes
      for (let l = 0; l < 3; l++) {
        const base = 60 + l * 14;
        const pts = [`0,${H}`];
        for (let x = 0; x <= W; x += 30) pts.push(`${x},${base - r() * (34 - l * 8)}`);
        pts.push(`${W},${H}`);
        out.push(<polygon key={l} points={pts.join(' ')} fill={l % 2 ? c2 : c1} opacity={0.3 + l * 0.22} />);
      }
      out.push(<circle key="sun" cx={40 + r() * 160} cy={22 + r() * 12} r={10 + r() * 6} fill={c2} opacity={0.85} />);
      break;
    case 1: // lanterns: soft glowing circles
      for (let i = 0; i < 7; i++) {
        out.push(<circle key={i} cx={r() * W} cy={r() * H} r={6 + r() * 20} fill={i % 2 ? c1 : c2} opacity={0.18 + r() * 0.5} />);
      }
      break;
    case 2: // lines: sweeping wave strokes
      for (let i = 0; i < 6; i++) {
        const y = 14 + i * 15;
        const a = 6 + r() * 12;
        const ph = r() * 40;
        out.push(<path key={i} d={`M0 ${y} Q ${60 + ph} ${y - a} 120 ${y} T ${W} ${y}`} fill="none" stroke={i % 2 ? c2 : c1} strokeWidth={2 + r() * 2} opacity={0.35 + i * 0.1} strokeLinecap="round" />);
      }
      break;
    case 3: // stones: rounded rectangles
      for (let i = 0; i < 8; i++) {
        const w = 24 + r() * 40;
        out.push(<rect key={i} x={r() * (W - w)} y={r() * (H - 24)} width={w} height={14 + r() * 22} rx={8} fill={i % 2 ? c1 : c2} opacity={0.25 + r() * 0.5} />);
      }
      break;
    case 4: // rows: diagonal bands
      for (let i = -2; i < 9; i++) {
        out.push(<polygon key={i} points={`${i * 30},${H} ${i * 30 + 14},${H} ${i * 30 + 14 + 40},0 ${i * 30 + 40},0`} fill={i % 2 ? c1 : c2} opacity={0.2 + r() * 0.4} />);
      }
      break;
    default: // grid: dots on a lattice, a few lit
      for (let gx = 0; gx < 10; gx++) {
        for (let gy = 0; gy < 4; gy++) {
          const lit = r() > 0.62;
          out.push(<circle key={`${gx}-${gy}`} cx={14 + gx * 24} cy={14 + gy * 24} r={lit ? 5 : 2.5} fill={lit ? c1 : LINE} opacity={lit ? 0.9 : 1} />);
        }
      }
      out.push(<rect key="bar" x={0} y={H - 10} width={W} height={10} fill={c2} opacity={0.35} />);
  }
  return out;
}

/** Built-in artwork `id`, drawn as inline SVG (no image files, nothing the CSP blocks). */
export function ArtworkSvg({ id }: { id: number }) {
  const gid = useId();
  const r = rng(id);
  const c1 = HUES[(id * 3) % HUES.length];
  const c2 = HUES[(id * 3 + 2 + (id % 2)) % HUES.length];
  const angle = Math.floor(r() * 4) * 45;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className="cover-svg">
      <defs>
        <linearGradient id={gid} gradientTransform={`rotate(${angle} .5 .5)`}>
          <stop offset="0" stopColor={RAISED} />
          <stop offset="1" stopColor={BG} />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${gid})`} />
      {shapes(id, c1, c2, r)}
    </svg>
  );
}

/** A deck or project cover: artwork, an uploaded image, or nothing. */
export function CoverArt({ cover, size, testId }: { cover: Cover; size: 'tile' | 'thumb'; testId?: string }) {
  if (!cover) return null;
  return (
    <span className={`cover cover-${size}`} data-testid={testId ?? 'deck-cover'} aria-hidden>
      {cover.kind === 'art'
        ? <ArtworkSvg id={cover.id} />
        : <img src={`/api/covers/${encodeURIComponent(cover.fileId)}`} alt="" loading="lazy" />}
    </span>
  );
}

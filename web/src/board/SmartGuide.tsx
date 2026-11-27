import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { currentStep, guidePhase, STEP_TEXT, type GuideState } from './smartGuideState';

/**
 * What the guide keeps clear of. Never over the side panels or the toolbars (Home's rails and their popovers, the zoom,
 * the status bar, the node's toolbar and its menus); when the canvas is too tight for that, it may cover Home's welcome
 * column or a hint (it is drawn above them).
 */
const HARD = '.board-filter-panel, .board-card-panel, .rail, .gpop, .board-zoom, .board-status, .board-notices > *, .btoolbar, .bcolors';
const SOFT = '.home-left, .board-hint';
const GAP = 12;
/** "Done" stays this long before the guide closes. */
const DONE_MS = 2500;

type Box = { l: number; t: number; r: number; b: number };
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** The board's page-wide keys that would delete the selected node; the guide keeps them. */
const BOARD_KEYS = new Set(['Delete', 'Backspace']);

/**
 * The Smart Node guide (web/src/board/smartGuideState.ts), drawn beside its node: right of it, else left, below or above,
 * whichever stays inside the canvas and clear of the panels and toolbars. Placed again on every board render, so it
 * follows a drag, a pan and a zoom. A non-modal region: it never takes the focus.
 */
export function SmartGuide({ guide, onNext, onSkip, onClose }: { guide: GuideState; onNext: () => void; onSkip: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [, relayout] = useState(0);
  const phase = guidePhase(guide);
  const at = currentStep(guide);
  const total = guide.steps.length;

  useLayoutEffect(() => {
    const el = ref.current, anchor = el?.parentElement, vp = anchor?.querySelector(':scope > .board-viewport');
    const node = vp?.querySelector(`[data-node-id="${CSS.escape(guide.nodeId)}"]`);
    if (!el || !anchor || !vp || !node) return;
    const n = node.getBoundingClientRect(), v = vp.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const lo = { x: v.left + 8, y: v.top + 8 }, hi = { x: v.right - 8 - w, y: v.bottom - 8 - h };
    const ys = clamp(n.top, lo.y, hi.y), xs = clamp(n.left, lo.x, hi.x);
    type Spot = { x: number; y: number };
    const fit = (p: Spot): Spot => ({ x: clamp(p.x, lo.x, hi.x), y: clamp(p.y, lo.y, hi.y) });
    const avoid: (Box & { k: number })[] = [{ l: n.left, t: n.top, r: n.right, b: n.bottom, k: 1 }];
    for (const [sel, k] of [[HARD, 1000], [SOFT, 1]] as const) {
      for (const o of document.querySelectorAll(sel)) {
        const r = o.getBoundingClientRect();
        if (r.width && r.height && !o.contains(el)) avoid.push({ l: r.left, t: r.top, r: r.right, b: r.bottom, k });
      }
    }
    const boxOf = (p: Spot): Box => ({ l: p.x, t: p.y, r: p.x + w, b: p.y + h });
    const cost = (p: Spot) => avoid.reduce((s, o) => s + o.k * overlap(boxOf(p), o), 0);
    // Right, left, below, above the node; a spot that lands on something also tries each side of it (twice over:
    // past the panel, then past the toolbar it may meet there). The least covered wins: the first of the four, else the
    // nearest to the node.
    let spots = [
      { x: n.right + GAP, y: ys }, { x: n.left - GAP - w, y: ys },
      { x: xs, y: n.bottom + GAP }, { x: xs, y: n.top - GAP - h },
    ].map(fit);
    for (let round = 0, edge = spots; round < 2; round++) {
      edge = edge.flatMap((p) => avoid.filter((o) => overlap(boxOf(p), o) > 0).flatMap((o) => [
        { x: o.l - GAP - w, y: p.y }, { x: o.r + GAP, y: p.y }, { x: p.x, y: o.t - GAP - h }, { x: p.x, y: o.b + GAP },
      ].map(fit)));
      spots = spots.concat(edge);
    }
    const far = (p: Spot) => Math.hypot(p.x + w / 2 - (n.left + n.right) / 2, p.y + h / 2 - (n.top + n.bottom) / 2);
    const scored = spots.map((p, i) => ({ p, c: cost(p), d: i < 4 ? -1 : far(p) }));
    const best = scored.reduce((b, x) => (x.c < b.c || (x.c === b.c && x.d < b.d) ? x : b)).p;
    el.style.left = `${best.x - a.left}px`;
    el.style.top = `${best.y - a.top}px`;
  });
  // A resized window moves the canvas edges without a board render.
  useEffect(() => {
    const on = () => relayout((x) => x + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(onClose, DONE_MS);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onSkip(); return; }
    if (BOARD_KEYS.has(e.key)) e.stopPropagation();
  };

  const live = phase === 'done' ? 'Done: your Smart Node is set up.' : at >= 0 ? `Step ${at + 1} of ${total}: ${STEP_TEXT[guide.steps[at]].label}` : '';
  return (
    <div ref={ref} className="bguide" role="region" aria-label="Smart Node guide" onKeyDown={onKeyDown} onPointerDown={(e) => e.stopPropagation()}>
      <div className="bguide-head">Smart Nodes · {guide.done.length} of {total}</div>
      <p className="sr-only" aria-live="polite">{live}</p>
      {phase === 'done' ? (
        <div className="bguide-done">
          <span>Done: your Smart Node is set up.</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
      ) : (
        <>
          <ol className="bguide-steps">
            {guide.steps.map((s, i) => {
              const done = guide.done.includes(s), cur = i === at;
              return (
                <li key={s} className={done ? 'is-done' : cur ? 'is-current' : undefined} aria-current={cur ? 'step' : undefined}>
                  <span className="bguide-mark" aria-hidden="true">{done ? '✓' : cur ? '▸' : '○'}</span>
                  <span>
                    {STEP_TEXT[s].label}{done && <span className="sr-only"> (done)</span>}
                    {cur && <span className="bguide-hint">{STEP_TEXT[s].hint}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="bguide-actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onSkip}>Skip</button>
            <button type="button" className="btn btn-sm" onClick={onNext}>{at === total - 1 ? 'Close' : 'Next ›'}</button>
          </div>
        </>
      )}
    </div>
  );
}

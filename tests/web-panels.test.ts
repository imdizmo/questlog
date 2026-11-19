import { describe, it, expect } from 'vitest';
import { closePanel, closeRightmostPanel, fitColumns, openFrom, parsePanels, PANELS_MAX, promotePanel, serialisePanels, setPanelCloser, STACK, withPanels } from '../web/src/panels';

describe('?panels= parse and serialise', () => {
  it('reads keys and $codes, oldest first', () => {
    expect(parsePanels('alpha,$1a3,beta_two')).toEqual(['alpha', '$1a3', 'beta_two']);
    expect(parsePanels(null)).toEqual([]);
    expect(parsePanels('')).toEqual([]);
  });
  it('drops empty, malformed and repeated items', () => {
    expect(parsePanels(',alpha,,alpha, beta ,a/b,$,$A?,<x>')).toEqual(['alpha', 'beta']);
    expect(parsePanels('x'.repeat(81))).toEqual([]);
  });
  it('keeps the newest PANELS_MAX', () => {
    const many = Array.from({ length: PANELS_MAX + 5 }, (_, i) => `e${i}`);
    const got = parsePanels(many.join(','));
    expect(got).toHaveLength(PANELS_MAX);
    expect(got[got.length - 1]).toBe(`e${PANELS_MAX + 4}`);
  });
  it('serialises to a comma list, or null for none', () => {
    expect(serialisePanels(['alpha', '$1a3'])).toBe('alpha,$1a3');
    expect(serialisePanels([])).toBeNull();
    expect(serialisePanels(['bad,item'])).toBe('bad,item'); // split into two valid items
    expect(parsePanels(serialisePanels(['alpha', '$1a3', 'beta']))).toEqual(['alpha', '$1a3', 'beta']);
  });
  it('withPanels replaces only its parameter and keeps commas and $ readable', () => {
    expect(withPanels('', ['alpha', '$1a3'])).toBe('?panels=alpha,$1a3');
    expect(withPanels('?show=help&panels=old', ['beta'])).toBe('?show=help&panels=beta');
    expect(withPanels('?show=help&panels=old', [])).toBe('?show=help');
    expect(withPanels('?panels=old', [])).toBe('');
    expect(new URLSearchParams(withPanels('?q=a%2Cb', ['x', 'y'])).get('q')).toBe('a,b');
  });
});

describe('column-browser steps', () => {
  it('opening from a column replaces the panels to its right', () => {
    expect(openFrom('main', [], 0, 'a')).toEqual(['a']);
    expect(openFrom('main', ['a'], 1, 'b')).toEqual(['a', 'b']);
    expect(openFrom('main', ['a', 'b', 'c'], 1, 'x')).toEqual(['a', 'x']);
    expect(openFrom('main', ['a', 'b', 'c'], 0, 'x')).toEqual(['x']);
  });
  it('does nothing when the target is already open at or left of the column, or right next to it', () => {
    expect(openFrom('main', ['a', 'b'], 2, 'main')).toBeNull();
    expect(openFrom('main', ['a', 'b'], 2, 'a')).toBeNull();
    expect(openFrom('main', ['a', 'b'], 0, 'a')).toBeNull();
    expect(openFrom('main', ['a', 'b'], 0, 'b')).toEqual(['b']); // further right: becomes the next one
  });
  it('close drops one panel; promote makes it the main entry and keeps the others in order', () => {
    expect(closePanel(['a', 'b', 'c'], 3)).toEqual(['a', 'b']);
    expect(closePanel(['a', 'b', 'c'], 2)).toEqual(['a', 'c']);
    expect(promotePanel('main', ['a', 'b', 'c'], 2)).toEqual({ main: 'b', panels: ['main', 'a', 'c'] });
  });
  it('Esc reaches only a stack that registered itself', () => {
    expect(closeRightmostPanel()).toBe(false);
    let n = 0;
    const off = setPanelCloser(() => { n++; return true; });
    expect(closeRightmostPanel()).toBe(true);
    off();
    expect(closeRightmostPanel()).toBe(false);
    expect(n).toBe(1);
  });
});

describe('fitColumns', () => {
  const width = (r: { strips: number; panelWidth: number }, panels: number) => {
    const full = r.strips === 0 ? panels : panels - (r.strips - 1);
    return r.strips * (STACK.strip + STACK.gap) + (r.strips === 0 ? STACK.mainMin + STACK.gap : 0) + full * r.panelWidth + (full - 1) * STACK.gap;
  };
  it('keeps everything full when it fits, at most three panels', () => {
    expect(fitColumns(0, 0)).toEqual({ strips: 0, panelWidth: 0 });
    expect(fitColumns(0, 2)).toEqual({ strips: 0, panelWidth: STACK.panelPref });
    expect(fitColumns(3000, 3).strips).toBe(0);
    expect(fitColumns(3000, 4).strips).toBe(2); // main + the oldest panel fold: three full panels
    expect(fitColumns(3000, 6).strips).toBe(4);
  });
  it('folds the main entry first, then the oldest panels, until every full column fits', () => {
    expect(fitColumns(1100, 1)).toEqual({ strips: 0, panelWidth: 440 });
    expect(fitColumns(1100, 2).strips).toBe(1);
    expect(fitColumns(700, 1).strips).toBe(1);
    expect(fitColumns(700, 3).strips).toBe(3);
    expect(fitColumns(1032, 3)).toEqual({ strips: 1, panelWidth: 318 });
    for (const w of [600, 712, 1032, 1352, 1640]) {
      for (const n of [1, 2, 3, 4, 5]) {
        const r = fitColumns(w, n);
        expect(r.panelWidth).toBeGreaterThanOrEqual(r.strips === n ? 240 : STACK.panelMin);
        if (r.strips < n) expect(width(r, n)).toBeLessThanOrEqual(w);
        expect(n - Math.max(0, r.strips - 1)).toBeLessThanOrEqual(3);
      }
    }
  });
  it('always keeps the newest panel', () => {
    expect(fitColumns(200, 3).strips).toBe(3);
  });
});

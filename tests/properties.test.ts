import { describe, it, expect } from 'vitest';
import { effortScale, cardEffort, heroEffort, PRIORITY_ORDER, priorityLabel, isPastDate, isHero } from '../shared/properties';
import { DEFAULT_SETTINGS } from '../shared/types';

const s = DEFAULT_SETTINGS;
describe('properties', () => {
  it('scales', () => {
    expect(effortScale({ ...s, effortScale: 'exponential' })).toEqual([0, 1, 2, 4, 8, 16]);
    expect(effortScale({ ...s, effortScale: 'fibonacci' })).toEqual([0, 1, 2, 3, 5, 8]);
    expect(effortScale({ ...s, effortScale: 'linear' })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it('cardEffort falls back', () => {
    expect(cardEffort({ effort: null }, s)).toBe(1);
    expect(cardEffort({ effort: 0 }, s)).toBe(0);
  });
  it('heroEffort', () => {
    expect(heroEffort({ effort: 5 }, [{ effort: null }], s)).toBe(6);
  });
  it('priority', () => {
    expect(PRIORITY_ORDER).toEqual(['c', 'b', 'a']);
    expect(priorityLabel('a', s)).toBe('High');
  });
  it('isPastDate', () => {
    expect(isPastDate('2026-11-13', '2026-11-14')).toBe(true);
    expect(isPastDate('2026-11-14', '2026-11-14')).toBe(false);
  });
  it('isHero', () => {
    expect(isHero('p', [{ id: 'c', parentCardId: 'p' }, { id: 'p', parentCardId: null }])).toBe(true);
    expect(isHero('c', [{ id: 'c', parentCardId: 'p' }])).toBe(false);
  });
});

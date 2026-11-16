import { describe, it, expect } from 'vitest';
import { workdaysBetween, isoWeek, addDays, colors } from '../shared/schedule';

describe('schedule', () => {
  it('counts workdays, exclusive of the start and inclusive of the end', () => {
    expect(workdaysBetween('2026-11-16', '2026-11-30', [1, 2, 3, 4, 5])).toBe(10);
    expect(workdaysBetween('2026-11-16', '2026-11-16', [1, 2, 3, 4, 5])).toBe(0);
    expect(workdaysBetween('2026-11-13', '2026-11-16', [1, 2, 3, 4, 5])).toBe(1);
    expect(workdaysBetween('2026-11-30', '2026-11-16', [1, 2, 3, 4, 5])).toBe(-10);
  });
  it('ISO week numbers', () => {
    expect(isoWeek('2026-11-14')).toBe(46);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2021-01-03')).toBe(53);
  });
  it('adds days across month ends', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('has 8 colours including green', () => {
    expect(colors).toHaveLength(8);
    expect(colors).toContain('green');
  });
});

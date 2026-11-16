import { describe, it, expect } from 'vitest';
import { monthGrid, weekNumberOfStart, weekStartOf, localToday, hourLabel } from '../web/src/planning';

describe('planning helpers', () => {
  it('numbers weeks by the ISO week of their Thursday', () => {
    expect(weekNumberOfStart('2026-12-28')).toBe(53); // monday
    expect(weekNumberOfStart('2027-01-04')).toBe(1);
    expect(weekNumberOfStart('2026-12-27')).toBe(53); // sunday start
    expect(weekNumberOfStart('2027-01-02')).toBe(1); // saturday start
  });
  it('finds the week start for each setting', () => {
    expect(weekStartOf('2026-11-14', 'monday')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-14', 'sunday')).toBe('2026-11-08');
    expect(weekStartOf('2026-11-14', 'saturday')).toBe('2026-11-14');
  });
  it('builds a month grid whose last December 2026 row is W53', () => {
    const rows = monthGrid(2026, 11, 'monday');
    expect(rows.every((r) => r.days.length === 7)).toBe(true);
    expect(weekNumberOfStart(rows[rows.length - 1].start)).toBe(53);
    expect(rows[0].days.filter(Boolean)[0]).toBe('2026-12-01');
  });
  it('formats local dates and hours', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(hourLabel(24)).toBe('12 am');
    expect(hourLabel(13)).toBe('1 pm');
  });
});

describe('burnSeries', () => {
  it('sums projects, carrying each forward, and keeps the last days', async () => {
    const { burnSeries } = await import('../web/src/planning');
    const rows = [
      { projectId: 'a', day: '2026-01-01', totalCount: 2, doneCount: 0 },
      { projectId: 'b', day: '2026-01-02', totalCount: 3, doneCount: 1 },
      { projectId: 'a', day: '2026-01-03', totalCount: 2, doneCount: 2 },
      { projectId: 'x', day: '2026-01-03', totalCount: 9, doneCount: 9 },
    ];
    expect(burnSeries(rows, new Set(['a', 'b']))).toEqual([
      { day: '2026-01-01', total: 2, done: 0 }, { day: '2026-01-02', total: 5, done: 1 }, { day: '2026-01-03', total: 5, done: 3 },
    ]);
    expect(burnSeries(rows, new Set(['a', 'b']), 1)).toHaveLength(1);
  });
});

import type { AccountSettings } from '../../shared/types';
import { addDays, isoWeek, isoWeekday, workdaysBetween } from '../../shared/schedule';

/** The browser's own calendar date, YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const START_WD: Record<AccountSettings['weekStart'], number> = { monday: 1, sunday: 7, saturday: 6 };

/** The first day of the week containing `day`. */
export function weekStartOf(day: string, weekStart: AccountSettings['weekStart']): string {
  return addDays(day, -((isoWeekday(day) - START_WD[weekStart] + 7) % 7));
}

/**
 * Week number shown for the week that begins on `start`. Non-Monday week starts (Sunday, Saturday) are labelled
 * by the ISO week of the Thursday inside that 7-day span, so every week has exactly one stable number.
 */
export const weekNumberOfStart = (start: string): number => isoWeek(addDays(start, (4 - isoWeekday(start) + 7) % 7));

/** Weekday headers, in the order the week starts. */
export function weekdayNames(weekStart: AccountSettings['weekStart']): string[] {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const i = START_WD[weekStart] - 1;
  return [...names.slice(i), ...names.slice(0, i)];
}

export const COLOR_HEX: Record<string, string> = {
  green: '#3fb950', blue: '#4f8cff', purple: '#a78bfa', pink: '#f06bb0', red: '#e5484d', orange: '#ec8219', yellow: '#e3b341', gray: '#8b8b94',
};
export const colorHex = (c: string): string => COLOR_HEX[c] ?? COLOR_HEX.gray;

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Rows of 7 days (null = outside the month) for one month grid. */
export function monthGrid(year: number, month0: number, weekStart: AccountSettings['weekStart']): { start: string; days: (string | null)[] }[] {
  const p = (n: number) => String(n).padStart(2, '0');
  const first = `${year}-${p(month0 + 1)}-01`;
  const count = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const lead = (isoWeekday(first) - START_WD[weekStart] + 7) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${year}-${p(month0 + 1)}-${p(i + 1)}`)];
  while (cells.length % 7) cells.push(null);
  const rows: { start: string; days: (string | null)[] }[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const days = cells.slice(i, i + 7);
    const anchor = days.find((d) => d) as string;
    rows.push({ start: weekStartOf(anchor, weekStart), days });
  }
  return rows;
}

/** Hour label for the run's finish hour; 24 is midnight at the end of the last day. */
export const hourLabel = (h: number): string => (h === 24 || h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);

const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** "14 Nov". */
export const dayMon = (d: string): string => `${Number(d.slice(8))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1].slice(0, 3)}`;
/** "Saturday 14 Nov". */
export const weekdayDayMon = (d: string): string => `${WEEKDAYS_LONG[isoWeekday(d) - 1]} ${dayMon(d)}`;

/** A milestone or run config applies to a project when it is global or lists it. */
export const coversProject = (x: { isGlobal: boolean; projectIds: string[] }, projectId: string): boolean => x.isGlobal || x.projectIds.includes(projectId);

/** "in 3 workdays", "today", "2 workdays ago". */
export function workdaysPhrase(today: string, day: string, workdays: number[]): string {
  if (day === today) return 'today';
  const n = workdaysBetween(today, day, workdays);
  return n >= 0 ? `in ${n} workday${n === 1 ? '' : 's'}` : `${-n} workday${n === -1 ? '' : 's'} ago`;
}

export interface BurnPoint { day: string; total: number; done: number }
interface ProgressRow { projectId: string; day: string; totalCount: number; doneCount: number }

/**
 * Per-day totals from per-project rows. Rows exist only on days a project's counts changed, so each project's last
 * known values carry forward; only projects in `projects` count. At most the last `limit` days are returned.
 */
export function burnSeries(rows: Iterable<ProgressRow>, projects: ReadonlySet<string>, limit = 60): BurnPoint[] {
  const byProject = new Map<string, ProgressRow[]>();
  const days = new Set<string>();
  for (const r of rows) {
    if (!projects.has(r.projectId)) continue;
    days.add(r.day);
    const l = byProject.get(r.projectId);
    if (l) l.push(r); else byProject.set(r.projectId, [r]);
  }
  for (const l of byProject.values()) l.sort((a, b) => a.day.localeCompare(b.day));
  const idx = new Map<string, number>();
  const out: BurnPoint[] = [];
  for (const day of [...days].sort()) {
    let total = 0;
    let done = 0;
    for (const [p, l] of byProject) {
      let i = idx.get(p) ?? -1;
      while (i + 1 < l.length && l[i + 1].day <= day) i++;
      idx.set(p, i);
      if (i >= 0) { total += l[i].totalCount; done += l[i].doneCount; }
    }
    out.push({ day, total, done });
  }
  return out.slice(-limit);
}

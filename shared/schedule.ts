/** Calendar-day helpers on 'YYYY-MM-DD' strings (no time zones involved). */

const MS = 86400e3;
const toMs = (day: string) => Date.parse(day + 'T00:00:00Z');
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Day `n` days after (or before, when negative) `day`. */
export function addDays(day: string, n: number): string {
  return toDay(toMs(day) + n * MS);
}

/** ISO weekday: Monday 1 .. Sunday 7. */
export function isoWeekday(day: string): number {
  return ((new Date(toMs(day)).getUTCDay() + 6) % 7) + 1;
}

/** ISO 8601 week number (1-53). */
export function isoWeek(day: string): number {
  const thursday = toMs(day) + (4 - isoWeekday(day)) * MS;
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - jan1) / (7 * MS)) + 1;
}

/** Workdays after `fromDay` up to and including `toDay`; negative when toDay is earlier. `workdays` are ISO weekdays 1-7. */
export function workdaysBetween(fromDay: string, toDayStr: string, workdays: number[]): number {
  if (toDayStr < fromDay) return -workdaysBetween(toDayStr, fromDay, workdays);
  const set = new Set(workdays);
  const total = Math.round((toMs(toDayStr) - toMs(fromDay)) / MS);
  let n = 0;
  for (let i = 1; i <= total; i++) if (set.has(isoWeekday(addDays(fromDay, i)))) n++;
  return n;
}

/** Milestone colours (our own names). */
export const colors = ['green', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'gray'] as const;
export type MilestoneColor = (typeof colors)[number];

/** The run's label: the template with %RUN_NR% replaced by the run number. */
export const runLabel = (template: string, nr: number): string => template.replaceAll('%RUN_NR%', String(nr));

/** Run `nr` (1-based) starts `(nr-1)*weeks*7` days after `startDay` and ends one day before the next run starts. */
export function runWindow(startDay: string, nr: number, weeks: number): { startDay: string; endDay: string } {
  const start = addDays(startDay, (nr - 1) * weeks * 7);
  return { startDay: start, endDay: addDays(start, weeks * 7 - 1) };
}

/** The instant a run ends, in epoch ms. Hour 24 means the next day's 00:00; `tz` is an IANA zone. */
export function runEndsAt(endDay: string, endHour: number, tz: string): number {
  const T = (globalThis as any).Temporal;
  const date = T.PlainDate.from(endDay);
  const [d, h] = endHour >= 24 ? [date.add({ days: 1 }), 0] : [date, endHour];
  return d.toZonedDateTime({ timeZone: tz, plainTime: new T.PlainTime(h) }).epochMilliseconds;
}

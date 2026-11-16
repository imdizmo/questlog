const MIN = 60_000;

/** One segment is at most a day long. */
export const MAX_SEGMENT_MS = 24 * 3600e3;

/**
 * Parses a typed duration into ms: '120' (minutes), '3:20' (h:mm), '2.5h', '45m', '1h30m'. Anything else is null.
 * Zero parses (as 0); callers decide whether that is acceptable.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,6})$/))) return Number(m[1]) * MIN;
  if ((m = s.match(/^(\d{1,4}):([0-5]\d)$/))) return (Number(m[1]) * 60 + Number(m[2])) * MIN;
  if ((m = s.match(/^(\d{1,4}(?:\.\d+)?)h$/))) return Math.round(Number(m[1]) * 60) * MIN;
  if ((m = s.match(/^(\d{1,6})m$/))) return Number(m[1]) * MIN;
  if ((m = s.match(/^(\d{1,4})h\s*([0-5]?\d)m$/))) return (Number(m[1]) * 60 + Number(m[2])) * MIN;
  return null;
}

/** ms as h:mm (minutes rounded down). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MIN));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

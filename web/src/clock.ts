import { useEffect, useState } from 'react';

/** Re-reads the clock every minute so remind and snooze times pass without a reload. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  return now;
}

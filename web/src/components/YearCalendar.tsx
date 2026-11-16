import { useState } from 'react';
import type { AccountSettings } from '../../../shared/types';
import { MONTH_NAMES, monthGrid, weekNumberOfStart, weekdayNames } from '../planning';

interface Props {
  today: string;
  weekStart: AccountSettings['weekStart'];
  /** Days that already carry a milestone. */
  marked: Set<string>;
  onPick: (day: string) => void;
}

/** Twelve month grids with a week number at the start of each row. Click a day to pick it. */
export function YearCalendar({ today, weekStart, marked, onPick }: Props) {
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const heads = weekdayNames(weekStart);
  return (
    <div className="yearcal" data-testid="year-calendar">
      <div className="yearcal-head">
        <button type="button" className="btn btn-ghost" onClick={() => setYear(year - 1)} aria-label="Previous year">&lsaquo;</button>
        <strong>{year}</strong>
        <button type="button" className="btn btn-ghost" onClick={() => setYear(year + 1)} aria-label="Next year">&rsaquo;</button>
      </div>
      <div className="yearcal-grid">
        {MONTH_NAMES.map((name, m) => (
          <table key={name} className="yearcal-month" aria-label={`${name} ${year}`}>
            <caption>{name}</caption>
            <thead><tr><th aria-label="Week" className="wk">W</th>{heads.map((h) => <th key={h} scope="col">{h[0]}</th>)}</tr></thead>
            <tbody>
              {monthGrid(year, m, weekStart).map((row) => (
                <tr key={row.start}>
                  <td className="wk">{weekNumberOfStart(row.start)}</td>
                  {row.days.map((d, i) => (
                    <td key={i}>
                      {d && (
                        <button
                          type="button" aria-label={d}
                          className={`yc-day${d === today ? ' today' : ''}${marked.has(d) ? ' marked' : ''}`}
                          onClick={() => onPick(d)}
                        >{Number(d.slice(8))}</button>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}

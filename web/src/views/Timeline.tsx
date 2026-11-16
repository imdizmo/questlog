import { useMemo, useState } from 'react';
import { addDays, workdaysBetween } from '../../../shared/schedule';
import type { Milestone, Sprint, SprintConfig } from '../../../shared/types';
import { canManageProject, isAdmin, projectVisible, settingsOf, useEffortOn, useStore, type State } from '../store';
import { useMinuteClock } from '../clock';
import { Link, setQuery, useLocation } from '../router';
import { MilestoneDialog } from '../components/MilestoneDialog';
import { RunSetupDialog } from '../components/RunSetupDialog';
import { YearCalendar } from '../components/YearCalendar';
import { MONTH_NAMES, colorHex, localToday, monthGrid, weekNumberOfStart, weekStartOf, weekdayNames } from '../planning';

const WEEKS_BACK = 8;
const WEEKS_SHOWN = 28; // 8 back .. 20 ahead
const SHIFT_WEEKS = 8;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

/** Whether something scoped to these projects concerns the projects in view (global or unscoped always does). */
const inView = (s: State, isGlobal: boolean, projectIds: string[]) => isGlobal || projectIds.length === 0 || projectIds.some((p) => projectVisible(s, p));

export function Timeline() {
  const s = useStore((x) => x);
  useMinuteClock(); // the today marker rolls over at midnight
  const today = localToday();
  const settings = settingsOf(s);
  const admin = isAdmin(s);

  const manageable = useMemo(() => [...s.projects.values()].filter((p) => !p.isArchived && canManageProject(s, p)).sort((a, b) => a.seq - b.seq),
    [s.projects, s.projectAccess, s.me, s.users]); // eslint-disable-line react-hooks/exhaustive-deps
  const initial = new Set([...s.projects.values()].filter((p) => projectVisible(s, p.id)).map((p) => p.id));
  const canAdd = manageable.length > 0;

  const milestones = useMemo(() => [...s.milestones.values()].filter((m) => inView(s, m.isGlobal, m.projectIds))
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.accountSeq - b.accountSeq),
    [s.milestones, s.projectPrefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const configs = useMemo(() => new Map([...s.sprintConfigs.values()].filter((c) => !c.isArchived && inView(s, c.isGlobal, c.projectIds)).map((c) => [c.id, c])),
    [s.sprintConfigs, s.projectPrefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const sprints = useMemo(() => [...s.sprints.values()].filter((sp) => configs.has(sp.configId)).sort((a, b) => a.startDay.localeCompare(b.startDay)),
    [s.sprints, configs]);

  const [picked, setPicked] = useState<string | null>(null);
  const [runSetup, setRunSetup] = useState(false);
  const marked = useMemo(() => new Set(milestones.map((m) => m.date).filter((d): d is string => !!d)), [milestones]);

  const view = useLocation().query.get('view');
  const mode: 'strip' | 'calendar' | 'overview' = view === 'calendar' || view === 'overview' ? view : 'strip';
  const [adding, setAdding] = useState(false);
  const pick = (v: 'calendar' | 'overview') => setQuery('view', mode === v ? null : v);
  const showAdd = canAdd && adding;

  return (
    <main className="page" id="main">
      <div className="page-head">
        <div><p className="eyebrow">{s.account?.name ?? 'Workspace'}</p><h1>Milestones</h1></div>
        <div className="tl-tabs">
          {canAdd && <button type="button" className={adding ? 'btn btn-active' : 'btn'} aria-pressed={adding} onClick={() => setAdding(!adding)}>Add</button>}
          <button type="button" className={mode === 'calendar' ? 'btn btn-active' : 'btn'} aria-pressed={mode === 'calendar'} onClick={() => pick('calendar')}>Calendar View</button>
          <button type="button" className={mode === 'overview' ? 'btn btn-active' : 'btn'} aria-pressed={mode === 'overview'} onClick={() => pick('overview')}>Milestone Overview</button>
        </div>
      </div>

      <div className={showAdd ? 'tl-layout with-side' : 'tl-layout'}>
        <div className="tl-main">
          {mode === 'strip' && <Strip today={today} settings={settings} milestones={milestones} sprints={sprints} configs={configs} />}
          {mode === 'calendar' && <CalendarView today={today} settings={settings} milestones={milestones} sprints={sprints} configs={configs} />}
          {mode === 'overview' && <Overview state={s} today={today} workdays={settings.workdays} milestones={milestones} />}
        </div>
        {showAdd && (
          <aside className="tl-side" aria-label="Add">
            {settings.sprintsEnabled && <button type="button" className="btn" onClick={() => setRunSetup(true)}>Set up Sprints</button>}
            {settings.milestonesEnabled && (
              <>
                <p className="hint">Click on Date to add Milestone</p>
                <YearCalendar today={today} weekStart={settings.weekStart} marked={marked} onPick={setPicked} />
              </>
            )}
          </aside>
        )}
      </div>

      {picked && <MilestoneDialog day={picked} projects={manageable} initial={initial} admin={admin} onClose={() => setPicked(null)} />}
      {runSetup && <RunSetupDialog today={today} projects={manageable} initial={initial} admin={admin} onClose={() => setRunSetup(false)} />}
    </main>
  );
}

interface LayerProps {
  today: string;
  settings: ReturnType<typeof settingsOf>;
  milestones: Milestone[];
  sprints: Sprint[];
  configs: Map<string, SprintConfig>;
}

/** The horizontal strip. Only the visible window of weeks is rendered; Earlier/Later move it by 8 weeks. */
function Strip({ today, settings, milestones, sprints, configs }: LayerProps) {
  const [shift, setShift] = useState(0);
  const days = settings.timelineScale === 'days';
  const dayW = days ? 30 : 8;
  const first = addDays(weekStartOf(today, settings.weekStart), (shift - WEEKS_BACK) * 7);
  const last = addDays(first, WEEKS_SHOWN * 7 - 1);
  const width = WEEKS_SHOWN * 7 * dayW;
  const x = (day: string) => dayDiff(first, day) * dayW;

  const weeks = Array.from({ length: WEEKS_SHOWN }, (_, i) => addDays(first, i * 7));
  const visibleMs = milestones.filter((m) => m.date && (m.startDate ?? m.date) <= last && m.date >= first);
  // Greedy lanes so neighbouring labels do not overlap.
  const laneEnds: number[] = [];
  const placed = visibleMs.map((m) => {
    const left = x(m.date!);
    const lane = laneEnds.findIndex((end) => end <= left - 6);
    const i = lane === -1 ? laneEnds.length : lane;
    laneEnds[i] = left + 20 + m.name.length * 7 + 8;
    return { m, left, lane: i };
  });
  const runsByConfig = new Map<string, Sprint[]>();
  for (const sp of sprints) {
    if (sp.startDay > last || sp.endDay < first) continue;
    const list = runsByConfig.get(sp.configId);
    if (list) list.push(sp); else runsByConfig.set(sp.configId, [sp]);
  }
  const todayX = today >= first && today <= last ? x(today) + dayW / 2 : null;

  return (
    <section className="tl-section" aria-label="Timeline strip">
      <div className="tl-controls">
        <button type="button" className="btn" onClick={() => setShift(shift - SHIFT_WEEKS)}>Earlier</button>
        <button type="button" className="btn btn-ghost" onClick={() => setShift(0)} disabled={shift === 0}>Today</button>
        <button type="button" className="btn" onClick={() => setShift(shift + SHIFT_WEEKS)}>Later</button>
      </div>
      <div className="tl-scroll">
        <div className="tl-strip" data-testid="timeline-strip" style={{ width }}>
          <div className="tl-head">
            {weeks.map((w, i) => (
              <div key={w} className="tl-week" style={{ left: i * 7 * dayW, width: 7 * dayW }}>
                <span data-testid="week-label">W{weekNumberOfStart(w)}</span>
                <small>{w.slice(5)}</small>
              </div>
            ))}
          </div>
          {days && (
            <div className="tl-days">
              {Array.from({ length: WEEKS_SHOWN * 7 }, (_, i) => <span key={i} style={{ left: i * dayW, width: dayW }}>{Number(addDays(first, i).slice(8))}</span>)}
            </div>
          )}
          <div className="tl-body" style={{ minHeight: 40 + (laneEnds.length + runsByConfig.size) * 34 }}>
            {weeks.map((w, i) => <i key={w} className="tl-gridline" style={{ left: i * 7 * dayW }} />)}
            {todayX !== null && <div className="tl-today" data-testid="today-marker" style={{ left: todayX }} title={`Today, ${today}`} />}
            {placed.map(({ m, left, lane }) => (
              <Link key={m.id} href={`/milestones/${m.accountSeq}`} className="tl-ms" data-testid="milestone-diamond" style={{ left, top: 6 + lane * 28, ['--c' as never]: colorHex(m.color) }} title={`${m.name}, ${m.date}`}>
                <i className="tl-diamond" /><span>{m.name}</span>
              </Link>
            ))}
            {[...runsByConfig.entries()].map(([cid, list], row) => (
              <div key={cid} className="tl-lane" style={{ top: 12 + (laneEnds.length + row) * 34 }}>
                {list.map((sp) => {
                  const left = Math.max(0, x(sp.startDay));
                  const right = Math.min(width, x(addDays(sp.endDay, 1)));
                  return (
                    <Link key={sp.id} href={`/milestones/run/${sp.accountSeq}`} className={`tl-run${sp.isFinished ? ' done' : ''}`} data-testid="run-bar" title={`${sp.label}: ${sp.startDay} to ${sp.endDay}`}
                      style={{ left, width: Math.max(4, right - left), ['--c' as never]: colorHex(configs.get(cid)?.color ?? 'blue') }}>
                      {sp.label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One month grid at a time, with milestones on their day and runs as coloured spans. */
function CalendarView({ today, settings, milestones, sprints, configs }: LayerProps) {
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const step = (n: number) => setYm(({ y, m }) => { const t = y * 12 + m + n; return { y: Math.floor(t / 12), m: t % 12 }; });
  const rows = monthGrid(ym.y, ym.m, settings.weekStart);
  const lo = rows[0].start;
  const hi = addDays(rows[rows.length - 1].start, 6);
  const byDay = new Map<string, Milestone[]>();
  for (const m of milestones) {
    if (!m.date || m.date < lo || m.date > hi) continue;
    const list = byDay.get(m.date);
    if (list) list.push(m); else byDay.set(m.date, [m]);
  }
  const runs = sprints.filter((sp) => sp.startDay <= hi && sp.endDay >= lo);
  const heads = weekdayNames(settings.weekStart);

  return (
    <section className="tl-section" aria-labelledby="tl-cal" data-testid="calendar-view">
      <div className="tl-cal-head">
        <h2 id="tl-cal">Calendar View</h2>
        <button type="button" className="btn btn-ghost" onClick={() => step(-1)} aria-label="Previous month">&lsaquo;</button>
        <strong>{MONTH_NAMES[ym.m]} {ym.y}</strong>
        <button type="button" className="btn btn-ghost" onClick={() => step(1)} aria-label="Next month">&rsaquo;</button>
      </div>
      <div className="tl-cal">
        <div className="tl-cal-row heads"><span /> {heads.map((h) => <span key={h}>{h}</span>)}</div>
        {rows.map((row) => (
          <div key={row.start} className="tl-cal-row">
            <span className="wk">W{weekNumberOfStart(row.start)}</span>
            {row.days.map((d, i) => (
              <div key={i} className={`tl-cell${d === today ? ' today' : ''}${d ? '' : ' blank'}`} data-day={d ?? undefined}>
                {d && <b>{Number(d.slice(8))}</b>}
                {d && runs.filter((sp) => sp.startDay <= d && d <= sp.endDay).map((sp) => (
                  <em key={sp.id} className="tl-cal-run" style={{ ['--c' as never]: colorHex(configs.get(sp.configId)?.color ?? 'blue') }} title={sp.label}>
                    {d === sp.startDay || i === 0 ? sp.label : ' '}
                  </em>
                ))}
                {d && (byDay.get(d) ?? []).map((m) => (
                  <span key={m.id} className="tl-cal-ms" style={{ ['--c' as never]: colorHex(m.color) }}><i className="tl-diamond" />{m.name}</span>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Each milestone with its date, workdays to go and the latest done/total of the projects in view. */
function Overview({ state, today, workdays, milestones }: { state: State; today: string; workdays: number[]; milestones: Milestone[] }) {
  const effortOn = useEffortOn();
  const totals = useMemo(() => {
    const latest = new Map<string, { day: string; dn: number; t: number; de: number; te: number }>();
    for (const p of state.milestoneProgress.values()) {
      if (!projectVisible(state, p.projectId)) continue;
      const k = `${p.milestoneId}|${p.projectId}`;
      const cur = latest.get(k);
      if (!cur || p.day > cur.day) latest.set(k, { day: p.day, dn: p.doneCount, t: p.totalCount, de: p.doneEffort, te: p.totalEffort });
    }
    const sum = new Map<string, { dn: number; t: number; de: number; te: number }>();
    for (const [k, v] of latest) {
      const id = k.split('|')[0];
      const cur = sum.get(id) ?? { dn: 0, t: 0, de: 0, te: 0 };
      sum.set(id, { dn: cur.dn + v.dn, t: cur.t + v.t, de: cur.de + v.de, te: cur.te + v.te });
    }
    return sum;
  }, [state.milestoneProgress, state.projectPrefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const when = (m: Milestone) => {
    if (!m.date) return 'no date';
    if (m.date === today) return 'today';
    const n = workdaysBetween(today, m.date, workdays);
    return n >= 0 ? `in ${n} workday${n === 1 ? '' : 's'}` : `${-n} workday${n === -1 ? '' : 's'} ago`;
  };

  return (
    <section className="tl-section" aria-labelledby="tl-ov" data-testid="milestone-overview">
      <h2 id="tl-ov">Milestone Overview</h2>
      {milestones.length === 0 ? <p className="muted">No milestones yet.</p> : (
        <ul className="tl-ov">
          {milestones.map((m) => {
            const t = totals.get(m.id) ?? { dn: 0, t: 0, de: 0, te: 0 };
            return (
              <li key={m.id} data-testid="milestone-row" style={{ ['--c' as never]: colorHex(m.color) }}>
                <i className="tl-diamond" />
                <Link href={`/milestones/${m.accountSeq}`}><strong>{m.name}</strong></Link>
                <span className="muted">{m.date ?? '-'}</span>
                <span>{when(m)}</span>
                <span className="muted">{t.dn}/{t.t} tasks</span>
                {effortOn && <span className="muted">{t.de}/{t.te} effort</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}


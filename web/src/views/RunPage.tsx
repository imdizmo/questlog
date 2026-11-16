import { workdaysBetween } from '../../../shared/schedule';
import { settingsOf, useStore } from '../store';
import { useMinuteClock } from '../clock';
import { Link } from '../router';
import { LatestActivity } from '../components/LatestActivity';
import { BurnChart } from '../components/BurnChart';
import { usePlanTile } from '../components/PlanCardTile';
import { burnSeries, colorHex, dayMon, localToday } from '../planning';

export function RunPage({ seq }: { seq: number }) {
  const s = useStore((x) => x);
  useMinuteClock();
  const today = localToday();
  const settings = settingsOf(s);
  const tile = usePlanTile();
  const run = [...s.sprints.values()].find((r) => r.accountSeq === seq);
  if (!run || !settings.sprintsEnabled) {
    return (
      <main className="page" id="main">
        <h1>{run ? 'Sprints are switched off' : 'Sprint not found'}</h1>
        <p><Link href="/milestones">Back to the Timeline</Link></p>
      </main>
    );
  }
  const cfg = s.sprintConfigs.get(run.configId);
  const cards = [...s.cards.values()].filter((c) => c.sprintId === run.id && c.visibility === 'default').sort((a, b) => a.seq - b.seq);
  const points = burnSeries([...s.sprintProgress.values()].filter((p) => p.sprintId === run.id), new Set(s.projects.keys()));
  const state = run.isFinished ? 'Finished' : run.startDay > today ? `Starts in ${workdaysBetween(today, run.startDay, settings.workdays)} workdays` : `${Math.max(0, workdaysBetween(today, run.endDay, settings.workdays))} workdays left`;
  return (
    <main className="page" id="main" data-testid="run-page">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link href="/milestones">Milestones</Link></p>
          <h1><i className="tl-diamond ms-mark" style={{ ['--c' as never]: colorHex(cfg?.color ?? 'blue') }} /> {run.label}</h1>
          <p className="muted">{dayMon(run.startDay)} to {dayMon(run.endDay)} · {state}</p>
        </div>
      </div>
      <BurnChart points={points} name={run.label} />
      <section aria-label="Tasks" className="zones">
        <div className="zone-col">
          <header className="zone-head"><h2>Tasks <span className="tab-count quiet">{cards.length}</span></h2></header>
          {cards.length === 0 && <p className="muted">No tasks in this sprint yet.</p>}
          <ul className="zone-cards">{cards.map((c) => <li key={c.id}>{tile(c)}</li>)}</ul>
        </div>
      </section>
      <LatestActivity key={run.id} sprintId={run.id} href={`/milestones/run/${run.accountSeq}/activity`} />
    </main>
  );
}

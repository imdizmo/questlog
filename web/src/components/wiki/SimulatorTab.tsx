import { useEffect, useRef, useState } from 'react';
import type { Card, FieldDef, ScenarioValue } from '../../../../shared/types';
import { bindRoles } from '../../../../shared/balance';
import { SIM_LIMITS, type BatchResult, type MeasureSummary, type RunResult, type SimProblem } from '../../../../shared/sim';
import { useStore } from '../../store';
import { campaignLookup, showValue } from '../../balance';
import { SIM_TIME_CAP_MS, type FromSim, type ToSim } from '../../simHost';
import { useBalanceName } from './RuleEditor';

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number, of: number) => `${(of ? (100 * n) / of : 0).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const num = (v: number) => showValue(v);
const duration = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);
/** The worker is restarted when it doesn't answer for this long while a batch runs (a run is bounded to ~1 s of work). */
const WATCHDOG_MS = 5_000;
/** After Cancel, the worker gets this long to send what it has before it is stopped. */
const CANCEL_GRACE_MS = 1_000;

interface Done { result: BatchResult; timedOut: boolean; ms: number; measures: string[]; state: string[] }
interface Replay { seed: number; run: RunResult | null; error: SimProblem | null; state: string[] }

/**
 * The simulator for a saved scenario that passed its checks: pick an entry for each role, a number of runs and a
 * seed, and the runs go in a worker (time-sliced, cancellable, stopped at 10 s). Per measure: a histogram, p5/p50/p95,
 * mean, min and max; the outliers (outside p1–p99) with their seeds; any run replayed tick by tick.
 */
export function SimulatorTab({ card, def, projectId }: { card: Card; def: FieldDef; projectId: string }) {
  const lookup = useStore((s) => campaignLookup(s, projectId));
  const name = useBalanceName(card, def);
  const scenario = lookup.balance.scenarios.find((s) => s.name === name)?.value ?? null;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState('10000');
  const [seed, setSeed] = useState('1');
  const [running, setRunning] = useState<{ done: number; total: number; ms: number; cancelling: boolean } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaySeed, setReplaySeed] = useState('');
  const worker = useRef<Worker | null>(null);
  const runId = useRef(0);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<{ measures: string[]; state: string[] }>({ measures: [], state: [] });
  /** True after Cancel: progress then no longer re-arms the watchdog, so the 1 s cancel backstop holds. */
  const cancelling = useRef(false);

  const stopWorker = () => { worker.current?.terminate(); worker.current = null; };
  const clearWatchdog = () => { if (watchdog.current) clearTimeout(watchdog.current); watchdog.current = null; };
  const arm = (ms: number, why: string) => {
    clearWatchdog();
    const id = runId.current;
    watchdog.current = setTimeout(() => {
      if (runId.current !== id) return;
      stopWorker();
      setRunning(null);
      setProblem(why);
    }, ms);
  };
  useEffect(() => () => { clearWatchdog(); stopWorker(); }, []);

  const onMessage = (m: FromSim) => {
    if (m.id !== runId.current) return;
    if (m.type === 'progress') {
      if (!cancelling.current) arm(WATCHDOG_MS, 'The simulator stopped answering, so it was stopped.');
      setRunning((r) => (r ? { ...r, done: m.done, total: m.total, ms: m.ms } : r));
    } else if (m.type === 'done') {
      clearWatchdog();
      setRunning(null);
      setDone({ result: m.result, timedOut: m.timedOut, ms: m.ms, ...shown.current });
    } else if (m.type === 'failed') {
      clearWatchdog();
      setRunning(null);
      setProblem(`The scenario can't run: ${m.error.where}: ${m.error.message}`);
    } else if (m.type === 'replay') {
      setReplay({ seed: m.seed, run: m.run, error: m.error, state: shown.current.state });
    }
  };
  const getWorker = () => {
    if (!worker.current) {
      const w = new Worker(new URL('../../sim.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromSim>) => onMessage(e.data);
      w.onerror = (e) => { e.preventDefault(); stopWorker(); clearWatchdog(); setRunning(null); setProblem('The simulator hit a problem and was stopped.'); };
      worker.current = w;
    }
    return worker.current;
  };
  const post = (m: ToSim) => getWorker().postMessage(m);

  if (!scenario) {
    return <p className="hint" role="status">The simulator runs the saved scenario once it has no problems. Fix the ones shown in the Scenario tab first.</p>;
  }
  const roles = scenario.roles;
  const pick: Record<string, string> = {};
  for (const r of roles) {
    const options = lookup.entriesOf(r.type);
    const p = Object.hasOwn(picked, r.name) ? picked[r.name] : undefined;
    const key = p && options.some((o) => o.key === p) ? p : options[0]?.key;
    if (key) pick[r.name] = key;
  }
  const nRuns = Number(runs);
  const nSeed = Number(seed);
  const runsOk = Number.isInteger(nRuns) && nRuns >= 1 && nRuns <= SIM_LIMITS.runs;
  const seedOk = Number.isInteger(nSeed) && nSeed >= 0 && nSeed <= 0xffffffff;
  const binding = bindRoles(roles, pick, lookup, 'scenario');
  const ready = runsOk && seedOk && binding.problems.length === 0;

  const start = () => {
    if (!ready || running) return;
    const id = ++runId.current;
    cancelling.current = false;
    shown.current = { measures: scenario.measures.map((m) => m.name), state: scenario.state.map((s) => s.name) };
    setDone(null);
    setReplay(null);
    setProblem(null);
    setRunning({ done: 0, total: nRuns, ms: 0, cancelling: false });
    arm(WATCHDOG_MS, 'The simulator stopped answering, so it was stopped.');
    post({
      type: 'run', id, scenario: scenario as ScenarioValue, bindings: binding.values, runs: nRuns, seed: nSeed,
      tables: lookup.balance.tables, rules: lookup.balance.rules.map((r) => ({ name: r.name, value: r.value })),
    });
  };
  const cancel = () => {
    if (!running) return;
    post({ type: 'cancel', id: runId.current });
    cancelling.current = true;
    setRunning({ ...running, cancelling: true });
    // Backstop: a worker busy in one long run can't read the message; stop it after a moment.
    arm(CANCEL_GRACE_MS, 'Cancelled.');
  };
  const doReplay = (s: number) => {
    if (!done) return;
    setReplaySeed(String(s));
    post({ type: 'replay', id: runId.current, seed: s });
  };

  return (
    <div className="simulator" data-testid="simulator">
      <div className="sim-controls" role="group" aria-label="Simulator settings">
        {roles.map((r) => (
          <label key={r.name} className="balance-example-pick">
            <span>{r.name}</span>
            <select aria-label={`Simulator ${r.name}`} value={pick[r.name] ?? ''} onChange={(e) => setPicked({ ...picked, [r.name]: e.target.value })}>
              {!lookup.entriesOf(r.type).length && <option value="">No {lookup.typeName(r.type)} yet</option>}
              {lookup.entriesOf(r.type).map((o) => <option key={o.key} value={o.key}>{o.title}</option>)}
            </select>
          </label>
        ))}
        <label className="balance-example-pick">
          <span>runs</span>
          <input type="number" className="sim-runs" aria-label="Runs" min={1} max={SIM_LIMITS.runs} step={1} value={runs} aria-invalid={runsOk ? undefined : true} onChange={(e) => setRuns(e.target.value)} />
        </label>
        <label className="balance-example-pick">
          <span>seed</span>
          <input type="number" className="balance-seed" aria-label="Seed" min={0} max={0xffffffff} step={1} value={seed} aria-invalid={seedOk ? undefined : true} onChange={(e) => setSeed(e.target.value)} />
        </label>
        {running
          ? <button type="button" className="btn btn-sm" onClick={cancel} disabled={running.cancelling}>{running.cancelling ? 'Cancelling…' : 'Cancel'}</button>
          : <button type="button" className="btn btn-sm btn-primary" onClick={start} disabled={!ready}>Run</button>}
      </div>
      {!runsOk && <p className="hint">Runs: a whole number from 1 to {fmt(SIM_LIMITS.runs)}.</p>}
      {!seedOk && <p className="hint">Seed: a whole number from 0 to {fmt(0xffffffff)}.</p>}
      {binding.problems.map((p, i) => <p key={i} className="hint">{p.detail}</p>)}
      {running && (
        <div className="sim-progress" role="status">
          <progress max={running.total} value={running.done} aria-label="Runs done" />
          <span>{fmt(running.done)} of {fmt(running.total)} runs · {(running.ms / 1000).toFixed(1)} s (stops at {SIM_TIME_CAP_MS / 1000} s)</span>
        </div>
      )}
      {problem && <p className="notice" role="status">{problem}</p>}
      {done && <BatchView done={done} onReplay={doReplay} />}
      {done && (
        <div className="sim-replay-pick" role="group" aria-label="Replay a run">
          <label className="balance-example-pick">
            <span>replay seed</span>
            <input type="number" className="balance-seed" aria-label="Replay seed" min={0} max={0xffffffff} step={1} value={replaySeed} onChange={(e) => setReplaySeed(e.target.value)} />
          </label>
          <button type="button" className="btn btn-sm" disabled={!/^\d+$/.test(replaySeed) || Number(replaySeed) > 0xffffffff} onClick={() => doReplay(Number(replaySeed))}>Replay</button>
          <span className="hint">Run i of this batch has its own seed; the outliers list theirs.</span>
        </div>
      )}
      {replay && <ReplayView replay={replay} />}
    </div>
  );
}

const ENDED_TEXT: Record<'end' | 'cap' | 'ticks', string> = { end: 'by the end condition', cap: 'at the time cap', ticks: `at the ${fmt(SIM_LIMITS.ticks)}-tick limit` };

function BatchView({ done, onReplay }: { done: Done; onReplay: (seed: number) => void }) {
  const r = done.result;
  const ended = (['end', 'cap', 'ticks'] as const).filter((k) => r.ended[k] > 0).map((k) => `${fmt(r.ended[k])} ${ENDED_TEXT[k]}`).join(', ');
  return (
    <div className="sim-results" data-testid="sim-results">
      <p className="sim-summary" role="status">
        {fmt(r.runs)} {r.runs === 1 ? 'run' : 'runs'} in {duration(done.ms)} (seed {r.seed}){ended ? `; ended ${ended}` : ''}.
        {done.timedOut && ` Stopped at the ${SIM_TIME_CAP_MS / 1000} s limit, before ${fmt(r.requested)} runs.`}
        {r.cancelled && !done.timedOut && ` Cancelled before ${fmt(r.requested)} runs.`}
      </p>
      {r.error && (
        <p className="notice" role="alert">
          Run {fmt(r.error.run ?? 0)} (seed {r.error.seed}) stopped the batch: {r.error.where}: {r.error.rule ? `in rule ${r.error.rule}: ` : ''}{r.error.message}.{' '}
          {r.error.seed !== undefined && <button type="button" className="btn btn-sm" onClick={() => onReplay(r.error!.seed!)}>Replay it</button>}
        </p>
      )}
      <div className="sim-measures">
        {done.measures.filter((m) => Object.hasOwn(r.perMeasure, m)).map((m) => <MeasureView key={m} name={m} s={r.perMeasure[m]} runs={r.runs} />)}
      </div>
      <h4 className="balance-block-title">Outliers</h4>
      {r.outliers.length === 0
        ? <p className="hint">No outliers: every value lies between p1 and p99.</p>
        : <Outliers outliers={r.outliers} perMeasure={r.perMeasure} onReplay={onReplay} />}
    </div>
  );
}

/** Rows shown before "Show all": the most extreme few of each measure. */
const OUTLIERS_SHOWN = 6;

/** Runs outside p1–p99, the most extreme first (lowest, then highest), each with the seed that replays it. */
function Outliers({ outliers, perMeasure, onReplay }: { outliers: BatchResult['outliers']; perMeasure: BatchResult['perMeasure']; onReplay: (seed: number) => void }) {
  const [all, setAll] = useState(false);
  // A few of each measure's lowest and highest (the list holds them most extreme first) unless asked for all.
  const seen = new Map<string, number>();
  const shown = all ? outliers : outliers.filter((o) => {
    const side = `${o.measure}\0${o.value < perMeasure[o.measure].p1 ? 'low' : 'high'}`;
    const n = seen.get(side) ?? 0;
    seen.set(side, n + 1);
    return n < OUTLIERS_SHOWN / 2;
  });
  return (
    <>
      <p className="hint">Runs with a value below p1 or above p99 ({fmt(outliers.length)}). Replay one to see how it went.</p>
      <table className="sim-table" aria-label="Outliers">
        <thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Run</th><th scope="col">Seed</th><th /></tr></thead>
        <tbody>
          {shown.map((o) => (
            <tr key={`${o.measure}:${o.run}`}>
              <td>{o.measure}</td><td>{num(o.value)}</td><td>{fmt(o.run + 1)}</td><td>{o.seed}</td>
              <td><button type="button" className="btn btn-sm btn-ghost" aria-label={`Replay run ${o.run + 1}`} onClick={() => onReplay(o.seed)}>Replay</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length < outliers.length && (
        <button type="button" className="btn btn-sm btn-ghost balance-add" onClick={() => setAll(true)}>Show all {fmt(outliers.length)}</button>
      )}
    </>
  );
}

/** One measure: its histogram, its percentiles and, for small whole numbers, the share of each value. */
function MeasureView({ name, s, runs }: { name: string; s: MeasureSummary; runs: number }) {
  return (
    <figure className="sim-measure" aria-label={`Measure ${name}`}>
      <figcaption><strong>{name}</strong> <span className="muted">mean {num(s.mean)} · min {num(s.min)} · max {num(s.max)}</span></figcaption>
      <Histogram name={name} s={s} />
      <dl className="sim-stats">
        {(['p1', 'p5', 'p50', 'p95', 'p99'] as const).map((p) => <div key={p}><dt>{p}</dt><dd>{num(s[p])}</dd></div>)}
      </dl>
      {s.whole && (
        <table className="sim-table" aria-label={`${name} by value`}>
          <thead><tr><th scope="col">{name}</th><th scope="col">Runs</th><th scope="col">Share</th></tr></thead>
          <tbody>{s.bins.filter((b) => b.count > 0).map((b) => <tr key={b.from}><td>{num(b.from)}</td><td>{fmt(b.count)}</td><td>{pct(b.count, runs)}</td></tr>)}</tbody>
        </table>
      )}
    </figure>
  );
}

const W = 360, H = 140, PAD_L = 10, PAD_R = 10, PAD_T = 16, PAD_B = 22;

/** The bins as bars (plain SVG), with p5, p50 and p95 marked. */
export function Histogram({ name, s }: { name: string; s: MeasureSummary }) {
  const bins = s.bins;
  const top = Math.max(1, ...bins.map((b) => b.count));
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const bw = plotW / bins.length;
  // Where a value sits on the x axis: whole-number bins are centred on their number.
  const lo = s.whole ? s.min - 0.5 : s.min, hi = s.whole ? s.max + 0.5 : s.max;
  const x = (v: number) => PAD_L + (hi === lo ? plotW / 2 : ((v - lo) / (hi - lo)) * plotW);
  const labels = s.whole
    ? bins.filter((_, i) => bins.length <= 12 || i % Math.ceil(bins.length / 12) === 0).map((b) => ({ v: b.from, at: x(b.from) }))
    : [{ v: s.min, at: PAD_L }, { v: (s.min + s.max) / 2, at: PAD_L + plotW / 2 }, { v: s.max, at: PAD_L + plotW }];
  // p5, p50 and p95; marks that fall (nearly) on the same place share one line and label ("p50 · p95").
  const marks: { p: string; at: number }[] = [];
  for (const [p, v] of [['p5', s.p5], ['p50', s.p50], ['p95', s.p95]] as const) {
    const last = marks[marks.length - 1];
    if (last && Math.abs(x(v) - last.at) < 24) last.p += ` · ${p}`; else marks.push({ p, at: x(v) });
  }
  return (
    <svg className="sim-hist" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Histogram of ${name}: ${bins.length} bins from ${num(s.min)} to ${num(s.max)}, median ${num(s.p50)}`}>
      {bins.map((b, i) => {
        const h = (b.count / top) * plotH;
        return <rect key={i} className="sim-bar" x={PAD_L + i * bw + 1} y={PAD_T + plotH - h} width={Math.max(1, bw - 2)} height={h}><title>{s.whole ? num(b.from) : `${num(b.from)} – ${num(b.to)}`}: {fmt(b.count)}</title></rect>;
      })}
      <line className="sim-axis" x1={PAD_L} x2={PAD_L + plotW} y1={PAD_T + plotH} y2={PAD_T + plotH} />
      {marks.map((m) => (
        <g key={m.p} className="sim-mark">
          <line x1={m.at} x2={m.at} y1={PAD_T - 2} y2={PAD_T + plotH} />
          <text x={m.at < 50 ? Math.max(PAD_L, m.at - 8) : m.at > W - 50 ? Math.min(W - PAD_R, m.at + 8) : m.at} y={PAD_T - 4}
            textAnchor={m.at < 50 ? 'start' : m.at > W - 50 ? 'end' : 'middle'}>{m.p}</text>
        </g>
      ))}
      {labels.map((l, i) => <text key={i} className="sim-label" x={l.at} y={H - 6} textAnchor={s.whole ? 'middle' : i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>{num(l.v)}</text>)}
    </svg>
  );
}

/** One run, tick by tick: when, which clock, and the state after it. */
function ReplayView({ replay }: { replay: Replay }) {
  const run = replay.run;
  if (!run) {
    return <p className="notice" role="status">Run with seed {replay.seed}: {replay.error ? `${replay.error.where}: ${replay.error.message}` : 'no result'}.</p>;
  }
  const ticks = run.ticks ?? [];
  const cols = replay.state.filter((n) => n !== 'time');
  return (
    <div className="sim-replay" data-testid="sim-replay">
      <h4 className="balance-block-title">Run with seed {replay.seed}</h4>
      <p className="hint">
        {fmt(run.tickCount)} {run.tickCount === 1 ? 'tick' : 'ticks'}, ended {ENDED_TEXT[run.ended]} at {num(run.time)} s.{' '}
        {Object.entries(run.measures).map(([k, v]) => `${k} = ${num(v)}`).join(', ')}
        {run.ticksCut && ` Only the first ${fmt(SIM_LIMITS.replayTicks)} ticks are shown.`}
      </p>
      <div className="sim-scroll">
        <table className="sim-table" aria-label={`Ticks of the run with seed ${replay.seed}`}>
          <thead><tr><th scope="col">#</th><th scope="col">time (s)</th><th scope="col">clock</th>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {ticks.map((t, i) => (
              <tr key={i}><td>{i + 1}</td><td>{num(t.time)}</td><td>{t.clock}</td>{cols.map((c) => <td key={c}>{showValue(t.state[c])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

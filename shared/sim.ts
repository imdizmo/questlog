// The scenario runner: seeded runs of a scenario (a duel, …) and batches of them summed up as histograms, percentiles
// and outliers. Pure and deterministic: the same scenario, entries, tables, rules and seed give the same result on every
// platform (one generator, shared/formula/random.ts; a fixed order of evaluation, below). Used by the simulator's worker.
//
// One run:
// 1. State variables get their start formulas, in order (each may use the ones before). `time` is 0. Each clock's
//    `first` (a delay in seconds, default 0) is evaluated, in declaration order. Then the end condition is checked once,
//    so a scenario can end at time 0 without a tick.
// 2. The runner jumps to the clock that fires next; clocks due at the same instant fire in declaration order. Firing
//    is one tick: `time` is set to the firing time, the clock's updates run in order (each sees the ones before), then
//    the end condition is checked; if it is false, the clock's `every` is evaluated again (it may read the new state)
//    and the clock fires next at time + every. Random draws happen in exactly this order.
// 3. The run stops when the end condition is true ("end"), when no clock is due at or before the time cap ("cap";
//    `time` is then the cap), or after SIM_LIMITS.ticks ticks ("ticks"). Then the measures are read, in order.
// Times are kept on a grid of whole microseconds (TIME_STEP), so sums of delays like 0.1 + 0.1 + 0.1 land exactly on
// 0.3, ties are real ties and a tick due at the cap fires: a delay of d seconds is Math.round(d × 1e6) µs (`every` at
// least 1 µs), the cap is Math.round(cap × 1e6) µs, and `time` in formulas is µs / 1e6. RANDOM_INFO.scenario says this
// for the export. Each run has its own generator, seeded with runSeed(batch seed, run index), and its own step budget.
import type { FormulaRole, ScenarioValue } from './types';
import type { BalanceResult } from './balance';
import { SCENARIO_TIME } from './balance';
import {
  evaluate, FormulaError, makeRng, own, parseFormula, runSeed, type Expr, type FormulaEnv, type RuleProgram, type StepBudget,
  type TableData, type Value,
} from './formula';

/** Microseconds per second: scenario times are whole microseconds. */
export const TIME_STEP = 1e6;

export const SIM_LIMITS = {
  /** Runs per batch at most. */
  runs: 100_000,
  /** Ticks per run at most. */
  ticks: 100_000,
  /** Steps (values computed, table cells scanned) per run, across all its formulas and rule calls. ~1 s at most. */
  runSteps: 10_000_000,
  /** Outliers listed per batch, all measures together. */
  outliers: 200,
  /** Ticks a replay keeps (the run itself goes on to its end). */
  replayTicks: 10_000,
  /** Bins of a histogram of measures that are not small whole numbers. */
  bins: 40,
  /** A measure whose values are all whole numbers spanning at most this many gets one bin per number. */
  wholeBins: 60,
};

/** The tables and rules formulas can use, by their names in formulas. */
export interface SimData { tables: Record<string, TableData>; rules: Record<string, RuleProgram> }

/** The tables and rules that passed checkBalance, ready to run. */
export function simData(b: Pick<BalanceResult, 'tables' | 'rules'>): SimData {
  const tables: Record<string, TableData> = {};
  for (const t of b.tables) Object.defineProperty(tables, t.name, { value: t.unit ? { ...t.value, unit: t.unit } : t.value, enumerable: true });
  const rules: Record<string, RuleProgram> = {};
  for (const r of b.rules) {
    const program: RuleProgram = {
      roles: r.value.roles,
      parts: r.value.parts.map((p) => ({ name: p.name, tree: tree(p.formula, `rule ${r.name}: part ${p.name}`) })),
      result: tree(r.value.result, `rule ${r.name}: result`),
    };
    Object.defineProperty(rules, r.name, { value: program, enumerable: true });
  }
  return { tables, rules };
}

/** A problem that stopped a run: where (e.g. `clock swing: hp`), a plain message, the place in that formula. */
export interface SimProblem {
  where: string; message: string; from: number; to: number;
  /** The rule it happened in, when inside a called rule. */
  rule?: string;
  /** The run (from 0) and its seed, for a batch. */
  run?: number; seed?: number;
}
export class SimError extends Error {
  constructor(readonly problem: SimProblem) {
    super(`${problem.where}: ${problem.rule ? `in rule ${problem.rule}: ` : ''}${problem.message}`);
    this.name = 'SimError';
  }
}

function tree(text: string, where: string): Expr {
  const p = parseFormula(text);
  if ('error' in p) throw new SimError({ where, ...p.error });
  return p.tree;
}

interface Clock { name: string; every: Expr; first: Expr | null; do: { name: string; tree: Expr }[] }
/** A scenario ready to run: its formulas parsed, with the tables and rules they use. */
export interface SimScenario {
  roles: FormulaRole[];
  state: { name: string; tree: Expr }[];
  clocks: Clock[];
  end: Expr;
  cap: number;
  /** The cap on the time grid (µs). */
  capUs: number;
  measures: { name: string; tree: Expr }[];
  data: SimData;
}

/** Parses a scenario's formulas (throws SimError on a syntax error; one that passed checkBalance has none). */
export function prepareScenario(v: ScenarioValue, data: SimData): SimScenario {
  const capUs = Math.round(v.cap * TIME_STEP);
  if (!(typeof v.cap === 'number' && v.cap > 0 && capUs >= 1 && capUs <= Number.MAX_SAFE_INTEGER)) {
    throw new SimError({ where: 'cap', message: 'the time cap must be a number of seconds from 0.000001 up to about 9 billion', from: 0, to: 0 });
  }
  return {
    roles: v.roles,
    state: v.state.map((s) => ({ name: s.name, tree: tree(s.start, `state ${s.name}`) })),
    clocks: v.clocks.map((c) => ({
      name: c.name, every: tree(c.every, `clock ${c.name}: every`),
      first: c.first === undefined ? null : tree(c.first, `clock ${c.name}: first`),
      do: c.do.map((u) => ({ name: u.name, tree: tree(u.formula, `clock ${c.name}: ${u.name}`) })),
    })),
    end: tree(v.end, 'end'),
    cap: v.cap, capUs,
    measures: v.measures.map((m) => ({ name: m.name, tree: tree(m.formula, `measure ${m.name}`) })),
    data,
  };
}

/** Role → the bound entry's field values (bindRoles in shared/balance.ts gives them from entry keys). */
export type SimBindings = Record<string, Record<string, unknown>>;
export type EndReason = 'end' | 'cap' | 'ticks';
/** One tick of a replay: when, which clock, and the state after it (with `time`). */
export interface SimTick { time: number; clock: string; state: Record<string, Value> }
export interface RunResult {
  measures: Record<string, number>;
  /** Why the run stopped. */
  ended: EndReason;
  /** `time` at the end, in seconds. */
  time: number;
  tickCount: number;
  /** The ticks, only when replaying (the first SIM_LIMITS.replayTicks of them). */
  ticks?: SimTick[];
  /** True when the replay kept fewer ticks than the run had. */
  ticksCut?: boolean;
}

const kindOf = (v: Value) => (typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a true/false value' : 'a word');
const fmt = (n: number) => n.toLocaleString('en-US');

function checkRoles(s: SimScenario, roles: SimBindings): void {
  for (const r of s.roles) {
    if (!own(roles, r.name)) throw new SimError({ where: `role ${r.name}`, message: 'no entry is set for this role', from: 0, to: 0 });
  }
}

/** One run; measure values go to `into` (in measure order) when given. */
function simulate(s: SimScenario, roles: SimBindings, seed: number, replay: boolean, into?: Float64Array[], at = 0): RunResult | EndReason {
  const rng = makeRng(seed);
  const budget: StepBudget = { steps: 0, max: SIM_LIMITS.runSteps };
  const state = Object.create(null) as Record<string, Value>;
  const env: FormulaEnv = { roles, tables: s.data.tables, rules: s.data.rules, state };
  const ev = (e: Expr, where: string): Value => {
    try {
      return evaluate(e, env, rng, budget);
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      const message = budget.steps > budget.max ? `the run takes too many steps (more than ${fmt(budget.max)})` : err.message;
      throw new SimError({ where, message, from: err.from, to: err.to, ...(err.rule ? { rule: err.rule } : {}) });
    }
  };
  const fail = (where: string, message: string, e: Expr): never => { throw new SimError({ where, message, from: e.from, to: e.to }); };

  for (const st of s.state) state[st.name] = ev(st.tree, `state ${st.name}`);
  let now = 0; // µs
  state[SCENARIO_TIME] = 0;
  const clocks = s.clocks;
  /** A delay formula's value on the time grid (µs); `least` is the smallest allowed. */
  const delay = (e: Expr, where: string, least: number): number => {
    const d = ev(e, where);
    if (typeof d !== 'number') fail(where, `needs a number, not ${kindOf(d as Value)}`, e);
    const us = Math.round((d as number) * TIME_STEP);
    if (!(us >= least)) {
      fail(where, least > 0 ? `the time between ticks must be at least 0.000001 seconds (it is ${d})` : `the first tick can't come before the start (it is ${d})`, e);
    }
    if (now + us > Number.MAX_SAFE_INTEGER) fail(where, 'the next tick is too far away', e);
    return now + us;
  };
  const next = new Float64Array(clocks.length);
  clocks.forEach((c, i) => { if (c.first) next[i] = delay(c.first, `clock ${c.name}: first`, 0); });
  const isEnd = (): boolean => {
    const end = ev(s.end, 'end');
    if (typeof end !== 'boolean') fail('end', `needs a true/false value, not ${kindOf(end)}`, s.end);
    return end as boolean;
  };
  const log: SimTick[] | undefined = replay ? [] : undefined;
  let ticks = 0;
  let ended: EndReason = isEnd() ? 'end' : 'cap';
  while (ended === 'cap' && clocks.length) {
    let k = 0;
    for (let i = 1; i < clocks.length; i++) if (next[i] < next[k]) k = i;
    if (next[k] > s.capUs) break;
    if (ticks >= SIM_LIMITS.ticks) { ended = 'ticks'; break; }
    const c = clocks[k];
    now = next[k];
    state[SCENARIO_TIME] = now / TIME_STEP;
    for (const u of c.do) {
      const where = `clock ${c.name}: ${u.name}`;
      const old = u.name === SCENARIO_TIME ? undefined : own(state, u.name);
      if (old === undefined) fail(where, u.name === SCENARIO_TIME ? "time moves by itself; it can't be set" : `there is no state '${u.name}' to set`, u.tree);
      const v = ev(u.tree, where);
      if (typeof v !== typeof old) fail(where, `${u.name} holds ${kindOf(old!)}, not ${kindOf(v)}`, u.tree);
      state[u.name] = v;
    }
    ticks++;
    if (log && log.length < SIM_LIMITS.replayTicks) log.push({ time: now / TIME_STEP, clock: c.name, state: { ...state } });
    if (isEnd()) { ended = 'end'; break; }
    next[k] = delay(c.every, `clock ${c.name}: every`, 1);
  }
  if (ended === 'cap') { now = s.capUs; state[SCENARIO_TIME] = now / TIME_STEP; }
  const time = now / TIME_STEP;

  const measures: Record<string, number> | null = into ? null : {};
  s.measures.forEach((m, i) => {
    const v = ev(m.tree, `measure ${m.name}`);
    if (typeof v !== 'number') fail(`measure ${m.name}`, `needs a number, not ${kindOf(v)}`, m.tree);
    if (into) into[i][at] = v as number;
    else Object.defineProperty(measures, m.name, { value: v, enumerable: true });
  });
  if (!measures) return ended;
  const out: RunResult = { measures, ended, time, tickCount: ticks };
  if (log) { out.ticks = log; if (ticks > log.length) out.ticksCut = true; }
  return out;
}

/** One run with `seed` (a batch's run i has seed runSeed(batchSeed, i)). `replay` keeps the ticks. Throws SimError. */
export function runOnce(s: SimScenario, roles: SimBindings, seed: number, opts: { replay?: boolean } = {}): RunResult {
  checkRoles(s, roles);
  return simulate(s, roles, seed >>> 0, !!opts.replay) as RunResult;
}

// ------------------------------------------------------------------------------------------------ batches

export interface HistogramBin {
  /** Lowest and highest value the bin holds; equal for one whole number per bin. Bins are [from, to) except the last. */
  from: number; to: number; count: number;
}
export interface MeasureSummary {
  /** True when each bin holds one whole number. */
  whole: boolean;
  bins: HistogramBin[];
  p1: number; p5: number; p50: number; p95: number; p99: number;
  mean: number; min: number; max: number;
}
/** A run whose measure lies outside p1–p99, with what replays it. */
export interface Outlier { run: number; seed: number; measure: string; value: number }
export interface BatchResult {
  seed: number;
  /** Runs asked for and runs done (fewer when cancelled or stopped by a problem). */
  requested: number; runs: number;
  cancelled: boolean;
  /** The problem that stopped the batch, with its run and seed; null when none did. */
  error: SimProblem | null;
  /** How many runs stopped for each reason. */
  ended: Record<EndReason, number>;
  /** By measure name, in the scenario's order; empty when no run was done. */
  perMeasure: Record<string, MeasureSummary>;
  /** At most SIM_LIMITS.outliers, shared out between measures: per measure the lowest below p1, then the highest above p99. */
  outliers: Outlier[];
}

/** A batch run a chunk at a time, so a worker can report progress and take a cancel message between chunks. */
export interface Batch {
  readonly total: number;
  readonly done: number;
  /** True once every run is done or a problem stopped the batch. */
  readonly finished: boolean;
  /**
   * Does up to `runs` more runs, stopping early once `ms` milliseconds have passed (checked after each run, so one
   * slow run can overshoot it); returns `finished`. The time only decides where a slice ends, never a result.
   */
  step(runs: number, ms?: number): boolean;
  /** The summary of the runs done so far (cancelled when called before finishing). Frees the batch's arrays. */
  result(): BatchResult;
}

/** Starts a batch of `n` runs (1…SIM_LIMITS.runs) from `seed`. Memory: one Float64Array of n values per measure. */
export function createBatch(s: SimScenario, roles: SimBindings, n: number, seed: number): Batch {
  if (!Number.isInteger(n) || n < 1 || n > SIM_LIMITS.runs) throw new RangeError(`a batch has 1 to ${fmt(SIM_LIMITS.runs)} runs, not ${n}`);
  checkRoles(s, roles);
  const batchSeed = seed >>> 0;
  let values: Float64Array[] | null = s.measures.map(() => new Float64Array(n));
  const ended: Record<EndReason, number> = { end: 0, cap: 0, ticks: 0 };
  let done = 0;
  let error: SimProblem | null = null;
  const b: Batch = {
    total: n,
    get done() { return done; },
    get finished() { return done >= n || error !== null; },
    step(runs, ms) {
      if (!values) throw new Error('the batch is over');
      const stop = Math.min(n, done + Math.max(1, Math.floor(runs)));
      const until = ms === undefined ? Infinity : performance.now() + ms;
      const from = done;
      while (done < stop && !error) {
        if (done > from && performance.now() >= until) break;
        const runS = runSeed(batchSeed, done);
        try {
          ended[simulate(s, roles, runS, false, values, done) as EndReason]++;
          done++;
        } catch (err) {
          if (!(err instanceof SimError)) throw err;
          error = { ...err.problem, run: done, seed: runS };
        }
      }
      return b.finished;
    },
    result() {
      if (!values) throw new Error('the batch is over');
      const perMeasure: Record<string, MeasureSummary> = {};
      const outliers: Outlier[] = [];
      if (done > 0) {
        const quota = Math.floor(SIM_LIMITS.outliers / Math.max(1, s.measures.length));
        s.measures.forEach((m, i) => {
          const all = values![i].subarray(0, done);
          const sum = summarise(all);
          Object.defineProperty(perMeasure, m.name, { value: sum, enumerable: true });
          for (const o of outliersOf(all, sum, quota)) outliers.push({ run: o, seed: runSeed(batchSeed, o), measure: m.name, value: all[o] });
        });
      }
      values = null;
      return { seed: batchSeed, requested: n, runs: done, cancelled: done < n && error === null, error, ended, perMeasure, outliers };
    },
  };
  return b;
}

/**
 * Runs a batch of `n` runs from `seed`, calling `onProgress(done, total)` after every `chunk` runs; returning false from
 * it cancels the batch (the result then sums up the runs done). onProgress only runs between chunks, so for a
 * deadline to hold keep `chunk` small (a duel run takes ~10 µs, a long one up to SIM_LIMITS.runSteps steps ≈ 1 s).
 * For a worker that must take messages between slices, use createBatch and step(runs, ms) from a timer.
 */
export function runBatch(
  s: SimScenario, roles: SimBindings, n: number, seed: number,
  onProgress?: (done: number, total: number) => boolean | void, opts: { chunk?: number } = {},
): BatchResult {
  const batch = createBatch(s, roles, n, seed);
  const chunk = Math.max(1, Math.floor(opts.chunk ?? 1000));
  while (!batch.step(chunk)) {
    if (onProgress?.(batch.done, batch.total) === false) return batch.result();
  }
  onProgress?.(batch.done, batch.total);
  return batch.result();
}

/** p in [0, 1] of sorted values, interpolating between neighbours (h = (n − 1)·p). */
function quantile(sorted: Float64Array, p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function summarise(values: Float64Array): MeasureSummary {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  // A sorted copy for the percentiles, dropped on return (the values stay in run order for the outliers).
  const sorted = values.slice().sort();
  const min = sorted[0], max = sorted[sorted.length - 1];
  let whole = max - min + 1 <= SIM_LIMITS.wholeBins;
  for (let i = 0; whole && i < sorted.length; i++) if (!Number.isInteger(sorted[i])) whole = false;
  let bins: HistogramBin[];
  if (min === max) bins = [{ from: min, to: max, count: sorted.length }];
  else if (whole) {
    bins = [];
    for (let k = min; k <= max; k++) bins.push({ from: k, to: k, count: 0 });
    for (let i = 0; i < sorted.length; i++) bins[sorted[i] - min].count++;
  } else {
    const w = (max - min) / SIM_LIMITS.bins;
    bins = [];
    for (let k = 0; k < SIM_LIMITS.bins; k++) bins.push({ from: min + k * w, to: k === SIM_LIMITS.bins - 1 ? max : min + (k + 1) * w, count: 0 });
    for (let i = 0; i < sorted.length; i++) bins[Math.min(SIM_LIMITS.bins - 1, Math.floor((sorted[i] - min) / w))].count++;
  }
  return {
    whole: whole || min === max, bins,
    p1: quantile(sorted, 0.01), p5: quantile(sorted, 0.05), p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99),
    mean: total / values.length, min, max,
  };
}

/** Runs (indices) below p1 then above p99, the most extreme first, at most `quota` (half each side, if both have some). */
function outliersOf(values: Float64Array, s: MeasureSummary, quota: number): number[] {
  const low: number[] = [], high: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] < s.p1) low.push(i);
    else if (values[i] > s.p99) high.push(i);
  }
  low.sort((a, b) => values[a] - values[b] || a - b);
  high.sort((a, b) => values[b] - values[a] || a - b);
  let nLow = Math.min(low.length, Math.ceil(quota / 2));
  const nHigh = Math.min(high.length, quota - nLow);
  nLow = Math.min(low.length, quota - nHigh);
  return [...low.slice(0, nLow), ...high.slice(0, nHigh)];
}

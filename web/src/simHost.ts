// What the simulator's worker does, as plain code (web/src/sim.worker.ts only wires it to postMessage): runs a batch
// in time slices so a Cancel message gets in between them, stops it at a wall-time cap, and replays single runs.
import type { ScenarioValue } from '../../shared/types';
import type { BalanceRule, BalanceTable } from '../../shared/balance';
import {
  createBatch, prepareScenario, runOnce, simData, SimError, type Batch, type BatchResult, type RunResult, type SimBindings, type SimProblem,
  type SimScenario,
} from '../../shared/sim';

/** A batch stops after this much wall time, with the runs done so far (the plan's 10 s limit). */
export const SIM_TIME_CAP_MS = 10_000;
/** One slice of runs between looks at the message queue (progress, cancel). */
export const SIM_SLICE_MS = 40;

export type ToSim =
  | {
    type: 'run'; id: number; scenario: ScenarioValue;
    /** The campaign's tables and rules that passed the checks (samples and the rest are not needed). */
    tables: BalanceTable[]; rules: Pick<BalanceRule, 'name' | 'value'>[];
    bindings: SimBindings; runs: number; seed: number;
    capMs?: number; sliceMs?: number;
  }
  | { type: 'cancel'; id: number }
  | { type: 'replay'; id: number; seed: number };

export type FromSim =
  | { type: 'progress'; id: number; done: number; total: number; ms: number }
  | { type: 'done'; id: number; result: BatchResult; timedOut: boolean; ms: number }
  | { type: 'replay'; id: number; seed: number; run: RunResult | null; error: SimProblem | null }
  /** The batch could not start (a scenario that does not prepare, a bad run count). */
  | { type: 'failed'; id: number; error: SimProblem };

/**
 * The worker's state machine. `post` sends a message out; `later` runs a function after the queue has had a turn (a
 * MessageChannel in the worker, so a slice follows the next with no timer clamp); `now` is milliseconds.
 * Memory: one batch at a time (its arrays are freed by result()), and the last prepared scenario for replays.
 */
export function createSimHost(post: (m: FromSim) => void, later: (f: () => void) => void, now: () => number) {
  let current: { id: number; gen: number; batch: Batch; started: number; capMs: number; sliceMs: number; cancel: boolean } | null = null;
  /** Bumped by every new batch: a slice queued for an older one finds a different number and does nothing. */
  let generation = 0;
  let last: { id: number; scenario: SimScenario; bindings: SimBindings } | null = null;

  const finish = (c: NonNullable<typeof current>, timedOut: boolean) => {
    current = null;
    post({ type: 'done', id: c.id, result: c.batch.result(), timedOut, ms: now() - c.started });
  };
  const slice = (gen: number) => {
    const c = current;
    if (!c || c.gen !== gen) return;
    if (c.cancel) { finish(c, false); return; }
    const left = c.capMs - (now() - c.started);
    if (left <= 0) { finish(c, true); return; }
    const done = c.batch.step(c.batch.total, Math.min(c.sliceMs, left));
    if (done) { finish(c, false); return; }
    post({ type: 'progress', id: c.id, done: c.batch.done, total: c.batch.total, ms: now() - c.started });
    later(() => slice(gen));
  };

  return function handle(m: ToSim): void {
    if (m.type === 'cancel') {
      if (current && current.id === m.id) current.cancel = true;
      return;
    }
    if (m.type === 'replay') {
      if (!last || last.id !== m.id) {
        post({ type: 'replay', id: m.id, seed: m.seed, run: null, error: { where: 'replay', message: 'run the batch again first', from: 0, to: 0 } });
        return;
      }
      try {
        post({ type: 'replay', id: m.id, seed: m.seed, run: runOnce(last.scenario, last.bindings, m.seed, { replay: true }), error: null });
      } catch (err) {
        if (!(err instanceof SimError)) throw err;
        post({ type: 'replay', id: m.id, seed: m.seed, run: null, error: { ...err.problem, seed: m.seed } });
      }
      return;
    }
    // A new run replaces any batch still going (its result is not wanted any more).
    current = null;
    last = null;
    const gen = ++generation;
    let scenario: SimScenario;
    let batch: Batch;
    try {
      scenario = prepareScenario(m.scenario, simData({ tables: m.tables, rules: m.rules.map((r) => ({ ...r, entry: '', field: '', samples: [] })) }));
      batch = createBatch(scenario, m.bindings, m.runs, m.seed);
    } catch (err) {
      const error: SimProblem = err instanceof SimError ? err.problem : { where: 'batch', message: err instanceof Error ? err.message : String(err), from: 0, to: 0 };
      post({ type: 'failed', id: m.id, error });
      return;
    }
    last = { id: m.id, scenario, bindings: m.bindings };
    current = { id: m.id, gen, batch, started: now(), capMs: m.capMs ?? SIM_TIME_CAP_MS, sliceMs: m.sliceMs ?? SIM_SLICE_MS, cancel: false };
    later(() => slice(gen));
  };
}

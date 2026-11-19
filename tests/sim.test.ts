import { describe, it, expect } from 'vitest';
import type { Card, ScenarioValue, TableValue, RuleValue } from '../shared/types';
import { runChecks, type EntryType, type FieldDef, type WikiData } from '../shared/wiki';
import { bindRoles, type BalanceResult } from '../shared/balance';
import { evaluateRule, makeRng, runSeed, RANDOM_INFO } from '../shared/formula';
import {
  createBatch, prepareScenario, runBatch, runOnce, simData, SimError, SIM_LIMITS, type SimBindings, type SimScenario,
} from '../shared/sim';

// ---- A made-up duel: a Sword against a Slime (numbers from the worked fight in the survey) ----

const type = (id: string, key: string, fields: FieldDef[], name = key): EntryType =>
  ({ id, projectId: 'p', key, name, icon: null, color: null, parentTypeId: null, fields, sortIndex: 0, sections: [], templates: [], familyId: null, picture: null });
const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, kind, ...extra });
const entry = (id: string, entryTypeId: string, entryKey: string, fields: Record<string, unknown>) =>
  ({ id, entryTypeId, entryKey, fields, visibility: 'default' as Card['visibility'], content: '' });

const kindVsMaterial: TableValue = {
  keys: [{ field: 'kind', values: ['Pierce', 'Slash'] }, { field: 'material', values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1, 1.2, 0.8],
};
const combo: TableValue = { keys: [{ values: [1, 2, 3, 4, 5] }], mode: 'step', cells: [1.05, 1.1, 1.15, 1.2, 1.25] };
/** The weapon's flat part: damage × (1 + 0.1 × (item level − 1)). */
const flatRule: RuleValue = {
  roles: [{ name: 'weapon', type: 'weapon' }], parts: [], result: 'weapon.damage * (1 + 0.1 * (weapon.item_level - 1))', examples: [],
};
/** Per hit: (15 × combo(hit) × (crit ? 2 : 1) + flat) × kind-vs-material; a crit doubles the base part only. */
const duel: ScenarioValue = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  state: [{ name: 'hp', start: 'target.hp' }, { name: 'hits', start: '0' }, { name: 'crit', start: 'false' }, { name: 'dmg', start: '0' }],
  clocks: [{
    name: 'swing', every: 'attacker.swing',
    do: [
      { name: 'crit', formula: 'chance(attacker.crit_chance)' },
      { name: 'dmg', formula: '(15 * table(combo, hits + 1) * if(crit, 2, 1) + flat(attacker)) * table(kind_vs_material, attacker.kind, target.material)' },
      { name: 'hp', formula: 'hp - dmg' },
      { name: 'hits', formula: 'hits + 1' },
    ],
  }],
  end: 'hp <= 0', cap: 60,
  measures: [{ name: 'hits', formula: 'hits' }, { name: 'time_to_kill', formula: 'time' }],
};

const sword = { damage: 9, item_level: 10, kind: 'Pierce', swing: 1.1, crit_chance: 0.2 };
const slime = { hp: 45, material: 'Wet', attack_interval: 1.4 };
/** A rule with a random draw, with saved examples: the export runs them into golden samples. */
const strikeRule: RuleValue = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  parts: [{ name: 'crit', formula: 'chance(attacker.crit_chance)' }, { name: 'base', formula: 'flat(attacker) + rand()' }],
  result: 'if(crit, 2, 1) * base * table(kind_vs_material, attacker.kind, target.material)',
  examples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => ({ roles: { attacker: 'sword', target: 'slime' }, seed })),
};

function campaign(scenario: ScenarioValue = duel) {
  const types = [
    type('t-weapon', 'weapon', [
      f('damage', 'number'), f('item_level', 'integer'), f('kind', 'enum', { options: ['Pierce', 'Slash'] }),
      f('swing', 'number', { unit: 's' }), f('crit_chance', 'number'),
    ], 'Weapon'),
    type('t-creature', 'creature', [
      f('hp', 'number', { unit: 'hp' }), f('material', 'enum', { options: ['Wet', 'Dry'] }), f('attack_interval', 'number', { unit: 's' }),
    ], 'Creature'),
    type('t-chart', 'chart', [f('grid', 'table')]),
    type('t-rule', 'rule_holder', [f('rule', 'rule')]),
    type('t-scen', 'scenario_holder', [f('scenario', 'scenario')]),
  ];
  const entries = [
    entry('e-sword', 't-weapon', 'sword', sword),
    entry('e-dull', 't-weapon', 'dull_sword', { ...sword, crit_chance: 0 }),
    entry('e-slime', 't-creature', 'slime', slime),
    entry('e-kvm', 't-chart', 'kind_vs_material', { grid: kindVsMaterial }),
    entry('e-combo', 't-chart', 'combo', { grid: combo }),
    entry('e-flat', 't-rule', 'flat', { rule: flatRule }),
    entry('e-strike', 't-rule', 'strike', { rule: strikeRule }),
    entry('e-duel', 't-scen', 'duel', { scenario }),
  ];
  const d = { types, kinds: [], entries, links: [], includePages: false } satisfies WikiData;
  let balance: BalanceResult | null = null;
  const r = runChecks({ ...d, onBalance: (b) => { balance = b; } });
  const b = balance as unknown as BalanceResult;
  return { checks: r.checks, balance: b, entries };
}

/** The duel (or a variant) through the campaign checks, ready to run; fails the test on any check. */
function prepared(scenario: ScenarioValue = duel): SimScenario {
  const { checks, balance } = campaign(scenario);
  expect(checks).toEqual([]);
  const s = balance.scenarios.find((x) => x.name === 'duel');
  expect(s).toBeTruthy();
  return prepareScenario(s!.value, simData(balance));
}
const roles = (attacker = sword): SimBindings => ({ attacker, target: slime });

describe('runOnce: the duel', () => {
  it('golden per-hit values without crits: 19.71, 20.16, 20.61; 3 hits kill at 2.2 s', () => {
    const s = prepared();
    const r = runOnce(s, roles({ ...sword, crit_chance: 0 }), 1, { replay: true });
    expect(r.ended).toBe('end');
    expect(r.tickCount).toBe(3);
    const dmg = r.ticks!.map((t) => t.state.dmg as number);
    expect(dmg[0]).toBeCloseTo(19.71, 10);
    expect(dmg[1]).toBeCloseTo(20.16, 10);
    expect(dmg[2]).toBeCloseTo(20.61, 10);
    expect(r.ticks!.map((t) => t.time)).toEqual([0, 1.1, 2.2]);
    expect(r.ticks!.map((t) => t.clock)).toEqual(['swing', 'swing', 'swing']);
    expect(r.ticks![2].state.hp as number).toBeCloseTo(45 - 19.71 - 20.16 - 20.61, 10);
    expect(r.measures.hits).toBe(3);
    expect(r.measures.time_to_kill).toBeCloseTo(2.2, 10);
    expect(r.ticksCut).toBeUndefined();
    // Without replay no ticks are kept.
    expect(runOnce(s, roles({ ...sword, crit_chance: 0 }), 1).ticks).toBeUndefined();
  });

  it('a crit doubles the base part only', () => {
    const s = prepared();
    const r = runOnce(s, roles({ ...sword, crit_chance: 1 }), 7, { replay: true });
    expect(r.ticks![0].state.dmg as number).toBeCloseTo((15 * 1.05 * 2 + 17.1) * 0.6, 10);
    expect(r.measures.hits).toBe(2);
  });

  it('binds roles from entry keys with the same checks as rule examples', () => {
    const { balance, entries } = campaign();
    const s = prepareScenario(balance.scenarios[0].value, simData(balance));
    const byKey = new Map(entries.map((e) => [e.entryKey, e]));
    const typeKey: Record<string, string> = { 't-weapon': 'weapon', 't-creature': 'creature' };
    const input = {
      entry: (k: string) => { const e = byKey.get(k); return e && typeKey[e.entryTypeId] ? { typeKey: typeKey[e.entryTypeId], values: e.fields } : null; },
      fits: (a: string, b: string) => a === b,
      typeName: (k: string) => k,
    };
    const ok = bindRoles(s.roles, { attacker: 'dull_sword', target: 'slime' }, input, 'scenario');
    expect(ok.problems).toEqual([]);
    expect(runOnce(s, ok.values, 1).measures.hits).toBe(3);
    const bad = bindRoles(s.roles, { attacker: 'slime', target: 'ghost', extra: 'sword' }, input, 'scenario');
    expect(bad.problems).toEqual([
      { problem: 'wrong_type_ref', detail: 'attacker → slime is not a weapon' },
      { problem: 'broken_ref', detail: 'target → ghost is missing or deleted' },
      { problem: 'formula_error', detail: 'extra is not a role of the scenario' },
    ]);
    expect(() => runOnce(s, { attacker: sword }, 1)).toThrow(/role target: no entry is set/);
  });
});

describe('golden samples and the simulator agree', () => {
  it("a rule's exported samples equal the same rule run in a scenario with the sample's seed", () => {
    const { checks, balance } = campaign({
      roles: duel.roles, state: [{ name: 'x', start: 'strike(attacker, target)' }], clocks: [], end: 'true', cap: 1,
      measures: [{ name: 'x', formula: 'x' }],
    });
    expect(checks).toEqual([]);
    const samples = balance.rules.find((r) => r.name === 'strike')!.samples;
    expect(samples).toHaveLength(10);
    expect(new Set(samples.map((x) => x.parts.crit))).toEqual(new Set([true, false]));
    const data = simData(balance);
    const s = prepareScenario(balance.scenarios[0].value, data);
    for (const sample of samples) {
      expect(runOnce(s, roles(), sample.seed).measures.x).toBe(sample.result);
      expect(evaluateRule(data.rules.strike, roles(), data, makeRng(sample.seed), 'strike')).toEqual({ parts: sample.parts, result: sample.result });
    }
  });
});

describe('runBatch: the duel', () => {
  it('10 000 runs: 2 hits ≈ 36 %, 3 hits ≈ 64 % (±2 %); time to kill 1.1 s or 2.2 s', () => {
    const s = prepared();
    const r = runBatch(s, roles(), 10_000, 42);
    expect(r).toMatchObject({ runs: 10_000, requested: 10_000, cancelled: false, error: null, ended: { end: 10_000, cap: 0, ticks: 0 } });
    const hits = r.perMeasure.hits;
    expect(hits.whole).toBe(true);
    expect(hits.bins.map((b) => b.from)).toEqual([2, 3]);
    const two = hits.bins[0].count / r.runs, three = hits.bins[1].count / r.runs;
    expect(Math.abs(two - 0.36)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(three - 0.64)).toBeLessThanOrEqual(0.02);
    expect(hits.min).toBe(2);
    expect(hits.max).toBe(3);
    expect(hits.p50).toBe(3);
    expect(hits.mean).toBeCloseTo(2 * two + 3 * three, 10);
    const ttk = r.perMeasure.time_to_kill;
    expect(ttk.min).toBeCloseTo(1.1, 10);
    expect(ttk.max).toBeCloseTo(2.2, 10);
    expect(ttk.bins[0].count).toBe(hits.bins[0].count);
    expect(ttk.bins.at(-1)!.count).toBe(hits.bins[1].count);
    expect(ttk.bins.reduce((n, b) => n + b.count, 0)).toBe(10_000);
    // Two outcomes only, both inside p1–p99: no outliers.
    expect(r.outliers).toEqual([]);
    expect(Object.keys(r.perMeasure)).toEqual(['hits', 'time_to_kill']);
  });

  it('same data and seed → identical summary; another seed → another one; run i replays with runSeed(seed, i)', () => {
    const s = prepared();
    const a = runBatch(s, roles(), 2000, 9);
    const b = runBatch(prepared(), roles(), 2000, 9);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(runBatch(s, roles(), 2000, 10))).not.toBe(JSON.stringify(a));
    // A batch of one run is the run with runSeed(seed, 0).
    const one = runBatch(s, roles(), 1, 9);
    expect(one.perMeasure.hits.min).toBe(runOnce(s, roles(), runSeed(9, 0)).measures.hits);
  });

  it('outliers outside p1–p99 carry the seed that replays them; at most 200', () => {
    // hits = a whole number from 0 to 999: about 1 % fall below p1 and 1 % above p99.
    const spread: ScenarioValue = {
      ...duel, state: [{ name: 'n', start: 'randint(0, 999)' }], clocks: [], end: 'true', cap: 1,
      measures: [{ name: 'n', formula: 'n' }, { name: 'half', formula: 'n / 2' }],
    };
    const s = prepared(spread);
    const r = runBatch(s, roles(), 5000, 3);
    expect(r.outliers.length).toBeGreaterThan(0);
    expect(r.outliers.length).toBeLessThanOrEqual(SIM_LIMITS.outliers);
    const per = r.outliers.filter((o) => o.measure === 'n');
    expect(per.length).toBeLessThanOrEqual(100);
    for (const o of r.outliers) {
      const p = r.perMeasure[o.measure];
      expect(o.value < p.p1 || o.value > p.p99).toBe(true);
      expect(o.seed).toBe(runSeed(3, o.run));
      expect(runOnce(s, roles(), o.seed).measures[o.measure]).toBe(o.value);
    }
    // The most extreme first: lows go up from the minimum, highs come down from the maximum.
    const lows = per.filter((o) => o.value < r.perMeasure.n.p1);
    expect(lows[0].value).toBe(r.perMeasure.n.min);
    expect(r.perMeasure.n.whole).toBe(false);
    expect(r.perMeasure.n.bins).toHaveLength(SIM_LIMITS.bins);
    expect(r.perMeasure.n.bins.reduce((n, b) => n + b.count, 0)).toBe(5000);
  });

  it('onProgress reports chunks and can cancel; createBatch steps a chunk at a time', () => {
    const s = prepared();
    const seen: number[] = [];
    const r = runBatch(s, roles(), 10_000, 1, (done) => { seen.push(done); return done < 3000; }, { chunk: 1000 });
    expect(seen).toEqual([1000, 2000, 3000]);
    expect(r).toMatchObject({ runs: 3000, requested: 10_000, cancelled: true, error: null });
    // The cancelled summary is that of the first 3000 runs.
    expect(JSON.stringify(r.perMeasure)).toBe(JSON.stringify(runBatch(s, roles(), 3000, 1).perMeasure));
    const b = createBatch(s, roles(), 2500, 1);
    expect(b.step(1000)).toBe(false);
    expect(b.done).toBe(1000);
    b.step(1000);
    expect(b.step(1000)).toBe(true);
    expect(b.finished).toBe(true);
    expect(JSON.stringify(b.result())).toBe(JSON.stringify(runBatch(s, roles(), 2500, 1)));
    expect(() => b.step(1)).toThrow();
    // step(runs, ms): a time slice ends early (after at least one run); it never changes the result.
    const sliced = createBatch(s, roles(), 2500, 1);
    expect(sliced.step(10_000, 0)).toBe(false);
    expect(sliced.done).toBe(1);
    while (!sliced.step(10_000, 1));
    expect(JSON.stringify(sliced.result())).toBe(JSON.stringify(runBatch(s, roles(), 2500, 1)));
  });

  it('refuses batches outside 1…100 000 runs', () => {
    const s = prepared();
    expect(() => runBatch(s, roles(), 0, 1)).toThrow(RangeError);
    expect(() => runBatch(s, roles(), 100_001, 1)).toThrow(RangeError);
    expect(() => runBatch(s, roles(), 2.5, 1)).toThrow(RangeError);
  });
});

describe('clocks, the cap and the tick limit', () => {
  const base: ScenarioValue = { roles: duel.roles, state: [], clocks: [], end: 'false', cap: 10, measures: [] };

  it('the cap stops a never-ending scenario; time is the cap', () => {
    const s = prepared({ ...base, state: [{ name: 'n', start: '0' }], clocks: [{ name: 'c', every: '1', do: [{ name: 'n', formula: 'n + 1' }] }], cap: 10.5,
      measures: [{ name: 'n', formula: 'n' }, { name: 't', formula: 'time' }] });
    const r = runOnce(s, roles(), 1);
    expect(r).toMatchObject({ ended: 'cap', time: 10.5, tickCount: 11, measures: { n: 11, t: 10.5 } });
    // No clocks at all: the run goes straight to the cap.
    expect(runOnce(prepared({ ...base, measures: [{ name: 't', formula: 'time' }] }), roles(), 1)).toMatchObject({ ended: 'cap', tickCount: 0, measures: { t: 10 } });
    expect(runBatch(s, roles(), 50, 1).ended).toEqual({ end: 0, cap: 50, ticks: 0 });
  });

  it('a run stops after 100 000 ticks', () => {
    const s = prepared({ ...base, state: [{ name: 'n', start: '0' }], clocks: [{ name: 'c', every: '0.001', do: [{ name: 'n', formula: 'n + 1' }] }], cap: 1e9,
      measures: [{ name: 'n', formula: 'n' }] });
    const r = runOnce(s, roles(), 1, { replay: true });
    expect(r).toMatchObject({ ended: 'ticks', tickCount: SIM_LIMITS.ticks, measures: { n: SIM_LIMITS.ticks }, ticksCut: true });
    expect(r.ticks).toHaveLength(SIM_LIMITS.replayTicks);
  });

  it('clocks fire in time order, ties in declaration order; every is re-evaluated after firing', () => {
    // a: every 2; b: every 1; c: every n (its count so far), so c fires at 0, 1, 3, 6, 10.
    const s = prepared({
      ...base, cap: 6,
      state: [{ name: 'n', start: '0' }, { name: 'log', start: '0' }],
      clocks: [
        { name: 'a', every: '2', do: [{ name: 'log', formula: 'log * 10 + 1' }] },
        { name: 'b', every: '1', do: [{ name: 'log', formula: 'log * 10 + 2' }] },
        { name: 'c', every: 'n', do: [{ name: 'n', formula: 'n + 1' }, { name: 'log', formula: 'log * 10 + 3' }] },
      ],
    });
    const r = runOnce(s, roles(), 1, { replay: true });
    const order = r.ticks!.map((t) => `${t.clock}@${t.time}`);
    expect(order).toEqual(['a@0', 'b@0', 'c@0', 'b@1', 'c@1', 'a@2', 'b@2', 'b@3', 'c@3', 'a@4', 'b@4', 'b@5', 'a@6', 'b@6', 'c@6']);
    expect(r.ticks!.at(-1)!.state.log).toBe(Number(r.ticks!.map((t) => ({ a: 1, b: 2, c: 3 })[t.clock]).join('')));
  });

  it('times are whole microseconds: 0.1 + 0.1 + 0.1 ties with 0.3, and a tick due at the cap fires', () => {
    const s = prepared({
      ...base, cap: 0.3, clocks: [{ name: 'b', every: '0.1', do: [] }, { name: 'a', every: '0.3', do: [] }],
      measures: [{ name: 't', formula: 'time' }],
    });
    const r = runOnce(s, roles(), 1, { replay: true });
    expect(r.ticks!.map((t) => `${t.clock}@${t.time}`)).toEqual(['b@0', 'a@0', 'b@0.1', 'b@0.2', 'b@0.3', 'a@0.3']);
    expect(r.measures.t).toBe(0.3);
    const one = prepared({ ...base, cap: 0.3, clocks: [{ name: 'c', every: '0.1', do: [] }] });
    expect(runOnce(one, roles(), 1)).toMatchObject({ ended: 'cap', tickCount: 4, time: 0.3 });
    expect(RANDOM_INFO.scenario.join(' ')).toMatch(/microseconds/);
  });

  it("a clock's first delay: the creature strikes first after its interval, the sword at once", () => {
    const s = prepared({
      ...base, cap: 3, state: [{ name: 'hits', start: '0' }, { name: 'bites', start: '0' }],
      clocks: [
        { name: 'bite', every: 'target.attack_interval', first: 'target.attack_interval', do: [{ name: 'bites', formula: 'bites + 1' }] },
        { name: 'swing', every: 'attacker.swing', do: [{ name: 'hits', formula: 'hits + 1' }] },
      ],
      measures: [{ name: 'hits', formula: 'hits' }, { name: 'bites', formula: 'bites' }],
    });
    const r = runOnce(s, roles(), 1, { replay: true });
    expect(r.ticks!.map((t) => `${t.clock}@${t.time}`)).toEqual(['swing@0', 'swing@1.1', 'bite@1.4', 'swing@2.2', 'bite@2.8']);
    expect(r.measures).toEqual({ hits: 3, bites: 2 });
    // At the same instant, declaration order decides: with first = 1.1 the bite (declared first) goes before the swing.
    const tied = prepared({ ...base, cap: 1.1, clocks: [{ name: 'bite', every: '5', first: '1.1', do: [] }, { name: 'swing', every: '1.1', do: [] }] });
    expect(runOnce(tied, roles(), 1, { replay: true }).ticks!.map((t) => `${t.clock}@${t.time}`)).toEqual(['swing@0', 'bite@1.1', 'swing@1.1']);
  });

  it('the end condition is checked once at the start, so a run can end at time 0', () => {
    const s = prepared({ ...base, state: [{ name: 'n', start: '0' }], clocks: [{ name: 'c', every: '1', do: [{ name: 'n', formula: 'n + 1' }] }], end: 'n == 0',
      measures: [{ name: 'n', formula: 'n' }, { name: 't', formula: 'time' }] });
    expect(runOnce(s, roles(), 1, { replay: true })).toMatchObject({ ended: 'end', tickCount: 0, time: 0, ticks: [], measures: { n: 0, t: 0 } });
  });

  it('the end condition is checked after every tick, before a tied clock fires', () => {
    const s = prepared({
      ...base, state: [{ name: 'n', start: '0' }],
      clocks: [{ name: 'a', every: '1', do: [{ name: 'n', formula: 'n + 1' }] }, { name: 'b', every: '1', do: [{ name: 'n', formula: 'n + 100' }] }],
      end: 'n >= 1', measures: [{ name: 'n', formula: 'n' }],
    });
    expect(runOnce(s, roles(), 1)).toMatchObject({ ended: 'end', tickCount: 1, measures: { n: 1 } });
  });

  it('problems in a run are plain, with where; a batch stops and names the run and seed', () => {
    const zero = prepared({ ...base, clocks: [{ name: 'c', every: '0', do: [] }] });
    expect(() => runOnce(zero, roles(), 1)).toThrow(SimError);
    expect(() => runOnce(zero, roles(), 1)).toThrow('clock c: every: the time between ticks must be at least 0.000001 seconds (it is 0)');
    const tiny = prepared({ ...base, clocks: [{ name: 'c', every: '0.0000004', do: [] }] });
    expect(() => runOnce(tiny, roles(), 1)).toThrow('clock c: every: the time between ticks must be at least 0.000001 seconds (it is 4e-7)');
    const early = prepared({ ...base, clocks: [{ name: 'c', every: '1', first: '-1', do: [] }] });
    expect(() => runOnce(early, roles(), 1)).toThrow("clock c: first: the first tick can't come before the start (it is -1)");
    // Division by zero only in some runs: the batch stops at the first.
    const sometimes = prepared({ ...base, state: [{ name: 'n', start: 'randint(0, 3)' }], end: 'true', measures: [{ name: 'x', formula: '1 / n' }] });
    const r = runBatch(sometimes, roles(), 1000, 5);
    expect(r.error).toMatchObject({ where: 'measure x' });
    expect(r.error!.message).toMatch(/zero/);
    expect(r.runs).toBe(r.error!.run);
    expect(r.error!.seed).toBe(runSeed(5, r.error!.run!));
    expect(r.cancelled).toBe(false);
    expect(() => runOnce(sometimes, roles(), r.error!.seed!)).toThrow(/measure x/);
  });

  it('a run has a step budget', () => {
    const big: TableValue = { keys: [{ values: Array.from({ length: 1000 }, (_, i) => i) }], mode: 'step', cells: Array(1000).fill(1) };
    const { balance } = campaign({ ...base, state: [{ name: 'n', start: '0' }], clocks: [{ name: 'c', every: '0.001', do: [{ name: 'n', formula: 'n + 1' }] }], cap: 1e9 });
    const data = simData({ ...balance, tables: [...balance.tables, { name: 'big', entry: 'big', field: 'grid', value: big }] });
    const s = prepareScenario({ ...base, state: [{ name: 'n', start: '0' }], clocks: [{ name: 'c', every: '0.001', do: [{ name: 'n', formula: 'n + table(big, 5)' }] }], cap: 1e9, measures: [] }, data);
    const t0 = Date.now();
    expect(() => runOnce(s, roles(), 1)).toThrow('clock c: n: the run takes too many steps (more than 10,000,000)');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

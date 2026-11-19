import { describe, it, expect } from 'vitest';
import type { Card, EntryType, FieldDef, RuleValue, ScenarioValue, TableValue } from '../shared/types';
import { completions, evaluateRule, makeRng, RANDOM_INFO } from '../shared/formula';
import { formulaValues, refContext } from '../shared/wiki';
import { runBatch, prepareScenario, simData, type BatchResult } from '../shared/sim';
import { campaignLookup, checkRule, checkScenario, runExample, showValue, type Lookup } from '../web/src/balance';
import { createSimHost, type FromSim, type ToSim } from '../web/src/simHost';
import { completionText } from '../web/src/components/wiki/FormulaEditor';
import { readRule } from '../web/src/components/wiki/RuleEditor';
import { readScenario } from '../web/src/components/wiki/ScenarioEditor';
import type { ChecksInput } from '../web/src/wiki';
import { canonical, onStored, SENT_MAX_AGE_MS } from '../web/src/components/wiki/balanceParts';

// ---- A made-up campaign: a Sword and a Slime (the duel's numbers), as the store holds it ----

const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, kind, ...extra });
const type = (id: string, key: string, name: string, fields: FieldDef[]): EntryType =>
  ({ id, projectId: 'p', key, name, icon: null, color: null, parentTypeId: null, fields, sortIndex: 0, sections: [], templates: [], familyId: null, picture: null });
let seq = 0;
const card = (id: string, typeId: string, key: string, title: string, fields: Record<string, unknown>): Card =>
  ({ id, seq: ++seq, deckId: 'lore', isDoc: true, visibility: 'default', content: `# ${title}`, entryKey: key, entryTypeId: typeId, fields } as unknown as Card);

const kindVsMaterial: TableValue = {
  keys: [{ field: 'kind', values: ['Pierce', 'Slash'] }, { field: 'material', values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1, 1.2, 0.8],
};
const combo: TableValue = { keys: [{ values: [1, 2, 3, 4, 5] }], mode: 'step', cells: [1.05, 1.1, 1.15, 1.2, 1.25] };
const flat: RuleValue = { roles: [{ name: 'weapon', type: 'weapon' }], parts: [], result: 'weapon.damage * (1 + 0.1 * (weapon.item_level - 1))', examples: [] };
const strike: RuleValue = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  parts: [{ name: 'crit', formula: 'chance(attacker.crit_chance)' }, { name: 'base', formula: 'flat(attacker) + rand()' }],
  result: 'if(crit, 2, 1) * base * table(kind_vs_material, attacker.kind, target.material)',
  examples: [1, 2, 3].map((seed) => ({ roles: { attacker: 'sword', target: 'slime' }, seed })),
};
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

function store(): ChecksInput {
  const types = [
    type('t-w', 'weapon', 'Weapon', [f('damage', 'number'), f('item_level', 'integer'), f('kind', 'enum', { options: ['Pierce', 'Slash'] }), f('swing', 'number', { unit: 's' }), f('crit_chance', 'number'), f('secret', 'number', { hidden: true })]),
    type('t-c', 'creature', 'Creature', [f('hp', 'number', { unit: 'hp' }), f('armor', 'number', { unit: 'hp' }), f('material', 'enum', { options: ['Wet', 'Dry'] })]),
    type('t-t', 'chart', 'Chart', [f('grid', 'table')]),
    type('t-r', 'formula', 'Formula', [f('rule', 'rule')]),
    type('t-s', 'fight', 'Fight', [f('scenario', 'scenario')]),
  ];
  const cards = [
    card('c1', 't-w', 'sword', 'Sword', { damage: 9, item_level: 10, kind: 'Pierce', swing: 1.1, crit_chance: 0.2, secret: 5 }),
    card('c2', 't-c', 'slime', 'Slime', { hp: 45, armor: 2, material: 'Wet' }),
    card('c3', 't-t', 'kind_vs_material', 'Kind vs material', { grid: kindVsMaterial }),
    card('c4', 't-t', 'combo', 'Combo', { grid: combo }),
    card('c5', 't-r', 'flat', 'Flat', { rule: flat }),
    card('c6', 't-r', 'strike', 'Strike', { rule: strike }),
    card('c7', 't-s', 'duel', 'Duel', { scenario: duel }),
  ];
  return {
    cards: new Map(cards.map((c) => [c.id, c])), decks: new Map([['lore', { id: 'lore', projectId: 'p' }]]) as unknown as ChecksInput['decks'],
    entryTypes: new Map(types.map((t) => [t.id, t])), linkKinds: new Map(), entryLinks: new Map(), files: new Map(),
  };
}
const lookup = (): Lookup => campaignLookup(store(), 'p');

describe('the campaign as the editors see it', () => {
  it('gives each entry the values formulas see (visible, valid) and lists entries by type', () => {
    const l = lookup();
    expect(l.entry('sword')).toEqual({ typeKey: 'weapon', values: { damage: 9, item_level: 10, kind: 'Pierce', swing: 1.1, crit_chance: 0.2 } });
    expect(l.entry('nobody')).toBeNull();
    expect(l.entriesOf('creature')).toEqual([{ key: 'slime', title: 'Slime', typeKey: 'creature' }]);
    expect(l.balance.rules.map((r) => [r.name, r.resultType])).toEqual([['flat', { kind: 'number' }], ['strike', { kind: 'number' }]]);
    expect(l.balance.scenarios.map((s) => s.name)).toEqual(['duel']);
    // Memoised on the store collections.
    const s = store();
    expect(campaignLookup(s, 'p')).toBe(campaignLookup(s, 'p'));
  });

  it('formulaValues keeps visible fields with valid values only', () => {
    const t = type('t', 'x', 'X', [f('a', 'number'), f('b', 'enum', { options: ['Q'] }), f('h', 'number', { hidden: true })]);
    const ctx = refContext(new Map([['t', t]]), []);
    expect(formulaValues(t.fields, { a: 1, b: 'nope', h: 3, extra: 4 }, ctx)).toEqual({ a: 1 });
    expect(formulaValues(t.fields, undefined, ctx)).toEqual({});
  });
});

describe('completion and plain errors', () => {
  it('offers fields with their unit, as "armor (hp)"', () => {
    const l = lookup();
    const c = checkRule(strike, l, 'strike');
    const items = completions('target.ar', 9, c.resultScope);
    expect(items.map(completionText)).toEqual(['armor (hp)']);
    expect(completions('attacker.', 9, c.resultScope).map(completionText)).toContain('swing (s)');
  });

  it('a typo gives the plain error with its place, and did-you-mean', () => {
    const l = lookup();
    const c = checkRule({ ...strike, result: 'base - target.armr' }, l, 'strike');
    expect(c.ok).toBe(false);
    expect(c.result.problems).toEqual([{ message: "'Creature' has no field 'armr' — did you mean 'armor'?", from: 7, to: 18 }]);
    const e = checkRule({ ...strike, parts: [...strike.parts, { name: 'crit', formula: '1 +' }] }, l, 'strike');
    expect(e.parts[2].name).toBe("the name 'crit' is already used");
    expect(e.parts[2].formula.problems[0].message).toMatch(/end/);
    expect(checkRule({ ...strike, roles: [{ name: 'and', type: 'weapon' }, { name: 'x', type: 'ghost' }] }, l).roles)
      .toEqual(["'and' is a word of the formula language", "there is no type 'ghost'"]);
  });

  it('a rule may not call itself from the editor (it is left out of its own scope)', () => {
    const c = checkRule({ ...strike, result: 'strike(attacker, target)' }, lookup(), 'strike');
    expect(c.result.problems.length).toBe(1);
  });

  it('checks a scenario draft like the campaign checks', () => {
    const l = lookup();
    expect(checkScenario(duel, l).ok).toBe(true);
    const bad = checkScenario({
      ...duel, cap: 0, end: 'hp', state: [...duel.state, { name: 'time', start: '0' }],
      clocks: [{ ...duel.clocks[0], first: 'true', do: [...duel.clocks[0].do, { name: 'hits', formula: "'Wet'" }, { name: 'nope', formula: '1' }] }],
      measures: [{ name: 'hits', formula: 'crit' }],
    }, l);
    expect(bad.ok).toBe(false);
    expect(bad.cap).toMatch(/above 0/);
    expect(bad.end.problems[0].message).toBe('needs a true/false value, not a number');
    expect(bad.state[4].name).toMatch(/'time'/);
    expect(bad.clocks[0].first!.problems[0].message).toBe('needs a number, not a true/false value');
    expect(bad.clocks[0].do[4].formula.problems[0].message).toBe('hits holds a number, not a word');
    expect(bad.clocks[0].do[5].name).toBe("there is no state 'nope' to set");
    expect(bad.measures[0].formula.problems[0].message).toBe('needs a number, not a true/false value');
  });
});

describe('the live example', () => {
  it('shows exactly what the golden sample of a saved example holds', () => {
    const l = lookup();
    const c = checkRule(strike, l, 'strike');
    const data = simData(l.balance);
    for (const seed of [1, 2, 3, 77]) {
      const ex = runExample(strike, c, { attacker: 'sword', target: 'slime' }, seed, l);
      const want = evaluateRule(data.rules.strike, { attacker: l.entry('sword')!.values, target: l.entry('slime')!.values }, data, makeRng(seed), 'strike');
      expect(ex.blocked).toBeNull();
      expect(Object.fromEntries(ex.parts.map((p) => [p.name, p.value]))).toEqual(want.parts);
      expect(ex.result.value).toBe(want.result);
    }
    // And the export's samples (seeds 1–3) are the same numbers.
    const sample = l.balance.rules.find((r) => r.name === 'strike')!.samples[1];
    expect(runExample(strike, c, sample.roles, sample.seed, l).result.value).toBe(sample.result);
  });

  it('updates as the formula changes, stops at a failing part and says why', () => {
    const l = lookup();
    const draft = { ...strike, parts: [{ name: 'a', formula: 'attacker.damage * 2' }, { name: 'b', formula: 'a / (target.hp - 45)' }, { name: 'c', formula: 'b + 1' }], result: 'a' };
    const ex = runExample(draft, checkRule(draft, l, 'strike'), { attacker: 'sword', target: 'slime' }, 1, l);
    expect(ex.parts.map((p) => [p.name, p.value, p.problem])).toEqual([['a', 18, undefined], ['b', undefined, "can't divide by zero"], ['c', undefined, undefined]]);
    const ok = { ...draft, parts: [draft.parts[0]], result: 'a + target.armor' };
    expect(runExample(ok, checkRule(ok, l, 'strike'), { attacker: 'sword', target: 'slime' }, 1, l).result.value).toBe(20);
    const typo = { ...ok, result: 'a + target.armr' };
    expect(runExample(typo, checkRule(typo, l, 'strike'), { attacker: 'sword', target: 'slime' }, 1, l).result.problem).toBe('fix this formula first');
    expect(runExample(ok, checkRule(ok, l), { attacker: 'sword' }, 1, l).blocked).toBe('Pick an entry for target.');
    expect(runExample(ok, checkRule(ok, l), { attacker: 'slime', target: 'slime' }, 1, l).blocked).toBe('slime is not a Weapon.');
  });

  it('shows values in plain form', () => {
    expect(showValue(19.709999999)).toBe('19.71');
    expect(showValue(12000)).toBe('12,000');
    expect(showValue(true)).toBe('yes');
    expect(showValue('Wet')).toBe("'Wet'");
    expect(showValue(2.2, 's')).toBe('2.2 s');
  });
});

describe('the draft and the echoes of its saves', () => {
  const a = { json: canonical({ x: 1 }), at: 1000 };
  const b = { json: canonical({ x: 2 }), at: 1100 };
  it('an echo clears that value and the ones before it, without a reset', () => {
    expect(onStored([a, b], a.json, 1200)).toEqual({ sent: [b], reset: false });
    expect(onStored([a, b], b.json, 1200)).toEqual({ sent: [], reset: false });
  });
  it('another value waits while ours are on the way, and resets once none are', () => {
    const other = canonical({ x: 9 });
    expect(onStored([a, b], other, 1200)).toEqual({ sent: [a, b], reset: false });
    expect(onStored([], other, 1200)).toEqual({ sent: [], reset: true });
  });
  it('a sent value never echoed is forgotten after a few seconds, so remote changes reset the draft again', () => {
    const other = canonical({ x: 9 });
    expect(onStored([a, b], other, a.at + SENT_MAX_AGE_MS + 1)).toEqual({ sent: [b], reset: false });
    expect(onStored([a, b], other, b.at + SENT_MAX_AGE_MS + 1)).toEqual({ sent: [], reset: true });
    // An old echo still matches (and clears) rather than resetting.
    expect(onStored([a, b], a.json, b.at + SENT_MAX_AGE_MS + 1)).toEqual({ sent: [], reset: false });
  });
  it('canonical JSON ignores key order', () => {
    expect(canonical({ name: 'swing', every: '1', first: '0', do: [] })).toBe(canonical({ do: [], every: '1', first: '0', name: 'swing' }));
  });
});

describe('stored values the editors read', () => {
  it('keep exactly the shapes the server takes', () => {
    expect(readRule({ ...strike, extra: 1 })).toEqual(strike);
    expect(readRule({ roles: 1 })).toBeNull();
    const withFirst = { ...duel, clocks: [{ ...duel.clocks[0], first: '1.4' }] };
    expect(readScenario(withFirst)).toEqual(withFirst);
    expect(Object.keys(readScenario(duel)!.clocks[0])).toEqual(['name', 'every', 'do']);
    expect(readScenario({ cap: -1 })).toBeNull();
  });

  it('RANDOM_INFO says every is at least a microsecond after rounding', () => {
    expect(RANDOM_INFO.scenario.join(' ')).toContain('every (at least 0.000001 s after rounding to the microsecond grid)');
  });
});

// ---- The worker's state machine, driven by hand ----

function host(clock = { t: 0 }, stepMs = 0) {
  const out: FromSim[] = [];
  const queue: (() => void)[] = [];
  const handle = createSimHost((m) => out.push(m), (f) => queue.push(f), () => { clock.t += stepMs; return clock.t; });
  const drain = (max = 1e6) => { for (let i = 0; i < max && queue.length; i++) queue.shift()!(); };
  return { out, queue, handle, drain };
}
function runMsg(l: Lookup, extra: Partial<Extract<ToSim, { type: 'run' }>> = {}): ToSim {
  return {
    type: 'run', id: 1, scenario: duel, tables: l.balance.tables, rules: l.balance.rules.map((r) => ({ name: r.name, value: r.value })),
    bindings: { attacker: l.entry('sword')!.values, target: l.entry('slime')!.values }, runs: 3000, seed: 42, sliceMs: 1, ...extra,
  };
}

describe('the simulator worker', () => {
  it('runs a batch in slices and gives the same result as runBatch', () => {
    const l = lookup();
    const h = host();
    h.handle(runMsg(l));
    h.drain();
    const done = h.out.find((m) => m.type === 'done') as Extract<FromSim, { type: 'done' }>;
    const want: BatchResult = runBatch(prepareScenario(duel, simData(l.balance)), { attacker: l.entry('sword')!.values, target: l.entry('slime')!.values }, 3000, 42);
    expect(done.result).toEqual(want);
    expect(done.timedOut).toBe(false);
    const hits = done.result.perMeasure.hits.bins;
    expect(hits.map((b) => b.from)).toEqual([2, 3]);
    expect(Math.abs(hits[0].count / 3000 - 0.36)).toBeLessThan(0.03);
  });

  it('takes a cancel between slices and sums up the runs done', () => {
    const l = lookup();
    const h = host();
    h.handle(runMsg(l, { runs: 100_000 }));
    h.queue.shift()!();
    h.queue.shift()!();
    h.handle({ type: 'cancel', id: 1 });
    h.drain();
    const done = h.out.find((m) => m.type === 'done') as Extract<FromSim, { type: 'done' }>;
    expect(done.result.cancelled).toBe(true);
    expect(done.result.runs).toBeGreaterThan(0);
    expect(done.result.runs).toBeLessThan(100_000);
    expect(h.out.filter((m) => m.type === 'progress').length).toBeGreaterThan(0);
  });

  it('a slice queued for an old batch never runs the new one', () => {
    const l = lookup();
    const h = host();
    h.handle(runMsg(l, { runs: 1000, sliceMs: 0 }));
    h.queue.shift()!();
    h.queue.shift()!();
    expect(h.out.at(-1)).toMatchObject({ type: 'progress', id: 1 });
    h.handle(runMsg(l, { id: 2, runs: 5, sliceMs: 0 }));
    const before = h.out.length;
    expect(h.queue.length).toBe(2);
    h.queue.shift()!(); // batch 1's slice
    expect(h.out.length).toBe(before);
    h.drain();
    expect(h.out.filter((m) => m.type === 'done').map((m) => m.id)).toEqual([2]);
    expect(h.out.filter((m) => m.id === 2 && m.type === 'progress').map((m) => (m as { done: number }).done)).toEqual([1, 2, 3, 4]);
  });

  it('stops at the time cap', () => {
    const l = lookup();
    const clock = { t: 0 };
    const h = host(clock, 30);
    h.handle(runMsg(l, { runs: 100_000, capMs: 100 }));
    h.drain();
    const done = h.out.find((m) => m.type === 'done') as Extract<FromSim, { type: 'done' }>;
    expect(done.timedOut).toBe(true);
    expect(done.result.cancelled).toBe(true);
    expect(done.result.runs).toBeLessThan(100_000);
  });

  it('replays a run of the last batch with its ticks, and refuses a bad batch plainly', () => {
    const l = lookup();
    const h = host();
    h.handle({ type: 'replay', id: 1, seed: 5 });
    expect(h.out.pop()).toMatchObject({ type: 'replay', run: null, error: { message: 'run the batch again first' } });
    h.handle(runMsg(l, { runs: 10 }));
    h.drain();
    h.handle({ type: 'replay', id: 1, seed: 5 });
    const r = h.out.pop() as Extract<FromSim, { type: 'replay' }>;
    expect(r.run!.ticks!.length).toBe(r.run!.tickCount);
    expect(r.run!.ticks![0]).toMatchObject({ time: 0, clock: 'swing' });
    h.handle(runMsg(l, { id: 2, runs: 0 }));
    expect(h.out.pop()).toMatchObject({ type: 'failed', id: 2, error: { message: expect.stringMatching(/1 to 100,000 runs/) } });
    h.handle(runMsg(l, { id: 3, scenario: { ...duel, end: 'hp <=' } }));
    expect(h.out.pop()).toMatchObject({ type: 'failed', id: 3, error: { where: 'end' } });
  });
});

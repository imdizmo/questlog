import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Card, RuleValue, ScenarioValue, TableValue } from '../shared/types';
import { runChecks, validateValue, refContext, type EntryType, type FieldDef, type WikiData } from '../shared/wiki';
import type { BalanceResult } from '../shared/balance';
import { makeRng, parseFormula, RANDOM_INFO } from '../shared/formula';
import { openDb, newId, type Db } from '../server/db';
import { buildApp } from '../server/app';
import { _resetLimiter } from '../server/auth';

// ---- In-memory campaign (made-up names) ----

const type = (id: string, key: string, fields: FieldDef[], name = key): EntryType =>
  ({ id, projectId: 'p', key, name, icon: null, color: null, parentTypeId: null, fields, sortIndex: 0, sections: [], templates: [], familyId: null, picture: null });
const f = (key: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, kind, ...extra });
const entry = (id: string, entryTypeId: string, entryKey: string, fields: Record<string, unknown>) =>
  ({ id, entryTypeId, entryKey, fields, visibility: 'default' as Card['visibility'], content: '' });

const grid: TableValue = {
  keys: [{ field: 'kind', values: ['Pierce', 'Slash'] }, { field: 'material', values: ['Wet', 'Dry'] }], mode: 'exact', cells: [0.6, 1, 1.2, 0.8],
};
const combo: TableValue = { keys: [{ values: [1, 2, 3] }], mode: 'step', cells: [1.05, 1.15, 1.25] };
const hitRule: RuleValue = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  parts: [
    { name: 'base', formula: 'attacker.damage * table(kind_vs_material, attacker.kind, target.material)' },
    { name: 'crit', formula: 'chance(0.2)' },
    { name: 'soak', formula: 'target.armor' },
  ],
  result: 'if(crit, base * 2, base) * table(stats.combo, 2) - soak',
  examples: [{ roles: { attacker: 'sword', target: 'slime' }, seed: 1 }],
};
const duel: ScenarioValue = {
  roles: [{ name: 'attacker', type: 'weapon' }, { name: 'target', type: 'creature' }],
  state: [{ name: 'hp', start: 'target.hp' }, { name: 'hits', start: '0' }],
  clocks: [{ name: 'swing', every: '1.2', do: [{ name: 'hp', formula: 'hp - hit_damage(attacker, target)' }, { name: 'hits', formula: 'hits + 1' }] }],
  end: 'hp <= 0', cap: 60, measures: [{ name: 'time_to_kill', formula: 'time' }, { name: 'hits', formula: 'hits' }],
};

const creatureFields = [f('hp', 'number', { unit: 'hp' }), f('armor', 'number'), f('material', 'enum', { options: ['Wet', 'Dry'] })];
function campaign(over: { creature?: FieldDef[]; rule?: unknown; extra?: ReturnType<typeof entry>[]; scenario?: unknown } = {}) {
  const types = [
    type('t-weapon', 'weapon', [f('damage', 'number'), f('kind', 'enum', { options: ['Pierce', 'Slash'] }), f('hits', 'range')], 'Weapon'),
    type('t-creature', 'creature', over.creature ?? creatureFields, 'Creature'),
    type('t-chart', 'chart', [f('grid', 'table')]),
    type('t-stats', 'stats', [f('combo', 'table'), f('bonus', 'table', { unit: 'x' })]),
    type('t-rule', 'rule_holder', [f('rule', 'rule')]),
    type('t-scen', 'scenario_holder', [f('scenario', 'scenario')]),
  ];
  const entries = [
    entry('e-sword', 't-weapon', 'sword', { damage: 9, kind: 'Pierce', hits: { min: 1, max: 3 } }),
    entry('e-slime', 't-creature', 'slime', { hp: 45, armor: 2, armour: 2, material: 'Wet' }),
    entry('e-grid', 't-chart', 'kind_vs_material', { grid }),
    entry('e-stats', 't-stats', 'stats', { combo, bonus: combo }),
    entry('e-hit', 't-rule', 'hit_damage', { rule: over.rule ?? hitRule }),
    entry('e-duel', 't-scen', 'duel', { scenario: over.scenario ?? duel }),
    ...(over.extra ?? []),
  ];
  return { types, kinds: [], entries, links: [], includePages: false } satisfies WikiData;
}
function check(d: WikiData) {
  let balance: BalanceResult | null = null;
  const r = runChecks({ ...d, onBalance: (b) => { balance = b; } });
  return { checks: r.checks, balance: balance as unknown as BalanceResult };
}

const ctx = refContext(new Map(), []);
describe('validateValue: tables, rules and scenarios', () => {
  const tableDef = f('t', 'table');
  it('tables: one or two keys of words or numbers going up, a mode, one number per cell', () => {
    expect(validateValue(tableDef, grid, ctx)).toBeNull();
    expect(validateValue(tableDef, combo, ctx)).toBeNull();
    expect(validateValue(tableDef, 'grid', ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, [grid], ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...grid, mode: 'nearest' }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...grid, cells: [1, 2, 3] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...grid, cells: [1, 2, 3, '4'] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...combo, keys: [{ values: [1, 'two', 3] }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...combo, keys: [{ values: [] }], cells: [] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...combo, keys: [{ values: [1, 2, 3] }, { values: [1] }, { values: [1] }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...grid, keys: [{ values: ['Wet', 'Wet'] }, grid.keys[1]] }, ctx)).toBe('wrong_kind');
    expect(validateValue(tableDef, { ...combo, keys: [{ values: [1, 3, 2] }] }, ctx)).toBe('not_ascending');
    expect(validateValue(tableDef, { keys: [{ values: Array.from({ length: 1001 }, (_, i) => i) }], mode: 'step', cells: [] }, ctx)).toBe('too_large');
  });
  it('rules: roles, named parts, a result and examples', () => {
    const d = f('r', 'rule');
    expect(validateValue(d, hitRule, ctx)).toBeNull();
    expect(validateValue(d, 'x + 1', ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, result: 3 }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, parts: { base: '1' } }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, roles: [{ name: 'attacker' }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, examples: [{ roles: {}, seed: -1 }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, examples: [{ roles: { a: 1 }, seed: 1 }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...hitRule, parts: Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, formula: '1' })) }, ctx)).toBe('too_large');
  });
  it('scenarios: roles, state, clocks, end, a positive cap and measures', () => {
    const d = f('s', 'scenario');
    expect(validateValue(d, duel, ctx)).toBeNull();
    expect(validateValue(d, [], ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...duel, cap: 0 }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...duel, end: true }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...duel, clocks: [{ name: 'swing', every: '1' }] }, ctx)).toBe('wrong_kind');
    expect(validateValue(d, { ...duel, state: [{ name: 'hp' }] }, ctx)).toBe('wrong_kind');
  });
  it('a bad shape is an invalid_value check', () => {
    const { checks } = check(campaign({ rule: { ...hitRule, parts: 'nope' } }));
    expect(checks).toContainEqual({ entry: 'hit_damage', problem: 'invalid_value', detail: 'rule: wrong_kind' });
  });
});

describe('runChecks: formulas', () => {
  it('a sound campaign has no checks; the golden sample is computed with the formula language', () => {
    const { checks, balance } = check(campaign());
    expect(checks).toEqual([]);
    expect(balance.tables.map((t) => t.name).sort()).toEqual(['kind_vs_material', 'stats.bonus', 'stats.combo']);
    expect(balance.tables.find((t) => t.name === 'stats.bonus')!.unit).toBe('x');
    expect(balance.rules.map((r) => r.name)).toEqual(['hit_damage']);
    expect(balance.scenarios.map((s) => s.name)).toEqual(['duel']);
    // Seed 1's first float is 0.0915… (Task 1's known answer), below 0.2: a crit.
    expect(makeRng(1).float()).toBeLessThan(0.2);
    const base = 9 * 0.6;
    expect(balance.rules[0].samples).toEqual([{
      roles: { attacker: 'sword', target: 'slime' }, seed: 1, parts: { base, crit: true, soak: 2 }, result: base * 2 * 1.15 - 2,
    }]);
  });
  it('a field renamed after the rule was written: formula_error naming the entry, the part and the message', () => {
    // A field can't be deleted, only hidden: "renaming" hides armor and adds armour.
    const renamed = [f('hp', 'number'), f('armor', 'number', { hidden: true }), f('armour', 'number'), f('material', 'enum', { options: ['Wet', 'Dry'] })];
    const { checks, balance } = check(campaign({ creature: renamed }));
    expect(checks).toContainEqual({
      entry: 'hit_damage', problem: 'formula_error', detail: "rule: part soak: 'Creature' has no field 'armor' — did you mean 'armour'? (at 1)",
    });
    expect(balance.rules).toEqual([]);
    // The duel calls the rule: it is left out too, and says why.
    expect(checks).toContainEqual({ entry: 'duel', problem: 'formula_error', detail: 'scenario: clock swing: hp: calls rule hit_damage, which has problems' });
    expect(balance.scenarios).toEqual([]);
  });
  it('syntax errors, unknown role types and bad names', () => {
    const rule: RuleValue = {
      roles: [{ name: 'attacker', type: 'weapn' }, { name: 'and', type: 'creature' }],
      parts: [{ name: 'x', formula: '1 +' }, { name: 'x', formula: '2' }], result: 'x', examples: [],
    };
    const { checks } = check(campaign({ rule, scenario: null }));
    const details = checks.filter((c) => c.entry === 'hit_damage').map((c) => c.detail);
    expect(details).toEqual(expect.arrayContaining([
      "rule: role attacker: there is no type 'weapn'",
      "rule: role and: 'and' is a word of the formula language",
      expect.stringMatching(/^rule: part x: .+ \(at \d+\)$/),
      'rule: part x: the name is already used',
    ]));
    expect(checks.every((c) => c.entry !== 'hit_damage' || c.problem === 'formula_error')).toBe(true);
  });
  it('rules calling each other in a loop, and rules calling a broken rule', () => {
    const call = (other: string): RuleValue => ({ roles: [{ name: 'a', type: 'weapon' }], parts: [], result: `${other}(a) + 1`, examples: [] });
    const extra = [
      entry('e-r1', 't-rule', 'ping', { rule: call('pong') }),
      entry('e-r2', 't-rule', 'pong', { rule: call('ping') }),
      entry('e-r3', 't-rule', 'caller', { rule: call('ping') }),
      entry('e-r4', 't-rule', 'fine', { rule: { roles: [{ name: 'a', type: 'weapon' }], parts: [], result: 'a.damage', examples: [] } }),
      entry('e-r5', 't-rule', 'uses_fine', { rule: call('fine') }),
    ];
    const { checks, balance } = check(campaign({ extra }));
    expect(checks).toContainEqual({ entry: 'ping', problem: 'formula_error', detail: 'rule: calls itself in a loop (ping → pong → ping)' });
    expect(checks).toContainEqual({ entry: 'pong', problem: 'formula_error', detail: 'rule: calls itself in a loop (ping → pong → ping)' });
    expect(checks).toContainEqual({ entry: 'caller', problem: 'formula_error', detail: 'rule: calls rule ping, which has problems' });
    expect(balance.rules.map((r) => r.name).sort()).toEqual(['fine', 'hit_damage', 'uses_fine']);
  });
  it('rule calls deeper than the language allows are refused up front', () => {
    const extra = Array.from({ length: 17 }, (_, i) => entry(`e-d${i}`, 't-rule', `d${i}`, {
      rule: { roles: [{ name: 'a', type: 'weapon' }], parts: [], result: i === 16 ? '1' : `d${i + 1}(a)`, examples: [] },
    }));
    const { checks } = check(campaign({ extra }));
    expect(checks.map((c) => c.entry)).toEqual(['d0']);
    expect(checks[0].detail).toMatch(/^rule: calls rules 17 deep .*the limit is 16$/);
  });
  it('a table of an entry with several tables is named entry.field; plain entry key does not name it', () => {
    const rule = { ...hitRule, result: 'table(stats, 2)' };
    const { checks } = check(campaign({ rule }));
    expect(checks).toContainEqual(expect.objectContaining({ entry: 'hit_damage', problem: 'formula_error', detail: expect.stringContaining("result: unknown table 'stats'") }));
  });
  it('a rule of an entry with several rules is named and called as entry.field(…)', () => {
    const d = campaign();
    d.types.push(type('t-pair', 'pair', [f('first', 'rule'), f('second', 'rule')]));
    const r = (result: string): RuleValue => ({ roles: [{ name: 'a', type: 'weapon' }], parts: [], result, examples: [{ roles: { a: 'sword' }, seed: 3 }] });
    d.entries.push(entry('e-pair', 't-pair', 'pair', { first: r('a.damage * 2'), second: r('pair.first(a) + 1') }));
    const { checks, balance } = check(d);
    expect(checks).toEqual([]);
    expect(balance.rules.find((x) => x.name === 'pair.second')!.samples[0].result).toBe(19);
  });
  it('examples: a missing entry, the wrong type, an unknown role, and a run-time error each leave their sample out', () => {
    const rule: RuleValue = {
      ...hitRule,
      result: 'base / (target.armor - 2)',
      examples: [
        { roles: { attacker: 'sword', target: 'gone' }, seed: 1 },
        { roles: { attacker: 'slime', target: 'slime' }, seed: 1 },
        { roles: { attacker: 'sword', target: 'slime', extra: 'sword' }, seed: 1 },
        { roles: { attacker: 'sword', target: 'slime' }, seed: 7 },
      ],
    };
    const { checks, balance } = check(campaign({ rule }));
    expect(checks).toEqual(expect.arrayContaining([
      { entry: 'hit_damage', problem: 'broken_ref', detail: 'rule: example 1: target → gone is missing or deleted' },
      { entry: 'hit_damage', problem: 'wrong_type_ref', detail: 'rule: example 2: attacker → slime is not a Weapon' },
      { entry: 'hit_damage', problem: 'formula_error', detail: 'rule: example 3: extra is not a role of the rule' },
      expect.objectContaining({ entry: 'hit_damage', problem: 'formula_error', detail: expect.stringMatching(/^rule: example 4: .*zero/) }),
    ]));
    // The rule itself is sound, so it is kept, without samples.
    expect(balance.rules.find((r) => r.name === 'hit_damage')!.samples).toEqual([]);
  });
  it('a fan-out campaign: one shared step budget, then the rest of the examples are not run (in name order)', () => {
    // f0 calls f1 eight times, f1 calls f2 eight times, … : 8^9 calls if run in full.
    const extra = Array.from({ length: 10 }, (_, i) => entry(`e-f${i}`, 't-rule', `f${i}`, {
      rule: {
        roles: [{ name: 'a', type: 'weapon' }], parts: [],
        result: i === 9 ? 'table(stats.combo, a.damage)' : `max(${Array.from({ length: 8 }, () => `f${i + 1}(a)`).join(', ')})`,
        examples: Array.from({ length: 16 }, (_, s) => ({ roles: { a: 'sword' }, seed: s })),
      },
    }));
    const t0 = performance.now();
    const { checks, balance } = check(campaign({ extra }));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    const notRun = checks.filter((c) => c.detail.includes('not run'));
    // f0's first example uses the budget up: every later example (in name order: f0 … f9, then hit_damage) is not run.
    expect(notRun).toHaveLength(10 * 16 + 1); // hit_damage has one example
    expect(notRun[0]).toEqual({ entry: 'f0', problem: 'formula_error', detail: "rule: example 1: not run: the campaign's examples took more than 200,000 steps" });
    expect(notRun.map((c) => c.entry)).toEqual([...Array.from({ length: 10 }, (_, i) => Array(16).fill(`f${i}`)).flat(), 'hit_damage']);
    expect(balance.rules.every((r) => r.samples.length === 0)).toBe(true);
    // The same campaign gives the same checks every time (no clock).
    expect(check(campaign({ extra })).checks).toEqual(checks);
  });
  it('table work counts toward the budget', () => {
    const big: TableValue = { keys: [{ values: Array.from({ length: 1000 }, (_, i) => i) }], mode: 'exact', cells: Array(1000).fill(1) };
    const sum = Array.from({ length: 60 }, () => 'table(big, 999)').join(' + ');
    const extra = [
      entry('e-big', 't-chart', 'big', { grid: big }),
      entry('e-scan', 't-rule', 'scan', { rule: { roles: [{ name: 'a', type: 'weapon' }], parts: [], result: `${sum}`, examples: Array.from({ length: 16 }, (_, s) => ({ roles: { a: 'sword' }, seed: s })) } }),
    ];
    const { checks, balance } = check(campaign({ extra }));
    // 60 lookups × 1,000 values ≈ 60,000 steps each: the fourth example is past 200,000.
    expect(balance.rules.find((r) => r.name === 'scan')!.samples).toHaveLength(3);
    expect(checks.filter((c) => c.entry === 'scan').map((c) => c.detail)[0]).toBe("rule: example 4: not run: the campaign's examples took more than 200,000 steps");
  });
  it('a table or rule named like a built-in function or a word of the language is left out', () => {
    const extra = [
      entry('e-min', 't-rule', 'min', { rule: { roles: [], parts: [], result: '1', examples: [] } }),
      entry('e-roll', 't-chart', 'roll', { grid }),
      entry('e-not', 't-chart', 'not', { grid }),
    ];
    const { checks, balance } = check(campaign({ extra }));
    expect(checks).toEqual(expect.arrayContaining([
      { entry: 'min', problem: 'formula_error', detail: "rule: left out: 'min' is the name of a built-in function, so formulas can't name it; change the entry's key" },
      { entry: 'roll', problem: 'formula_error', detail: "grid: left out: 'roll' is the name of a built-in function, so formulas can't name it; change the entry's key" },
      { entry: 'not', problem: 'formula_error', detail: "grid: left out: 'not' is a word of the formula language, so formulas can't name it; change the entry's key" },
    ]));
    expect(balance.rules.map((r) => r.name)).not.toContain('min');
    expect(balance.tables.map((t) => t.name)).not.toContain('roll');
  });
  it('the rule characters cap leaves out the same rules whatever the entry order (name order)', () => {
    const long = (n: string) => entry(`e-${n}`, 't-rule', n, { rule: { roles: [], parts: [], result: `1${' + 1'.repeat(10)}${' '.repeat(600_000)}`, examples: [] } });
    const a = check(campaign({ extra: [long('zz_late'), long('aa_early')] })).checks;
    const b = check(campaign({ extra: [long('aa_early'), long('zz_late')] })).checks;
    expect(a).toEqual(b);
    expect(a.filter((c) => c.detail.includes('longer than')).map((c) => c.entry)).toEqual(['zz_late']);
  });
  it('an example reads only valid values: an invalid one is missing at run time', () => {
    const d = campaign();
    d.entries[1] = entry('e-slime', 't-creature', 'slime', { hp: 45, armor: 'two', material: 'Wet' });
    const { checks } = check(d);
    expect(checks).toContainEqual({ entry: 'slime', problem: 'invalid_value', detail: 'armor: wrong_kind' });
    expect(checks).toContainEqual(expect.objectContaining({ entry: 'hit_damage', problem: 'formula_error', detail: expect.stringMatching(/^rule: example 1: /) }));
  });
  it('scenarios: types of state updates, end and measures; time is built in', () => {
    const bad: ScenarioValue = {
      ...duel,
      state: [{ name: 'hp', start: 'target.hp' }, { name: 'time', start: '0' }],
      clocks: [{ name: 'swing', every: "'soon'", do: [{ name: 'hp', formula: 'hp > 3' }, { name: 'mana', formula: '1' }, { name: 'time', formula: '1' }] }],
      end: 'hp', measures: [{ name: 'won', formula: 'hp <= 0' }],
    };
    const { checks, balance } = check(campaign({ scenario: bad }));
    const details = checks.filter((c) => c.entry === 'duel').map((c) => c.detail);
    expect(details).toEqual([
      'scenario: state time: the name is already used',
      'scenario: clock swing: every: needs a number',
      'scenario: clock swing: hp: hp holds a number, not a true/false value',
      "scenario: clock swing: mana: there is no state 'mana' to set",
      "scenario: clock swing: time: time moves by itself; it can't be set",
      'scenario: end: needs a true/false value',
      'scenario: measure won: needs a number',
    ]);
    expect(balance.scenarios).toEqual([]);
  });
  it('an entry whose key is not unique: its tables and rules have no name and are left out', () => {
    const extra = [entry('e-grid2', 't-chart', 'kind_vs_material', { grid })];
    const { checks, balance } = check(campaign({ extra }));
    expect(checks).toContainEqual(expect.objectContaining({ entry: 'kind_vs_material', problem: 'duplicate_key' }));
    expect(checks).toContainEqual({ entry: 'kind_vs_material', problem: 'formula_error', detail: "grid: left out: the entry's key is invalid or not unique, so the table has no name" });
    expect(balance.tables.map((t) => t.name)).not.toContain('kind_vs_material');
  });
});

// ---- Through the server: storing the values and the export ----

const HOST = 'localhost:8780';
const SPACES = JSON.stringify([{ id: 1, name: null, icon: null, defaultDeckType: 'mixed' }]);
let db: Db;
let app: ReturnType<typeof buildApp>;
let cookie: string;
let projectId: string;
const dir = join(homedir(), '.cache/gametracker/scratch', `wiki-balance-test-${process.pid}`);

const send = (cmd: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/dispatch/${cmd}`, payload: payload as object, headers: { host: HOST, cookie, 'content-type': 'application/json' } });
const ok = async (cmd: string, payload: unknown) => {
  const r = await send(cmd, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().payload;
};
const exported = async (query = '') => {
  const r = await app.inject({ method: 'GET', url: `/api/wiki/${projectId}/export${query}`, headers: { host: HOST, cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return JSON.parse(r.body);
};

describe('export of tables, rules and scenarios', () => {
  let ids: Record<string, string>;
  beforeEach(async () => {
    db = openDb(':memory:');
    _resetLimiter();
    db.prepare("INSERT INTO account (id,name,settings_json,created_at) VALUES (?,'W','{}',0)").run(newId());
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    app = buildApp({ db, hosts: [HOST], filesDir: dir });
    await app.ready();
    const owner = newId();
    db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,'x',0)").run(owner, `${owner}@x.io`, 'owner');
    db.prepare("INSERT INTO account_roles (user_id, role) VALUES (?,'owner')").run(owner);
    const t = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(createHash('sha256').update(t).digest('hex'), owner, Date.now() + 3600e3);
    cookie = `jt_session=${t}`;
    projectId = newId();
    db.prepare("INSERT INTO projects (id,seq,name,visibility,is_archived,spaces_json,created_at) VALUES (?,1,'Duel','limited',0,?,0)").run(projectId, SPACES);
    db.prepare("INSERT INTO decks (id,seq,project_id,space_id,title,deck_type,sort_index,created_at) VALUES (?,2,?,1,'Lore','doc',1,0)").run(newId(), projectId);
    const c = campaign();
    const typeIds: Record<string, string> = {};
    for (const ty of c.types) typeIds[ty.id] = (await ok('wiki/createType', { projectId, name: ty.name, key: ty.key, fields: ty.fields })).id;
    ids = {};
    for (const e of c.entries) {
      const id = (await ok('wiki/createEntry', { projectId, typeId: typeIds[e.entryTypeId], name: e.entryKey })).id;
      await ok('wiki/setEntry', { cardId: id, key: e.entryKey, fields: e.fields });
      ids[e.entryKey] = id;
    }
  });
  afterEach(async () => {
    await app.close();
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tables, rules (text, tree, language 1, golden samples) and scenarios, and the random block', async () => {
    const d = await exported();
    expect(Object.keys(d)).toEqual(['format', 'version', 'campaign', 'exportedAt', 'types', 'families', 'linkKinds', 'entries', 'links', 'random', 'tables', 'rules', 'scenarios', 'checks']);
    expect(d.checks).toEqual([]);
    expect(d.random).toEqual(JSON.parse(JSON.stringify(RANDOM_INFO)));
    // Not repeated in the entry's fields.
    expect(d.entries.find((e: any) => e.key === 'hit_damage').fields).toEqual({});
    expect(d.entries.find((e: any) => e.key === 'sword').fields).toEqual({ damage: 9, kind: 'Pierce', hits: { min: 1, max: 3 } });
    expect(d.tables).toEqual([
      { name: 'kind_vs_material', entry: 'kind_vs_material', field: 'grid', unit: null, keys: [{ field: 'kind', values: ['Pierce', 'Slash'] }, { field: 'material', values: ['Wet', 'Dry'] }], mode: 'exact', cells: grid.cells },
      { name: 'stats.bonus', entry: 'stats', field: 'bonus', unit: 'x', keys: [{ field: null, values: [1, 2, 3] }], mode: 'step', cells: combo.cells },
      { name: 'stats.combo', entry: 'stats', field: 'combo', unit: null, keys: [{ field: null, values: [1, 2, 3] }], mode: 'step', cells: combo.cells },
    ]);
    const tree = (text: string) => (parseFormula(text) as { tree: unknown }).tree;
    const base = 9 * 0.6;
    expect(d.rules).toEqual([{
      name: 'hit_damage', entry: 'hit_damage', field: 'rule', language: 1,
      roles: hitRule.roles,
      parts: hitRule.parts.map((p) => ({ name: p.name, formula: { text: p.formula, tree: tree(p.formula) } })),
      result: { text: hitRule.result, tree: tree(hitRule.result) },
      samples: [{ roles: { attacker: 'sword', target: 'slime' }, seed: 1, parts: { base, crit: true, soak: 2 }, result: base * 2 * 1.15 - 2 }],
    }]);
    expect(d.scenarios).toHaveLength(1);
    const s = d.scenarios[0];
    expect(s).toMatchObject({ name: 'duel', entry: 'duel', field: 'scenario', language: 1, roles: duel.roles, cap: 60 });
    expect(s.state[0]).toEqual({ name: 'hp', start: { text: 'target.hp', tree: tree('target.hp') } });
    expect(s.clocks[0].every).toEqual({ text: '1.2', tree: tree('1.2') });
    expect(s.clocks[0].do[0]).toEqual({ name: 'hp', formula: { text: 'hp - hit_damage(attacker, target)', tree: tree('hp - hit_damage(attacker, target)') } });
    expect(s.end.text).toBe('hp <= 0');
    expect(s.measures.map((m: any) => m.name)).toEqual(['time_to_kill', 'hits']);
  });

  it('invalid ones are left out and listed in checks; strict refuses', async () => {
    await ok('wiki/setEntry', { cardId: ids.hit_damage, fields: { rule: { ...hitRule, parts: [...hitRule.parts.slice(0, 2), { name: 'soak', formula: 'target.armr' }] } } });
    await ok('wiki/setEntry', { cardId: ids.kind_vs_material, fields: { grid: { ...grid, cells: [1, 2] } } });
    const d = await exported();
    expect(d.rules).toEqual([]);
    expect(d.scenarios).toEqual([]);
    expect(d.tables.map((t: any) => t.name)).toEqual(['stats.bonus', 'stats.combo']);
    expect(d.checks).toEqual(expect.arrayContaining([
      { entry: 'kind_vs_material', problem: 'invalid_value', detail: 'grid: wrong_kind' },
      { entry: 'hit_damage', problem: 'formula_error', detail: "rule: part soak: 'Creature' has no field 'armr' — did you mean 'armor'? (at 1)" },
      { entry: 'duel', problem: 'formula_error', detail: 'scenario: clock swing: hp: calls rule hit_damage, which has problems' },
    ]));
    // The rule's table is gone too: its formula now names an unknown table.
    expect(d.checks.some((c: any) => c.entry === 'hit_damage' && c.detail.includes("unknown table 'kind_vs_material'"))).toBe(true);
    const r = await app.inject({ method: 'GET', url: `/api/wiki/${projectId}/export?strict=1`, headers: { host: HOST, cookie } });
    expect(r.statusCode).toBe(422);
  });

  it("a clock's optional first delay is stored, checked and exported", async () => {
    const withFirst = { ...duel, clocks: [{ ...duel.clocks[0], first: '0.5' }] };
    await ok('wiki/setEntry', { cardId: ids.duel, fields: { scenario: withFirst } });
    let d = await exported();
    expect(d.scenarios[0].clocks[0].first).toEqual({ text: '0.5', tree: (parseFormula('0.5') as { tree: unknown }).tree });
    await ok('wiki/setEntry', { cardId: ids.duel, fields: { scenario: { ...duel, clocks: [{ ...duel.clocks[0], first: 'hp > 0' }] } } });
    d = await exported();
    expect(d.scenarios).toEqual([]);
    expect(d.checks).toEqual(expect.arrayContaining([{ entry: 'duel', problem: 'formula_error', detail: 'scenario: clock swing: first: needs a number' }]));
    const bad = await send('wiki/setEntry', { cardId: ids.duel, fields: { scenario: { ...duel, clocks: [{ ...duel.clocks[0], first: 1 }] } } });
    expect(bad.statusCode).toBe(400);
    expect(validateValue(f('s', 'scenario'), { ...duel, clocks: [{ ...duel.clocks[0], first: 1 }] }, ctx)).toBe('wrong_kind');
  });

  it('values of the wrong shape are refused when stored; link properties cannot be tables, rules or scenarios', async () => {
    const bad = await send('wiki/setEntry', { cardId: ids.hit_damage, fields: { rule: { ...hitRule, extra: 1 } } });
    expect(bad.statusCode).toBe(400);
    const prop = await send('wiki/createLinkKind', {
      projectId, label: 'uses', reverseLabel: 'used by', fromTypes: [], toTypes: [], props: [{ key: 'how', label: 'How', kind: 'rule' }],
    });
    expect(prop.statusCode).toBe(400);
  });
});

describe('FieldEditor for the new kinds (rendered to HTML)', () => {
  it('a table is a grid of its cells; a rule and a scenario are read-only summaries', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { FieldEditor } = await import('../web/src/components/wiki/FieldEditor');
    const html = (def: FieldDef, value: unknown) => renderToStaticMarkup(createElement(FieldEditor, { def, value, onSave: () => {}, entries: [], titleOfKey: () => null, images: [] }));
    const t = html(f('grid', 'table'), grid);
    expect(t).toContain('aria-label="grid Pierce × Wet" value="0.6"');
    expect(t).toContain('aria-label="grid Slash × Dry" value="0.8"');
    expect(t).toContain('<th scope="col">Dry</th>');
    const r = html(f('rule', 'rule'), hitRule);
    expect(r).toContain('Roles: attacker (weapon), target (creature)');
    expect(r).toContain('<code>soak = target.armor</code>');
    const s = html(f('scenario', 'scenario'), duel);
    expect(s).toContain('Ends when <code>hp &lt;= 0</code> or at 60 s');
  });
});

describe('table editor drafts', () => {
  it('key values named like Object.prototype members are plain cells', async () => {
    const { draftOf, valueOf } = await import('../web/src/components/wiki/FieldEditor');
    const words = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];
    const t: TableValue = { keys: [{ values: words }, { values: ['__proto__', 'x'] }], mode: 'exact', cells: Array.from({ length: 10 }, (_, i) => i + 0.5) };
    const d = draftOf(t)!;
    expect(d.cells.size).toBe(10);
    expect(valueOf(d)).toEqual({ value: t });
    // A fresh draft typed by hand: no cell is read from the prototype.
    const fresh = { mode: 'exact' as const, keys: [{ field: '', text: words.join(', ') }], cells: new Map<string, string>() };
    expect(valueOf(fresh)).toEqual({ problem: 'Fill every cell with a number.' });
    words.forEach((w, i) => fresh.cells.set(w, String(i)));
    expect(valueOf(fresh)).toEqual({ value: { keys: [{ values: words }], mode: 'exact', cells: [0, 1, 2, 3, 4] } });
  });
  it('a stored value that is not a table gives no draft (the editor warns instead of overwriting it)', async () => {
    const { draftOf } = await import('../web/src/components/wiki/FieldEditor');
    expect(draftOf({ keys: 'x' })).toBeNull();
    expect(draftOf({ ...grid, cells: [1] })).toBeNull();
    expect(draftOf(null)!.keys).toEqual([{ field: '', text: '' }]);
    expect(draftOf({ ...combo, keys: [{ values: [3, 1, 2] }] })).not.toBeNull(); // not_ascending: still readable
  });
  it('instant saves of a half-typed key list never drop stored cells', async () => {
    const { draftOf, valueOf, keepsCells } = await import('../web/src/components/wiki/FieldEditor');
    const d = draftOf(grid)!;
    // Typing "Pierce, Sla" on the way to "Pierce, Slash, Blunt": a complete parse, but Slash's cells would go.
    const typing = { ...d, keys: [{ field: 'kind', text: 'Pierce, Sla' }, d.keys[1]] };
    const cells = new Map(d.cells);
    cells.set('Sla\u0000Wet', '1'); cells.set('Sla\u0000Dry', '1');
    const half = valueOf({ ...typing, cells });
    expect('value' in half && keepsCells(grid, half.value)).toBe(false);
    const grown = valueOf({ ...d, keys: [{ field: 'kind', text: 'Pierce, Slash, Blunt' }, d.keys[1]], cells: new Map([...d.cells, ['Blunt\u0000Wet', '1'], ['Blunt\u0000Dry', '1']]) });
    expect('value' in grown && keepsCells(grid, grown.value)).toBe(true);
  });
  it('the grid renders prototype-named keys without crashing', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { FieldEditor } = await import('../web/src/components/wiki/FieldEditor');
    const t: TableValue = { keys: [{ values: ['constructor', '__proto__'] }], mode: 'exact', cells: [1, 2] };
    const html = renderToStaticMarkup(createElement(FieldEditor, { def: f('w', 'table'), value: t, onSave: () => {}, entries: [], titleOfKey: () => null, images: [] }));
    expect(html).toContain('aria-label="w constructor" value="1"');
    expect(html).toContain('aria-label="w __proto__" value="2"');
    const bad = renderToStaticMarkup(createElement(FieldEditor, { def: f('w', 'table'), value: { keys: 1 }, onSave: () => {}, entries: [], titleOfKey: () => null, images: [] }));
    expect(bad).toContain('not a table the editor can read');
  });
});

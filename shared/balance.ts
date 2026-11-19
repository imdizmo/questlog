// Tables, rules and scenarios as wiki fields: their shapes, their names in formulas, and their checks (formula errors,
// rule calls, saved examples run into golden samples). Pure; used by runChecks (shared/wiki.ts) and the export.
import type { FieldDef, FormulaRole, NamedFormula, RuleValue, ScenarioValue, TableValue } from './types';
import {
  calledRules, checkFormula, evaluateRule, findRuleCycle, FormulaError, isBuiltin, makeRng, MAX_RULE_DEPTH, MAX_STEPS, own, parseFormula,
  type Expr, type StepBudget, type FormulaScope, type FType, type RuleProgram, type RuleSig, type ScopeRole, type TableData, type Value,
} from './formula';

/** Field kinds that hold a table, a rule or a scenario. */
export const BALANCE_KINDS = new Set(['table', 'rule', 'scenario']);

/** Caps of one table, rule or scenario (over them: too_large), and of a campaign's rules and examples together. */
export const BALANCE_LIMITS = {
  keyValues: 1000, cells: 10_000, roles: 16, parts: 64, examples: 16, state: 64, clocks: 16, updates: 64, measures: 32,
  /**
   * Formula characters of all rules together (in name order; later ones are left out): their trees are held at once
   * while checking, since examples call each other. A tree takes roughly 30–60 bytes per character of formula text, so
   * this bounds them near 30–60 MB in the worst case; real rules (a few hundred characters each) stay far below.
   */
  ruleChars: 1_000_000,
  /**
   * Steps (values computed, plus table cells scanned) all examples of a campaign may take together, shared and counted
   * in a fixed order, so the badge (rerun on every change in the browser) and the export stay quick and agree. A step
   * is ~0.1 µs, so this is ~20 ms at most; a normal example takes tens to hundreds of steps, so 200 of them use ~5%.
   */
  exampleSteps: 200_000,
  /** Examples run per campaign at most (each also builds a generator and its sample). */
  examplesRun: 2_000,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Problem code of a table value (null = fine): wrong_kind, not_ascending (number keys must go up) or too_large. */
export function tableProblem(v: unknown): string | null {
  if (!isObj(v) || !Array.isArray(v.keys) || v.keys.length < 1 || v.keys.length > 2) return 'wrong_kind';
  if (v.mode !== 'exact' && v.mode !== 'step' && v.mode !== 'linear') return 'wrong_kind';
  let size = 1;
  for (const k of v.keys as unknown[]) {
    if (!isObj(k) || (k.field !== undefined && !isStr(k.field)) || !Array.isArray(k.values) || k.values.length === 0) return 'wrong_kind';
    const vals = k.values as unknown[];
    if (vals.length > BALANCE_LIMITS.keyValues) return 'too_large';
    if (vals.every(isStr)) {
      if (vals.some((x) => x === '') || new Set(vals).size !== vals.length) return 'wrong_kind';
    } else if (vals.every(isNum)) {
      for (let i = 1; i < vals.length; i++) if (!((vals[i] as number) > (vals[i - 1] as number))) return 'not_ascending';
    } else return 'wrong_kind';
    size *= vals.length;
  }
  if (size > BALANCE_LIMITS.cells) return 'too_large';
  if (!Array.isArray(v.cells) || v.cells.length !== size || !v.cells.every(isNum)) return 'wrong_kind';
  return null;
}

const listOf = (v: unknown, max: number, item: (x: unknown) => boolean): string | null =>
  !Array.isArray(v) || !v.every(item) ? 'wrong_kind' : v.length > max ? 'too_large' : null;
const isRole = (x: unknown) => isObj(x) && isStr(x.name) && isStr(x.type);
const isNamed = (x: unknown) => isObj(x) && isStr(x.name) && isStr(x.formula);
const isExample = (x: unknown) => isObj(x) && isObj(x.roles) && Object.values(x.roles).every(isStr)
  && Number.isInteger(x.seed) && (x.seed as number) >= 0 && (x.seed as number) <= 0xffffffff;

/** Problem code of a rule value's shape (null = fine); its formulas are checked by checkBalance. */
export function ruleProblem(v: unknown): string | null {
  if (!isObj(v) || !isStr(v.result)) return 'wrong_kind';
  return listOf(v.roles, BALANCE_LIMITS.roles, isRole) ?? listOf(v.parts, BALANCE_LIMITS.parts, isNamed)
    ?? listOf(v.examples, BALANCE_LIMITS.examples, isExample);
}

/** Problem code of a scenario value's shape (null = fine); its formulas are checked by checkBalance. */
export function scenarioProblem(v: unknown): string | null {
  if (!isObj(v) || !isStr(v.end) || !isNum(v.cap) || v.cap <= 0) return 'wrong_kind';
  const isState = (x: unknown) => isObj(x) && isStr(x.name) && isStr(x.start);
  const clocks = listOf(v.clocks, BALANCE_LIMITS.clocks, (x) => isObj(x) && isStr(x.name) && isStr(x.every) && (x.first === undefined || isStr(x.first)) && Array.isArray(x.do) && x.do.every(isNamed));
  if (clocks) return clocks;
  if ((v.clocks as { do: unknown[] }[]).some((c) => c.do.length > BALANCE_LIMITS.updates)) return 'too_large';
  return listOf(v.roles, BALANCE_LIMITS.roles, isRole) ?? listOf(v.state, BALANCE_LIMITS.state, isState)
    ?? listOf(v.measures, BALANCE_LIMITS.measures, isNamed);
}

// ------------------------------------------------------------------------------------------------ checking

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
/** Why `name` can't name a role, part, state variable, clock or measure; null when it can. */
export function badName(name: string): string | null {
  if (!NAME_RE.test(name)) return `'${name}' is not a name: use letters, digits and _, starting with a letter`;
  if (name.length > 64) return `'${name.slice(0, 20)}…' is longer than 64 characters`;
  if (KEYWORDS.has(name)) return `'${name}' is a word of the formula language`;
  if (Object.hasOwn(Object.prototype, name)) return `'${name}' can't be used as a name`;
  return null;
}

/** Why a table or rule can't have this name (a built-in function or a word of the language), else null. */
function takenName(name: string): string | null {
  if (name.includes('.')) return null;
  if (isBuiltin(name)) return `left out: '${name}' is the name of a built-in function, so formulas can't name it; change the entry's key`;
  if (KEYWORDS.has(name)) return `left out: '${name}' is a word of the formula language, so formulas can't name it; change the entry's key`;
  return null;
}

/** The game-facing name of a table or rule: the entry's key, or `key.field` when its type has several of that kind. */
export const balanceName = (entryKey: string, fieldKey: string, several: boolean): string => (several ? `${entryKey}.${fieldKey}` : entryKey);

/** One table, rule or scenario field of a live typed entry whose value passed validateValue. */
export interface BalanceField {
  entry: string;
  def: FieldDef;
  value: TableValue | RuleValue | ScenarioValue;
  /** Its name in formulas (balanceName); null when the entry's key is invalid or not unique, so it can't be named. */
  name: string | null;
}
export interface BalanceInput {
  fields: BalanceField[];
  /** Visible fields of the entry type with this key, null when there is no such type. */
  typeFields(typeKey: string): FieldDef[] | null;
  /** Display name of a type, for messages. */
  typeName(typeKey: string): string;
  fits(typeKey: string, target: string): boolean;
  /** The typed entry with this (unique) key: its type key and its valid, visible field values; null when there is none. */
  entry(key: string): { typeKey: string; values: Record<string, unknown> } | null;
}
export type BalanceProblemCode = 'formula_error' | 'broken_ref' | 'wrong_type_ref';
export interface BalanceProblem { entry: string; problem: BalanceProblemCode; detail: string }
/** A saved example run with the formula language: the golden sample the export carries. */
export interface GoldenSample { roles: Record<string, string>; seed: number; parts: Record<string, Value>; result: Value }

export interface BalanceTable { name: string; entry: string; field: string; unit?: string; value: TableValue }
export interface BalanceRule {
  name: string; entry: string; field: string; value: RuleValue; samples: GoldenSample[];
  /** What the rule gives (number, true/false, word): its signature for formulas that call it (the editor's checks). */
  resultType?: FType;
}
export interface BalanceScenario { name: string; entry: string; field: string; value: ScenarioValue }
/** What passed: only these are exported; everything left out was reported as a problem. */
export interface BalanceResult { tables: BalanceTable[]; rules: BalanceRule[]; scenarios: BalanceScenario[] }

export interface RoleBinding {
  /** The bound entries' field values by role (only the visible, valid ones: what the export carries). */
  values: Record<string, Record<string, unknown>>;
  /** Why a role could not be bound (empty when all were). */
  problems: { problem: BalanceProblemCode; detail: string }[];
}
/**
 * Binds each role of a rule or scenario to the entry whose key `keys` gives it: missing roles, missing entries, entries
 * of the wrong type and keys that are not roles are problems. Used by the rules' examples and by the simulator.
 */
export function bindRoles(
  roles: FormulaRole[], keys: Record<string, string>, input: Pick<BalanceInput, 'entry' | 'fits' | 'typeName'>, of: 'rule' | 'scenario',
): RoleBinding {
  const out: RoleBinding = { values: {}, problems: [] };
  for (const r of roles) {
    const key = own(keys, r.name);
    const e = key === undefined ? null : input.entry(key);
    if (key === undefined) out.problems.push({ problem: 'formula_error', detail: `no entry for role ${r.name}` });
    else if (!e) out.problems.push({ problem: 'broken_ref', detail: `${r.name} → ${key} is missing or deleted` });
    else if (!input.fits(e.typeKey, r.type)) out.problems.push({ problem: 'wrong_type_ref', detail: `${r.name} → ${key} is not a ${input.typeName(r.type)}` });
    else out.values[r.name] = e.values;
  }
  const extra = Object.keys(keys).filter((k) => !roles.some((r) => r.name === k));
  if (extra.length) out.problems.push({ problem: 'formula_error', detail: `${extra.join(', ')} ${extra.length === 1 ? 'is not a role' : 'are not roles'} of the ${of}` });
  return out;
}

/** `time`: seconds since a scenario run started, readable in its clocks, updates, end and measures. */
export const SCENARIO_TIME = 'time';

interface RuleWork {
  f: BalanceField; name: string; value: RuleValue;
  parts: { name: string; tree: Expr | null }[]; result: Expr | null;
  calls: string[]; errors: string[]; ok: boolean; depth: number;
}

const ANY: FType = { kind: 'any' };
const at = (p: { message: string; from: number; to: number }) => `${p.message} (at ${p.from + 1})`;

/**
 * Checks every table, rule and scenario field given: names, role types, formulas against the roles' fields, the tables
 * and the other rules, rule calls (unknown, broken, in a loop, deeper than MAX_RULE_DEPTH), and runs each saved example
 * of a sound rule into a golden sample. Each problem is passed to `add`; the result lists only what passed.
 * Bounded: formulas by the language's limits; all examples together by BALANCE_LIMITS.exampleSteps and examplesRun
 * (spent in name order, deterministic, no clock); rule trees by BALANCE_LIMITS.ruleChars.
 */
export function checkBalance(input: BalanceInput, add: (p: BalanceProblem) => void): BalanceResult {
  const out: BalanceResult = { tables: [], rules: [], scenarios: [] };
  const problem = (f: BalanceField, detail: string, code: BalanceProblemCode = 'formula_error') => add({ entry: f.entry, problem: code, detail: `${f.def.key}: ${detail}` });
  const unnamed = (f: BalanceField) => problem(f, `left out: the entry's key is invalid or not unique, so the ${f.def.kind} has no name`);
  // Name order everywhere (then entry and field): the ruleChars cap and the examples' step budget leave out the same
  // ones wherever the checks run.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const fields = [...input.fields].sort((a, b) => cmp(a.name ?? '', b.name ?? '') || cmp(a.entry, b.entry) || cmp(a.def.key, b.def.key));

  // ---- Tables: valid by shape already; they only need a name. ----
  const tables: Record<string, TableData> = {};
  for (const f of fields) {
    if (f.def.kind !== 'table') continue;
    if (f.name === null) { unnamed(f); continue; }
    const taken = takenName(f.name);
    if (taken) { problem(f, taken); continue; }
    const value = f.value as TableValue;
    tables[f.name] = f.def.unit ? { ...value, unit: f.def.unit } : value;
    out.tables.push({ name: f.name, entry: f.entry, field: f.def.key, ...(f.def.unit ? { unit: f.def.unit } : {}), value });
  }

  /** Scope roles for a list of roles; problems (bad names, unknown types) go to `errors`. */
  const rolesScope = (roles: FormulaRole[], errors: string[]): Record<string, ScopeRole> => {
    const scope: Record<string, ScopeRole> = {};
    for (const r of roles) {
      const bad = badName(r.name);
      if (bad) { errors.push(`role ${r.name}: ${bad}`); continue; }
      if (own(scope, r.name)) { errors.push(`role ${r.name}: named twice`); continue; }
      const fields = input.typeFields(r.type);
      if (!fields) errors.push(`role ${r.name}: there is no type '${r.type}'`);
      scope[r.name] = { type: r.type, label: fields ? input.typeName(r.type) : r.type, fields: fields ?? [] };
    }
    return scope;
  };
  const parse = (text: string, where: string, errors: string[]): Expr | null => {
    const p = parseFormula(text);
    if ('error' in p) { errors.push(`${where}: ${at(p.error)}`); return null; }
    return p.tree;
  };

  // ---- Rules: parse, then check in call order (callees first), so each knows its callees' result types. ----
  const rules = new Map<string, RuleWork>();
  let chars = 0;
  for (const f of fields) {
    if (f.def.kind !== 'rule') continue;
    if (f.name === null) { unnamed(f); continue; }
    const taken = takenName(f.name);
    if (taken) { problem(f, taken); continue; }
    const value = f.value as RuleValue;
    const errors: string[] = [];
    const w: RuleWork = { f, name: f.name, value, parts: [], result: null, calls: [], errors, ok: false, depth: 1 };
    chars += value.parts.reduce((n, p) => n + p.formula.length, value.result.length);
    if (chars > BALANCE_LIMITS.ruleChars) {
      errors.push(`left out: the campaign's rules are longer than ${BALANCE_LIMITS.ruleChars.toLocaleString('en-US')} characters together`);
      rules.set(f.name, w);
      continue;
    }
    w.parts = value.parts.map((p) => ({ name: p.name, tree: parse(p.formula, `part ${p.name}`, errors) }));
    w.result = parse(value.result, 'result', errors);
    rules.set(f.name, w);
  }
  const isRule = (n: string) => rules.has(n);
  for (const w of rules.values()) {
    const calls = new Set<string>();
    for (const t of [...w.parts.map((p) => p.tree), w.result]) if (t) for (const c of calledRules(t, isRule)) calls.add(c);
    w.calls = [...calls];
  }
  const sigs: Record<string, RuleSig> = {};
  const checkRule = (w: RuleWork) => {
    const errors = w.errors;
    const roles = rolesScope(w.value.roles, errors);
    const parts: Record<string, FType> = {};
    const scope: FormulaScope = { roles, tables, rules: sigs, parts, fits: input.fits };
    for (const p of w.parts) {
      const bad = badName(p.name);
      if (bad) errors.push(`part ${p.name}: ${bad}`);
      else if (own(parts, p.name) || own(roles, p.name)) errors.push(`part ${p.name}: the name is already used`);
      let type = ANY;
      if (p.tree) {
        const c = checkFormula(p.tree, scope);
        for (const e of c.errors) errors.push(`part ${p.name}: ${at(e)}`);
        if (c.type.kind === 'range') errors.push(`part ${p.name}: is a range; use roll(…) to get a number from it`);
        else type = c.type;
      }
      if (!bad && !own(parts, p.name)) parts[p.name] = type;
    }
    let result = ANY;
    if (w.result) {
      const c = checkFormula(w.result, scope);
      for (const e of c.errors) errors.push(`result: ${at(e)}`);
      if (c.type.kind === 'range') errors.push('result: is a range; use roll(…) to get a number from it');
      else result = c.type;
    }
    sigs[w.name] = { roles: w.value.roles.map((r) => ({ name: r.name, type: r.type })), result };
  };
  // Kahn's order over the call graph: a rule is checked once all the rules it calls are.
  const waiting = new Map<string, number>();
  const callers = new Map<string, string[]>();
  for (const w of rules.values()) {
    waiting.set(w.name, w.calls.length);
    for (const c of w.calls) { const l = callers.get(c); if (l) l.push(w.name); else callers.set(c, [w.name]); }
  }
  const ready = [...rules.values()].filter((w) => w.calls.length === 0);
  const done = new Set<string>();
  while (ready.length) {
    const w = ready.pop()!;
    done.add(w.name);
    checkRule(w);
    for (const c of w.calls) {
      const callee = rules.get(c)!;
      if (!callee.ok) w.errors.push(`calls rule ${c}, which has problems`);
      w.depth = Math.max(w.depth, callee.depth + 1);
    }
    if (w.depth > MAX_RULE_DEPTH) w.errors.push(`calls rules ${w.depth} deep (through ${w.calls.join(', ')}); the limit is ${MAX_RULE_DEPTH}`);
    w.ok = w.errors.length === 0;
    for (const n of callers.get(w.name) ?? []) {
      const left = waiting.get(n)! - 1;
      waiting.set(n, left);
      if (left === 0) ready.push(rules.get(n)!);
    }
  }
  // The rest call themselves in a loop, or call a rule that does: name each loop, check their formulas all the same.
  const rest = [...rules.values()].filter((w) => !done.has(w.name));
  if (rest.length) {
    for (const w of rest) sigs[w.name] = { roles: w.value.roles.map((r) => ({ name: r.name, type: r.type })), result: ANY };
    const graph: Record<string, string[]> = {};
    for (const w of rest) graph[w.name] = w.calls.filter((c) => !done.has(c));
    const inLoop = new Set<string>();
    for (let cycle = findRuleCycle(graph); cycle; cycle = findRuleCycle(graph)) {
      for (const n of cycle.slice(0, -1)) {
        if (!inLoop.has(n)) rules.get(n)!.errors.push(`calls itself in a loop (${cycle.join(' → ')})`);
        inLoop.add(n);
        delete graph[n];
      }
      for (const k of Object.keys(graph)) graph[k] = graph[k].filter((c) => !inLoop.has(c));
    }
    for (const w of rest) {
      checkRule(w);
      if (!inLoop.has(w.name)) w.errors.push(`calls rule ${w.calls.find((c) => !done.has(c) || !rules.get(c)!.ok)}, which has problems`);
    }
  }

  // ---- Report rules; run the examples of the sound ones. ----
  const programs: Record<string, RuleProgram> = {};
  for (const w of rules.values()) {
    if (w.ok) programs[w.name] = { roles: w.value.roles, parts: w.parts.map((p) => ({ name: p.name, tree: p.tree! })), result: w.result! };
  }
  // One budget for every example of the campaign, spent in name order; past it, the rest are not run (and say so).
  let stepsLeft = BALANCE_LIMITS.exampleSteps;
  let runsLeft = BALANCE_LIMITS.examplesRun;
  let stopped: string | null = null;
  for (const w of rules.values()) {
    for (const e of w.errors) problem(w.f, e);
    if (!w.ok) continue;
    const samples: GoldenSample[] = [];
    w.value.examples.forEach((ex, i) => {
      const where = `example ${i + 1}`;
      const b = bindRoles(w.value.roles, ex.roles, input, 'rule');
      for (const p of b.problems) problem(w.f, `${where}: ${p.detail}`, p.problem);
      if (b.problems.length) return;
      const bound = b.values;
      if (!stopped && runsLeft <= 0) stopped = `the campaign has more than ${BALANCE_LIMITS.examplesRun.toLocaleString('en-US')} examples`;
      if (stopped) { problem(w.f, `${where}: not run: ${stopped}`); return; }
      runsLeft--;
      const budget: StepBudget = { steps: 0, max: Math.min(MAX_STEPS, stepsLeft) };
      try {
        const r = evaluateRule(programs[w.name], bound, { tables, rules: programs }, makeRng(ex.seed), w.name, budget);
        samples.push({ roles: { ...ex.roles }, seed: ex.seed, parts: r.parts, result: r.result });
      } catch (err) {
        if (!(err instanceof FormulaError)) throw err;
        if (budget.steps > budget.max && budget.max < MAX_STEPS) {
          stopped = `the campaign's examples took more than ${BALANCE_LIMITS.exampleSteps.toLocaleString('en-US')} steps`;
          problem(w.f, `${where}: not run: ${stopped}`);
        } else problem(w.f, `${where}: ${err.rule && err.rule !== w.name ? `in rule ${err.rule}: ` : ''}${at(err)}`);
      }
      stepsLeft -= Math.min(budget.steps, budget.max);
    });
    out.rules.push({ name: w.name, entry: w.f.entry, field: w.f.def.key, value: w.value, samples, resultType: sigs[w.name].result });
  }
  rules.clear();

  // ---- Scenarios: checked one at a time; their trees are not kept. ----
  const sound = new Set(out.rules.map((r) => r.name));
  for (const f of fields) {
    if (f.def.kind !== 'scenario') continue;
    if (f.name === null) { unnamed(f); continue; }
    const v = f.value as ScenarioValue;
    const errors: string[] = [];
    const roles = rolesScope(v.roles, errors);
    const state: Record<string, FType> = {};
    const scope: FormulaScope = { roles, tables, rules: sigs, state, fits: input.fits };
    const formula = (text: string, where: string, want?: FType['kind']): FType => {
      const tree = parse(text, where, errors);
      if (!tree) return ANY;
      for (const c of calledRules(tree, (n) => !!own(sigs, n) && !sound.has(n))) errors.push(`${where}: calls rule ${c}, which has problems`);
      const c = checkFormula(tree, scope);
      for (const e of c.errors) errors.push(`${where}: ${at(e)}`);
      if (c.errors.length || c.type.kind === 'any') return ANY;
      if (c.type.kind === 'range') { errors.push(`${where}: is a range; use roll(…) to get a number from it`); return ANY; }
      if (want && c.type.kind !== want) errors.push(`${where}: needs ${want === 'bool' ? 'a true/false value' : 'a number'}`);
      return c.type;
    };
    const named = (n: string, where: string, taken: (n: string) => boolean): boolean => {
      const bad = badName(n);
      if (bad) { errors.push(`${where}: ${bad}`); return false; }
      if (taken(n)) { errors.push(`${where}: the name is already used`); return false; }
      return true;
    };
    for (const s of v.state) {
      const ok = named(s.name, `state ${s.name}`, (n) => n === SCENARIO_TIME || !!own(state, n) || !!own(roles, n));
      const t = formula(s.start, `state ${s.name}`);
      if (ok) state[s.name] = t;
    }
    state[SCENARIO_TIME] = { kind: 'number', unit: 's' };
    const clockNames = new Set<string>();
    for (const c of v.clocks) {
      if (named(c.name, `clock ${c.name}`, (n) => clockNames.has(n))) clockNames.add(c.name);
      if (c.first !== undefined) formula(c.first, `clock ${c.name}: first`, 'number');
      formula(c.every, `clock ${c.name}: every`, 'number');
      for (const u of c.do as NamedFormula[]) {
        const where = `clock ${c.name}: ${u.name}`;
        const target = u.name === SCENARIO_TIME ? undefined : own(state, u.name);
        const t = formula(u.formula, where);
        if (!target) { errors.push(`${where}: ${u.name === SCENARIO_TIME ? 'time moves by itself; it can\'t be set' : `there is no state '${u.name}' to set`}`); continue; }
        if (target.kind !== 'any' && t.kind !== 'any' && t.kind !== target.kind) {
          errors.push(`${where}: ${u.name} holds ${target.kind === 'bool' ? 'a true/false value' : `a ${target.kind}`}, not ${t.kind === 'bool' ? 'a true/false value' : `a ${t.kind}`}`);
        }
      }
    }
    formula(v.end, 'end', 'bool');
    const measureNames = new Set<string>();
    for (const m of v.measures) {
      if (named(m.name, `measure ${m.name}`, (n) => measureNames.has(n))) measureNames.add(m.name);
      formula(m.formula, `measure ${m.name}`, 'number');
    }
    for (const e of errors) problem(f, e);
    if (!errors.length) out.scenarios.push({ name: f.name, entry: f.entry, field: f.def.key, value: v });
  }
  return out;
}

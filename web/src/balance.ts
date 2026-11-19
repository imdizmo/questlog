// The formula editor's and simulator's view of a campaign: which entries roles can use (and the values formulas see
// of them), the scope a formula is checked against, plain-word checks of a rule or scenario being edited, and the live
// example of a rule. Pure functions over the store; the editors call them on every keystroke, so each is small.
import type { Card, EntryType, FieldDef, FormulaRole, RuleValue, ScenarioValue } from '../../shared/types';
import { titleOf } from '../../shared/cards';
import { fieldsOf, formulaValues, isTypeOrChild, KEY_RE, refContext } from '../../shared/wiki';
import { badName, SCENARIO_TIME, type BalanceResult } from '../../shared/balance';
import {
  checkFormula, describe, evaluate, FormulaError, makeRng, MAX_STEPS, own, parseFormula,
  type Expr, type FormulaProblem, type FormulaScope, type FType, type RuleSig, type ScopeRole, type StepBudget, type TableSig, type Value,
} from '../../shared/formula';
import { simData, type SimData } from '../../shared/sim';
import { campaignBalanceResult, campaignLore, type ChecksInput } from './wiki';

// ---------------------------------------------------------------------------------------------- the campaign

/** An entry a role can be bound to. */
export interface RoleEntry { key: string; title: string; typeKey: string }
/** What the editors need to know of a campaign's types and entries. */
export interface Lookup {
  /** Types of the campaign, in their order. */
  types: EntryType[];
  /** The typed entry with this key (valid and unique): its type key and what formulas see of it; null when none. */
  entry(key: string): { typeKey: string; values: Record<string, unknown> } | null;
  fits(typeKey: string, target: string): boolean;
  typeName(typeKey: string): string;
  /** Visible fields of a type (by key); null when there is no such type. */
  typeFields(typeKey: string): FieldDef[] | null;
  /** Entries of a type or a child of it that a role can use, by title. */
  entriesOf(typeKey: string): RoleEntry[];
  /** What passed the checks: tables, rules (with golden samples) and scenarios. */
  balance: BalanceResult;
}

let lastLookup: { in: ChecksInput; projectId: string; out: Lookup } | null = null;
const LOOKUP_INPUT: (keyof ChecksInput)[] = ['cards', 'decks', 'entryTypes', 'linkKinds', 'entryLinks', 'files'];

/** The campaign as the editors see it; recomputed only when a store collection it reads (or the project) changes. */
export function campaignLookup(s: ChecksInput, projectId: string): Lookup {
  const l = lastLookup;
  if (l && l.projectId === projectId && LOOKUP_INPUT.every((k) => l.in[k] === s[k])) return l.out;
  const types = [...s.entryTypes.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
  const typeMap = new Map(types.map((t) => [t.id, t]));
  const typeByKey = new Map(types.map((t) => [t.key, t]));
  // The same entries the checks see: live Lore of the project whose type is one of its types.
  const live = campaignLore(s.cards.values(), projectId, s.decks).filter((c) => !!c.entryTypeId && typeMap.has(c.entryTypeId));
  const ctx = refContext(typeMap, live);
  const byKey = new Map<string, Card[]>();
  for (const c of live) if (c.entryKey) byKey.set(c.entryKey, [...(byKey.get(c.entryKey) ?? []), c]);
  const unique = (k: string) => KEY_RE.test(k) && byKey.get(k)?.length === 1;
  const visible = new Map<string, FieldDef[]>();
  const fieldsOfType = (id: string) => {
    let defs = visible.get(id);
    if (!defs) { defs = fieldsOf(typeMap, id).filter((f) => !f.hidden); visible.set(id, defs); }
    return defs;
  };
  const values = new Map<string, { typeKey: string; values: Record<string, unknown> } | null>();
  const out: Lookup = {
    types,
    entry: (k) => {
      if (values.has(k)) return values.get(k)!;
      const c = unique(k) ? byKey.get(k)![0] : undefined;
      const found = c ? { typeKey: typeMap.get(c.entryTypeId!)!.key, values: formulaValues(fieldsOfType(c.entryTypeId!), c.fields, ctx) } : null;
      values.set(k, found);
      return found;
    },
    fits: ctx.fits,
    typeName: (k) => typeByKey.get(k)?.name ?? k,
    typeFields: (k) => { const t = typeByKey.get(k); return t ? fieldsOfType(t.id) : null; },
    entriesOf: (typeKey) => live
      .filter((c) => c.entryKey && unique(c.entryKey) && isTypeOrChild(typeMap, c.entryTypeId!, [typeKey]))
      .map((c) => ({ key: c.entryKey!, title: titleOf(c.content) || c.entryKey!, typeKey: typeMap.get(c.entryTypeId!)!.key }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key)),
    balance: campaignBalanceResult(s, projectId),
  };
  lastLookup = { in: { cards: s.cards, decks: s.decks, entryTypes: s.entryTypes, linkKinds: s.linkKinds, entryLinks: s.entryLinks, files: s.files }, projectId, out };
  return out;
}

const dataCache = new WeakMap<BalanceResult, SimData>();
/** The campaign's tables and rules, ready to run (parsed once per check result). */
export function runData(b: BalanceResult): SimData {
  let d = dataCache.get(b);
  if (!d) { d = simData(b); dataCache.set(b, d); }
  return d;
}

// ---------------------------------------------------------------------------------------------- scopes

/** Tables and other rules a formula may name; `except` (the rule being edited) is left out, so it can't call itself. */
export function baseScope(l: Lookup, except?: string): FormulaScope {
  const tables: Record<string, TableSig> = {};
  for (const t of l.balance.tables) Object.defineProperty(tables, t.name, { value: { keys: t.value.keys, mode: t.value.mode, ...(t.unit ? { unit: t.unit } : {}) }, enumerable: true });
  const rules: Record<string, RuleSig> = {};
  for (const r of l.balance.rules) {
    if (r.name === except) continue;
    Object.defineProperty(rules, r.name, { value: { roles: r.value.roles.map((x) => ({ name: x.name, type: x.type })), result: r.resultType ?? { kind: 'any' } }, enumerable: true });
  }
  return { tables, rules, fits: l.fits };
}

/** The roles as a formula sees them, and why each one can't be used (null when it can). */
export function rolesScope(roles: FormulaRole[], l: Lookup): { roles: Record<string, ScopeRole>; problems: (string | null)[] } {
  const scope: Record<string, ScopeRole> = {};
  const problems = roles.map((r) => {
    const bad = badName(r.name);
    if (bad) return bad;
    if (own(scope, r.name)) return `there is already a role '${r.name}'`;
    const fields = l.typeFields(r.type);
    scope[r.name] = { type: r.type, label: fields ? l.typeName(r.type) : r.type, fields: fields ?? [] };
    return fields ? null : r.type ? `there is no type '${r.type}'` : 'pick a type';
  });
  return { roles: scope, problems };
}

// ---------------------------------------------------------------------------------------------- checking

export interface FormulaCheck {
  /** Problems in plain words with their place in the text (empty when the formula is fine). */
  problems: FormulaProblem[];
  /** What the formula gives; `any` when unknown (after a problem). */
  type: FType;
  tree: Expr | null;
}
const ANY: FType = { kind: 'any' };

/** One formula against a scope; `want` adds "needs a number" / "needs a true/false value". */
export function checkOne(text: string, scope: FormulaScope, want?: 'number' | 'bool'): FormulaCheck {
  if (!text.trim()) return { problems: [{ message: 'write a formula here', from: 0, to: 0 }], type: ANY, tree: null };
  const p = parseFormula(text);
  if ('error' in p) return { problems: [p.error], type: ANY, tree: null };
  const c = checkFormula(p.tree, scope);
  const problems = [...c.errors];
  let type = c.errors.length ? ANY : c.type;
  const all = { from: 0, to: text.length };
  if (type.kind === 'range') { problems.push({ message: 'this is a range; use roll(…) to get a number from it', ...all }); type = ANY; }
  if (want && type.kind !== 'any' && type.kind !== want) {
    problems.push({ message: `needs ${want === 'bool' ? 'a true/false value' : 'a number'}, not ${describe(type)}`, ...all });
  }
  return { problems, type, tree: p.tree };
}

/** The draft of a rule, checked: a problem per role, per part name, and each formula's check. */
export interface RuleCheck {
  roles: (string | null)[];
  parts: { name: string | null; formula: FormulaCheck; scope: FormulaScope }[];
  result: FormulaCheck;
  resultScope: FormulaScope;
  ok: boolean;
}

/** Checks a rule draft the way the campaign checks do (roles, part names, each formula against the parts above it). */
export function checkRule(v: RuleValue, l: Lookup, ruleName?: string): RuleCheck {
  const base = baseScope(l, ruleName);
  const { roles, problems } = rolesScope(v.roles, l);
  const parts: Record<string, FType> = {};
  const out: RuleCheck['parts'] = [];
  for (const p of v.parts) {
    const scope: FormulaScope = { ...base, roles, parts: { ...parts } };
    const bad = badName(p.name);
    const name = bad ?? (own(parts, p.name) || own(roles, p.name) ? `the name '${p.name}' is already used` : null);
    const formula = checkOne(p.formula, scope);
    out.push({ name, formula, scope });
    if (!bad && !own(parts, p.name)) Object.defineProperty(parts, p.name, { value: formula.type, enumerable: true });
  }
  const resultScope: FormulaScope = { ...base, roles, parts };
  const result = checkOne(v.result, resultScope);
  const ok = problems.every((x) => !x) && out.every((p) => !p.name && !p.formula.problems.length) && !result.problems.length;
  return { roles: problems, parts: out, result, resultScope, ok };
}

/** The draft of a scenario, checked like the campaign checks do. */
export interface ScenarioCheck {
  roles: (string | null)[];
  state: { name: string | null; start: FormulaCheck; scope: FormulaScope }[];
  clocks: { name: string | null; first: FormulaCheck | null; every: FormulaCheck; do: { name: string | null; formula: FormulaCheck }[] }[];
  /** Scope of clocks, end and measures: every state variable and `time`. */
  scope: FormulaScope;
  end: FormulaCheck;
  cap: string | null;
  measures: { name: string | null; formula: FormulaCheck }[];
  ok: boolean;
}

const kindWords = (t: FType) => (t.kind === 'bool' ? 'a true/false value' : `a ${t.kind}`);

export function checkScenario(v: ScenarioValue, l: Lookup): ScenarioCheck {
  const base = baseScope(l);
  const { roles, problems } = rolesScope(v.roles, l);
  const state: Record<string, FType> = {};
  const named = (n: string, taken: boolean) => badName(n) ?? (taken ? `the name '${n}' is already used` : null);
  const stateOut: ScenarioCheck['state'] = [];
  for (const s of v.state) {
    const scope: FormulaScope = { ...base, roles, state: { ...state } };
    const name = s.name === SCENARIO_TIME ? "'time' is the scenario's clock; pick another name" : named(s.name, !!own(state, s.name) || !!own(roles, s.name));
    const start = checkOne(s.start, scope);
    stateOut.push({ name, start, scope });
    if (!name) Object.defineProperty(state, s.name, { value: start.type, enumerable: true });
  }
  Object.defineProperty(state, SCENARIO_TIME, { value: { kind: 'number', unit: 's' }, enumerable: true });
  const scope: FormulaScope = { ...base, roles, state };
  const clockNames = new Set<string>();
  const clocks = v.clocks.map((c) => {
    const name = named(c.name, clockNames.has(c.name));
    clockNames.add(c.name);
    return {
      name,
      first: c.first === undefined ? null : checkOne(c.first, scope, 'number'),
      every: checkOne(c.every, scope, 'number'),
      do: c.do.map((u) => {
        const target = u.name === SCENARIO_TIME ? undefined : own(state, u.name);
        const formula = checkOne(u.formula, scope);
        let nameProblem: string | null = null;
        if (u.name === SCENARIO_TIME) nameProblem = "time moves by itself; it can't be set";
        else if (!target) nameProblem = u.name ? `there is no state '${u.name}' to set` : 'pick what to set';
        else if (target.kind !== 'any' && formula.type.kind !== 'any' && formula.type.kind !== target.kind) {
          formula.problems.push({ message: `${u.name} holds ${kindWords(target)}, not ${kindWords(formula.type)}`, from: 0, to: u.formula.length });
        }
        return { name: nameProblem, formula };
      }),
    };
  });
  const end = checkOne(v.end, scope, 'bool');
  const cap = typeof v.cap === 'number' && Number.isFinite(v.cap) && v.cap > 0 ? null : 'the time cap must be a number of seconds above 0';
  const measureNames = new Set<string>();
  const measures = v.measures.map((m) => {
    const name = named(m.name, measureNames.has(m.name));
    measureNames.add(m.name);
    return { name, formula: checkOne(m.formula, scope, 'number') };
  });
  const fine = (f: FormulaCheck | null) => !f || !f.problems.length;
  const ok = problems.every((x) => !x) && stateOut.every((s) => !s.name && fine(s.start)) && !cap && fine(end)
    && clocks.every((c) => !c.name && fine(c.first) && fine(c.every) && c.do.every((u) => !u.name && fine(u.formula)))
    && measures.every((m) => !m.name && fine(m.formula));
  return { roles: problems, state: stateOut, clocks, scope, end, cap, measures, ok };
}

// ---------------------------------------------------------------------------------------------- the live example

export interface ExampleStep { name: string; value?: Value; problem?: string }
export interface ExampleRun {
  /** Why the example can't run at all (a role without an entry, …); null when it ran. */
  blocked: string | null;
  parts: ExampleStep[];
  result: ExampleStep;
}

/**
 * Runs a rule draft on picked entries with a seed, the way the export runs a saved example into a golden sample (one
 * generator for the parts in order, then the result), so "Save as example" saves exactly what is shown. A part that
 * fails stops the run there: later parts are shown as not run.
 */
export function runExample(v: RuleValue, c: RuleCheck, picked: Record<string, string>, seed: number, l: Lookup): ExampleRun {
  const notRun = (name: string): ExampleStep => ({ name });
  const out: ExampleRun = { blocked: null, parts: v.parts.map((p) => notRun(p.name)), result: notRun('result') };
  const values: Record<string, Record<string, unknown>> = {};
  for (const r of v.roles) {
    const key = own(picked, r.name);
    if (!key) { out.blocked = `Pick an entry for ${r.name || 'each role'}.`; return out; }
    const e = l.entry(key);
    if (!e) { out.blocked = `${key} is missing.`; return out; }
    if (!l.fits(e.typeKey, r.type)) { out.blocked = `${key} is not a ${l.typeName(r.type)}.`; return out; }
    Object.defineProperty(values, r.name, { value: e.values, enumerable: true });
  }
  const data = runData(l.balance);
  const parts: Record<string, Value> = {};
  const rng = makeRng(seed);
  const budget: StepBudget = { steps: 0, max: MAX_STEPS };
  const step = (name: string, check: FormulaCheck): ExampleStep | null => {
    if (!check.tree || check.problems.length) return { name, problem: 'fix this formula first' };
    try {
      return { name, value: evaluate(check.tree, { roles: values, tables: data.tables, rules: data.rules, parts }, rng, budget) };
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      return { name, problem: `${err.rule ? `in rule ${err.rule}: ` : ''}${err.message}` };
    }
  };
  for (let i = 0; i < v.parts.length; i++) {
    const s = step(v.parts[i].name, c.parts[i].formula)!;
    out.parts[i] = s;
    if (s.problem !== undefined) return out;
    if (!c.parts[i].name) Object.defineProperty(parts, v.parts[i].name, { value: s.value, enumerable: true, writable: true });
  }
  out.result = step('result', c.result)!;
  return out;
}

/** A value for display: numbers to at most 4 decimals (the stored value is exact), true/false as yes/no. */
export function showValue(v: Value | undefined, unit?: string): string {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return `'${v}'`;
  const n = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return unit ? `${n} ${unit}` : n;
}

/** The unit a part or result is in, when the check knows it. */
export const unitOfType = (t: FType): string | undefined => (t.kind === 'number' ? t.unit : undefined);

/** A random seed for a new example (0 … 2^32 − 1). */
export const newSeed = (): number => Math.floor(Math.random() * 0x100000000) >>> 0;

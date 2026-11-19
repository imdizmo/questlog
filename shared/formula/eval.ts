import { tableRefName, type TableData } from './check';
import { FormulaError, own } from './lexer';
import { MAX_DEPTH, type Expr } from './parser';
import type { Rng } from './random';

export const MAX_RULE_DEPTH = 16;
/** Steps (values computed) one evaluation may take, counted across every rule it calls. */
export const MAX_STEPS = 1_000_000;
/**
 * Steps counted so far and the most allowed (MAX_STEPS for one evaluation). A caller may share one budget across many
 * evaluations, with a lower max, to bound them together. Table work counts too: a lookup or pick costs its table's size.
 */
export interface StepBudget { steps: number; max: number }
type Budget = StepBudget;

/** A formula's result: a number, true/false, or a word (an enum value). */
export type Value = number | boolean | string;
interface Range { min: number; max: number }
type Inner = Value | Range;

/** A rule ready to run: its roles in call order, its named parts in order, and its result. */
export interface RuleProgram { roles: { name: string }[]; parts: { name: string; tree: Expr }[]; result: Expr }

/** What a formula reads while running. Role values are the bound entry's field values by field key. */
export interface FormulaEnv {
  roles?: Record<string, Record<string, unknown>>;
  tables?: Record<string, TableData>;
  rules?: Record<string, RuleProgram>;
  parts?: Record<string, Value>;
  state?: Record<string, Value>;
}

const isRange = (v: unknown): v is Range =>
  typeof v === 'object' && v !== null && typeof (v as Range).min === 'number' && typeof (v as Range).max === 'number';
const kindOf = (v: Inner): string =>
  typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a true/false value' : typeof v === 'string' ? 'a word' : 'a range';

class Run {
  constructor(private readonly env: FormulaEnv, private readonly rng: Rng, private readonly stack: string[], private readonly budget: Budget) {}

  private fail(message: string, e: Expr): never { throw new FormulaError(message, e.from, e.to); }

  /** Counts `n` steps of work that is not a value (scanning a table). */
  private charge(n: number, e: Expr): void {
    this.budget.steps += n;
    if (this.budget.steps > this.budget.max) {
      this.fail(`this formula takes too many steps (more than ${this.budget.max.toLocaleString('en-US')}); a rule may call others too often`, e);
    }
  }

  private numOf(e: Expr, d: number, what: string): number {
    const v = this.val(e, d);
    if (typeof v !== 'number') this.fail(`${what} needs a number, not ${kindOf(v)}`, e);
    return v;
  }
  private boolOf(e: Expr, d: number, what: string): boolean {
    const v = this.val(e, d);
    if (typeof v !== 'boolean') this.fail(`${what} needs a true/false value, not ${kindOf(v)}`, e);
    return v;
  }
  private finite(n: number, e: Expr): number {
    if (!Number.isFinite(n)) this.fail('the result is too large or not a number', e);
    return n;
  }

  val(e: Expr, d: number): Inner {
    if (d > MAX_DEPTH) this.fail(`the formula is nested too deeply (more than ${MAX_DEPTH} levels)`, e);
    if (++this.budget.steps > this.budget.max) {
      this.fail(`this formula takes too many steps (more than ${this.budget.max.toLocaleString('en-US')}); a rule may call others too often`, e);
    }
    switch (e.t) {
      case 'num': case 'word': case 'bool': return e.v;
      case 'field': {
        const role = own(this.env.roles, e.role);
        if (!role) this.fail(`no entry is set for the role '${e.role}'`, e);
        const v = own(role, e.field);
        if (typeof v === 'number' && !Number.isFinite(v)) this.fail(`'${e.role}' has a value for '${e.field}' that is not a finite number`, e);
        if (isRange(v) && !(Number.isFinite(v.min) && Number.isFinite(v.max))) this.fail(`'${e.role}' has a range for '${e.field}' that is not finite`, e);
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || isRange(v)) return v;
        this.fail(`'${e.role}' has no value for '${e.field}'`, e);
      }
      case 'name': {
        const p = own(this.env.parts, e.name);
        if (p !== undefined) return p;
        const s = own(this.env.state, e.name);
        if (s !== undefined) return s;
        this.fail(`unknown name '${e.name}'`, e);
      }
      case 'unary':
        return e.op === 'not' ? !this.boolOf(e.arg, d + 1, 'not') : -this.numOf(e.arg, d + 1, 'a minus sign');
      case 'binary': return this.binary(e, d);
      case 'call': return this.call(e, d);
    }
    throw new FormulaError('this formula has a part this version does not understand', (e as Expr).from, (e as Expr).to);
  }

  private binary(e: Extract<Expr, { t: 'binary' }>, d: number): Inner {
    switch (e.op) {
      // Short-circuit: the right side (and any randomness in it) only runs when needed.
      case 'and': return this.boolOf(e.left, d + 1, "'and'") && this.boolOf(e.right, d + 1, "'and'");
      case 'or': return this.boolOf(e.left, d + 1, "'or'") || this.boolOf(e.right, d + 1, "'or'");
      case '==': case '!=': {
        const l = this.val(e.left, d + 1), r = this.val(e.right, d + 1);
        if (isRange(l) || isRange(r)) this.fail("ranges can't be compared; use roll(…)", e);
        if (typeof l !== typeof r) this.fail(`can't compare ${kindOf(l)} with ${kindOf(r)}`, e);
        return e.op === '==' ? l === r : l !== r;
      }
      default: break;
    }
    const what = `'${e.op}'`;
    const l = this.numOf(e.left, d + 1, what);
    const r = this.numOf(e.right, d + 1, what);
    switch (e.op) {
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '>=': return l >= r;
      case '+': return this.finite(l + r, e);
      case '-': return this.finite(l - r, e);
      case '*': return this.finite(l * r, e);
      case '/':
        if (r === 0) this.fail("can't divide by zero", e.right);
        return this.finite(l / r, e);
      case '^': return this.finite(l ** r, e);
    }
  }

  private call(e: Extract<Expr, { t: 'call' }>, d: number): Inner {
    const a = e.args;
    const n = (i: number) => this.numOf(a[i], d + 1, e.fn);
    const need = (k: number) => { if (a.length !== k) this.fail(`${e.fn} takes ${k} value${k === 1 ? '' : 's'}`, e); };
    switch (e.fn) {
      case 'if':
        need(3);
        return this.boolOf(a[0], d + 1, 'the condition of if') ? this.val(a[1], d + 1) : this.val(a[2], d + 1);
      case 'min': case 'max': {
        if (a.length < 2) this.fail(`${e.fn} takes at least 2 values`, e);
        const xs = a.map((_, i) => n(i));
        return e.fn === 'min' ? Math.min(...xs) : Math.max(...xs);
      }
      case 'clamp': {
        need(3);
        const x = n(0), lo = n(1), hi = n(2);
        if (lo > hi) this.fail(`clamp's low (${lo}) is above its high (${hi})`, e);
        return Math.min(Math.max(x, lo), hi);
      }
      case 'round': {
        if (a.length < 1 || a.length > 2) this.fail('round takes 1 or 2 values', e);
        const x = n(0);
        if (a.length === 1) return Math.round(x);
        const k = n(1);
        if (!Number.isInteger(k) || k < 0 || k > 10) this.fail('round can keep 0 to 10 digits', a[1]);
        const f = 10 ** k;
        return this.finite(Math.round(x * f) / f, e);
      }
      case 'floor': need(1); return Math.floor(n(0));
      case 'ceil': need(1); return Math.ceil(n(0));
      case 'abs': need(1); return Math.abs(n(0));
      case 'rand': need(0); return this.rng.float();
      case 'randint': {
        need(2);
        const lo = n(0), hi = n(1);
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) this.fail('randint needs whole numbers', e);
        if (lo > hi) this.fail(`randint's first number (${lo}) is above its second (${hi})`, e);
        const count = hi - lo + 1;
        if (count > 16777216) this.fail('randint can pick from at most 16,777,216 numbers', e);
        return lo + Math.floor(this.rng.float() * count);
      }
      case 'chance': need(1); { const p = n(0); return this.rng.float() < p; }
      case 'roll': {
        need(1);
        const r = this.val(a[0], d + 1);
        if (!isRange(r)) this.fail(`roll needs a range, not ${kindOf(r)}`, a[0]);
        if (r.min > r.max) this.fail(`this range's min (${r.min}) is above its max (${r.max})`, a[0]);
        return r.min + this.rng.float() * (r.max - r.min);
      }
      case 'pick': {
        need(1);
        const [name, t] = this.table(a[0]);
        if (t.keys.length !== 1) this.fail('pick needs a table with one key', a[0]);
        this.charge(t.cells.length, a[0]);
        let total = 0;
        for (const w of t.cells) {
          if (!(w >= 0) || !Number.isFinite(w)) this.fail(`table ${name} has a weight below zero or not a number`, a[0]);
          total += w;
        }
        if (total <= 0) this.fail(`table ${name}'s weights add up to zero`, a[0]);
        const x = this.rng.float() * total;
        let acc = 0;
        let last = 0;
        for (let i = 0; i < t.cells.length; i++) {
          if (t.cells[i] <= 0) continue;
          acc += t.cells[i];
          last = i;
          if (x < acc) return t.keys[0].values[i];
        }
        return t.keys[0].values[last];
      }
      case 'table': {
        const [name, t] = this.table(a[0]);
        if (a.length - 1 !== t.keys.length) this.fail(`table ${name} takes ${t.keys.length} key${t.keys.length === 1 ? '' : 's'}`, e);
        return this.lookup(name, t, a.slice(1), d);
      }
    }
    const rule = own(this.env.rules, e.fn);
    if (rule) return this.rule(e, rule);
    this.fail(`there's no function or rule '${e.fn}'`, e);
  }

  private table(a: Expr): [string, TableData] {
    const name = tableRefName(a);
    const t = name === null ? undefined : own(this.env.tables, name);
    if (name === null || !t) this.fail(name !== null ? `unknown table '${name}'` : "a table's name is needed here", a);
    let size = 1;
    for (const k of t.keys) size *= k.values.length;
    if (t.keys.length < 1 || t.keys.length > 2 || t.cells.length !== size) this.fail(`table ${name} is incomplete`, a);
    return [name, t];
  }

  /** Each key gives cell indexes with weights (two for linear between thresholds); the result is the weighted sum. */
  private lookup(name: string, t: TableData, keys: Expr[], d: number): number {
    const axes = keys.map((k, i): [number, number][] => {
      const vals = t.keys[i].values;
      const v = this.val(k, d + 1);
      this.charge(vals.length, k);
      if (typeof vals[0] === 'string') {
        if (typeof v !== 'string') this.fail(`table ${name} needs a word here, not ${kindOf(v)}`, k);
        const at = (vals as string[]).indexOf(v);
        if (at < 0) this.fail(`table ${name} has no '${v}'`, k);
        return [[at, 1]];
      }
      if (typeof v !== 'number') this.fail(`table ${name} needs a number here, not ${kindOf(v)}`, k);
      const th = vals as number[];
      if (t.mode === 'exact') {
        const at = th.indexOf(v);
        if (at < 0) this.fail(`table ${name} has no ${v}`, k);
        return [[at, 1]];
      }
      for (let j = 1; j < th.length; j++) if (!(th[j] > th[j - 1])) this.fail(`table ${name}'s numbers must go up`, k);
      if (v <= th[0]) return [[0, 1]];
      const last = th.length - 1;
      if (v >= th[last]) return [[last, 1]];
      let j = 0;
      while (th[j + 1] <= v) j++;
      if (t.mode === 'step') return [[j, 1]];
      const f = (v - th[j]) / (th[j + 1] - th[j]);
      return f === 0 ? [[j, 1]] : [[j, 1 - f], [j + 1, f]];
    });
    const n1 = t.keys.length === 2 ? t.keys[1].values.length : 1;
    let sum = 0;
    for (const [i0, w0] of axes[0]) {
      if (axes.length === 1) { sum += w0 * t.cells[i0]; continue; }
      for (const [i1, w1] of axes[1]) sum += w0 * w1 * t.cells[i0 * n1 + i1];
    }
    if (!Number.isFinite(sum)) this.fail(`table ${name} has a number that is not finite`, keys[0]);
    return sum;
  }

  private rule(e: Extract<Expr, { t: 'call' }>, rule: RuleProgram): Value {
    if (this.stack.includes(e.fn)) this.fail(`rule '${e.fn}' calls itself (${[...this.stack, e.fn].join(' → ')})`, e);
    if (this.stack.length >= MAX_RULE_DEPTH) this.fail(`rules call each other too deeply (more than ${MAX_RULE_DEPTH})`, e);
    if (e.args.length !== rule.roles.length) this.fail(`${e.fn} takes ${rule.roles.length} roles`, e);
    const roles: Record<string, Record<string, unknown>> = {};
    rule.roles.forEach((r, i) => {
      const a = e.args[i];
      const bound = a.t === 'name' ? own(this.env.roles, a.name) : undefined;
      if (!bound) this.fail(`${e.fn} needs a role for '${r.name}'`, a);
      roles[r.name] = bound;
    });
    try {
      return runRule(rule, roles, this.env, this.rng, [...this.stack, e.fn], this.budget).result;
    } catch (err) {
      if (err instanceof FormulaError && err.rule === undefined) err.rule = e.fn;
      throw err;
    }
  }
}

function finish(v: Inner, e: Expr): Value {
  if (isRange(v)) throw new FormulaError('the result is a range; use roll(…) to get a number from it', e.from, e.to);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new FormulaError('the result is too large or not a number', e.from, e.to);
  return v;
}

function runRule(rule: RuleProgram, roles: Record<string, Record<string, unknown>>, env: FormulaEnv, rng: Rng, stack: string[], budget: Budget) {
  const parts: Record<string, Value> = {};
  const inner: FormulaEnv = { roles, tables: env.tables, rules: env.rules, parts };
  const run = new Run(inner, rng, stack, budget);
  for (const p of rule.parts) parts[p.name] = finish(run.val(p.tree, 1), p.tree);
  return { parts: { ...parts }, result: finish(run.val(rule.result, 1), rule.result) };
}

/**
 * Runs a formula. Throws FormulaError (plain message, place in the text, and `rule` when it happened in a called rule)
 * on a problem only visible with real values: a missing field value, division by zero, clamp low above high, ...
 * `and`, `or` and `if` only run the side they need, so randomness on the other side is not drawn. A `budget` shared
 * by several evaluations bounds them together (the simulator gives one to each run).
 */
export function evaluate(tree: Expr, env: FormulaEnv, rng: Rng, budget: StepBudget = { steps: 0, max: MAX_STEPS }): Value {
  return finish(new Run(env, rng, [], budget).val(tree, 1), tree);
}

/** Runs a rule: its parts in order (each may use the ones before), then its result. `ruleKey` guards against cycles. */
export function evaluateRule(
  rule: RuleProgram, roles: Record<string, Record<string, unknown>>, env: Omit<FormulaEnv, 'roles' | 'parts'>, rng: Rng, ruleKey?: string,
  budget: StepBudget = { steps: 0, max: MAX_STEPS },
): { parts: Record<string, Value>; result: Value } {
  return runRule(rule, roles, env, rng, ruleKey ? [ruleKey] : [], budget);
}

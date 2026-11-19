import type { FieldDef } from '../types';
import { own, type FormulaProblem } from './lexer';
import { MAX_DEPTH, type Expr } from './parser';

/** The type of a formula value. Words are enum values (strings); `options` lists the allowed ones when known. */
export type FType =
  | { kind: 'number'; unit?: string }
  | { kind: 'bool' }
  | { kind: 'word'; options?: string[] }
  | { kind: 'range'; unit?: string }
  /** Unknown, after an error: accepted everywhere so one mistake gives one message. */
  | { kind: 'any' };

export type TableMode = 'exact' | 'step' | 'linear';
/**
 * One key of a table: an enum field's options (words, always looked up exactly) or numeric thresholds in ascending
 * order (looked up by the table's mode). `field` names the field the key usually comes from, for display.
 */
export interface TableKey { field?: string; values: string[] | number[] }
/** What a formula needs to know about a table to check it. */
export interface TableSig { keys: TableKey[]; mode: TableMode; unit?: string }
/** A table with its numbers: `cells` is row-major (first key's index × second key's count + second key's index). */
export interface TableData extends TableSig { cells: number[] }

/** A role a formula can read: its entry type key (and a label for messages, e.g. the type's name) and fields. */
export interface ScopeRole { type?: string; label?: string; fields: FieldDef[] }
/** Another rule's signature: its roles in order (with the entry type each expects) and its result type. */
export interface RuleSig { roles: { name: string; type?: string }[]; result: FType }

/** Everything a formula may name. */
export interface FormulaScope {
  roles?: Record<string, ScopeRole>;
  tables?: Record<string, TableSig>;
  rules?: Record<string, RuleSig>;
  /** Named parts this formula may use (in a rule: the parts above it). */
  parts?: Record<string, FType>;
  /** State variables (in a scenario). */
  state?: Record<string, FType>;
  /** Does an entry of type `typeKey` fit a role expecting `target` (the type or a child)? Default: same key. */
  fits?: (typeKey: string, target: string) => boolean;
}

export interface CheckResult { type: FType; errors: FormulaProblem[] }

export interface FnInfo { name: string; signature: string; help: string }
/** The built-in functions, in the order completion lists them. */
export const FUNCTIONS: FnInfo[] = [
  { name: 'if', signature: 'if(condition, then, else)', help: 'then when the condition holds, else otherwise' },
  { name: 'min', signature: 'min(a, b, …)', help: 'the smallest number' },
  { name: 'max', signature: 'max(a, b, …)', help: 'the largest number' },
  { name: 'clamp', signature: 'clamp(x, low, high)', help: 'x kept between low and high' },
  { name: 'round', signature: 'round(x[, digits])', help: 'x rounded (halves up)' },
  { name: 'floor', signature: 'floor(x)', help: 'x rounded down' },
  { name: 'ceil', signature: 'ceil(x)', help: 'x rounded up' },
  { name: 'abs', signature: 'abs(x)', help: 'x without its sign' },
  { name: 'rand', signature: 'rand()', help: 'a random number from 0 up to (not including) 1' },
  { name: 'randint', signature: 'randint(a, b)', help: 'a random whole number from a to b, both included' },
  { name: 'chance', signature: 'chance(p)', help: 'true with probability p (0 to 1)' },
  { name: 'roll', signature: 'roll(role.range)', help: 'any number from the range’s min up to (not including) its max, [min, max); for whole numbers use round(roll(…))' },
  { name: 'pick', signature: 'pick(table)', help: 'one of a one-key table’s keys, weighted by its numbers' },
  { name: 'table', signature: 'table(table, key[, key2])', help: 'the number in a table for the keys' },
];
const FN_NAMES = new Set(FUNCTIONS.map((f) => f.name));
export const isBuiltin = (name: string): boolean => FN_NAMES.has(name);

// ---------------------------------------------------------------------------------------------- did you mean

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The closest known name to `name` (case-insensitive, at most 1 edit for short names, 2 for longer), or null. */
export function closest(name: string, known: Iterable<string>): string | null {
  const low = name.toLowerCase();
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    if (k === name) continue;
    const d = k.toLowerCase() === low ? 0 : distance(low, k.toLowerCase());
    if (d <= limit && d < bestD) { best = k; bestD = d; }
  }
  return best;
}
const hint = (name: string, known: Iterable<string>) => {
  const c = closest(name, known);
  return c === null ? '' : ` — did you mean '${c}'?`;
};

// ---------------------------------------------------------------------------------------------- checker

/**
 * The table a `table(…)`/`pick(…)` argument names: `name`, or `entry.field` (an entry with several table fields);
 * null when it is not a name.
 */
export function tableRefName(a: Expr): string | null {
  return a.t === 'name' ? a.name : a.t === 'field' ? `${a.role}.${a.field}` : null;
}

const NUM: FType = { kind: 'number' };
const BOOL: FType = { kind: 'bool' };
const ANY: FType = { kind: 'any' };

/** "a number", "a word", ... for messages. */
export function describe(t: FType): string {
  switch (t.kind) {
    case 'number': return 'a number';
    case 'bool': return 'a true/false value';
    case 'word': return 'a word';
    case 'range': return 'a range';
    case 'any': return 'a value';
  }
}

/** The formula type of a field, or a reason it can't be used in formulas. */
export function fieldType(def: FieldDef): FType | string {
  switch (def.kind) {
    case 'number': case 'integer': return def.unit ? { kind: 'number', unit: def.unit } : NUM;
    case 'boolean': return BOOL;
    case 'enum': return { kind: 'word', options: def.options ?? [] };
    case 'text': case 'longtext': case 'color': return { kind: 'word' };
    case 'range': return def.unit ? { kind: 'range', unit: def.unit } : { kind: 'range' };
    case 'multienum': return 'is a list of options; formulas can only read single values';
    case 'entry': case 'entries': return 'links to other entries; formulas can only read numbers, words and ranges';
    default: return `is a ${def.kind} field; formulas can only read numbers, words and ranges`;
  }
}

const unitOf = (t: FType): string | undefined => (t.kind === 'number' || t.kind === 'range' ? t.unit : undefined);
const num = (unit?: string): FType => (unit ? { kind: 'number', unit } : NUM);

const VERB: Record<string, [string, string]> = {
  '+': ['add', 'to'], '-': ['subtract', 'from'], '*': ['multiply', 'by'], '/': ['divide', 'by'], '^': ['raise', 'to the power of'],
};

class Checker {
  readonly errors: FormulaProblem[] = [];
  constructor(private readonly scope: FormulaScope) {}

  private err(message: string, at: { from: number; to: number }): FType {
    this.errors.push({ message, from: at.from, to: at.to });
    return ANY;
  }
  private roleName(role: string): string {
    const r = own(this.scope.roles, role);
    return r?.label ?? r?.type ?? role;
  }
  private knownValueNames(): string[] {
    return [
      ...Object.keys(this.scope.parts ?? {}), ...Object.keys(this.scope.state ?? {}),
      ...Object.keys(this.scope.roles ?? {}), ...Object.keys(this.scope.tables ?? {}),
    ];
  }

  /** Expects a value of `want` kind; reports `what` otherwise. Returns the type when it fits. */
  private want(t: FType, want: FType['kind'], e: Expr, what: string): boolean {
    if (t.kind === 'any' || t.kind === want) return true;
    const extra = t.kind === 'range' && want === 'number' ? '; use roll(…) to get a number from a range' : '';
    this.err(`${what} needs ${describe({ kind: want } as FType)}, not ${describe(t)}${extra}`, e);
    return false;
  }

  check(e: Expr, depth: number): FType {
    if (depth > MAX_DEPTH) return this.err(`the formula is nested too deeply (more than ${MAX_DEPTH} levels)`, e);
    switch (e.t) {
      case 'num': return NUM;
      case 'bool': return BOOL;
      case 'word': return { kind: 'word' };
      case 'field': return this.field(e);
      case 'name': return this.name(e);
      case 'unary': {
        const a = this.check(e.arg, depth + 1);
        if (e.op === 'not') { this.want(a, 'bool', e.arg, 'not'); return BOOL; }
        this.want(a, 'number', e.arg, 'a minus sign');
        return num(unitOf(a));
      }
      case 'binary': return this.binary(e, depth);
      case 'call': return this.call(e, depth);
    }
  }

  private field(e: Extract<Expr, { t: 'field' }>): FType {
    const role = own(this.scope.roles, e.role);
    if (!role && own(this.scope.tables, `${e.role}.${e.field}`)) {
      return this.err(`'${e.role}.${e.field}' is a table; look a number up with table(${e.role}.${e.field}, …)`, e);
    }
    if (!role) {
      if (own(this.scope.parts, e.role) || own(this.scope.state, e.role)) return this.err(`'${e.role}' is a value, not a role; it has no fields`, e);
      return this.err(`unknown role '${e.role}'${hint(e.role, Object.keys(this.scope.roles ?? {}))}`, e);
    }
    const def = role.fields.find((f) => f.key === e.field);
    if (!def) {
      return this.err(`'${this.roleName(e.role)}' has no field '${e.field}'${hint(e.field, role.fields.map((f) => f.key))}`, e);
    }
    const t = fieldType(def);
    return typeof t === 'string' ? this.err(`'${e.role}.${e.field}' ${t}`, e) : t;
  }

  private name(e: Extract<Expr, { t: 'name' }>): FType {
    const s = this.scope;
    const part = own(s.parts, e.name);
    if (part) return part;
    const st = own(s.state, e.name);
    if (st) return st;
    if (own(s.roles, e.name)) return this.err(`'${e.name}' is a role; use one of its fields, like ${e.name}.${own(s.roles, e.name)!.fields[0]?.key ?? 'field'}`, e);
    if (own(s.tables, e.name)) return this.err(`'${e.name}' is a table; look a number up with table(${e.name}, …)`, e);
    if (isBuiltin(e.name) || own(s.rules, e.name)) return this.err(`'${e.name}' needs brackets: ${e.name}(…)`, e);
    return this.err(`unknown name '${e.name}'${hint(e.name, this.knownValueNames())}`, e);
  }

  private binary(e: Extract<Expr, { t: 'binary' }>, depth: number): FType {
    const l = this.check(e.left, depth + 1);
    const r = this.check(e.right, depth + 1);
    switch (e.op) {
      case 'and': case 'or':
        this.want(l, 'bool', e.left, `'${e.op}'`);
        this.want(r, 'bool', e.right, `'${e.op}'`);
        return BOOL;
      case '==': case '!=': {
        if (l.kind === 'any' || r.kind === 'any') return BOOL;
        if (l.kind === 'range' || r.kind === 'range') { this.err("ranges can't be compared; use roll(…) to get a number from a range", e); return BOOL; }
        if (l.kind !== r.kind) { this.err(`can't compare ${describe(l)} with ${describe(r)}`, e); return BOOL; }
        if (l.kind === 'word' && r.kind === 'word') { this.wordFits(e.left, r); this.wordFits(e.right, l); }
        return BOOL;
      }
      case '<': case '<=': case '>': case '>=':
        if (l.kind === 'word' || r.kind === 'word') { this.err(`only numbers can be compared with ${e.op}; words can only be compared with == or !=`, e); return BOOL; }
        this.want(l, 'number', e.left, `'${e.op}'`);
        this.want(r, 'number', e.right, `'${e.op}'`);
        return BOOL;
      default: {
        const lOk = l.kind === 'number' || l.kind === 'any';
        const rOk = r.kind === 'number' || r.kind === 'any';
        if (!lOk || !rOk) {
          const [verb, prep] = VERB[e.op];
          const bad = !lOk ? l : r;
          const other = !lOk ? r : l;
          const range = bad.kind === 'range' ? '; use roll(…) to get a number from a range' : '';
          return this.err(`can't ${verb} ${describe(bad)} ${prep} ${describe(other.kind === 'any' ? NUM : other)}${range}`, e);
        }
        const lu = unitOf(l), ru = unitOf(r);
        if (e.op === '+' || e.op === '-') return num(lu === ru ? lu : lu && !ru ? lu : !lu && ru ? ru : undefined);
        if (e.op === '*') return num(lu && ru ? undefined : lu ?? ru);
        if (e.op === '/') return num(ru ? undefined : lu);
        return NUM;
      }
    }
  }

  /** A word literal compared with a word of known options must be one of them. */
  private wordFits(e: Expr, other: FType): void {
    if (e.t !== 'word' || other.kind !== 'word' || !other.options) return;
    if (!other.options.includes(e.v)) {
      this.err(`'${e.v}' is not one of the options (${other.options.join(', ')})${hint(e.v, other.options)}`, e);
    }
  }

  private arity(e: Extract<Expr, { t: 'call' }>, min: number, max: number, sig: string): boolean {
    const n = e.args.length;
    if (n >= min && n <= max) return true;
    this.err(`${e.fn} takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} or ${max}`} value${max === 1 && min === 1 ? '' : 's'}: ${sig}`, e);
    return false;
  }

  private call(e: Extract<Expr, { t: 'call' }>, depth: number): FType {
    const sig = FUNCTIONS.find((f) => f.name === e.fn)?.signature ?? '';
    const nums = (what: string): FType[] => e.args.map((a) => {
      const t = this.check(a, depth + 1);
      this.want(t, 'number', a, what);
      return t;
    });
    switch (e.fn) {
      case 'if': {
        if (!this.arity(e, 3, 3, sig)) { e.args.forEach((a) => this.check(a, depth + 1)); return ANY; }
        const c = this.check(e.args[0], depth + 1);
        this.want(c, 'bool', e.args[0], 'the condition of if');
        const a = this.check(e.args[1], depth + 1);
        const b = this.check(e.args[2], depth + 1);
        if (a.kind === 'any') return b;
        if (b.kind === 'any') return a;
        if (a.kind !== b.kind) return this.err(`both results of if must be the same kind: ${describe(a)} and ${describe(b)} given`, e);
        if (a.kind === 'number') return num(unitOf(a) === unitOf(b) ? unitOf(a) : undefined);
        if (a.kind === 'word' && b.kind === 'word') return a.options && b.options ? { kind: 'word', options: [...new Set([...a.options, ...b.options])] } : { kind: 'word' };
        return a;
      }
      case 'min': case 'max': {
        this.arity(e, 2, Infinity, sig);
        const ts = nums(e.fn);
        const u = unitOf(ts[0] ?? NUM);
        return num(ts.every((t) => unitOf(t) === u) ? u : undefined);
      }
      case 'clamp': {
        this.arity(e, 3, 3, sig);
        const ts = nums('clamp');
        const [, lo, hi] = e.args;
        if (lo?.t === 'num' && hi?.t === 'num' && lo.v > hi.v) this.err(`clamp's low (${lo.v}) is above its high (${hi.v})`, e);
        return num(unitOf(ts[0] ?? NUM));
      }
      case 'round': {
        this.arity(e, 1, 2, sig);
        const ts = nums('round');
        const d = e.args[1];
        if (d && d.t === 'num' && (!Number.isInteger(d.v) || d.v > 10)) this.err('round can keep 0 to 10 digits', d);
        return num(unitOf(ts[0] ?? NUM));
      }
      case 'floor': case 'ceil': case 'abs': {
        this.arity(e, 1, 1, sig);
        return num(unitOf(nums(e.fn)[0] ?? NUM));
      }
      case 'rand':
        this.arity(e, 0, 0, sig);
        e.args.forEach((a) => this.check(a, depth + 1));
        return NUM;
      case 'randint': {
        this.arity(e, 2, 2, sig);
        nums('randint');
        const [a, b] = e.args;
        if (a?.t === 'num' && b?.t === 'num' && a.v > b.v) this.err(`randint's first number (${a.v}) is above its second (${b.v})`, e);
        for (const x of e.args) if (x.t === 'num' && !Number.isInteger(x.v)) this.err('randint needs whole numbers', x);
        return NUM;
      }
      case 'chance':
        this.arity(e, 1, 1, sig);
        nums('chance');
        return BOOL;
      case 'roll': {
        if (!this.arity(e, 1, 1, sig)) return NUM;
        const t = this.check(e.args[0], depth + 1);
        if (t.kind !== 'range' && t.kind !== 'any') return this.err(`roll needs a range field, like ${this.rangeExample()}; got ${describe(t)}`, e.args[0]);
        return num(unitOf(t));
      }
      case 'pick': {
        if (!this.arity(e, 1, 1, sig)) return ANY;
        const tbl = this.tableArg(e.args[0], 'pick');
        if (!tbl) return ANY;
        if (tbl.keys.length !== 1) return this.err('pick needs a table with one key', e.args[0]);
        const vals = tbl.keys[0].values;
        return typeof vals[0] === 'number' ? NUM : { kind: 'word', options: vals as string[] };
      }
      case 'table': {
        if (e.args.length < 2) { this.err(`table takes a table and its keys: ${sig}`, e); e.args.slice(1).forEach((a) => this.check(a, depth + 1)); return NUM; }
        const tbl = this.tableArg(e.args[0], 'table');
        const keys = e.args.slice(1);
        if (!tbl) { keys.forEach((k) => this.check(k, depth + 1)); return NUM; }
        const name = tableRefName(e.args[0])!;
        if (keys.length !== tbl.keys.length) {
          keys.forEach((k) => this.check(k, depth + 1));
          return this.err(`table ${name} has ${tbl.keys.length} key${tbl.keys.length === 1 ? '' : 's'}, so it takes ${tbl.keys.length} after its name; ${keys.length} given`, e);
        }
        keys.forEach((k, i) => this.tableKey(name, tbl.keys[i], k, depth + 1));
        return num(tbl.unit);
      }
    }
    const rule = own(this.scope.rules, e.fn);
    if (rule) return this.ruleCall(e, rule);
    e.args.forEach((a) => { if (a.t !== 'name') this.check(a, depth + 1); });
    const r = own(this.scope.roles, e.fn) ? ' (it is a role)' : own(this.scope.parts, e.fn) || own(this.scope.state, e.fn) ? ' (it is a value)' : '';
    return this.err(`there's no function or rule '${e.fn}'${r}${r ? '' : hint(e.fn, [...FN_NAMES, ...Object.keys(this.scope.rules ?? {})])}`, { from: e.from, to: e.from + e.fn.length });
  }

  private rangeExample(): string {
    for (const [name, r] of Object.entries(this.scope.roles ?? {})) {
      const f = r.fields.find((d) => d.kind === 'range');
      if (f) return `${name}.${f.key}`;
    }
    return 'attacker.damage';
  }

  private tableArg(a: Expr, fn: string): TableSig | null {
    const name = tableRefName(a);
    if (name !== null && own(this.scope.tables, name)) return own(this.scope.tables, name)!;
    if (name !== null && a.t === 'field' && !own(this.scope.roles, a.role)) {
      this.err(`unknown table '${name}'${hint(name, Object.keys(this.scope.tables ?? {}))}`, a);
      return null;
    }
    if (a.t === 'name') {
      this.err(`unknown table '${a.name}'${hint(a.name, Object.keys(this.scope.tables ?? {}))}`, a);
      return null;
    }
    this.err(`${fn} needs a table's name first`, a);
    return null;
  }

  private tableKey(table: string, key: TableKey, arg: Expr, depth: number): void {
    const t = this.check(arg, depth);
    if (t.kind === 'any') return;
    const words = key.values.length > 0 && typeof key.values[0] === 'string';
    const label = key.field ? `${table}'s ${key.field} key` : `${table}'s key`;
    if (words) {
      if (!this.want(t, 'word', arg, label)) return;
      const vals = key.values as string[];
      if (arg.t === 'word' && !vals.includes(arg.v)) {
        this.err(`table ${table} has no '${arg.v}' (it has ${vals.join(', ')})${hint(arg.v, vals)}`, arg);
      } else if (t.kind === 'word' && t.options) {
        const missing = t.options.filter((o) => !vals.includes(o));
        if (missing.length) this.err(`table ${table} has no ${missing.map((m) => `'${m}'`).join(', ')}, which this value can be`, arg);
      }
    } else {
      this.want(t, 'number', arg, label);
    }
  }

  private ruleCall(e: Extract<Expr, { t: 'call' }>, rule: RuleSig): FType {
    if (e.args.length !== rule.roles.length) {
      return this.err(`${e.fn} takes ${rule.roles.length} role${rule.roles.length === 1 ? '' : 's'} (${rule.roles.map((r) => r.name).join(', ')}); ${e.args.length} given`, e);
    }
    const fits = this.scope.fits ?? ((a: string, b: string) => a === b);
    e.args.forEach((a, i) => {
      const want = rule.roles[i];
      if (a.t !== 'name' || !own(this.scope.roles, a.name)) {
        this.err(`${e.fn} needs a role for '${want.name}'${a.t === 'name' ? `; '${a.name}' is not a role${hint(a.name, Object.keys(this.scope.roles ?? {}))}` : ''}`, a);
        return;
      }
      const have = own(this.scope.roles, a.name)!;
      if (want.type && have.type && !fits(have.type, want.type)) {
        this.err(`${e.fn} expects a ${want.type} for '${want.name}', but '${a.name}' is a ${have.label ?? have.type}`, a);
      }
    });
    return rule.result;
  }
}

/** Type-checks a parsed formula against what it may name. `errors` is empty when the formula is fine. */
export function checkFormula(tree: Expr, scope: FormulaScope): CheckResult {
  const c = new Checker(scope);
  const type = c.check(tree, 1);
  return { type, errors: c.errors };
}

/** The rule keys a formula calls (not built-ins), for cycle checks. */
export function calledRules(tree: Expr, isRule: (name: string) => boolean): string[] {
  const out = new Set<string>();
  const walk = (e: Expr, d: number): void => {
    if (d > MAX_DEPTH) return;
    if (e.t === 'call') { if (!isBuiltin(e.fn) && isRule(e.fn)) out.add(e.fn); e.args.forEach((a) => walk(a, d + 1)); }
    else if (e.t === 'unary') walk(e.arg, d + 1);
    else if (e.t === 'binary') { walk(e.left, d + 1); walk(e.right, d + 1); }
  };
  walk(tree, 1);
  return [...out];
}

/** A cycle in rule calls (`calls`: rule key → rules it calls), as the path [a, b, …, a], or null when there is none. */
export function findRuleCycle(calls: Record<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    const s = state.get(k);
    if (s === 2) return null;
    if (s === 1) return [...path.slice(path.indexOf(k)), k];
    state.set(k, 1);
    path.push(k);
    for (const n of own(calls, k) ?? []) {
      const c = visit(n);
      if (c) return c;
    }
    path.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of Object.keys(calls)) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- completion

export type CompletionKind = 'role' | 'field' | 'part' | 'state' | 'table' | 'function' | 'rule' | 'option' | 'keyword';
export interface Completion {
  label: string;
  kind: CompletionKind;
  /** The field's unit, e.g. 'hp'. */
  unit?: string;
  /** A short description: the field kind, a function's signature, ... */
  detail?: string;
  /** The text range the completion replaces. */
  from: number;
  to: number;
}

const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);

/** What to offer at `pos` in `text`: fields after `role.`, options inside a quote, otherwise every name in scope. */
export function completions(text: string, pos: number, scope: FormulaScope): Completion[] {
  pos = Math.max(0, Math.min(pos, text.length));
  // Inside an open quote: enum options.
  const quotes = (text.slice(0, pos).match(/'/g) ?? []).length;
  if (quotes % 2 === 1) {
    const from = text.lastIndexOf("'", pos - 1) + 1;
    const prefix = text.slice(from, pos).toLowerCase();
    const seen = new Set<string>();
    const out: Completion[] = [];
    for (const r of Object.values(scope.roles ?? {})) {
      for (const f of r.fields) {
        if (f.kind !== 'enum') continue;
        for (const o of f.options ?? []) {
          if (seen.has(o) || !o.toLowerCase().startsWith(prefix)) continue;
          seen.add(o);
          out.push({ label: o, kind: 'option', detail: f.label || f.key, from, to: pos });
        }
      }
    }
    return out;
  }
  let from = pos;
  while (from > 0 && isNameChar(text[from - 1])) from--;
  const prefix = text.slice(from, pos).toLowerCase();
  const match = (name: string) => name.toLowerCase().startsWith(prefix);
  if (from > 0 && text[from - 1] === '.') {
    let rs = from - 1;
    while (rs > 0 && isNameChar(text[rs - 1])) rs--;
    const head = text.slice(rs, from - 1);
    const role = own(scope.roles, head);
    if (!role) {
      // `entry.field` names of tables and rules (entries with several of them).
      const dotted: Completion[] = [];
      for (const [n, t] of Object.entries(scope.tables ?? {})) {
        if (n.startsWith(`${head}.`) && match(n.slice(head.length + 1))) dotted.push({ label: n.slice(head.length + 1), kind: 'table', detail: `table by ${t.keys.map((k, i) => k.field ?? `key ${i + 1}`).join(' × ')}`, from, to: pos });
      }
      for (const [n, r] of Object.entries(scope.rules ?? {})) {
        if (n.startsWith(`${head}.`) && match(n.slice(head.length + 1))) dotted.push({ label: n.slice(head.length + 1), kind: 'rule', detail: `${n}(${r.roles.map((x) => x.name).join(', ')})`, from, to: pos });
      }
      return dotted;
    }
    return role.fields.filter((f) => match(f.key) && typeof fieldType(f) !== 'string').map((f) => ({
      label: f.key, kind: 'field' as const, ...(f.unit ? { unit: f.unit } : {}), detail: f.label && f.label !== f.key ? `${f.label} (${f.kind})` : f.kind, from, to: pos,
    }));
  }
  const out: Completion[] = [];
  const add = (label: string, kind: CompletionKind, extra: Partial<Completion> = {}) => {
    if (match(label)) out.push({ label, kind, ...extra, from, to: pos });
  };
  const typeDetail = (t: FType) => (t.kind === 'bool' ? 'true/false' : t.kind);
  for (const [n, t] of Object.entries(scope.parts ?? {})) add(n, 'part', { detail: typeDetail(t), ...(unitOf(t) ? { unit: unitOf(t) } : {}) });
  for (const [n, t] of Object.entries(scope.state ?? {})) add(n, 'state', { detail: typeDetail(t), ...(unitOf(t) ? { unit: unitOf(t) } : {}) });
  for (const [n, r] of Object.entries(scope.roles ?? {})) add(n, 'role', { detail: r.label ?? r.type ?? 'role' });
  for (const [n, t] of Object.entries(scope.tables ?? {})) add(n, 'table', { detail: `table by ${t.keys.map((k, i) => k.field ?? `key ${i + 1}`).join(' × ')}` });
  for (const [n, r] of Object.entries(scope.rules ?? {})) add(n, 'rule', { detail: `${n}(${r.roles.map((x) => x.name).join(', ')})` });
  for (const f of FUNCTIONS) add(f.name, 'function', { detail: f.signature });
  for (const k of ['and', 'or', 'not', 'true', 'false']) if (prefix) add(k, 'keyword');
  return out;
}

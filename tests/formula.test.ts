import { describe, it, expect } from 'vitest';
import {
  RANDOM_INFO, parseFormula, checkFormula, evaluate, evaluateRule, makeRng, splitmix32, runSeed, completions, findRuleCycle, calledRules,
  FormulaError, type Expr, type FormulaScope, type FormulaEnv, type TableData, type RuleProgram, type Value,
} from '../shared/formula';
import type { FieldDef } from '../shared/types';

const tree = (text: string): Expr => {
  const r = parseFormula(text);
  if ('error' in r) throw new Error(`parse failed: ${r.error.message}`);
  return r.tree;
};
const parseError = (text: string) => {
  const r = parseFormula(text);
  if (!('error' in r)) throw new Error('expected a parse error');
  return r.error;
};
const run = (text: string, env: FormulaEnv = {}, seed = 1): Value => evaluate(tree(text), env, makeRng(seed));
const runError = (text: string, env: FormulaEnv = {}): FormulaError => {
  try { run(text, env); } catch (e) { if (e instanceof FormulaError) return e; throw e; }
  throw new Error('expected a run error');
};

const swordFields: FieldDef[] = [
  { key: 'damage', label: 'Damage', kind: 'range', unit: 'hp' },
  { key: 'level', label: 'Item level', kind: 'integer' },
  { key: 'kind', label: 'Kind', kind: 'enum', options: ['Pierce', 'Slash'] },
  { key: 'tags', label: 'Tags', kind: 'multienum', options: ['a'] },
];
const slimeFields: FieldDef[] = [
  { key: 'hp', label: 'Health', kind: 'number', unit: 'hp' },
  { key: 'armor', label: 'Armor', kind: 'number', unit: 'hp' },
  { key: 'material', label: 'Material', kind: 'enum', options: ['Wet', 'Dry'] },
  { key: 'boss', label: 'Boss', kind: 'boolean' },
];
const kindVsMaterial: TableData = {
  keys: [{ field: 'kind', values: ['Pierce', 'Slash'] }, { field: 'material', values: ['Wet', 'Dry'] }],
  mode: 'exact', cells: [0.6, 1, 1.2, 0.8],
};
const byLevel = (mode: TableData['mode']): TableData => ({ keys: [{ field: 'level', values: [1, 10, 20] }], mode, cells: [1, 2, 4] });
const drops: TableData = { keys: [{ values: ['Coin', 'Gem', 'Nothing'] }], mode: 'exact', cells: [3, 1, 0] };

const scope: FormulaScope = {
  roles: {
    attacker: { type: 'weapon', label: 'Sword', fields: swordFields },
    target: { type: 'creature', label: 'Slime', fields: slimeFields },
  },
  tables: { kindVsMaterial, byLevel: byLevel('step'), drops },
  rules: { hit: { roles: [{ name: 'a', type: 'weapon' }, { name: 'b', type: 'creature' }], result: { kind: 'number', unit: 'hp' } } },
  parts: { base: { kind: 'number', unit: 'hp' } },
  state: { hits: { kind: 'number' } },
};
const env: FormulaEnv = {
  roles: {
    attacker: { damage: { min: 5, max: 9 }, level: 10, kind: 'Pierce' },
    target: { hp: 45, armor: 2, material: 'Wet', boss: false },
  },
  tables: { kindVsMaterial, byLevel: byLevel('step'), drops },
  parts: { base: 15 },
  state: { hits: 2 },
};
const errorsOf = (text: string, s: FormulaScope = scope) => checkFormula(tree(text), s).errors.map((e) => e.message);

describe('parsing and arithmetic', () => {
  it('follows precedence and associativity', () => {
    expect(run('2^3^2')).toBe(512);
    expect(run('-2^2')).toBe(-4);
    expect(run('(-2)^2')).toBe(4);
    expect(run('2^-1')).toBe(0.5);
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('10 - 4 - 3')).toBe(3);
    expect(run('24 / 4 / 3')).toBe(2);
    expect(run('--3')).toBe(3);
    expect(run('.5 + 1.25')).toBe(1.75);
    expect(run('1 < 2 and 3 > 4 or true')).toBe(true);
    expect(run('not 1 == 2')).toBe(true);
    expect(run('true or false and false')).toBe(true);
  });
  it('keeps positions and gives a plain JSON tree', () => {
    const t = tree('1 + attacker.level');
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
    expect(t).toMatchObject({ t: 'binary', op: '+', from: 0, to: 18, right: { t: 'field', role: 'attacker', field: 'level', from: 4, to: 18 } });
  });
  it('explains syntax errors with a place', () => {
    expect(parseError('')).toMatchObject({ message: 'the formula is empty' });
    expect(parseError('1 +')).toMatchObject({ message: 'the formula ends too early; a value is missing', from: 3 });
    expect(parseError('(1 + 2')).toMatchObject({ message: "this '(' is missing its closing ')'", from: 0, to: 1 });
    expect(parseError('1 + 2)')).toMatchObject({ message: "there's a ')' without a matching '('", from: 5, to: 6 });
    expect(parseError('a = 1').message).toBe('use == to compare two values');
    expect(parseError('1 < 2 < 3').message).toMatch(/can't be chained/);
    expect(parseError("'Pierce").message).toBe('this word has no closing quote');
    expect(parseError('1 # 2')).toMatchObject({ message: "unexpected character '#'", from: 2, to: 3 });
    expect(parseError('max(1,)').message).toBe('a value is missing in max(…)');
    expect(parseError('2 3').message).toMatch(/unexpected '3'/);
  });
});

describe('limits', () => {
  it('refuses a formula over 4 000 characters', () => {
    const ok = '1' + '+1'.repeat(1999) + ' ';
    expect(ok.length).toBe(4000);
    const long = ok + '1';
    expect(long.length).toBe(4001);
    expect(parseError(long)).toEqual({ message: 'the formula is too long (4,001 characters; the limit is 4,000)', from: 4000, to: 4001 });
  });
  it('refuses depth 65 and allows 64', () => {
    const nested = (n: number) => 'abs('.repeat(n - 1) + '1' + ')'.repeat(n - 1); // tree depth n
    expect('tree' in parseFormula(nested(64))).toBe(true);
    expect(parseError(nested(65)).message).toBe('the formula is nested too deeply (more than 64 levels)');
    expect(parseError('('.repeat(65) + '1' + ')'.repeat(65)).message).toMatch(/nested too deeply/);
    expect(parseError('-'.repeat(65) + '1').message).toMatch(/nested too deeply/);
    expect(parseError('2^'.repeat(65) + '2').message).toMatch(/nested too deeply/);
  });
  it('refuses hostile input quickly without blowing the stack', () => {
    expect(parseError('1' + '+1'.repeat(1990)).message).toBe('too many terms in one chain (more than 64); split it with brackets or a named part');
    expect(parseError('1' + '*2'.repeat(64)).message).toMatch(/too many terms in one chain/);
    expect('tree' in parseFormula('1' + '+1'.repeat(63))).toBe(true); // 64 terms
    expect(parseError('true' + ' or true'.repeat(64)).message).toMatch(/too many terms in one chain/);
    expect(parseError('('.repeat(3999)).message).toMatch(/nested too deeply/);
    expect(parseError('not '.repeat(999) + 'true').message).toMatch(/nested too deeply/);
    expect(run('1' + '+1'.repeat(62))).toBe(63);
  });
  it('guards trees that did not come from the parser', () => {
    let t: Expr = { t: 'num', v: 1, from: 0, to: 1 };
    for (let i = 0; i < 100; i++) t = { t: 'unary', op: '-', arg: t, from: 0, to: 1 };
    expect(() => evaluate(t, {}, makeRng(1))).toThrow(/nested too deeply/);
    expect(checkFormula(t, {}).errors[0].message).toMatch(/nested too deeply/);
  });
});

describe('hostile names and numbers', () => {
  const sneaky = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  it('never reaches JS object internals: plain errors when checking', () => {
    for (const n of sneaky) {
      expect(errorsOf(n)).toEqual([`unknown name '${n}'`]);
      expect(errorsOf(`${n}.name`)).toEqual([`unknown role '${n}'`]);
      expect(errorsOf(`${n}(1)`)).toEqual([`there's no function or rule '${n}'`]);
      expect(errorsOf(`table(${n}, 1)`)).toEqual([`unknown table '${n}'`]);
      expect(errorsOf(`pick(${n})`)).toEqual([`unknown table '${n}'`]);
      expect(errorsOf(`target.${n}`)).toEqual([`'Slime' has no field '${n}'`]);
      expect(errorsOf(`hit(${n}, target)`)[0]).toMatch(new RegExp(`'${n}' is not a role`));
    }
    expect(errorsOf('toStrin')).toEqual(["unknown name 'toStrin'"]);
    expect(errorsOf('targe.hp')).toEqual(["unknown role 'targe' — did you mean 'target'?"]);
    expect(errorsOf('toString(a)')).toEqual(["there's no function or rule 'toString'"]);
    expect(errorsOf('constructr(attacker)')).toEqual(["there's no function or rule 'constructr'"]);
  });
  it('never returns or calls JS object internals when running', () => {
    for (const n of sneaky) {
      expect(runError(n, env).message).toBe(`unknown name '${n}'`);
      expect(runError(`${n}.name`, env).message).toBe(`no entry is set for the role '${n}'`);
      expect(runError(`${n}(attacker)`, env).message).toBe(`there's no function or rule '${n}'`);
      expect(runError(`table(${n}, 1)`, env).message).toBe(`unknown table '${n}'`);
      expect(runError(`pick(${n})`, env).message).toBe(`unknown table '${n}'`);
      expect(runError(`target.${n}`, env).message).toBe(`'target' has no value for '${n}'`);
    }
  });
  it('completion lists only real names', () => {
    expect(completions('constructor.', 12, scope)).toEqual([]);
    expect(completions('__proto__.', 10, scope)).toEqual([]);
    expect(completions('toStr', 5, scope)).toEqual([]);
  });
  it('refuses numbers that are not finite', () => {
    expect(parseError('1' + '0'.repeat(400))).toEqual({ message: 'this number is too large', from: 0, to: 401 });
    expect(runError('round(10^300, 10)').message).toBe('the result is too large or not a number');
    expect(runError('target.hp', { roles: { target: { hp: NaN } } }).message).toBe("'target' has a value for 'hp' that is not a finite number");
    expect(runError('roll(a.r)', { roles: { a: { r: { min: 0, max: Infinity } } } }).message).toBe("'a' has a range for 'r' that is not finite");
    expect(runError('x', { parts: { x: Infinity } }).message).toBe('the result is too large or not a number');
  });
  it('names odd characters by code point, keeps emoji whole, and treats Unicode spaces as spaces', () => {
    expect(run('1\u00a0+\u20032\u3000')).toBe(3);
    expect(parseError('1 + \u200b2')).toEqual({ message: 'unexpected character: a zero-width space (U+200B)', from: 4, to: 5 });
    expect(parseError('1 + 😀')).toEqual({ message: "unexpected character '😀' (U+1F600)", from: 4, to: 6 });
    expect(parseError('1 € 2').message).toBe("unexpected character '€' (U+20AC)");
    expect(parseError('attacker.kind == ‘Pierce’').message).toBe("write words in straight single quotes, like 'Pierce'");
  });
});

describe('functions', () => {
  it('if, min, max, clamp, round, floor, ceil, abs', () => {
    expect(run('if(1 < 2, 10, 20)')).toBe(10);
    expect(run("if(false, 'A', 'B')")).toBe('B');
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1, 2)')).toBe(3);
    expect(run('clamp(5, 0, 3)')).toBe(3);
    expect(run('clamp(-5, 0, 3)')).toBe(0);
    expect(run('clamp(2, 2, 2)')).toBe(2);
    expect(run('round(2.5)')).toBe(3);
    expect(run('round(-2.5)')).toBe(-2);
    expect(run('round(1.2345, 2)')).toBe(1.23);
    expect(run('floor(-1.5)')).toBe(-2);
    expect(run('ceil(1.1)')).toBe(2);
    expect(run('abs(-4)')).toBe(4);
  });
  it('clamp with low above high is an error', () => {
    expect(errorsOf('clamp(1, 5, 2)')).toEqual(["clamp's low (5) is above its high (2)"]);
    expect(runError('clamp(1, 5, 1 + 1)').message).toBe("clamp's low (5) is above its high (2)");
  });
  it('if only runs the branch it needs (no draw on the other side)', () => {
    const a = makeRng(7); evaluate(tree('if(true, 1, rand())'), {}, a);
    const b = makeRng(7);
    expect(a.next()).toBe(b.next());
    expect(run('false and 1 / 0 == 1')).toBe(false);
    expect(runError('1 / 0').message).toBe("can't divide by zero");
    expect(runError('10 ^ 400').message).toMatch(/too large/);
  });
  it('rand, chance', () => {
    const r = makeRng(3);
    const t = tree('rand()');
    for (let i = 0; i < 1000; i++) { const v = evaluate(t, {}, r) as number; expect(v >= 0 && v < 1).toBe(true); }
    expect(run('chance(0)')).toBe(false);
    expect(run('chance(1)')).toBe(true);
    let yes = 0;
    const c = tree('chance(0.25)');
    const rc = makeRng(9);
    for (let i = 0; i < 10000; i++) if (evaluate(c, {}, rc)) yes++;
    expect(yes / 10000).toBeGreaterThan(0.23);
    expect(yes / 10000).toBeLessThan(0.27);
  });
  it('randint is inclusive at both ends', () => {
    const seen = new Set<number>();
    const r = makeRng(5);
    const t = tree('randint(1, 3)');
    for (let i = 0; i < 300; i++) seen.add(evaluate(t, {}, r) as number);
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(run('randint(4, 4)')).toBe(4);
    expect(errorsOf('randint(3, 1)')).toEqual(["randint's first number (3) is above its second (1)"]);
    expect(errorsOf('randint(1, 2.5)')).toEqual(['randint needs whole numbers']);
    expect(runError('randint(1, 0 + 2.5)').message).toBe('randint needs whole numbers');
  });
  it('roll gives a number in the range', () => {
    const r = makeRng(11);
    const t = tree('roll(attacker.damage)');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2000; i++) { const v = evaluate(t, env, r) as number; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeGreaterThanOrEqual(5);
    expect(hi).toBeLessThanOrEqual(9);
    expect(hi - lo).toBeGreaterThan(3.9);
    expect(run('roll(attacker.damage)', { roles: { attacker: { damage: { min: 7, max: 7 } } } })).toBe(7);
    expect(checkFormula(tree('roll(attacker.damage)'), scope).type).toEqual({ kind: 'number', unit: 'hp' });
    expect(errorsOf('roll(target.hp)')).toEqual(['roll needs a range field, like attacker.damage; got a number']);
    expect(errorsOf('attacker.damage + 1')).toEqual(["can't add a range to a number; use roll(…) to get a number from a range"]);
    expect(runError('attacker.damage', env).message).toMatch(/result is a range/);
  });
  it('pick draws a key by weight and never a zero-weight key', () => {
    const r = makeRng(2);
    const t = tree('pick(drops)');
    const n: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) { const k = evaluate(t, env, r) as string; n[k] = (n[k] ?? 0) + 1; }
    expect(n.Nothing).toBeUndefined();
    expect(n.Coin / 4000).toBeGreaterThan(0.72);
    expect(n.Coin / 4000).toBeLessThan(0.78);
    expect(checkFormula(tree("pick(drops) == 'Gem'"), scope).errors).toEqual([]);
    expect(errorsOf("pick(drops) == 'Gen'")).toEqual(["'Gen' is not one of the options (Coin, Gem, Nothing) — did you mean 'Gem'?"]);
    expect(errorsOf('pick(kindVsMaterial)')).toEqual(['pick needs a table with one key']);
    expect(runError('pick(drops)', { tables: { drops: { ...drops, cells: [0, 0, 0] } } }).message).toBe("table drops's weights add up to zero");
  });
  it('table looks up exact words, steps and lines', () => {
    expect(run('table(kindVsMaterial, attacker.kind, target.material)', env)).toBe(0.6);
    expect(run("table(kindVsMaterial, 'Slash', 'Dry')", env)).toBe(0.8);
    const step = (x: number) => run(`table(byLevel, ${x})`, { tables: { byLevel: byLevel('step') } });
    expect([step(0), step(1), step(9), step(10), step(15), step(25)]).toEqual([1, 1, 1, 2, 2, 4]);
    const lin = (x: number) => run(`table(byLevel, ${x})`, { tables: { byLevel: byLevel('linear') } });
    expect([lin(0), lin(1), lin(5.5), lin(10), lin(15), lin(30)]).toEqual([1, 1, 1.5, 2, 3, 4]);
    expect(run('table(byLevel, 10)', { tables: { byLevel: byLevel('exact') } })).toBe(2);
    expect(runError('table(byLevel, 11)', { tables: { byLevel: byLevel('exact') } }).message).toBe('table byLevel has no 11');
    expect(errorsOf("table(kindVsMaterial, 'Pierce')")).toEqual(['table kindVsMaterial has 2 keys, so it takes 2 after its name; 1 given']);
    expect(errorsOf("table(kindVsMaterial, 'Pirce', 'Wet')")).toEqual(["table kindVsMaterial has no 'Pirce' (it has Pierce, Slash) — did you mean 'Pierce'?"]);
    expect(errorsOf('table(kindVsMaterial, target.material, attacker.kind)')[0]).toMatch(/has no 'Wet', 'Dry'/);
    expect(errorsOf('table(kindVsMaterial, 1, target.material)')).toEqual(["kindVsMaterial's kind key needs a word, not a number"]);
    expect(errorsOf('table(kindVsMatrial, 1)')).toEqual(["unknown table 'kindVsMatrial' — did you mean 'kindVsMaterial'?"]);
  });
  it('names an unknown function, with a suggestion', () => {
    expect(errorsOf('mx(1, 2)')).toEqual(["there's no function or rule 'mx' — did you mean 'max'?"]);
    expect(errorsOf('sqrt(4)')).toEqual(["there's no function or rule 'sqrt'"]);
    expect(errorsOf('min(1)')).toEqual(['min takes at least 2 values: min(a, b, …)']);
    expect(errorsOf('clamp(1, 2)')).toEqual(['clamp takes 3 values: clamp(x, low, high)']);
    expect(runError('sqrt(4)').message).toBe("there's no function or rule 'sqrt'");
  });
});

describe('types and names', () => {
  it('checks fields in plain words with a suggestion', () => {
    const r = checkFormula(tree('target.armr + 1'), scope);
    expect(r.errors).toEqual([{ message: "'Slime' has no field 'armr' — did you mean 'armor'?", from: 0, to: 11 }]);
    expect(errorsOf('attackr.level')).toEqual(["unknown role 'attackr' — did you mean 'attacker'?"]);
    expect(errorsOf('attacker.tags')).toEqual(["'attacker.tags' is a list of options; formulas can only read single values"]);
    expect(errorsOf('bas * 2')).toEqual(["unknown name 'bas' — did you mean 'base'?"]);
    expect(errorsOf('attacker')[0]).toMatch(/'attacker' is a role; use one of its fields/);
    expect(errorsOf('drops')[0]).toMatch(/'drops' is a table/);
  });
  it("can't mix words and numbers", () => {
    expect(errorsOf('attacker.kind + 1')).toEqual(["can't add a word to a number"]);
    expect(errorsOf("1 + 'Pierce'")).toEqual(["can't add a word to a number"]);
    expect(errorsOf("10 - 'Pierce'")).toEqual(["can't subtract a word from a number"]);
    expect(errorsOf('target.boss * 2')).toEqual(["can't multiply a true/false value by a number"]);
    expect(errorsOf("attacker.kind == 1")).toEqual(["can't compare a word with a number"]);
    expect(errorsOf("attacker.kind < 'Slash'")).toEqual(['only numbers can be compared with <; words can only be compared with == or !=']);
    expect(errorsOf('1 and true')).toEqual(["'and' needs a true/false value, not a number"]);
    expect(errorsOf('if(1, 2, 3)')).toEqual(['the condition of if needs a true/false value, not a number']);
    expect(errorsOf("if(true, 2, 'A')")).toEqual(['both results of if must be the same kind: a number and a word given']);
    expect(runError("1 + 'A'").message).toBe("'+' needs a number, not a word");
  });
  it('compares enum values as words and checks them against the options', () => {
    expect(run("attacker.kind == 'Pierce'", env)).toBe(true);
    expect(run("target.material != 'Wet'", env)).toBe(false);
    expect(run("pick(drops) == 'Coin' or true", env)).toBe(true);
    expect(errorsOf("attacker.kind == 'Pirce'")).toEqual(["'Pirce' is not one of the options (Pierce, Slash) — did you mean 'Pierce'?"]);
    expect(errorsOf("'Slash' == attacker.kind")).toEqual([]);
    expect(checkFormula(tree("attacker.kind == 'Slash'"), scope).type).toEqual({ kind: 'bool' });
  });
  it('carries units for display', () => {
    expect(checkFormula(tree('target.hp - target.armor'), scope).type).toEqual({ kind: 'number', unit: 'hp' });
    expect(checkFormula(tree('target.hp * 1.5'), scope).type).toEqual({ kind: 'number', unit: 'hp' });
    expect(checkFormula(tree('target.hp / target.armor'), scope).type).toEqual({ kind: 'number' });
    expect(checkFormula(tree('base + hits'), scope).type).toEqual({ kind: 'number', unit: 'hp' });
  });
  it('reads parts and state', () => {
    expect(run('base * hits', env)).toBe(30);
    expect(runError('target.hp', { roles: { target: {} } }).message).toBe("'target' has no value for 'hp'");
  });
  it('reports every problem, one message each', () => {
    expect(errorsOf("target.armr + attacker.kind + mx(1)")).toHaveLength(3);
  });
});

describe('rules calling rules', () => {
  const hit: RuleProgram = {
    roles: [{ name: 'a' }, { name: 'b' }],
    parts: [{ name: 'flat', tree: tree('roll(a.damage)') }, { name: 'mult', tree: tree('table(kindVsMaterial, a.kind, b.material)') }],
    result: tree('flat * mult'),
  };
  it('runs parts in order and a call binds roles by position', () => {
    const one = { roles: { a: { damage: { min: 10, max: 10 }, kind: 'Pierce' }, b: { material: 'Wet' } } };
    expect(evaluateRule(hit, one.roles, { tables: { kindVsMaterial } }, makeRng(1))).toEqual({ parts: { flat: 10, mult: 0.6 }, result: 6 });
    const e2: FormulaEnv = { roles: { attacker: one.roles.a, target: one.roles.b }, tables: { kindVsMaterial }, rules: { hit } };
    expect(run('hit(attacker, target) + 1', e2)).toBe(7);
    expect(errorsOf('hit(attacker, target)')).toEqual([]);
    expect(errorsOf('hit(target, attacker)')).toEqual([
      "hit expects a weapon for 'a', but 'target' is a Slime", "hit expects a creature for 'b', but 'attacker' is a Sword",
    ]);
    expect(errorsOf('hit(attacker)')).toEqual(['hit takes 2 roles (a, b); 1 given']);
    expect(errorsOf('hit(attacker, 3)')).toEqual(["hit needs a role for 'b'"]);
  });
  it('stops cycles and deep chains with a plain error', () => {
    const loop: RuleProgram = { roles: [{ name: 'x' }], parts: [], result: tree('loop(x) + 1') };
    const e: FormulaEnv = { roles: { attacker: {} }, rules: { loop } };
    expect(runError('loop(attacker)', e).message).toBe("rule 'loop' calls itself (loop → loop)");
    const rules: Record<string, RuleProgram> = {};
    for (let i = 0; i < 20; i++) rules[`r${i}`] = { roles: [{ name: 'x' }], parts: [], result: tree(i === 19 ? '1' : `r${i + 1}(x)`) };
    expect(runError('r0(attacker)', { roles: { attacker: {} }, rules }).message).toBe('rules call each other too deeply (more than 16)');
    expect(findRuleCycle({ a: ['b'], b: ['c'], c: ['a'], d: [] })).toEqual(['a', 'b', 'c', 'a']);
    expect(findRuleCycle({ a: ['b'], b: [] })).toBeNull();
    expect(calledRules(tree('hit(a, b) + max(1, other(a))'), (n) => n !== 'zzz')).toEqual(['hit', 'other']);
  });
  it('stops rules that fan out with a step budget, fast', () => {
    const rules: Record<string, RuleProgram> = {};
    const fan = (callee: string) => `max(${Array.from({ length: 300 }, () => `${callee}(x)`).join(', ')})`;
    rules.r3 = { roles: [{ name: 'x' }], parts: [], result: tree('1') };
    for (const [k, callee] of [['r2', 'r3'], ['r1', 'r2'], ['r0', 'r1']]) rules[k] = { roles: [{ name: 'x' }], parts: [], result: tree(fan(callee)) };
    const t0 = Date.now();
    expect(runError('r0(attacker)', { roles: { attacker: {} }, rules }).message)
      .toBe('this formula takes too many steps (more than 1,000,000); a rule may call others too often');
    expect(Date.now() - t0).toBeLessThan(3000);
    const t1 = Date.now();
    expect(() => evaluateRule(rules.r0, { x: {} }, { rules }, makeRng(1))).toThrow(/too many steps/);
    expect(Date.now() - t1).toBeLessThan(3000);
    expect(run('r2(attacker)', { roles: { attacker: {} }, rules })).toBe(1); // 90 601 steps is fine
  });
  it('says which rule a problem came from', () => {
    const bad: RuleProgram = { roles: [{ name: 'x' }], parts: [], result: tree('1 / 0') };
    const err = runError('bad(attacker)', { roles: { attacker: {} }, rules: { bad } });
    expect(err.rule).toBe('bad');
    expect([err.from, err.to]).toEqual([4, 5]);
  });
});

describe('the seeded generator', () => {
  it('known answer: first 5 floats for seed 1 (checked against a C reference of xoshiro128** + splitmix32)', () => {
    const r = makeRng(1);
    expect(Array.from({ length: 5 }, () => r.float())).toEqual([
      0.091569483280181885, 0.50619775056838989, 0.88819277286529541, 0.48725515604019165, 0.43427014350891113,
    ]);
  });
  it('splitmix per-run seeds', () => {
    expect(splitmix32(0)).toBe(1684164658);
    expect([0, 1, 2].map((i) => runSeed(1, i))).toEqual([4293442868, 3524174333, 2762329221]);
    expect(runSeed(1, 0)).toBe(splitmix32((1 ^ Math.imul(1, 0x9e3779b9)) >>> 0));
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => runSeed(42, i)));
    expect(seeds.size).toBe(1000);
  });
  it('documents evaluation order for the export', () => {
    expect(RANDOM_INFO.order.join(' ')).toMatch(/short-circuit/);
    expect(RANDOM_INFO.order.join(' ')).toMatch(/left to right/);
    expect(RANDOM_INFO.order.join(' ')).toMatch(/non-integer exponent/);
  });
  it('is deterministic and outputs 32-bit numbers', () => {
    const a = makeRng(123), b = makeRng(123), c = makeRng(124);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(xs);
    expect(c.next()).not.toBe(xs[0]);
    expect(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32)).toBe(true);
  });
});

describe('completions', () => {
  it('offers fields with units after role.', () => {
    const c = completions('roll(target.ar', 14, scope);
    expect(c).toEqual([{ label: 'armor', kind: 'field', unit: 'hp', detail: 'Armor (number)', from: 12, to: 14 }]);
    const all = completions('attacker.', 9, scope).map((x) => x.label);
    expect(all).toEqual(['damage', 'level', 'kind']); // the list field is left out
  });
  it('offers names by prefix with their kind', () => {
    const c = completions('1 + ta', 6, scope);
    expect(c.map((x) => [x.label, x.kind])).toEqual([['target', 'role'], ['table', 'function']]);
    expect(completions('', 0, scope).map((x) => x.kind)).toEqual(expect.arrayContaining(['part', 'state', 'role', 'table', 'rule', 'function']));
    expect(completions('b', 1, scope)[0]).toMatchObject({ label: 'base', kind: 'part', unit: 'hp' });
  });
  it('offers enum options inside a quote', () => {
    expect(completions("attacker.kind == 'Pi", 20, scope)).toEqual([{ label: 'Pierce', kind: 'option', detail: 'Kind', from: 18, to: 20 }]);
  });
});

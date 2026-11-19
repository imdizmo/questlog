import { FormulaError, tokenize, type FormulaProblem, type Token } from './lexer';

/** Language version of the expression tree below; exported with every formula. */
export const FORMULA_LANGUAGE_VERSION = 1;
export const MAX_FORMULA_LENGTH = 4000;
export const MAX_DEPTH = 64;

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
export type UnaryOp = '-' | 'not';

interface At { from: number; to: number }
/**
 * The expression tree. Plain JSON (no classes, no cycles), so it can be stored and exported as is.
 * `field` is `role.field`; `name` is a part, state variable, role or table; `call` is a built-in function or a rule.
 */
export type Expr =
  | ({ t: 'num'; v: number } & At)
  | ({ t: 'word'; v: string } & At)
  | ({ t: 'bool'; v: boolean } & At)
  | ({ t: 'name'; name: string } & At)
  | ({ t: 'field'; role: string; field: string } & At)
  | ({ t: 'unary'; op: UnaryOp; arg: Expr } & At)
  | ({ t: 'binary'; op: BinaryOp; left: Expr; right: Expr } & At)
  | ({ t: 'call'; fn: string; args: Expr[] } & At);

export type ParseResult = { tree: Expr } | { error: FormulaProblem };

const CMP = new Set(['==', '!=', '<', '<=', '>', '>=']);
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);

class Parser {
  private i = 0;
  private nest = 0;
  private readonly depth = new Map<Expr, number>();
  constructor(private readonly toks: Token[]) {}

  private get tok(): Token { return this.toks[this.i]; }
  /** The current token, without the narrowing TypeScript keeps on `tok` across calls that move on. */
  private peek(): Token { return this.toks[this.i]; }
  private isOp(text: string): boolean { return this.tok.type === 'op' && this.tok.text === text; }
  private isKw(text: string): boolean { return this.tok.type === 'name' && this.tok.text === text; }

  private fail(message: string, t: Token = this.tok): never {
    throw new FormulaError(message, t.from, t.type === 'end' ? t.from : t.to);
  }
  private tooDeep(from: number, to: number): never {
    throw new FormulaError(`the formula is nested too deeply (more than ${MAX_DEPTH} levels)`, from, to);
  }
  /** Registers a node's depth (leaf = 1); refuses trees deeper than MAX_DEPTH. */
  private mk<E extends Expr>(e: E, ...kids: Expr[]): E {
    let d = 1;
    for (const k of kids) d = Math.max(d, 1 + (this.depth.get(k) ?? 1));
    if (d > MAX_DEPTH) this.tooDeep(e.from, e.to);
    this.depth.set(e, d);
    return e;
  }
  private tooLong(from: number, to: number): never {
    throw new FormulaError(`too many terms in one chain (more than ${MAX_DEPTH}); split it with brackets or a named part`, from, to);
  }
  /** Guards recursion (brackets, calls, prefix operators) before any node exists, so the stack stays small. */
  private enter(t: Token): void { if (++this.nest > MAX_DEPTH) this.tooDeep(t.from, t.to); }
  private leave(): void { this.nest--; }

  parseAll(): Expr {
    if (this.tok.type === 'end') this.fail('the formula is empty');
    const e = this.expr();
    if (this.peek().type !== 'end') {
      if (this.isOp(')')) this.fail("there's a ')' without a matching '('");
      this.fail(`unexpected '${this.tok.text}' here; is an operator missing?`);
    }
    return e;
  }

  private expr(): Expr {
    this.enter(this.tok);
    const e = this.or();
    this.leave();
    return e;
  }

  private or(): Expr {
    let left = this.and();
    let terms = 1;
    while (this.isKw('or')) {
      if (++terms > MAX_DEPTH) this.tooLong(left.from, this.tok.to);
      this.i++;
      const right = this.and();
      left = this.mk({ t: 'binary', op: 'or', left, right, from: left.from, to: right.to }, left, right);
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    let terms = 1;
    while (this.isKw('and')) {
      if (++terms > MAX_DEPTH) this.tooLong(left.from, this.tok.to);
      this.i++;
      const right = this.not();
      left = this.mk({ t: 'binary', op: 'and', left, right, from: left.from, to: right.to }, left, right);
    }
    return left;
  }

  private not(): Expr {
    if (this.isKw('not')) {
      const t = this.tok;
      this.i++;
      this.enter(t);
      const arg = this.not();
      this.leave();
      return this.mk({ t: 'unary', op: 'not', arg, from: t.from, to: arg.to }, arg);
    }
    return this.cmp();
  }

  private cmp(): Expr {
    const left = this.add();
    if (this.tok.type === 'op' && CMP.has(this.tok.text)) {
      const op = this.tok.text as BinaryOp;
      this.i++;
      const right = this.add();
      if (this.tok.type === 'op' && CMP.has(this.tok.text)) {
        this.fail("comparisons can't be chained; join them with and, like a < b and b < c");
      }
      return this.mk({ t: 'binary', op, left, right, from: left.from, to: right.to }, left, right);
    }
    return left;
  }

  private add(): Expr {
    let left = this.mul();
    let terms = 1;
    while (this.isOp('+') || this.isOp('-')) {
      if (++terms > MAX_DEPTH) this.tooLong(left.from, this.tok.to);
      const op = this.tok.text as BinaryOp;
      this.i++;
      const right = this.mul();
      left = this.mk({ t: 'binary', op, left, right, from: left.from, to: right.to }, left, right);
    }
    return left;
  }

  private mul(): Expr {
    let left = this.unary();
    let terms = 1;
    while (this.isOp('*') || this.isOp('/')) {
      if (++terms > MAX_DEPTH) this.tooLong(left.from, this.tok.to);
      const op = this.tok.text as BinaryOp;
      this.i++;
      const right = this.unary();
      left = this.mk({ t: 'binary', op, left, right, from: left.from, to: right.to }, left, right);
    }
    return left;
  }

  /** Unary minus binds looser than ^, so -2^2 is -(2^2). */
  private unary(): Expr {
    if (this.isOp('-')) {
      const t = this.tok;
      this.i++;
      this.enter(t);
      const arg = this.unary();
      this.leave();
      return this.mk({ t: 'unary', op: '-', arg, from: t.from, to: arg.to }, arg);
    }
    return this.pow();
  }

  /** ^ is right-associative: 2^3^2 is 2^(3^2); the exponent may carry a sign (2^-1). */
  private pow(): Expr {
    const base = this.primary();
    if (this.isOp('^')) {
      const t = this.tok;
      this.i++;
      this.enter(t);
      const exp = this.unary();
      this.leave();
      return this.mk({ t: 'binary', op: '^', left: base, right: exp, from: base.from, to: exp.to }, base, exp);
    }
    return base;
  }


  /** `fn(` was read up to the bracket: its arguments and the closing bracket. */
  private callArgs(fn: string, t: Token): Expr {
    this.i++;
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        if (this.isOp(',') || this.isOp(')')) this.fail(`a value is missing in ${fn}(…)`);
        args.push(this.expr());
        if (this.isOp(',')) { this.i++; continue; }
        if (this.isOp(')')) break;
        if (this.tok.type === 'end') this.fail(`${fn}( is missing its closing ')'`, t);
        this.fail(`expected ',' or ')' in ${fn}(…)`);
      }
    }
    const close = this.tok;
    this.i++;
    return this.mk({ t: 'call', fn, args, from: t.from, to: close.to }, ...args);
  }
  private primary(): Expr {
    const t = this.tok;
    if (t.type === 'num') {
      this.i++;
      return this.mk({ t: 'num', v: t.value as number, from: t.from, to: t.to });
    }
    if (t.type === 'word') {
      this.i++;
      return this.mk({ t: 'word', v: t.value as string, from: t.from, to: t.to });
    }
    if (t.type === 'name') {
      if (t.text === 'true' || t.text === 'false') {
        this.i++;
        return this.mk({ t: 'bool', v: t.text === 'true', from: t.from, to: t.to });
      }
      if (KEYWORDS.has(t.text)) this.fail(`'${t.text}' needs a value before it`);
      this.i++;
      if (this.isOp('.')) {
        this.i++;
        const f = this.tok;
        if (f.type !== 'name' || KEYWORDS.has(f.text)) this.fail(`write a field name after '${t.text}.'`, f);
        this.i++;
        if (this.isOp('.')) this.fail(`'${t.text}.${f.text}' has no fields of its own`);
        // `entry.field(…)`: a rule named by its entry and field (an entry with several rule fields).
        if (this.isOp('(')) return this.callArgs(`${t.text}.${f.text}`, t);
        return this.mk({ t: 'field', role: t.text, field: f.text, from: t.from, to: f.to });
      }
      if (this.isOp('(')) return this.callArgs(t.text, t);
      return this.mk({ t: 'name', name: t.text, from: t.from, to: t.to });
    }
    if (this.isOp('(')) {
      this.i++;
      if (this.isOp(')')) this.fail('empty brackets; put a value inside');
      const inner = this.expr();
      if (!this.isOp(')')) {
        if (this.tok.type === 'end') this.fail("this '(' is missing its closing ')'", t);
        this.fail(`expected ')' but found '${this.tok.text}'`);
      }
      this.i++;
      return inner;
    }
    if (t.type === 'end') this.fail('the formula ends too early; a value is missing');
    if (t.type === 'op' && t.text === ')') this.fail("there's a ')' without a matching '('");
    this.fail(`a value is missing before '${t.text}'`);
  }
}

/** Parses a formula into an expression tree, or gives the first problem in plain words with its place. */
export function parseFormula(text: string): ParseResult {
  if (text.length > MAX_FORMULA_LENGTH) {
    return { error: {
      message: `the formula is too long (${text.length.toLocaleString('en-US')} characters; the limit is ${MAX_FORMULA_LENGTH.toLocaleString('en-US')})`,
      from: MAX_FORMULA_LENGTH, to: text.length,
    } };
  }
  try {
    return { tree: new Parser(tokenize(text)).parseAll() };
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.toProblem() };
    throw e;
  }
}

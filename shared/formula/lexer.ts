/** Tokens of the formula language. Positions are character offsets into the formula text (`to` is exclusive). */

export type TokenType = 'num' | 'word' | 'name' | 'op' | 'end';
export interface Token { type: TokenType; text: string; value?: number | string; from: number; to: number }

/** A problem with a formula, in plain words, at a place in its text. */
export interface FormulaProblem { message: string; from: number; to: number }

export class FormulaError extends Error {
  readonly from: number;
  readonly to: number;
  /** The rule the problem is in, when it happened inside a called rule. */
  rule?: string;
  constructor(message: string, from: number, to: number, rule?: string) {
    super(message);
    this.name = 'FormulaError';
    this.from = from;
    this.to = to;
    if (rule !== undefined) this.rule = rule;
  }
  toProblem(): FormulaProblem { return { message: this.message, from: this.from, to: this.to }; }
}

/** An own property of a plain record, never one inherited from Object.prototype (`constructor`, `__proto__`, ...). */
export function own<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Any Unicode white space (incl. non-breaking and other wide spaces) counts as a space. */
const SPACE = /\s/u;
/** Characters that are invisible or easy to confuse, named in errors. */
const INVISIBLE: Record<number, string> = {
  0x200b: 'a zero-width space', 0x200c: 'a zero-width non-joiner', 0x200d: 'a zero-width joiner', 0x2060: 'a word joiner',
  0x00ad: 'a soft hyphen', 0x0000: 'a null character', 0x200e: 'a left-to-right mark', 0x200f: 'a right-to-left mark',
};

const OPS2 = ['==', '!=', '<=', '>='];
const OPS1 = '+-*/^(),.<>';

const isDigit = (c: string) => c >= '0' && c <= '9';
const isNameStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isNameChar = (c: string) => isNameStart(c) || isDigit(c);

/** Splits a formula into tokens; throws FormulaError on a character that can't start a token. Always ends with 'end'. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (SPACE.test(c)) { i++; continue; }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      while (i < text.length && isDigit(text[i])) i++;
      if (text[i] === '.' && isDigit(text[i + 1] ?? '')) { i++; while (i < text.length && isDigit(text[i])) i++; }
      if (isNameStart(text[i] ?? '')) {
        let j = i;
        while (j < text.length && isNameChar(text[j])) j++;
        throw new FormulaError(`'${text.slice(start, j)}' is not a number or a name`, start, j);
      }
      const s = text.slice(start, i);
      if (!Number.isFinite(Number(s))) throw new FormulaError('this number is too large', start, i);
      out.push({ type: 'num', text: s, value: Number(s), from: start, to: i });
      continue;
    }
    if (isNameStart(c)) {
      while (i < text.length && isNameChar(text[i])) i++;
      out.push({ type: 'name', text: text.slice(start, i), from: start, to: i });
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new FormulaError('this word has no closing quote', start, text.length);
      const w = text.slice(i + 1, close);
      if (w.includes('\n')) throw new FormulaError('this word has no closing quote', start, start + 1 + w.indexOf('\n'));
      i = close + 1;
      out.push({ type: 'word', text: text.slice(start, i), value: w, from: start, to: i });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (OPS2.includes(two)) { i += 2; out.push({ type: 'op', text: two, from: start, to: i }); continue; }
    if (c === '=') throw new FormulaError('use == to compare two values', start, start + 1);
    if (c === '"') throw new FormulaError("write words in single quotes, like 'Pierce'", start, start + 1);
    if (c === '!') throw new FormulaError('use not to negate, or != for "not equal"', start, start + 1);
    if (OPS1.includes(c)) { i++; out.push({ type: 'op', text: c, from: start, to: i }); continue; }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch === '\u2018' || ch === '\u2019') throw new FormulaError("write words in straight single quotes, like 'Pierce'", start, start + 1);
    const code = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    const named = INVISIBLE[cp];
    throw new FormulaError(named ? `unexpected character: ${named} (${code})` : cp > 0x20 && cp < 0x7f ? `unexpected character '${ch}'` : `unexpected character '${ch}' (${code})`, start, start + ch.length);
  }
  out.push({ type: 'end', text: '', from: text.length, to: text.length });
  return out;
}

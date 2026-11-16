// The small language of a storyline's flow: variables, and conditions and changes written inside a line's label.
//   Open the door {if has_key and score >= 3} {set score += 1}
// Pure functions, used by Play mode.

export type Value = number | boolean | string;
export type Vars = Record<string, Value>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseValue(raw: string): Value {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t.replace(/^(["'])(.*)\1$/, '$2');
}

/** Starting values, one `name = value` per line; lines that are not that are ignored. */
export function parseVars(text: string): Vars {
  const vars: Vars = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) vars[m[1]] = parseValue(m[2]);
  }
  return vars;
}

/** A line's label split into what the player reads, its condition and its changes. Several {if} must all hold. */
export function parseLabel(label: string): { text: string; cond: string | null; sets: string[] } {
  const conds: string[] = [], sets: string[] = [];
  const text = label.replace(/\{\s*(if|set)\s+([^}]*)\}/g, (_m, kind: string, body: string) => { (kind === 'if' ? conds : sets).push(body.trim()); return ''; }).replace(/\s+/g, ' ').trim();
  return { text, cond: conds.length ? conds.join(' and ') : null, sets };
}

const truthy = (v: Value | undefined) => v !== undefined && v !== false && v !== 0 && v !== '';

function atom(src: string, vars: Vars, visits: (title: string) => number): boolean {
  let s = src.trim(), not = false;
  while (s.startsWith('!')) { not = !not; s = s.slice(1).trim(); }
  let r: boolean;
  const seen = /^seen\s+(.+)$/i.exec(s);
  const cmp = /^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(s);
  if (seen) r = visits(seen[1].trim()) > 0;
  else if (cmp) {
    const a = vars[cmp[1]] ?? 0, b = parseValue(cmp[3]);
    r = cmp[2] === '==' ? a === b : cmp[2] === '!=' ? a !== b
      : typeof a === 'number' && typeof b === 'number' && (cmp[2] === '>' ? a > b : cmp[2] === '>=' ? a >= b : cmp[2] === '<' ? a < b : a <= b);
  } else r = NAME.test(s) && truthy(vars[s]);
  return not ? !r : r;
}

/** `a and b or c` reads as (a and b) or c. `seen <frame title>` is true once that frame was visited. An unknown name is 0. */
export const evalCond = (cond: string, vars: Vars, visits: (title: string) => number): boolean =>
  cond.split(/\s+or\s+/i).some((all) => all.split(/\s+and\s+/i).every((a) => atom(a, vars, visits)));

/** `name = value`, `name += n`, `name -= n`; anything else leaves the variables as they are. */
export function applySet(set: string, vars: Vars): Vars {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=|\+=|-=)\s*(.+)$/.exec(set.trim());
  if (!m) return vars;
  const v = parseValue(m[3]), old = vars[m[1]];
  if (m[2] === '=') return { ...vars, [m[1]]: v };
  if (typeof v !== 'number') return vars;
  return { ...vars, [m[1]]: (typeof old === 'number' ? old : 0) + (m[2] === '+=' ? v : -v) };
}

/** `{name}` in a frame's text shows the variable's value; unknown names stay as written. */
export const fillText = (text: string, vars: Vars): string =>
  text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

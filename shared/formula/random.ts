/**
 * The one seeded generator formulas use, documented so another program can reproduce every run:
 * - seeding: splitmix32 — state s = seed; four times: s = s + 0x9E3779B9 (mod 2^32), output mix(s); those four outputs
 *   are the xoshiro128** state words s0..s3, in order. `splitmix32(x)` below is the first output for state x.
 * - generator: xoshiro128** (Blackman & Vigna), 32-bit outputs.
 * - floats: only `(next() >>> 8) / 2^24`, in [0, 1).
 * - run i (0-based) of a batch with seed S uses seed `splitmix32(S ^ Math.imul(i + 1, 0x9E3779B9))`.
 */
export const RANDOM_INFO = {
  generator: 'xoshiro128**',
  seeding: 'splitmix32: s = seed; 4 times s = (s + 0x9E3779B9) mod 2^32, word = mix(s); state = the 4 words',
  mix: 'z = s; z = (z ^ (z >>> 16)) * 0x21F0AAAD; z = (z ^ (z >>> 15)) * 0x735A2D97; z = z ^ (z >>> 15) (32-bit)',
  float: '(next() >>> 8) / 2^24',
  runSeed: 'splitmix32(seed ^ ((i + 1) * 0x9E3779B9 mod 2^32)) for run i from 0',
  order: [
    'and, or and if short-circuit: the side that is not needed is not run, so its random draws are skipped',
    'arguments of functions and rule calls are evaluated left to right; a rule runs its parts in order, then its result',
    '^ with a non-integer exponent may differ in the last bit between JavaScript engines (it uses Math.pow)',
  ],
  /** How a scenario run goes, so another program can replay one from its seed and get the same draws and times. */
  scenario: [
    'each run has its own generator: makeRng(runSeed(batch seed, run index))',
    'start: state start formulas in order; time = 0; each clock\'s first (default 0) in declaration order; then end once',
    'times are whole microseconds: a delay (first or every) of d seconds is Math.round(d × 1e6) µs (every: at least 1); '
      + 'next time = now + delay; the cap is Math.round(cap × 1e6) µs; time in formulas = µs / 1e6',
    'next tick: the clock with the earliest time; ties at the same microsecond in declaration order; none at or before the cap → stop, time = cap',
    'a tick: time = its time; the clock\'s updates in order; end; if not ended, the clock\'s every (at least 0.000001 s after rounding to the microsecond grid) → next time = now + every',
    'stop after 100000 ticks; then the measures in order',
    'at the 100000-tick stop, time stays at the last tick\'s time (only the cap sets time to the cap)',
  ],
} as const;

function mix(s: number): number {
  let z = s | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/** The first splitmix32 output for state `x` (an unsigned 32-bit number). */
export function splitmix32(x: number): number {
  return mix((x + 0x9e3779b9) | 0);
}

/** The seed of run `i` (from 0) of a batch started with `seed`. */
export function runSeed(seed: number, i: number): number {
  return splitmix32((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0);
}

export interface Rng {
  /** The next unsigned 32-bit output. */
  next(): number;
  /** A float in [0, 1): `(next() >>> 8) / 2^24`. */
  float(): number;
}

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

/** xoshiro128** seeded from splitmix32 of a 32-bit seed (non-integers and larger numbers are cut to 32 bits). */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const w: number[] = [];
  for (let k = 0; k < 4; k++) { s = (s + 0x9e3779b9) >>> 0; w.push(mix(s)); }
  let [s0, s1, s2, s3] = w;
  const next = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
  return { next, float: () => (next() >>> 8) / 16777216 };
}

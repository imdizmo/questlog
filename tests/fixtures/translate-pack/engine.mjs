// Fake language pack: prefixes the target language, keeps text (and any ⟦n⟧ placeholders) as is.
// Special inputs: THROW throws; CRASHLATER throws from a timer 20 ms later; WHICH answers with the pair loaded; HANG never answers. If JT_TRANSLATE_LOADLOG is set, each load appends a line.
import { appendFileSync } from 'node:fs';
let pair = null;
export async function load(dir, from, to) {
  pair = `${from}>${to}`;
  if (process.env.JT_TRANSLATE_LOADLOG) appendFileSync(process.env.JT_TRANSLATE_LOADLOG, pair + '\n');
}
export async function translate(texts, from, to) {
  if (pair !== `${from}>${to}`) throw new Error(`pair ${from}>${to} not loaded (have ${pair})`);
  if (texts.includes('HANG')) return new Promise(() => {});
  return texts.map((t) => {
    if (t.includes('THROW')) throw new Error('fixture throw');
    if (t === 'WHICH') return pair;
    if (t === 'CRASHLATER') { setTimeout(() => { throw new Error('idle crash'); }, 20); return '[ok]'; }
    return `[${to}] ${t}`;
  });
}

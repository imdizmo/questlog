import { seqFromCode } from './cards';

export interface ParsedContent {
  tags: string[];
  mentions: string[];
  cardCodes: string[];
  checkboxStats: { checked: number; total: number } | null;
  wordCount: number;
}

/**
 * Token rules shared by the server (derivation) and the web renderer (chips), so both agree on
 * what counts as a #tag, @mention or $code. A token must start the text or follow whitespace.
 */
/** \p{M}: combining marks, so a decomposed (NFD) "María" stays one token. */
const MENTION_CHARS = '\\p{L}\\p{M}\\p{N}._-';
export const TOKEN_BODY = {
  tag: '[\\p{L}\\p{N}_-]+',
  mention: `[${MENTION_CHARS}]+`,
  code: '[a-z0-9]+',
} as const;
/** True when a token may start right after this character (undefined = start of text). */
export const tokenBoundary = (prev: string | undefined) => prev === undefined || /\s/u.test(prev);

const TAG = new RegExp(`(^|\\s)#(${TOKEN_BODY.tag})`, 'gu');
const MENTION = new RegExp(`(^|\\s)@(${TOKEN_BODY.mention})`, 'gu');
const CODE = new RegExp(`(^|\\s)\\$(${TOKEN_BODY.code})`, 'gu');
/** A checklist line: `- [ ] ` / `* [x] `. Group 1 is the mark. */
export const CHECKBOX = /^\s*[-*] \[( |x|X)\] /;

const NOT_MENTION_CHAR = new RegExp(`[^${MENTION_CHARS}]`, 'gu');
/**
 * The @handle a user is mentioned by: their name in lower case with every character a mention
 * token can't hold removed ("O'Brien" → "obrien"), so every handle matches TOKEN_BODY.mention whole.
 */
export const mentionHandle = (name: string) => name.normalize('NFC').toLowerCase().replace(NOT_MENTION_CHAR, '');

/** Remove fenced blocks and inline code spans so nothing inside them counts. */
function stripCode(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push('');
    } else if (m) {
      fence = m[1];
      out.push('');
    } else {
      out.push(line.replace(/(`+)[^\n]*?\1/g, ' '));
    }
  }
  return out.join('\n');
}

export function parseContent(content: string): ParsedContent {
  const text = stripCode(content);
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG)) tags.add(m[2].toLowerCase());
  const mentions = new Set<string>();
  for (const m of text.matchAll(MENTION)) mentions.add(m[2]);
  const cardCodes = new Set<string>();
  for (const m of text.matchAll(CODE)) if (seqFromCode(m[2]) !== null) cardCodes.add(m[2]);

  let checked = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    const m = CHECKBOX.exec(line);
    if (m) {
      total++;
      if (m[1] !== ' ') checked++;
    }
  }

  const plain = text
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*~]{1,3}|(^|\s)_+|_+(?=\s|$)/g, '$1')
    .trim();
  const wordCount = plain === '' ? 0 : plain.split(/\s+/).length;

  return {
    tags: [...tags],
    mentions: [...mentions],
    cardCodes: [...cardCodes],
    checkboxStats: total > 0 ? { checked, total } : null,
    wordCount,
  };
}

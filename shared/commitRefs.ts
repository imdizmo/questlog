import { seqFromCode } from './cards';

/** Card references and commands found in one commit message. */
export interface CommitRefs {
  /** Every referenced card code, once each, in order of appearance (commands included). */
  refs: string[];
  /** `closes $code` (mark done) and `review $code` (open a review thread). Our own syntax. */
  commands: { action: 'close' | 'review'; code: string }[];
}

/** References and commands taken from one commit; the rest of a long message is ignored. */
export const MAX_REFS_PER_COMMIT = 20;

// Links with a scheme, and bare www. links.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi;
// `$` + a code of the card-code alphabet (shared/cards.ts), not glued to a word and not followed by more code characters.
const CODE = String.raw`\$([0-9acefghjkmnpqrstuvwxyz]{3,8})(?![0-9a-z$])`;
const REF_RE = new RegExp(String.raw`(?<![\w$])${CODE}`, 'gi');
const COMMAND_RE = new RegExp(String.raw`(?<![\w$])(closes|review)\s+${CODE}`, 'gi');

/** `$<code>` references and `closes $<code>` / `review $<code>` commands (case-insensitive); codes inside URLs are ignored. */
export function parseCommitRefs(message: string): CommitRefs {
  const text = message.replace(URL_RE, ' ');
  const refs: string[] = [];
  const commands: CommitRefs['commands'] = [];
  for (const m of text.matchAll(REF_RE)) {
    const code = m[1].toLowerCase();
    if (seqFromCode(code) !== null && !refs.includes(code) && refs.length < MAX_REFS_PER_COMMIT) refs.push(code);
  }
  for (const m of text.matchAll(COMMAND_RE)) {
    const [action, code] = [m[1].toLowerCase() === 'closes' ? 'close' as const : 'review' as const, m[2].toLowerCase()];
    if (seqFromCode(code) !== null && commands.length < MAX_REFS_PER_COMMIT && !commands.some((c) => c.action === action && c.code === code)) commands.push({ action, code });
  }
  return { refs, commands };
}

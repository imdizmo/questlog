import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import type { Card, User } from '../../shared/types';
import { cardCode, seqFromCode, slugOf, titleOf } from '../../shared/cards';
import { CHECKBOX, mentionHandle, TOKEN_BODY, tokenBoundary } from '../../shared/content';

/** Looks up what a token in the text refers to; null when it refers to nothing we know. */
export interface RenderContext {
  /** Title of the card with this code. */
  cardTitle(code: string): string | null;
  /** Display name of the user with this @handle (see mentionHandle). */
  userName(handle: string): string | null;
}

export interface RenderOptions {
  /** Line in the full card text where the rendered part starts (the body comes after the title). */
  lineOffset?: number;
  /** Checkboxes can be ticked; otherwise they render disabled. */
  checkable?: boolean;
}

interface Env { ctx: RenderContext; lineOffset: number; checkable: boolean }

type RefKind = 'tag' | 'mention' | 'code';
const SIGIL: Record<string, RefKind> = { '#': 'tag', '@': 'mention', $: 'code' };
/** The token bodies of shared/content.ts, anchored where the sigil ends. */
const BODY: Record<RefKind, RegExp> = {
  tag: new RegExp(TOKEN_BODY.tag, 'uy'),
  mention: new RegExp(TOKEN_BODY.mention, 'uy'),
  code: new RegExp(TOKEN_BODY.code, 'uy'),
};

/** `#tag`, `@handle` and `$code` → one `jt_ref` token, by the same rules parseContent uses. */
function refRule(state: StateInline, silent: boolean): boolean {
  const kind = SIGIL[state.src[state.pos]];
  if (!kind) return false;
  if (!tokenBoundary(state.pos > 0 ? state.src[state.pos - 1] : undefined)) return false;
  const re = BODY[kind];
  re.lastIndex = state.pos + 1;
  const m = re.exec(state.src);
  if (!m) return false;
  const name = m[0];
  if (kind === 'code') {
    if (seqFromCode(name) === null) return false;
    // A card link inside a link label would nest anchors; leave it as text there.
    if ((state as StateInline & { linkLevel: number }).linkLevel > 0) return false;
  }
  if (!silent) state.push('jt_ref', '', 0).meta = { kind, name };
  state.pos += 1 + name.length;
  return true;
}

/** One run of a single line of text: plain, or a #tag / @mention / $code token. */
export type InlineSegment = { text: string } | { kind: RefKind; name: string };

/**
 * Splits one line (a card title) into text and tokens by the same rules as refRule, for rendering
 * as React elements instead of HTML.
 */
export function tokenizeInline(src: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let plain = '';
  for (let pos = 0; pos < src.length; ) {
    const kind = SIGIL[src[pos]];
    if (kind && tokenBoundary(pos > 0 ? src[pos - 1] : undefined)) {
      const re = BODY[kind];
      re.lastIndex = pos + 1;
      const name = re.exec(src)?.[0];
      if (name && (kind !== 'code' || seqFromCode(name) !== null)) {
        if (plain) out.push({ text: plain });
        plain = '';
        out.push({ kind, name });
        pos += 1 + name.length;
        continue;
      }
    }
    plain += src[pos++];
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Plain text of an inline token's children, for a checkbox's accessible name. */
const plainText = (children: Token[]) =>
  children.map((c) => (c.type === 'jt_ref' ? `${{ tag: '#', mention: '@', code: '$' }[c.meta.kind as RefKind]}${c.meta.name}` : c.content)).join('').trim();

/** `- [ ] x` / `* [x] x` list items → a checkbox carrying the item's line in the card text. */
function taskRule(state: StateCore): void {
  const env = state.env as Env;
  const lines = state.src.split('\n');
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const line = tok.map?.[0];
    if (line === undefined || !CHECKBOX.test(lines[line] ?? '')) continue;
    const first = tok.children?.[0];
    const m = first?.type === 'text' ? /^\[([ xX])\](?: |$)/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('jt_check', 'input', 0);
    box.meta = { checked: m[1] !== ' ', line: line + env.lineOffset, label: plainText(tok.children!) };
    tok.children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'md-task');
  }
}

function build(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true });
  const esc = md.utils.escapeHtml;
  md.inline.ruler.before('linkify', 'jt_ref', refRule);
  md.core.ruler.push('jt_tasks', taskRule);

  md.renderer.rules.jt_ref = (tokens, idx, _o, env: Env) => {
    const { kind, name } = tokens[idx].meta as { kind: RefKind; name: string };
    if (kind === 'tag') return `<span class="md-chip md-tag">#${esc(name.toLowerCase())}</span>`;
    if (kind === 'mention') {
      const handle = name.toLowerCase();
      const user = env.ctx.userName(handle);
      return user === null
        ? `<span class="md-chip md-mention">@${esc(name)}</span>`
        : `<span class="md-chip md-mention" title="@${esc(handle)}">@${esc(user)}</span>`;
    }
    const title = env.ctx.cardTitle(name);
    return title === null
      ? `<a class="card-ref missing" href="/card/${esc(name)}">$${esc(name)}</a>`
      : `<a class="card-ref" href="/card/${esc(name)}-${esc(slugOf(title) || 'card')}" title="$${esc(name)}">${esc(title)}</a>`;
  };

  md.renderer.rules.jt_check = (tokens, idx, _o, env: Env) => {
    const { checked, line, label } = tokens[idx].meta as { checked: boolean; line: number; label: string };
    return `<input type="checkbox" class="md-check" data-line="${line}"${checked ? ' checked' : ''}${env.checkable ? '' : ' disabled'} aria-label="${esc(label)}">`;
  };

  // Only our own attachments load as images. Any other URL (internet or LAN) would be fetched by
  // every viewer's browser just by opening the card, so it becomes a plain link instead.
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src') ?? '';
    if (OWN_FILE.test(src)) return defaultImage(tokens, idx, options, env, self);
    const alt = self.renderInlineAsText(tokens[idx].children ?? [], options, env);
    return `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(alt || src)}</a>`;
  };

  // Every link opens in a new tab and sends no referrer or opener. markdown-it's own validateLink
  // has already dropped javascript:, vbscript:, file: and non-image data: URLs.
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md;
}

/** An attachment served by this app (the id as the picker inserts it). */
export const OWN_FILE = /^\/api\/files\/[A-Za-z0-9_-]+$/;

let instance: MarkdownIt | null = null;

/**
 * Card text → HTML. markdown-it escapes all raw HTML (html:false); the only markup added here is
 * our chips, links and checkboxes, and every name or title they show is escaped.
 */
export function renderMarkdown(content: string, ctx: RenderContext, opts: RenderOptions = {}): string {
  instance ??= build();
  const env: Env = { ctx, lineOffset: opts.lineOffset ?? 0, checkable: opts.checkable ?? false };
  return instance.render(content, env);
}

/** The title line and the body below it (leading blank lines dropped), with the line the body starts on. */
export function splitTitle(content: string): { title: string; body: string; bodyStart: number } {
  const lines = content.split('\n');
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  return { title: titleOf(content), body: lines.slice(i).join('\n'), bodyStart: Math.min(i, lines.length) };
}

const MARK = /^(\s*[-*] \[)[ xX](\] )/;
/** A checklist line with its mark blanked, to compare items regardless of checked state. */
const unmarked = (line: string) => line.replace(MARK, '$1 $2');

/**
 * The text with the checklist item on `line` set to checked or not. Null when that line is no
 * checklist item, or (with `expected`, the line as it was when clicked) when it now holds a
 * different item: lines moved under us, and ticking by index would hit the wrong one.
 */
export function setCheckLine(content: string, line: number, checked: boolean, expected?: string): string | null {
  const lines = content.split('\n');
  if (line < 0 || line >= lines.length || !CHECKBOX.test(lines[line])) return null;
  if (expected !== undefined && unmarked(lines[line]) !== unmarked(expected)) return null;
  lines[line] = lines[line].replace(MARK, `$1${checked ? 'x' : ' '}$2`);
  return lines.join('\n');
}

/** Lookups for the renderer over what this person can see. */
export function renderContext(cards: Map<string, Card>, users: Map<string, User>): RenderContext {
  let byCode: Map<string, Card> | null = null;
  let byHandle: Map<string, User> | null = null;
  return {
    cardTitle(code) {
      byCode ??= new Map([...cards.values()].map((c) => [cardCode(c.seq), c]));
      const c = byCode.get(code);
      return c ? titleOf(c.content) : null;
    },
    userName(handle) {
      byHandle ??= new Map([...users.values()].filter((u) => !u.disabled).map((u) => [mentionHandle(u.name), u]));
      return byHandle.get(handle.normalize('NFC').toLowerCase())?.name ?? null;
    },
  };
}

import { describe, it, expect } from 'vitest';
import { renderContext, renderMarkdown, setCheckLine, splitTitle, tokenizeInline, type RenderContext } from '../web/src/markdown';
import { mentionHandle, parseContent } from '../shared/content';
import type { User } from '../shared/types';

const ctx: RenderContext = {
  cardTitle: (code) => (code === '115' ? 'Fog shader' : code === '116' ? '<b>Evil</b> task' : null),
  userName: (handle) => (handle === 'adaowner' ? 'Ada Owner' : handle === 'evil' ? '<img src=x onerror=alert(1)>' : null),
};
const r = (s: string) => renderMarkdown(s, ctx);

describe('renderMarkdown', () => {
  it('renders hostile content inert', () => {
    const out = r([
      '<img src=x onerror=alert(1)>',
      '#<script>alert(1)</script>',
      '@<b>x</b>',
      '[x](javascript:alert(1))',
      '[y](JAVASCRIPT:alert(1)) [z](vbscript:msgbox) [w](data:text/html,<script>alert(1)</script>)',
      '![i](javascript:alert(1))',
      '<script>alert(1)</script>',
      '$116 @evil #tag"onmouseover="alert(1)',
      '<javascript:alert(1)>',
    ].join('\n\n'));
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<b>/i);
    expect(out).not.toMatch(/href="\s*(javascript|vbscript|data):/i);
    expect(out).not.toMatch(/src="\s*javascript:/i);
    expect(out).not.toMatch(/<[^>]*\son[a-z]+=/i); // no event-handler attribute inside any real tag
    expect(out).toContain('&lt;b&gt;Evil&lt;/b&gt; task');
  });

  it('links $code to the task and shows its title', () => {
    const out = r('see $115 now');
    expect(out).toMatch(/<a class="card-ref" href="\/card\/115-fog-shader"[^>]*>Fog shader<\/a>/);
  });

  it('leaves unknown or invalid codes as plain task codes', () => {
    expect(r('$999zz')).toContain('/card/999zz');
    expect(r('price $abc!')).not.toContain('card-ref');
    expect(r('a$115')).not.toContain('card-ref');
  });

  it('renders #tag and @mention chips with the same rules as parseContent', () => {
    const out = r('fix #Bug for @adaowner and @nobody, not a#b');
    expect(out).toContain('<span class="md-chip md-tag">#bug</span>');
    expect(out).toContain('<span class="md-chip md-mention" title="@adaowner">@Ada Owner</span>');
    expect(out).toContain('<span class="md-chip md-mention">@nobody</span>'); // unknown user keeps the handle
    expect(out).toContain('a#b');
  });

  it('gives no chips inside code spans and fences', () => {
    const out = r('`#a @adaowner $115`\n\n```\n#b $115\n```');
    expect(out).not.toContain('md-chip');
    expect(out).not.toContain('card-ref');
  });

  it('renders checklist items as checkboxes with their line', () => {
    const out = r('- [ ] a');
    expect(out).toMatch(/<input type="checkbox" class="md-check" data-line="0"[^>]*>/);
    expect(out).not.toContain('[ ]');
    const two = r('Intro\n\n- [x] done\n- [ ] todo');
    expect(two).toMatch(/data-line="2" checked/);
    expect(two).toMatch(/data-line="3"(?! checked)/);
  });

  it('offsets checkbox lines for a body rendered without its title', () => {
    const { body, bodyStart } = splitTitle('Title\n\n- [ ] a');
    expect(body).toBe('- [ ] a');
    expect(renderMarkdown(body, ctx, { lineOffset: bodyStart })).toContain('data-line="2"');
  });

  it('opens links in a new tab without referrer', () => {
    const out = r('[site](https://example.com) and https://jatify.com');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>');
    expect(out).toContain('<a href="https://jatify.com" target="_blank" rel="noopener noreferrer">');
  });

  it('never nests a task link inside a link', () => {
    const out = r('[see $115](https://example.com)');
    expect(out).not.toContain('card-ref');
    expect(out).toContain('>see $115</a>');
  });

  it('loads only our own attachments as images; other URLs become plain links', () => {
    for (const src of ['https://tracker.example/pixel.png', 'http://192.168.1.1/x', '//evil.example/a.gif', '/api/status', '/api/files/../logout']) {
      const out = r(`![shot](${src})`);
      expect(out, src).not.toMatch(/<img/i);
      expect(out, src).toMatch(/<a href="[^"]*" target="_blank" rel="noopener noreferrer">shot<\/a>/);
    }
    expect(r('![](http://192.168.1.1/x)')).toContain('>http://192.168.1.1/x</a>');
    expect(r('![a "q" <b>](https://x.example/<i>)')).not.toMatch(/<(img|b|i)[ >]/);
    expect(r('![shot](/api/files/3f2a-b9_c)')).toContain('<img src="/api/files/3f2a-b9_c" alt="shot">');
  });

  it('renders headings', () => {
    expect(r('## Plan')).toContain('<h2>Plan</h2>');
  });
});

describe('setCheckLine', () => {
  it('rewrites only that line', () => {
    expect(setCheckLine('T\n- [ ] a\n- [ ] b', 2, true)).toBe('T\n- [ ] a\n- [x] b');
    expect(setCheckLine('T\n  * [X] a', 1, false)).toBe('T\n  * [ ] a');
  });
  it('refuses when the clicked item is no longer on that line', () => {
    // Clicked "- [ ] b" on line 2, but a line was inserted above before the save ran.
    const now = 'T\n- [ ] new\n- [ ] a\n- [ ] b';
    expect(setCheckLine(now, 2, true, '- [ ] b')).toBeNull();
    // Same item, mark changed by someone else meanwhile: still the item, so it is set.
    expect(setCheckLine('T\n- [x] a\n- [ ] b', 2, true, '- [x] b')).toBe('T\n- [x] a\n- [x] b');
    expect(setCheckLine('T\n- [ ] a', 1, true, '- [ ] a')).toBe('T\n- [x] a');
  });
  it('returns null when that line is no checklist item', () => {
    expect(setCheckLine('T\nplain', 1, true)).toBeNull();
    expect(setCheckLine('T', 5, true)).toBeNull();
  });
});

describe('mention handles', () => {
  const user = (name: string): User => ({ id: name, email: '', name, timezone: null, disabled: false, createdAt: 0 });
  it.each(["O'Brien", 'Ana María', 'Ada Owner', 'Zoë (QA)', 'J.R. Smith-Jones'])('every user is mentionable: %s', (name) => {
    const handle = mentionHandle(name);
    expect(handle).toMatch(/^[\p{L}\p{N}._-]+$/u);
    const text = `ping @${handle} please`;
    // The server derives exactly this handle from the text (and maps it back with mentionHandle) ...
    expect(parseContent(text).mentions.map((m) => m.toLowerCase())).toEqual([handle]);
    // ... and the renderer resolves the same token to the user.
    const ctx = renderContext(new Map(), new Map([[name, user(name)]]));
    const esc = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    expect(renderMarkdown(text, ctx)).toContain(`>@${esc}</span>`);
  });
  it('a decomposed (NFD) handle renders as the same user', () => {
    const ctx = renderContext(new Map(), new Map([['m', user('María')]]));
    const text = `ping @${mentionHandle('María')} please`.normalize('NFD');
    expect(renderMarkdown(text, ctx)).toContain('>@María</span>');
  });
  it('strips characters a mention cannot hold', () => {
    expect(mentionHandle("O'Brien")).toBe('obrien');
    expect(mentionHandle('Ana María')).toBe('anamaría');
  });
});

describe('tokenizeInline', () => {
  const tokens = (s: string) => tokenizeInline(s).filter((x) => 'kind' in x);
  /** Chips the markdown renderer makes for the same line. */
  const rendered = (s: string) => (renderMarkdown(s, ctx).match(/md-chip|card-ref/g) ?? []).length;
  it('finds a tag at the start of the line and splits the text around it', () => {
    expect(tokenizeInline('#art fix')).toEqual([{ kind: 'tag', name: 'art' }, { text: ' fix' }]);
    expect(tokenizeInline('fix #art')).toEqual([{ text: 'fix ' }, { kind: 'tag', name: 'art' }]);
  });
  it('turns a $ followed by something that is not a task code into plain text', () => {
    expect(tokenizeInline('costs $five and $ nope')).toEqual([{ text: 'costs $five and $ nope' }]);
    expect(tokens('$115')).toEqual([{ kind: 'code', name: '115' }]);
  });
  it('ends a tag or code at punctuation; a mention keeps its trailing dot, as the markdown rule does', () => {
    expect(tokenizeInline('#art.')).toEqual([{ kind: 'tag', name: 'art' }, { text: '.' }]);
    expect(tokenizeInline('$115.')).toEqual([{ kind: 'code', name: '115' }, { text: '.' }]);
    expect(tokenizeInline('(#art), @adaowner.')).toEqual([{ text: '(#art), ' }, { kind: 'mention', name: 'adaowner.' }]);
  });
  it('needs whitespace or the line start before the sigil', () => {
    expect(tokenizeInline('a#b x@y')).toEqual([{ text: 'a#b x@y' }]);
  });
  it('lets @mention and an unknown but well-formed $code through, like the renderer', () => {
    expect(tokens('hi @adaowner')).toEqual([{ kind: 'mention', name: 'adaowner' }]);
    expect(tokens('$zzzz')).toEqual([{ kind: 'code', name: 'zzzz' }]);
  });
  it('agrees with the markdown chip rule on how many tokens a line has', () => {
    for (const s of ['#art fix', 'x #a #b @adaowner $115', 'a#b', '$ nope', '(@adaowner)', '$115.', '$five', '$zzzz'])
      expect(tokens(s).length, s).toBe(rendered(s));
  });
});

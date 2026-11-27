import { describe, expect, it } from 'vitest';
import { detectLang, translateMarkdown, type GlossaryEntry, type Lang } from '../shared/translate';
import { entryPieces } from '../shared/translate';

type Run = (texts: string[], from: Lang, to: Lang) => Promise<string[]>;
const prefix: Run = async (texts, _from, to) => texts.map((t) => `[${to}] ${t}`);
const spy = () => {
  const calls: { texts: string[]; from: Lang; to: Lang }[] = [];
  const run: Run = async (texts, from, to) => { calls.push({ texts, from, to }); return prefix(texts, from, to); };
  return { calls, run };
};
const go = (text: string, to: Lang, o: { glossary?: GlossaryEntry[]; fallback?: Lang | null; run?: Run } = {}) =>
  translateMarkdown(text, to, { glossary: o.glossary ?? [], fallback: o.fallback === undefined ? 'it' : o.fallback, run: o.run ?? prefix });

describe('detectLang', () => {
  it('tells Italian from English, and gives up on short or tied text', () => {
    expect(detectLang('Vogliamo raccontare una storia? Se si, con che modalità?')).toBe('it');
    expect(detectLang('Decide how we tell the lore')).toBe('en');
    expect(detectLang('Lore')).toBeNull();
    expect(detectLang('Lore Storia')).toBeNull();
    expect(detectLang('Asdis Ozzac Ots')).toBeNull();
  });
  it('reads Italian elisions as Italian', () => {
    expect(detectLang('Corpi d’acqua chiamati')).toBe('it');
  });
});

describe('translateMarkdown structure', () => {
  it('keeps headings, checkboxes, list markers, numbers, quotes', async () => {
    expect((await go('## Storia\n- [ ] Scrivi la quest', 'en')).text).toBe('## [en] Storia\n- [ ] [en] Scrivi la quest');
    expect((await go('- [x] Fatto\n1. Uno\n2) Due\n> Citazione\n* Punto', 'en')).text)
      .toBe('- [x] [en] Fatto\n1. [en] Uno\n2) [en] Due\n> [en] Citazione\n* [en] Punto');
  });
  it('keeps table syntax and translates cells', async () => {
    const t = '| Nome | Descrizione |\n|---|---|\n| Asdis | la vera polena |';
    expect((await go(t, 'en')).text).toBe('| [en] Nome | [en] Descrizione |\n|---|---|\n| [en] Asdis | [en] la vera polena |');
  });
  it('does not translate fenced or inline code, URLs, links, mentions, codes, images', async () => {
    const { calls, run } = spy();
    const fence = '```\nconst storia = 1\n```';
    expect((await go(fence, 'en', { run })).text).toBe(fence);
    expect(calls).toHaveLength(0);
    const line = 'Vedi `codice` e https://example.com/a?b=1 con [[Lore]] di @dizmo su $abc12 e ![x](a.png) il [sito](https://x.y)';
    const r = await go(line, 'en', { run });
    expect(calls[0].texts[0]).toMatch(/^Vedi ⟦0⟧ e ⟦1⟧ con ⟦2⟧ di ⟦3⟧ su ⟦4⟧ e ⟦5⟧ il ⟦6⟧$/);
    expect(r.text).toBe(`[en] ${line}`);
    const html = '<div>\nuna storia che si vede\n</div>';
    expect((await go(html, 'en', { run })).text).toBe(html);
  });
});

describe('translateMarkdown glossary', () => {
  it('keeps names with no target exactly once', async () => {
    const { calls, run } = spy();
    const r = await go('Asdis è la vera polena', 'en', { glossary: [{ term: 'Asdis' }, { term: 'Ozzac Ots' }], run });
    expect(calls[0].texts).toEqual(['⟦0⟧ è la vera polena']);
    expect(r.text.split('Asdis')).toHaveLength(2);
    expect(r.text).toBe('[en] Asdis è la vera polena');
  });
  it('is whole-word, case-insensitive, and keeps the text as written; longer terms win', async () => {
    const { calls, run } = spy();
    const r = await go('asdis e Ozzac ots con Asdisone', 'en', { glossary: [{ term: 'Ozzac' }, { term: 'Asdis' }, { term: 'Ozzac Ots' }], run });
    expect(calls[0].texts).toEqual(['⟦0⟧ e ⟦1⟧ con Asdisone']);
    expect(r.text).toBe('[en] asdis e Ozzac ots con Asdisone');
  });
  it('replaces a term with a fixed target', async () => {
    const { calls, run } = spy();
    const r = await go('La Storia del mondo', 'en', { glossary: [{ term: 'Storia', en: 'Story' }], run });
    expect(calls[0].texts[0]).toMatch(/⟦0⟧/);
    expect(calls[0].texts[0]).not.toContain('Storia');
    expect(r.text).toContain('Story');
    expect(r.text).not.toContain('Storia');
  });
});

describe('translateMarkdown code-like tokens', () => {
  it('keeps identifiers, wildcards and paths', async () => {
    const { calls, run } = spy();
    expect((await go('Corpi d’acqua chiamati FB_Water_*', 'en', { run })).text).toBe('[en] Corpi d’acqua chiamati FB_Water_*');
    expect(calls[0].texts[0]).not.toContain('FB_Water');
    const s = 'Metti la mod in /images/mods/jatify-ui-inventory.webp subito.';
    expect((await go(s, 'en', { run })).text).toBe(`[en] ${s}`);
    expect(calls[1].texts[0]).toBe('Metti la mod in ⟦0⟧ subito.');
    const p = 'Il file src/data/projects.ts è vecchio';
    await go(p, 'en', { run });
    expect(calls[2].texts[0]).toBe('Il file ⟦0⟧ è vecchio');
  });
  it('keeps camelCase, ALLCAPS and extensions but not plain words', async () => {
    const { calls, run } = spy();
    await go('Usa getName e il GDD, poi **molto bene** e file.json qui', 'en', { run });
    expect(calls[0].texts[0]).toBe('Usa ⟦0⟧ e il ⟦1⟧, poi ⟦2⟧molto bene⟦3⟧ e ⟦4⟧ qui');
  });
});

describe('translateMarkdown emphasis and empties', () => {
  it('masks emphasis delimiters, translates inside, and falls back when one is lost', async () => {
    const { calls, run } = spy();
    const src = 'Questo è **molto** importante e *così*';
    const r = await go(src, 'en', { run });
    expect(calls[0].texts[0]).toBe('Questo è ⟦0⟧molto⟦1⟧ importante e ⟦2⟧così⟦3⟧');
    expect(r.text).toBe(`[en] ${src}`);
    expect(r.text.match(/\*\*/g)).toHaveLength(2);
    const drop: Run = async (t) => t.map((x) => `[en] ${x}`.replace('⟦1⟧', ''));
    expect((await go(src, 'en', { run: drop })).text).toBe(src);
  });
  it('keeps the original when the engine replies blank', async () => {
    const src = 'Il mondo è bello e grande';
    expect((await go(src, 'en', { run: async (t) => t.map(() => '  ') })).text).toBe(src);
  });
  it('keeps a term whose fixed target is empty', async () => {
    const r = await go('La Storia del mondo', 'en', { glossary: [{ term: 'Storia', en: '' }] });
    expect(r.text).toBe('[en] La Storia del mondo');
  });
});

describe('translateMarkdown safety', () => {
  it('falls back to the original block when a placeholder is dropped, duplicated or renumbered', async () => {
    const src = 'Asdis è la vera polena';
    const g = [{ term: 'Asdis' }];
    for (const bad of ['è la vera polena', '⟦0⟧ ⟦0⟧ è la', '⟦1⟧ è la vera polena', '⟦0⟧ ⟦1⟧ è la']) {
      expect((await go(src, 'en', { glossary: g, run: async (t) => t.map(() => bad) })).text).toBe(src);
    }
    const two = `${src}\nIl mondo è bello e grande`;
    const r = await go(two, 'en', { glossary: g, run: async (t) => t.map((x) => (x.includes('⟦') ? 'perso' : `[en] ${x}`)) });
    expect(r.text).toBe(`${src}\n[en] Il mondo è bello e grande`);
  });
  it('falls back wholesale when run returns the wrong count', async () => {
    const src = 'Il mondo è bello e grande';
    expect((await go(src, 'en', { run: async () => [] })).text).toBe(src);
  });
  it('sends only blocks that are not in the target language, in one batch', async () => {
    const { calls, run } = spy();
    const r = await go('Decide how we tell the lore\nVogliamo raccontare una storia? Se si, con che modalità?\nIl mondo è bello e grande', 'en', { run });
    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe('it');
    expect(calls[0].texts).toHaveLength(2);
    expect(r.text.split('\n')[0]).toBe('Decide how we tell the lore');
    expect(r.from).toBe('it');
  });
  it('uses the fallback for undetectable blocks; null fallback leaves them', async () => {
    expect((await go('Storia', 'en', { fallback: 'it' })).text).toBe('[en] Storia');
    expect(await go('Storia', 'en', { fallback: null })).toEqual({ text: 'Storia', from: null });
    expect((await go('Storia', 'en', { fallback: 'en' })).text).toBe('Storia');
  });
  it('reports from=null when nothing translated and leaves blank lines alone', async () => {
    expect(await go('Decide how we tell the lore\n\n', 'en')).toEqual({ text: 'Decide how we tell the lore\n\n', from: null });
  });
});

describe('entryPieces', () => {
  it('keeps text fields, list lines and table cells by place; drops empty, number-like and non-text values', () => {
    const layout = {
      blocks: [{ id: 'a', kind: 'table' }, { id: 'b', kind: 'lines' }, { id: 'c', kind: 'links' }],
      data: { a: { rows: [['Morso', '8'], ['Artiglio', '3.5 kg']] }, b: { items: ['Grr!', '', 'Ice'] }, c: { items: ['x'] } },
    };
    expect(entryPieces({ desc: 'Un lupo', dmg: 8, note: '  ', tag: 'nope' }, ['desc', 'dmg', 'note'], layout)).toEqual({
      'f:desc': 'Un lupo', 'b:a:0:0': 'Morso', 'b:a:1:0': 'Artiglio', 'b:b:0': 'Grr!', 'b:b:2': 'Ice',
    });
  });
});

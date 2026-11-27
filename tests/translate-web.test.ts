import { describe, it, expect } from 'vitest';
import { shownContent, shownEntry, shownTitle, needsOpen, type TranslateState } from '../web/src/translate';
import { Store } from '../web/src/store';
import { textVersion, type Lang } from '../shared/translate';
import type { Card, ResolvableEntry, Translation } from '../shared/types';

const EN = 'Fix the lantern\n\nThe lantern in the harbour does not light up when the player walks by.';
const IT = 'Sistemare la lanterna\n\nLa lanterna nel porto non si accende quando il giocatore passa.';
const card = (content: string, contentVersion = 3) => ({ id: 'c1', content, contentVersion } as Card);
const entry = (content: string) => ({ id: 'e1', content } as ResolvableEntry);
const row = (p: Partial<Translation>): Translation =>
  ({ kind: 'card', sourceId: 'c1', lang: 'it', sourceVersion: 3, fromLang: 'en', text: '[it] x', createdAt: 1, ...p });
const state = (rows: Translation[], enabled = true): TranslateState => ({
  translations: new Map(rows.map((r) => [`${r.kind}:${r.sourceId}:${r.lang}`, r])),
  account: { settings: { translationEnabled: enabled } } as TranslateState['account'],
});

describe('shownContent', () => {
  it('a current translation: the translated text and the language it came from', () => {
    const s = state([row({ text: `[it] ${EN}` })]);
    expect(shownContent(card(EN), 'it', false, s)).toEqual({ text: `[it] ${EN}`, from: 'en', pending: false });
  });
  it('a stale translation: the original, pending', () => {
    const s = state([row({ sourceVersion: 2 })]);
    expect(shownContent(card(EN), 'it', false, s)).toEqual({ text: EN, from: null, pending: true });
  });
  it('no row yet and the text is in another language: the original, pending', () => {
    expect(shownContent(card(EN), 'it', false, state([]))).toEqual({ text: EN, from: null, pending: true });
  });
  it('reading "as written": the original', () => {
    const s = state([row({})]);
    expect(shownContent(card(EN), 'original', false, s)).toEqual({ text: EN, from: null, pending: false });
  });
  it('show original: the original', () => {
    const s = state([row({})]);
    expect(shownContent(card(EN), 'it', true, s)).toEqual({ text: EN, from: null, pending: false });
  });
  it('a card already in the reader\'s language (no row, same language): the original, not pending', () => {
    expect(shownContent(card(IT), 'it', false, state([]))).toEqual({ text: IT, from: null, pending: false });
  });
  it('another language\'s row at this version: the server looked and found nothing for mine', () => {
    const s = state([row({ lang: 'en', fromLang: 'it', text: '[en] x' })]);
    expect(shownContent(card('Fix it'), 'it', false, s)).toEqual({ text: 'Fix it', from: null, pending: false });
  });
  it('a marker row (fromLang null): the original, no "Translated from"', () => {
    const s = state([row({ fromLang: null, text: 'ok' })]);
    expect(shownContent(card('ok'), 'it', false, s)).toEqual({ text: 'ok', from: null, pending: false });
  });
  it('translation switched off: never pending', () => {
    expect(shownContent(card(EN), 'it', false, state([], false))).toEqual({ text: EN, from: null, pending: false });
  });
  it('translation switched off: rows already there are not shown either (off means as written)', () => {
    const s = state([row({ text: '[it] y' })], false);
    expect(shownContent(card(EN), 'it', false, s)).toEqual({ text: EN, from: null, pending: false });
  });
});

describe('shownTitle', () => {
  it('the first line of the shown text', () => {
    const s = state([row({ text: `# [it] Lanterna\n\nresto` })]);
    expect(shownTitle(card(EN), 'it', s)).toBe('[it] Lanterna');
    expect(shownTitle(card(EN), 'original', s)).toBe('Fix the lantern');
    expect(shownTitle(card(EN), 'en', s)).toBe('Fix the lantern');
  });
});

describe('shownEntry (comments)', () => {
  const v = textVersion(EN);
  it('current when the row matches the text\'s version', () => {
    const s = state([row({ kind: 'entry', sourceId: 'e1', sourceVersion: v, text: '[it] c' })]);
    expect(shownEntry(entry(EN), 'it', false, s)).toEqual({ text: '[it] c', from: 'en', pending: false });
  });
  it('an edited comment: the original, pending', () => {
    const s = state([row({ kind: 'entry', sourceId: 'e1', sourceVersion: v + 1, text: '[it] c' })]);
    expect(shownEntry(entry(EN), 'it', false, s)).toEqual({ text: EN, from: null, pending: true });
  });
});

describe('needsOpen', () => {
  it('asks the server only when the text is pending in my language', () => {
    expect(needsOpen(card(EN), 'it', state([]))).toBe(true);
    expect(needsOpen(card(EN), 'original', state([]))).toBe(false);
    expect(needsOpen(card(EN), 'it', state([row({})]))).toBe(false);
    expect(needsOpen(card(EN), 'it', state([], false))).toBe(false);
  });
});

describe('store: translation rows', () => {
  const snap = () => ({
    me: { id: 'u1' }, account: { id: 'a', settings: {} }, users: [], accountRoles: [], projects: [], decks: [], cards: [],
    translations: [row({ text: 'a' })],
  });
  it('loads the snapshot\'s rows keyed kind:sourceId:lang, applies upserts and removes', async () => {
    const st = new Store();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(snap()), { status: 200 })) as typeof fetch;
    try { await st.load(); } finally { globalThis.fetch = realFetch; }
    expect(st.get().translations.get('card:c1:it')?.text).toBe('a');
    st.apply([{ model: 'translation', op: 'upsert', row: row({ lang: 'en' as Lang, text: 'b' }) }]);
    expect(st.get().translations.get('card:c1:en')?.text).toBe('b');
    st.apply([{ model: 'translation', op: 'remove', row: { kind: 'card', sourceId: 'c1', lang: 'it', cardId: 'c1' } }]);
    expect(st.get().translations.has('card:c1:it')).toBe(false);
    expect(st.get().translations.has('card:c1:en')).toBe(true);
  });
});

describe('glossary rows', () => {
  it('saves trimmed rows, leaves out empty words and empty translations', async () => {
    const { glossaryOf } = await import('../web/src/components/GlossaryDialog');
    expect(glossaryOf([{ term: ' polena ', en: '', it: '' }, { term: '', en: 'x', it: '' }, { term: 'Lanterna', en: ' Beacon ', it: '' }]))
      .toEqual([{ term: 'polena' }, { term: 'Lanterna', en: 'Beacon' }]);
  });
  it('finds a word written twice in any case', async () => {
    const { duplicateTerm } = await import('../web/src/components/GlossaryDialog');
    expect(duplicateTerm([{ term: 'polena' }, { term: 'Lore' }])).toBeNull();
    expect(duplicateTerm([{ term: 'polena' }, { term: 'POLENA' }])).toBe('POLENA');
  });
});

describe('search matches the shown text as well as the original', () => {
  it('quickResults finds a card by its translated title and a comment by its translation', async () => {
    const { quickResults } = await import('../shared/search');
    const c = { ...card(EN), seq: 1, lastUpdatedAt: 1 } as Card;
    const e = { id: 'e1', content: 'The wick is short', createdAt: 1 } as ResolvableEntry;
    const ctx = { shownTitle: () => '[it] Sistemare la lanterna', shownEntry: () => '[it] Lo stoppino è corto' } as never;
    expect(quickResults('sistemare', [c], [e]).cards).toEqual([]);
    expect(quickResults('sistemare', [c], [e], ctx).cards).toEqual([c]);
    expect(quickResults('lantern', [c], [e], ctx).cards).toEqual([c]);
    expect(quickResults('stoppino', [c], [e], ctx).comments).toEqual([e]);
    expect(quickResults('wick', [c], [e], ctx).comments).toEqual([e]);
  });
});

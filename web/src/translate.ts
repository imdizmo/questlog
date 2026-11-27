/**
 * Reading in your own language (spec 2026-11-26-auto-translate): which text a reader sees for a card or a comment, given
 * their reading language and the server's translation rows (store `translations`). Only display goes through here;
 * editing, copying, exporting and anything that writes keeps the original text.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { titleOf } from '../../shared/cards';
import { detectLang, textVersion, type Lang } from '../../shared/translate';
import type { AccountSettings, Card, ResolvableEntry } from '../../shared/types';
import { prefs, usePref } from './prefs';
import { store, useStore, type State } from './store';

/** A person's reading language: a language, or the text as its author wrote it. */
export type ReadLang = Lang | 'original';
export const READ_LANGS: readonly { value: ReadLang; label: string }[] = [
  { value: 'en', label: 'English' }, { value: 'it', label: 'Italiano' }, { value: 'original', label: 'As written' },
];
export const LANG_NAME: Record<Lang, string> = { en: 'English', it: 'Italian' };

const isReadLang = (v: unknown): v is ReadLang => v === 'en' || v === 'it' || v === 'original';
const isTrue = (v: unknown): v is boolean => v === true;

/** The reading language (pref `readLang`, default "as written") and a setter that saves it at once. */
export function useReadLang(): [ReadLang, (l: ReadLang) => void] {
  return [usePref('readLang', isReadLang, 'original'), setReadLang];
}
export const setReadLang = (l: ReadLang): void => prefs.set('readLang', l, true);
export const readLangNow = (): ReadLang => prefs.get('readLang', isReadLang, 'original');

/** The one-time "which language do you read?" question: asked while no reading language is stored and it wasn't answered. */
export const wantsReadLangPrompt = (): boolean =>
  prefs.ready() && !prefs.get('translatePrompted', isTrue, false) && prefs.get<ReadLang | null>('readLang', isReadLang, null) === null;
export function answerReadLangPrompt(l: ReadLang | null): void {
  if (l) setReadLang(l);
  prefs.set('translatePrompted', true, true);
}

export type TranslateState = Pick<State, 'translations'> & { account: { settings?: Partial<AccountSettings> } | null };

export interface Shown {
  text: string;
  /** The language the shown text was translated from; null: the original is shown. */
  from: Lang | null;
  /** No translation for this version yet: the original is shown while the server works on it. */
  pending: boolean;
}

const on = (s: TranslateState) => s.account?.settings?.translationEnabled === true;

function shown(kind: 'card' | 'entry', id: string, text: string, version: number, lang: ReadLang, showOriginal: boolean, s: TranslateState): Shown {
  const original: Shown = { text, from: null, pending: false };
  if (lang === 'original' || showOriginal || !on(s) || !text.trim()) return original;
  const row = s.translations.get(`${kind}:${id}:${lang}`);
  if (row && row.sourceVersion === version) return row.fromLang ? { text: row.text, from: row.fromLang, pending: false } : original;
  // Another language's row at this version: the server has looked at this text and found nothing to put into mine.
  const other = s.translations.get(`${kind}:${id}:${lang === 'en' ? 'it' : 'en'}`);
  if (other && other.sourceVersion === version) return original;
  return { text, from: null, pending: detectLang(text) !== lang };
}

/** A card's text as this reader sees it. */
export const shownContent = (card: Pick<Card, 'id' | 'content' | 'contentVersion'>, readLang: ReadLang, showOriginal: boolean, s: TranslateState = store.get()): Shown =>
  shown('card', card.id, card.content, card.contentVersion, readLang, showOriginal, s);

/** A card's title (first line) as this reader sees it, for lists, boards, tabs and search. */
export const shownTitle = (card: Pick<Card, 'id' | 'content' | 'contentVersion'>, readLang: ReadLang, s: TranslateState = store.get()): string =>
  titleOf(shownContent(card, readLang, false, s).text);

/** A comment as this reader sees it (comments are versioned by their text). */
export const shownEntry = (e: Pick<ResolvableEntry, 'id' | 'content'>, readLang: ReadLang, showOriginal: boolean, s: TranslateState = store.get()): Shown =>
  shown('entry', e.id, e.content, textVersion(e.content), readLang, showOriginal, s);

/** True when the server should be told someone is looking at this card (it then translates it first). */
export const needsOpen = (card: Pick<Card, 'id' | 'content' | 'contentVersion'>, readLang: ReadLang, s: TranslateState = store.get()): boolean =>
  shownContent(card, readLang, false, s).pending;

/** Asks the server to translate a card or comment now; at most once per text version per page load. Errors are ignored. */
const opened = new Set<string>();
export function openForTranslation(kind: 'card' | 'entry' | 'fields', id: string, version: number): void {
  const key = `${kind}:${id}:${version}`;
  if (opened.has(key)) return;
  if (opened.size > 500) opened.clear();
  opened.add(key);
  void fetch('/dispatch/translate/open', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, id }),
  }).catch(() => opened.delete(key));
}

/**
 * Display titles for a component: re-renders when translations, the setting or the reading language change, and
 * returns a function from card to the title to show.
 */
export function useShownTitle(): (card: Pick<Card, 'id' | 'content' | 'contentVersion'>) => string {
  const [lang] = useReadLang();
  const translations = useStore((s) => s.translations);
  const account = useStore((s) => s.account);
  return useCallback((card) => shownTitle(card, lang, { translations, account }), [lang, translations, account]);
}

/**
 * A Lore entry's field value, list line or table cell (shared/translate pieceKey) as this reader sees it: the
 * translation while its source still reads `value`, else `value`. Follows the entry's "Show original".
 */
export function useShownPiece(cardId: string | undefined): (key: string, value: string) => string {
  const [lang] = useReadLang();
  const on = useStore((s) => s.account?.settings?.translationEnabled === true);
  const row = useStore((s) => (cardId && lang !== 'original' ? s.translations.get(`fields:${cardId}:${lang}`) : undefined));
  const [showOriginal] = useShowOriginal(`card:${cardId ?? ''}`);
  const map = useMemo(() => {
    try { return row?.fromLang ? JSON.parse(row.text) as Record<string, [string, string]> : null; } catch { return null; }
  }, [row]);
  const missing = !!cardId && on && lang !== 'original' && !row;
  // Nothing looked at yet: ask once (the server ignores entries with no text outside the body).
  useEffect(() => { if (missing) openForTranslation('fields', cardId!, 0); }, [missing, cardId]);
  return useCallback((key: string, value: string) => {
    const p = on && !showOriginal ? map?.[key] : undefined;
    return p && p[0] === value ? p[1] : value;
  }, [on, showOriginal, map]);
}

// ---- "Show original", per item, for this page session ----
const originals = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Whether this item shows its original (toggled by "Show original" / "Show translation"), remembered until reload. */
export function useShowOriginal(key: string): [boolean, () => void] {
  useSyncExternalStore(subscribe, () => version);
  const toggle = () => {
    if (originals.has(key)) originals.delete(key); else originals.add(key);
    version++;
    for (const fn of [...listeners]) fn();
  };
  return [originals.has(key), toggle];
}

/**
 * A card's title as the signed-in reader sees it now (the page store and the stored reading language), for code
 * outside components: tab labels, the palette, Home's recents, rendered `$code` references.
 */
export const titleNow = (card: Pick<Card, 'id' | 'content' | 'contentVersion'>): string => shownTitle(card, readLangNow());

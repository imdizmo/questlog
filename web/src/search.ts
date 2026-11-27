import { useMemo } from 'react';
import type { Card } from '../../shared/types';
import { derivedStatus } from '../../shared/cards';
import { priorityLabel } from '../../shared/properties';
import { decodeChips, encodeChips, savedSearchName, type SearchCtx, type SearchToken, type SuggestCtx } from '../../shared/search';
import { navigate, parse, setQuery, useLocation } from './router';
import { localToday, openByCard } from './cards';
import { settingsOf, useStore } from './store';
import { shownEntry, shownTitle, useReadLang } from './translate';

export const SEARCH_INPUT_ID = 'search-box-input';

/** `/` lands here: puts the cursor in the top bar search box. */
export function focusSearchBox(): void {
  document.getElementById(SEARCH_INPUT_ID)?.focus();
}

export interface Chips { tokens: SearchToken[]; forceOr: boolean }

/** The chips in `?search=` (empty when absent or malformed). */
export function useChips(): Chips {
  const raw = useLocation().query.get('search') ?? '';
  return useMemo(() => decodeChips(raw) ?? { tokens: [], forceOr: false }, [raw]);
}

const sameToken = (a: SearchToken, b: SearchToken) => JSON.stringify(a) === JSON.stringify(b);
export const sameChips = (a: Chips, b: Chips) =>
  a.forceOr === b.forceOr && a.tokens.length === b.tokens.length && a.tokens.every((t, i) => sameToken(t, b.tokens[i]));

/**
 * Writes the chips to `?search=`. Decks and the deck page filter in place; every other page
 * hands the chips to /decks, which is where an organisation-wide search shows its results.
 */
export function setChips(chips: Chips): void {
  const value = chips.tokens.length ? encodeChips(chips.tokens, chips.forceOr) : null;
  const name = parse(location.pathname).name;
  if (name === 'deck' || name === 'deckCard' || name === 'decks') setQuery('search', value);
  else navigate(value ? `/decks?search=${value}` : '/decks');
}

export function addChip(cur: Chips, t: SearchToken): void {
  if (cur.tokens.some((x) => sameToken(x, t))) return;
  setChips({ tokens: [...cur.tokens, t], forceOr: cur.forceOr });
}

/** A chip's text without the leading "not": "'gets'", "blocked", "owned by Ada". */
export function chipLabel(t: SearchToken, ctx: SuggestCtx): string {
  return savedSearchName([{ ...t, isNegated: false }], ctx).replace(/ tasks$/, '');
}

export interface SearchContexts { search: SearchCtx; suggest: SuggestCtx }

/** Everything compileSearch and suggest need, rebuilt when the store changes. */
export function useSearchCtx(): SearchContexts {
  const s = useStore((x) => x);
  const [readLang] = useReadLang();
  return useMemo(() => {
    const settings = settingsOf(s);
    const open = openByCard(s.resolvables.values());
    const mine = new Map<string, string[]>();
    for (const t of s.userCardTags.values()) {
      if (t.userId !== s.me?.id) continue;
      const l = mine.get(t.cardId);
      if (l) l.push(t.tag); else mine.set(t.cardId, [t.tag]);
    }
    const kids = new Map<string, number>();
    const bySeq = new Map<number, Card>();
    for (const c of s.cards.values()) {
      bySeq.set(c.seq, c);
      if (c.parentCardId) kids.set(c.parentCardId, (kids.get(c.parentCardId) ?? 0) + 1);
    }
    const sprints = [...s.sprints.values()].sort((a, b) => a.startDay.localeCompare(b.startDay) || a.runNr - b.runNr);
    const search: SearchCtx = {
      status: (c) => derivedStatus(c, open.get(c.id) ?? new Set()),
      personalTags: (id) => mine.get(id) ?? [],
      subCount: (id) => kids.get(id) ?? 0,
      todayDay: localToday(), sprints, now: Date.now(),
      shownTitle: (c) => shownTitle(c, readLang, s),
      shownEntry: (e) => shownEntry(e, readLang, false, s).text,
    };
    const projectTags = new Set<string>();
    for (const p of s.projects.values()) for (const t of p.tags) projectTags.add(t.name);
    const personal = new Set<string>();
    for (const tags of mine.values()) for (const t of tags) personal.add(t);
    const suggest: SuggestCtx = {
      users: [...s.users.values()].map((u) => ({ id: u.id, name: u.name })),
      decks: [...s.decks.values()].sort((a, b) => a.seq - b.seq).map((d) => ({ id: d.id, title: d.title })),
      projectTags: [...projectTags].sort(), personalTags: [...personal].sort(),
      milestones: [...s.milestones.values()].map((m) => ({ id: m.id, name: m.name })),
      sprints: sprints.map((x) => ({ id: x.id, configId: x.configId, label: x.label })),
      sprintConfigs: [...s.sprintConfigs.values()].filter((c) => !c.isArchived).map((c) => ({ id: c.id, name: c.name })),
      priorityLabel: (p) => priorityLabel(p, settings),
      cardBySeq: (seq) => bySeq.get(seq) ?? null,
    };
    return { search, suggest };
  }, [s.cards, s.resolvables, s.userCardTags, s.users, s.decks, s.projects, s.milestones, s.sprints, s.sprintConfigs, s.me, s.account, s.translations, readLang]);
}

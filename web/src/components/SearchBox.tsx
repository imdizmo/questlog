import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Card } from '../../../shared/types';
import { titleOf, cardCode } from '../../../shared/cards';
import { quickResults, savedSearchName, suggest, type GoTo, type SearchToken } from '../../../shared/search';
import { dispatch } from '../api';
import { useStore } from '../store';
import { navigate, parse, useLocation } from '../router';
import { cardHref, deckPath } from '../cards';
import { showToast } from '../toast';
import { addChip, chipLabel, focusSearchBox, sameChips, SEARCH_INPUT_ID, setChips, useChips, useSearchCtx, type Chips } from '../search';
import { encodeChips } from '../../../shared/search';
import { Icon } from './icons';
import { completeStep } from '../onboarding';
import { useShownTitle } from '../translate';

interface Row {
  id: string;
  label: string;
  sub?: string;
  disabled?: boolean;
  onPick(): void;
  onDelete?(): void;
  deleteLabel?: string;
}
interface Group { heading: string; rows: Row[] }

/** The top bar search: chips in `?search=`, a suggestion menu, quick results and saved searches. */
export function SearchBox() {
  const shownTitle = useShownTitle();
  const uid = useId();
  const loc = useLocation();
  const s = useStore((x) => x);
  const chips = useChips();
  const ctx = useSearchCtx();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const route = loc.route;
  const scopeDeck = route.name === 'deck' || route.name === 'deckCard' ? [...s.decks.values()].find((d) => d.seq === route.deckSeq) : undefined;
  const liveCards = useMemo(() => [...s.cards.values()].filter((c) => c.visibility === 'default'), [s.cards]);
  const scopeCount = scopeDeck ? liveCards.filter((c) => c.deckId === scopeDeck.id).length : 0;

  const hrefOf = (c: Card) => cardHref(c, c.deckId ? s.decks.get(c.deckId) : null);
  const go = (to: string) => { setText(''); setOpen(false); navigate(to); };
  const pickToken = (t: SearchToken) => { setText(''); setOpen(false); addChip(chips, t); completeStep('useSearch'); };
  const pickGoto = (g: GoTo) => {
    if (g.kind === 'deck') { const d = s.decks.get(g.id); if (d) go(deckPath(d)); return; }
    if (g.kind === 'card') { const c = s.cards.get(g.id); if (c) go(hrefOf(c)); return; }
    const hit = commentHit(g.text);
    if (hit) go(hrefOf(hit)); else showToast('No comment contains that text.', 'info');
  };
  const commentHit = (needle: string): Card | null => {
    const e = quickResults(needle, liveCards, [...s.entries.values()], ctx.search).comments.find((x) => s.cards.has(s.resolvables.get(x.resolvableId)?.cardId ?? ''));
    const r = e ? s.resolvables.get(e.resolvableId) : undefined;
    return r ? s.cards.get(r.cardId) ?? null : null;
  };

  const mySaved = useMemo(
    () => [...s.savedSearches.values()].sort((a, b) => b.createdAt - a.createdAt),
    [s.savedSearches],
  );
  const apply = (c: Chips) => { setText(''); setOpen(false); setChips(c); completeStep('useSearch'); };
  const alreadySaved = mySaved.some((x) => sameChips(x, chips));

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    if (text.trim() === '') {
      const rows: Row[] = [{
        id: 'saved-mine', label: 'My tasks',
        onPick: () => apply({ tokens: s.me ? [{ category: 'owner', value: s.me.id, isNegated: false }] : [], forceOr: false }),
      }];
      for (const x of mySaved) {
        const name = savedSearchName(x.tokens, ctx.suggest, x.forceOr);
        rows.push({
          id: `saved-${x.id}`, label: name,
          onPick: () => apply({ tokens: x.tokens, forceOr: x.forceOr }),
          deleteLabel: `Delete saved search ${name}`,
          onDelete: () => { void dispatch('search', 'delete', { id: x.id }).catch(() => {}); },
        });
      }
      out.push({ heading: 'Saved searches', rows });
      return out;
    }
    const plain = !/^([!#@$]|g[dcm]:)/.test(text);
    const quick = plain ? quickResults(text, liveCards, [...s.entries.values()], ctx.search) : null;
    if (quick?.cards.length) {
      out.push({ heading: 'Tasks', rows: quick.cards.map((c) => ({ id: `q-${c.id}`, label: shownTitle(c), sub: `$${cardCode(c.seq)}`, onPick: () => go(hrefOf(c)) })) });
    }
    const comments = quick?.comments.flatMap((e) => {
      const card = s.cards.get(s.resolvables.get(e.resolvableId)?.cardId ?? '');
      return card ? [{ e, card }] : [];
    }) ?? [];
    if (comments.length) {
      out.push({ heading: 'Comments', rows: comments.map(({ e, card }) => ({
        id: `c-${e.id}`, label: (ctx.search.shownEntry?.(e) ?? e.content).replace(/\s+/g, ' ').slice(0, 90), sub: shownTitle(card), onPick: () => go(hrefOf(card)),
      })) });
    }
    for (const g of suggest(text, ctx.suggest)) {
      if (g.heading === 'Go to task' && quick?.codeHit) {
        const c = quick.codeHit;
        out.push({ heading: 'Go to task', rows: [{ id: `g-${c.id}`, label: shownTitle(c), sub: `$${cardCode(c.seq)}`, onPick: () => go(hrefOf(c)) }] });
        continue;
      }
      out.push({
        heading: g.heading,
        rows: g.items.map((it, i) => ({
          id: `s-${g.heading}-${i}`, label: it.label, disabled: it.disabled || (!it.token && !it.goto),
          onPick: () => (it.token ? pickToken(it.token) : it.goto ? pickGoto(it.goto) : undefined),
        })),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, ctx, liveCards, s.entries, s.resolvables, s.cards, s.decks, mySaved, s.me, chips, shownTitle]);

  const flat = groups.flatMap((g) => g.rows).filter((r) => !r.disabled);
  const optId = (r: Row) => `${uid}-${r.id}`;
  const activeRow = active >= 0 ? flat[active] : undefined;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (flat.length) setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % flat.length : (i - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow) { activeRow.onPick(); setActive(-1); }
      else if (text.trim() && !/^[!#@$]$/.test(text.trim())) pickToken({ category: 'content', value: text.trim(), isNegated: false });
    } else if (e.key === 'Backspace' && text === '' && chips.tokens.length) {
      setChips({ tokens: chips.tokens.slice(0, -1), forceOr: chips.forceOr });
    }
  };

  const saveSearch = async () => {
    try {
      await dispatch('search', 'save', { tokens: chips.tokens, forceOr: chips.forceOr });
      showToast(`Saved "${savedSearchName(chips.tokens, ctx.suggest, chips.forceOr)}".`, 'info', 3000);
    } catch { /* api toasts the error */ }
  };
  const searchAllDecks = () => {
    setOpen(false);
    navigate(chips.tokens.length ? `/decks?search=${encodeChips(chips.tokens, chips.forceOr)}` : '/decks');
  };
  const onDecksRoute = parse(location.pathname).name === 'decks';

  return (
    <div
      className="sbox"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        if (open) { focusSearchBox(); setOpen(false); } else (e.target as HTMLElement).blur();
      }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <div className="sbox-field" onClick={() => document.getElementById(SEARCH_INPUT_ID)?.focus()}>
        <Icon name="search" size={16} />
        <ul className="sbox-chips" aria-label="Search filters">
          {chips.tokens.map((t, i) => {
            const label = chipLabel(t, ctx.suggest);
            return (
              <li key={i} className={t.isNegated ? 'stoken negated' : 'stoken'}>
                {t.isNegated && <span className="stoken-not">not</span>}
                <span>{label}</span>
                <button type="button" className="chip-x" aria-label={`Remove filter ${t.isNegated ? 'not ' : ''}${label}`}
                  onClick={(e) => { e.stopPropagation(); setChips({ tokens: chips.tokens.filter((_, j) => j !== i), forceOr: chips.forceOr }); focusSearchBox(); }}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
        <input
          id={SEARCH_INPUT_ID} className="sbox-input" role="combobox" aria-label="Search tasks" aria-keyshortcuts="/"
          aria-expanded={open} aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={open && activeRow ? optId(activeRow) : undefined}
          placeholder="Search tasks…" autoComplete="off" spellCheck={false} value={text}
          onChange={(e) => { setText(e.target.value); setActive(-1); setOpen(true); }}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKey}
        />
        {chips.tokens.length === 0 && text === '' && <kbd className="sbox-kbd" aria-hidden>/</kbd>}
        {chips.tokens.length > 0 && (
          <span className="sbox-actions">
            <button type="button" className={chips.forceOr ? 'btn btn-active sbox-btn' : 'btn sbox-btn'} aria-pressed={chips.forceOr}
              title="Show tasks that match any chip instead of all of them"
              onClick={(e) => { e.stopPropagation(); setChips({ tokens: chips.tokens, forceOr: !chips.forceOr }); }}>Match any</button>
            <button type="button" className="btn sbox-btn" disabled={alreadySaved} title={alreadySaved ? 'This search is already saved' : 'Save this search'}
              onClick={(e) => { e.stopPropagation(); focusSearchBox(); void saveSearch(); }}>Save search</button>
          </span>
        )}
      </div>

      {open && (
        <div className="sbox-menu" onMouseDown={(e) => e.preventDefault()}>
          <div id={`${uid}-list`} role="listbox" aria-label="Search suggestions">
            {groups.map((g) => (
              <div key={g.heading} role="group" aria-label={g.heading} className="sbox-group">
                <div className="sbox-heading" aria-hidden>{g.heading}</div>
                {g.rows.map((r) => (
                  <div key={r.id} className="sbox-row" role="presentation">
                    <div id={optId(r)} role="option" aria-selected={r === activeRow} aria-disabled={r.disabled || undefined}
                      className={r === activeRow ? 'sbox-opt active' : r.disabled ? 'sbox-opt disabled' : 'sbox-opt'}
                      onClick={() => { if (!r.disabled) r.onPick(); }}>
                      <span className="sbox-opt-label">{r.label}</span>
                      {r.sub && <span className="sbox-opt-sub">{r.sub}</span>}
                    </div>
                    {r.onDelete && (
                      <button type="button" className="icon-btn" aria-label={r.deleteLabel} title="Delete saved search" onClick={r.onDelete}><Icon name="trash" size={15} /></button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="sbox-foot">
            {scopeDeck ? (
              <>
                <span>Searching {scopeCount} {scopeCount === 1 ? 'task' : 'tasks'} in this list</span>
                <button type="button" className="btn btn-ghost" onClick={searchAllDecks}>Search all lists</button>
              </>
            ) : (
              <span>{onDecksRoute ? 'Searching all lists' : 'Chips search all lists'}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

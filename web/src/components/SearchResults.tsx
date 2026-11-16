import { entryPath } from '../wiki';
import { useEffect, useMemo } from 'react';
import type { Card, Deck } from '../../../shared/types';
import { compileSearch } from '../../../shared/search';
import { Link } from '../router';
import { deckPath, openByCard } from '../cards';
import { settingsOf, useStore } from '../store';
import { setChips, useChips, useSearchCtx } from '../search';
import { CardTile } from './CardTile';
import { BulkBar, GroupSelect } from './BulkBar';
import { clearSelection, pruneSelection } from '../selection';
import { canEditContent, projectVisible } from '../store';

/** /decks with chips: every matching card in the workspace, grouped by deck. */
export function SearchResults() {
  const s = useStore((x) => x);
  const chips = useChips();
  const ctx = useSearchCtx();
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  const settings = settingsOf(s);

  const { byDeck, total } = useMemo(() => {
    const match = compileSearch(chips.tokens, chips.forceOr, ctx.search);
    const m = new Map<string, Card[]>();
    let n = 0;
    for (const c of s.cards.values()) {
      if (!c.deckId || c.visibility !== 'default' || !match(c)) continue;
      const d = s.decks.get(c.deckId), p = d && s.projects.get(d.projectId);
      if (!d || !p || p.isArchived || !projectVisible(s, p.id)) continue;
      const l = m.get(c.deckId);
      if (l) l.push(c); else m.set(c.deckId, [c]);
      n += 1;
    }
    for (const l of m.values()) l.sort((a, b) => a.seq - b.seq);
    const decks = [...m.keys()].map((id) => s.decks.get(id)).filter((d): d is Deck => !!d)
      .sort((a, b) => (s.projects.get(a.projectId)?.seq ?? 0) - (s.projects.get(b.projectId)?.seq ?? 0) || a.sortIndex - b.sortIndex || a.seq - b.seq);
    return { byDeck: decks.map((d) => ({ deck: d, cards: m.get(d.id) ?? [] })), total: n };
  }, [s.cards, s.decks, s.projects, s.projectPrefs, chips, ctx]);

  const editable = (d: Deck) => { const p = s.projects.get(d.projectId); return !!p && canEditContent(s, p); };
  // Only decks I can edit take part; the order is the rendered order across decks.
  const order = byDeck.filter(({ deck }) => editable(deck)).flatMap(({ cards }) => cards.map((c) => c.id));
  const orderKey = order.join(',');
  useEffect(() => clearSelection, []);
  useEffect(() => { pruneSelection(new Set(order)); }, [orderKey]);

  return (
    <>
      <p className="hint filter-note" role="status">
        {total} {total === 1 ? 'task' : 'tasks'} in {byDeck.length} {byDeck.length === 1 ? 'list' : 'lists'}{' '}
        <button type="button" className="btn btn-ghost" onClick={() => setChips({ tokens: [], forceOr: false })}>Clear search</button>
      </p>
      {total === 0 && <div className="empty"><p>No tasks match these filters.</p></div>}
      {byDeck.map(({ deck, cards }) => {
        const project = s.projects.get(deck.projectId);
        return (
          <section key={deck.id} className="card-group" aria-label={deck.title}>
            <div className="group-bar">
              {editable(deck) && <GroupSelect label={deck.title} ids={cards.map((c) => c.id)} />}
              <h3 className="group-head"><Link href={deckPath(deck)}>{deck.title}</Link></h3>
              <span className="group-stats">{project?.name} · {cards.length} {cards.length === 1 ? 'task' : 'tasks'}</span>
            </div>
            <ul className="card-list" aria-label={`${deck.title} results`}>
              {cards.map((c) => (
                <li key={c.id}>
                  <CardTile card={c} deck={deck} open={open.get(c.id) ?? new Set()} href={c.isDoc && c.entryKey && project ? entryPath(project.seq, c) : undefined}
                    owner={c.assigneeId ? s.users.get(c.assigneeId) : undefined} settings={settings} projectTags={project?.tags} selectOrder={editable(deck) ? order : undefined} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <BulkBar cards={s.cards} />
    </>
  );
}

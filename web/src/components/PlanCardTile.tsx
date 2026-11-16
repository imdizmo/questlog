import { useMemo } from 'react';
import type { Card } from '../../../shared/types';
import { openByCard } from '../cards';
import { settingsOf, useStore } from '../store';
import { CardTile } from './CardTile';

/** Everything a card tile needs, looked up once for a list of cards on a planning page. */
export function usePlanTile() {
  const s = useStore((x) => x);
  const settings = settingsOf(s);
  const open = useMemo(() => openByCard(s.resolvables.values()), [s.resolvables]);
  return (c: Card) => {
    const deck = c.deckId ? s.decks.get(c.deckId) : undefined;
    if (!deck) return null;
    return (
      <CardTile card={c} deck={deck} open={open.get(c.id) ?? new Set()} owner={c.assigneeId ? s.users.get(c.assigneeId) : undefined}
        settings={settings} projectTags={s.projects.get(deck.projectId)?.tags} />
    );
  };
}

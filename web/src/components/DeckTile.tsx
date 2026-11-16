import type { Deck, DeckType, DerivedStatus } from '../../../shared/types';
import { STATUS_LABEL } from '../../../shared/cards';
import { Link } from '../router';
import { DeckTypeIcon, DECK_TYPE_LABEL, Icon } from './icons';
import { CoverArt } from './CoverArt';
import { useStore } from '../store';
import { Menu, type MenuItem } from './Menu';

export { STATUS_LABEL };
const ORDER: DerivedStatus[] = ['unassigned', 'assigned', 'started', 'blocked', 'review', 'snoozing', 'done'];

/** Spoken part of a tile's link name after the title, e.g. "task deck, 2 started, 1 done". */
export function deckSummary(type: DeckType, counts: ReadonlyArray<readonly [number, string]>, docCount: number): string {
  const parts: string[] = [];
  if (type !== 'mixed') parts.push(DECK_TYPE_LABEL[type].toLowerCase());
  for (const [n, label] of counts) parts.push(`${n} ${label}`);
  if (docCount > 0) parts.push(`${docCount} lore`);
  if (counts.length === 0 && docCount === 0) parts.push('empty');
  return parts.join(', ');
}

export { deckPath as deckHref } from '../cards';
import { deckPath as deckHref } from '../cards';

interface Props {
  deck: Deck;
  counts: Record<DerivedStatus, number>;
  /** Cards that have no status (docs). */
  docCount: number;
  hideDone: boolean;
  actions?: MenuItem[];
  /** Given to people who can edit: shown in place of a missing cover. */
  onAddCover?: () => void;
}

export function DeckTile({ deck, counts, docCount, hideDone, actions, onAddCover }: Props) {
  const subscribed = useStore((st) => st.deckSubscriptions.has(`${st.me?.id}|${deck.id}`));
  const shown = ORDER.filter((s) => counts[s] > 0 && !(hideDone && s === 'done'));
  const total = ORDER.reduce((n, s) => n + counts[s], 0) + docCount;
  const summary = deckSummary(deck.deckType, shown.map((s) => [counts[s], STATUS_LABEL[s].toLowerCase()] as const), docCount);
  return (
    <article className={`deck-tile type-${deck.deckType}`} data-testid="deck-tile">
      {/* The visible counts are just numbers and dots; the link's name says them in words. */}
      <Link href={deckHref(deck)} className="deck-link" aria-label={`${deck.title}, ${summary}`}>
        {/* No cover picked yet: the deck still gets artwork, drawn from its number. */}
        <CoverArt cover={deck.cover ?? { kind: 'art', id: deck.seq }} size="tile" testId={deck.cover ? undefined : 'deck-cover-default'} />
        <span className="deck-top">
          <span aria-hidden className="deck-icon-wrap"><DeckTypeIcon type={deck.deckType} /></span>
          <span className="deck-title">{deck.title}</span>
          {subscribed && <span className="deck-sub" role="img" aria-label="Subscribed" title="You are subscribed to this list"><Icon name="bell" size={14} /></span>}
        </span>
        <span className="deck-counts" aria-hidden>
          {shown.map((s) => (
            <span key={s} className={`count status-${s}`} title={STATUS_LABEL[s]}>
              <span className="dot" />{counts[s]}
            </span>
          ))}
          {docCount > 0 && <span className="count status-doc" title="Lore"><span className="dot" />{docCount}</span>}
          {total === 0 && <span className="count-empty">Empty</span>}
        </span>
      </Link>
      {!deck.cover && onAddCover && (
        <button type="button" className="cover-add" onClick={onAddCover}><Icon name="plus" size={14} /> Add cover</button>
      )}
      {actions && actions.length > 0 && (
        <div className="deck-menu">
          <Menu label={`List actions for ${deck.title}`} trigger={<Icon name="more" />} items={actions} />
        </div>
      )}
    </article>
  );
}

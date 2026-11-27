import { taskId } from '../taskId';
import type { AccountSettings, Card, Deck, ProjectTag, ResolvableContext, User } from '../../../shared/types';
import { InlineTitle } from './InlineTitle';
import { cardCode, derivedStatus, STATUS_LABEL, titleOf } from '../../../shared/cards';
import { isPastDate, priorityLabel } from '../../../shared/properties';
import { Link } from '../router';
import { cardHref, keepSearch, formatDay, localToday, wordCount } from '../cards';
import { PriorityMark } from './PriorityButtons';
import { Icon } from './icons';
import { subCountLabel } from '../relations';
import { tagMark } from './TagToggles';
import { SelectBox } from './BulkBar';
import { useEffortOn } from '../store';
import { useShownTitle } from '../translate';

/** Tag chips shown on a tile before the rest collapse into "+N" (observed). */
const MAX_TAGS = 3;

interface Props {
  /** Where the tile leads, when not to the task in its list (a wiki entry found by search opens in the Wiki). */
  href?: string;
  card: Card;
  deck: Deck;
  open: Set<ResolvableContext>;
  owner?: User;
  selected?: boolean;
  settings: Pick<AccountSettings, 'priorityLabels' | 'dueDateEnabled' | 'dependenciesEnabled'>;
  /** The project's tags, for their emoji. */
  projectTags?: ProjectTag[];
  /** Title of the hero card, for sub cards. */
  parentTitle?: string;
  /** My own private tags on this card. */
  personalTags?: string[];
  /** Hero cards: how many sub cards, and the effort including them (shown instead of the own effort). */
  hero?: { subCount: number; effort: number };
  /** One line: title, priority, effort and owner only. */
  compact?: boolean;
  /** Visible card ids in order; gives the tile a Select box (editors only). */
  selectOrder?: readonly string[];
}

/** A card in a deck list. The link's name says in words what the badges show. */
export function CardTile({ href, card, deck, open, owner, selected, settings, projectTags, parentTitle, personalTags = [], hero, compact, selectOrder }: Props) {
  const title = useShownTitle()(card);
  const code = cardCode(card.seq);
  const status = derivedStatus(card, open);
  const words = card.isDoc ? wordCount(card.content) : 0;
  const tagInfo = new Map((projectTags ?? []).map((t) => [t.name, t]));
  const tags = card.masterTags ?? [];
  const shownTags = tags.slice(0, MAX_TAGS);
  const due = settings.dueDateEnabled ? card.dueDate : null;
  // Same notion of done as the status badge (derived), not the raw column.
  const pastDue = due !== null && status !== 'done' && isPastDate(due, localToday());
  const prio = card.priority ? priorityLabel(card.priority, settings) : null;
  const locked = settings.dependenciesEnabled && !!card.hasBlockingDeps && status !== 'done';
  const effort = !useEffortOn() ? null : hero ? hero.effort : card.effort;
  const spoken = [
    parentTitle ? `${parentTitle} › ${title}` : title, taskId(card),
    status ? STATUS_LABEL[status] : `lore, ${words} words`,
    card.visibility === 'archived' ? 'archived' : '',
    locked ? 'locked by unfinished tasks' : '',
    hero ? `main task, ${subCountLabel(hero.subCount)}` : '',
    prio ? `${prio} priority` : '',
    effort !== null ? `${effort} effort${hero ? ' with subtasks' : ''}` : '',
    tags.length ? `tags ${tags.join(', ')}` : '',
    due ? `${pastDue ? 'overdue, was due' : 'due'} ${formatDay(due)}` : '',
    personalTags.length ? `my tags ${personalTags.join(', ')}` : '',
    owner ? `owner ${owner.name}` : '',
  ].filter(Boolean).join(', ');
  return (
    <article className={`card-tile st-${status ?? 'doc'}${card.isDoc ? ' is-doc' : ''}${selected ? ' selected' : ''}${card.visibility === 'archived' ? ' is-archived' : ''}${compact ? ' compact' : ''}${selectOrder ? ' selectable' : ''}`}
      data-testid="card-tile">
      {selectOrder && <SelectBox id={card.id} order={selectOrder} title={title} />}
      <Link href={href ?? keepSearch(cardHref(card, deck))} className="card-link" aria-label={spoken} aria-current={selected ? 'page' : undefined}>
        {card.coverFileId && !compact && (
          <img className="card-cover-banner" src={`/api/files/${encodeURIComponent(card.coverFileId)}`} alt="" loading="lazy" data-testid="cover" />
        )}
        <span className="card-title">
          {locked && <span className="lock-mark" data-testid="locked" title="Locked: waiting for unfinished tasks"><Icon name="lock" size={13} /></span>}
          {parentTitle && <span className="card-parent" data-testid="parent-title"><InlineTitle text={parentTitle} /> ›</span>}
          <InlineTitle text={title} />
        </span>
        <span className="card-meta" aria-hidden>
          {card.priority && (
            <span className={`prio-badge prio-${card.priority}`} data-testid="priority" title={`Priority: ${prio}`}>
              <PriorityMark priority={card.priority} />
            </span>
          )}
          {!compact && <span className="code">{taskId(card)}</span>}
          {!compact && status && <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>}
          {!compact && card.isDoc && <span className="words">{words}w</span>}
          {card.visibility === 'archived' && <span className="badge">Archived</span>}
          {!compact && shownTags.map((t) => (
            <span key={t} className="tag-chip" data-testid="tag"><span className="tag-mark">{tagMark(tagInfo.get(t))}</span>{t}</span>
          ))}
          {!compact && tags.length > MAX_TAGS && <span className="tag-chip more" title={tags.slice(MAX_TAGS).join(', ')}>+{tags.length - MAX_TAGS}</span>}
          {!compact && personalTags.map((t) => <span key={t} className="tag-chip personal" data-testid="personal-tag" title="Only you see this tag">{t}</span>)}
          {!compact && due && <span className={`due-chip${pastDue ? ' past' : ''}`} data-testid="due" title={`Due ${due}`}>Due {formatDay(due)}</span>}
          <span className="card-meta-end">
            {hero && <span className="sub-count" title={subCountLabel(hero.subCount)}><Icon name="hero" size={13} />{hero.subCount}</span>}
            {effort !== null && (
              <span className={`effort-badge${hero ? ' hero' : ''}`} data-testid="effort"
                title={hero ? `${effort} effort including subtasks` : `${effort} effort`}>{effort}</span>
            )}
            {owner && <span className="avatar sm" data-testid="owner" title={owner.name}>{owner.name.slice(0, 1).toUpperCase()}</span>}
          </span>
        </span>
      </Link>
    </article>
  );
}

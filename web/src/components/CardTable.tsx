import type { AccountSettings, Card, Deck, Milestone, ProjectTag, ResolvableContext, Sprint, User } from '../../../shared/types';
import type { CardGroup } from '../../../shared/order';
import type { SearchToken } from '../../../shared/search';
import { titleOf } from '../../../shared/cards';
import { Link } from '../router';
import { cardHref, keepSearch } from '../cards';
import { formatShort } from '../timeTracking';
import { PriorityMark } from './PriorityButtons';
import { Icon } from './icons';
import { InlineTitle } from './InlineTitle';
import { tagMark } from './TagToggles';
import { GroupSelect, SelectBox } from './BulkBar';
import { useEffortOn } from '../store';

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** What a group holds, in words: "7 cards · 8 of 18 effort done". */
export const groupStatsText = (g: CardGroup, effort: boolean): string =>
  `${g.cards.length} ${g.cards.length === 1 ? 'task' : 'tasks'}` + (effort ? ` · ${fmt(g.effortDone)} of ${fmt(g.effortTotal)} effort done` : '');

/** The group header's icon button: adds the group's token as a filter chip. */
export function GroupFilterButton({ group, onFilter }: { group: CardGroup; onFilter(t: SearchToken): void }) {
  if (!group.filterToken) return null;
  const token = group.filterToken;
  return (
    <button type="button" className="icon-btn group-filter" aria-label={`Filter by ${group.label}`} title={`Filter by ${group.label}`} onClick={() => onFilter(token)}>
      <Icon name="search" size={15} />
    </button>
  );
}

interface Props {
  groups: CardGroup[];
  deck: Deck;
  settings: Pick<AccountSettings, 'priorityLabels' | 'sprintsEnabled' | 'milestonesEnabled'>;
  sprints: Map<string, Sprint>;
  milestones: Map<string, Milestone>;
  users: Map<string, User>;
  projectTags?: ProjectTag[];
  open: Map<string, Set<ResolvableContext>>;
  /** Tracked time per card in ms; null when time tracking is off (the column is left out). */
  timeOf: ((cardId: string) => number) | null;
  selected?: string;
  /** Editors only: adds a Select column and group Select buttons. */
  selectable?: boolean;
  onFilter(t: SearchToken): void;
}

/** The deck as a table: one row per card, group header rows carry the same effort summary as the list. */
export function CardTable({ groups, deck, settings, sprints, milestones, users, projectTags, open, timeOf, selected, selectable, onFilter }: Props) {
  const tagInfo = new Map((projectTags ?? []).map((t) => [t.name, t]));
  const runs = settings.sprintsEnabled, miles = settings.milestonesEnabled;
  const effortOn = useEffortOn();
  const cols = 5 + (runs ? 1 : 0) + (miles ? 1 : 0) + (timeOf ? 1 : 0) + (selectable ? 1 : 0);
  const order = groups.flatMap((g) => g.cards.map((c) => c.id));
  return (
    <div className="table-wrap deck-table-wrap">
      <table className="table deck-table" aria-label="Tasks">
        <thead>
          <tr>
            {selectable && <th scope="col"><span className="sr-only">Select</span></th>}
            <th scope="col"><span className="sr-only">Priority or type</span></th>
            {effortOn && <th scope="col">Effort</th>}
            {runs && <th scope="col">Sprint</th>}
            {miles && <th scope="col">Milestone</th>}
            <th scope="col">Owner</th>
            <th scope="col">Title</th>
            {timeOf && <th scope="col">Tracked</th>}
            <th scope="col"><span className="sr-only">Open conversation</span></th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            <tr className="group-row">
              <th colSpan={cols} scope="colgroup">
                <span className="group-bar">
                  {selectable && <GroupSelect label={g.label} ids={g.cards.map((c) => c.id)} />}
                  <GroupFilterButton group={g} onFilter={onFilter} />
                  <span className="group-label">{g.label}</span>
                  <span className="group-stats" data-testid="group-stats">{groupStatsText(g, effortOn)}</span>
                </span>
              </th>
            </tr>
            {g.cards.map((c: Card) => {
              const owner = c.assigneeId ? users.get(c.assigneeId) : undefined;
              const sprint = c.sprintId ? sprints.get(c.sprintId) : undefined;
              const milestone = c.milestoneId ? milestones.get(c.milestoneId) : undefined;
              const talk = (open.get(c.id)?.size ?? 0) > 0;
              return (
                <tr key={c.id} className={c.id === selected ? 'selected' : undefined} data-testid="card-row">
                  {selectable && <td className="select-cell"><SelectBox id={c.id} order={order} title={titleOf(c.content)} /></td>}
                  <td>
                    {c.isDoc ? <Icon name="doc" size={15} title="Lore" />
                      : c.priority ? <span title={`Priority: ${settings.priorityLabels[c.priority]}`}><PriorityMark priority={c.priority} /></span> : null}
                  </td>
                  {effortOn && <td>{c.effort !== null && <span className="effort-badge">{c.effort}</span>}</td>}
                  {runs && <td>{sprint?.label}</td>}
                  {miles && <td>{milestone?.name}</td>}
                  <td>{owner && <span className="avatar sm" title={owner.name}>{owner.name.slice(0, 1).toUpperCase()}</span>}</td>
                  <td>
                    <div className="deck-table-title">
                    <Link href={keepSearch(cardHref(c, deck))} aria-current={c.id === selected ? 'page' : undefined}><InlineTitle text={titleOf(c.content)} /></Link>
                    {(c.masterTags ?? []).map((t) => (
                      <span key={t} className="tag-chip"><span className="tag-mark">{tagMark(tagInfo.get(t))}</span>{t}</span>
                    ))}
                    </div>
                  </td>
                  {timeOf && <td className="num">{timeOf(c.id) > 0 ? formatShort(timeOf(c.id)) : ''}</td>}
                  <td>{talk && <span className="talk-mark"><Icon name="review" size={15} title="Open conversation" /></span>}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

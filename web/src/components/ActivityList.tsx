import { useMemo } from 'react';
import { filterOf, formatDay, sentence, type ActivityItem, type ActivityLookup } from '../../../shared/activity';
import { cardCode } from '../../../shared/cards';
import { priorityLabel } from '../../../shared/properties';
import { settingsOf, useStore } from '../store';
import { InlineTitle } from './InlineTitle';
import { Icon, type IconName } from './icons';

/** Lookup for `sentence`. A card renders as its `$code`, so InlineTitle shows it as a linked chip. */
export function useActivityLookup(): ActivityLookup {
  const cards = useStore((s) => s.cards);
  const users = useStore((s) => s.users);
  const decks = useStore((s) => s.decks);
  const projects = useStore((s) => s.projects);
  const account = useStore((s) => s.account);
  const milestones = useStore((s) => s.milestones);
  const zones = useStore((s) => s.milestoneZones);
  const sprints = useStore((s) => s.sprints);
  return useMemo(() => {
    const labels = settingsOf({ account } as never).priorityLabels;
    return {
      card: (id) => { const c = cards.get(id); return c ? `$${cardCode(c.seq)}` : null; },
      user: (id) => (id === 'system' ? 'System' : users.get(id)?.name ?? 'someone'),
      deck: (id) => decks.get(id)?.title ?? 'a list',
      project: (id) => projects.get(id)?.name ?? 'a project',
      milestone: (id) => milestones.get(id)?.name ?? 'a milestone',
      milestoneZone: (id) => { const z = zones.get(id); return z ? `${z.name} of ${milestones.get(z.milestoneId)?.name ?? 'a milestone'}` : 'a milestone zone'; },
      sprint: (id) => sprints.get(id)?.label ?? 'a sprint',
      priorityLabel: (p) => priorityLabel(p as 'a' | 'b' | 'c', { priorityLabels: labels }),
    };
  }, [cards, users, decks, projects, account, milestones, zones, sprints]);
}

function iconOf(it: ActivityItem): IconName {
  if (it.kind === 'deckCreated') return 'plus';
  if (it.kind === 'entry') return 'review';
  const c = it.changes?.[0];
  if (!c) return 'edit';
  if (c.kind === 'status' && c.to === 'done') return 'check';
  switch (filterOf(c.kind)) {
    case 'newCards': return 'plus';
    case 'workflow': return 'play';
    case 'done': return 'check';
    case 'attachments': return 'file';
    case 'content': return 'edit';
    case 'conversations': return 'review';
    default: return 'gear';
  }
}

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayOffset = (n: number) => localDay(Date.now() - n * 86_400_000);
export function dayLabel(ms: number): string {
  const d = localDay(ms);
  return d === dayOffset(0) ? 'Today' : d === dayOffset(1) ? 'Yesterday' : formatDay(d);
}

/** One entry: actor avatar, type icon, then the card chip (when the sentence does not already name the card) and the sentence. */
export function ActivityRow({ item, lookup }: { item: ActivityItem; lookup: ActivityLookup }) {
  const stored = useStore((s) => s.users.get(item.actorId));
  const actor = item.actorId === 'system' ? { name: 'System' } : stored;
  const text = sentence(item, lookup);
  const code = item.cardId ? lookup.card(item.cardId) : null;
  const named = !!code && text.includes(code);
  const time = new Date(item.at);
  return (
    <li className="activity-item" data-testid="activity-item">
      <span className="avatar sm" title={actor?.name ?? 'someone'}>{(actor?.name ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="activity-icon"><Icon name={iconOf(item)} size={14} /></span>
      <div className="activity-text">
        {code && !named && <><InlineTitle text={code} links />{' '}</>}
        {item.kind === 'entry' && code
          // Message quotes stay plain text: only the card chip is rich.
          ? <><InlineTitle text={code} links /> wrote {item.quote}</>
          : item.kind === 'entry' ? text : <InlineTitle text={text} links />}
        <span className="muted activity-who"> · {actor?.name ?? 'someone'}</span>
      </div>
      <time className="muted activity-time" dateTime={time.toISOString()}>{time.toLocaleTimeString(undefined, { timeStyle: 'short' })}</time>
    </li>
  );
}

/** Items grouped by day, newest first. */
export function ActivityList({ items, compact = false }: { items: ActivityItem[]; compact?: boolean }) {
  const lookup = useActivityLookup();
  const groups = useMemo(() => {
    const out: { label: string; items: ActivityItem[] }[] = [];
    for (const it of items) {
      const label = dayLabel(it.at);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(it); else out.push({ label, items: [it] });
    }
    return out;
  }, [items]);
  return (
    <div className="activity-list" data-testid="activity-list">
      {groups.map((g) => (
        <section key={g.label} className="activity-group" aria-label={g.label}>
          {!compact && <h3 className="group-head">{g.label}</h3>}
          <ol className="activity-items">{g.items.map((it) => <ActivityRow key={it.id} item={it} lookup={lookup} />)}</ol>
        </section>
      ))}
    </div>
  );
}

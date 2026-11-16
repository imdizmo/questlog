import { useEffect, useMemo, useState } from 'react';
import { Link } from '../../router';
import { Icon } from '../../components/icons';
import { PriorityMark } from '../../components/PriorityButtons';
import { renderMarkdown, splitTitle } from '../../markdown';
import { showToast } from '../../toast';
import { openApi, openMessage, type PublicCard, type PublicCardFull, type PublicStatus } from './api';
import type { OpenCtx } from './OpenApp';

const STATUS_TEXT: Record<Exclude<PublicStatus, null>, string> = { notStarted: 'Not started', started: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done' };
const STATUS_CLASS: Record<Exclude<PublicStatus, null>, string> = { notStarted: 'unassigned', started: 'started', blocked: 'blocked', review: 'review', done: 'done' };
const PRIORITY_TEXT = { a: 'High priority', b: 'Medium priority', c: 'Low priority' } as const;
/** Public pages know no workspace cards or people: $codes and @handles render as plain text. */
const NO_LOOKUPS = { cardTitle: () => null, userName: () => null };

function StatusBadge({ status }: { status: PublicStatus }) {
  if (!status) return <span className="badge">Lore</span>;
  return <span className={`status-badge status-${STATUS_CLASS[status]}`}>{STATUS_TEXT[status]}</span>;
}

/** ▲ n: votes when upvoting is on; asks an anonymous visitor to join first. */
function Upvote({ ctx, card, onChange }: { ctx: OpenCtx; card: PublicCard; onChange: (c: { upvotes: number; upvoted: boolean }) => void }) {
  const [busy, setBusy] = useState(false);
  if (!ctx.project.upvoting) return null;
  const click = async () => {
    if (!ctx.viewer) { ctx.askToJoin(); return; }
    setBusy(true);
    try { onChange(await openApi.upvote(card.id, !card.upvoted)); } catch (e) { showToast(openMessage(e)); } finally { setBusy(false); }
  };
  return (
    <button type="button" className={card.upvoted ? 'btn btn-active upvote-btn' : 'btn upvote-btn'} aria-pressed={card.upvoted} disabled={busy}
      aria-label={`Upvote ${card.title} (${card.upvotes})`} title={card.upvoted ? 'Take your upvote back' : 'Upvote'} onClick={() => void click()}>
      <Icon name="upvote" size={15} /> {card.upvotes}
    </button>
  );
}

function CardMeta({ card }: { card: PublicCard }) {
  return (
    <span className="open-meta">
      <StatusBadge status={card.status} />
      {card.priority && <span className="badge" title={PRIORITY_TEXT[card.priority]}><PriorityMark priority={card.priority} /> {PRIORITY_TEXT[card.priority]}</span>}
      {card.effort !== null && <span className="badge" title="Effort">{card.effort} effort</span>}
      {card.tags.map((t) => <span key={t} className="tag-chip">#{t}</span>)}
    </span>
  );
}

export function ProjectOverview({ ctx }: { ctx: OpenCtx }) {
  const { project } = ctx;
  return (
    <>
      <h1>{project.displayName}</h1>
      {project.welcome && <p className="open-welcome">{project.welcome}</p>}
      {project.decks.length === 0 ? <p className="muted">No lists yet.</p> : (
        <ul className="open-decks" aria-label="Lists">
          {project.decks.map((d) => (
            <li key={d.seq}>
              <Link className="open-deck-tile" href={`/open/${project.urlName}/deck/${d.seq}`}>
                <strong>{d.title}</strong>
                <span className="muted">{d.cardCount} {d.cardCount === 1 ? 'task' : 'tasks'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type Sort = 'default' | 'upvotes' | 'priority' | 'title';
const SORTS: [Sort, string][] = [['default', 'Default order'], ['upvotes', 'Most upvoted'], ['priority', 'Priority'], ['title', 'Title']];

export function DeckPage({ ctx, seq }: { ctx: OpenCtx; seq: number }) {
  const { project } = ctx;
  const [deck, setDeck] = useState<{ seq: number; title: string; cards: PublicCard[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Visitors can re-sort for themselves; it isn't stored.
  const [sort, setSort] = useState<Sort>('default');
  const viewerName = ctx.viewer?.name;
  useEffect(() => {
    openApi.deck(project.urlName, seq).then((r) => setDeck(r.deck)).catch((e) => setError(openMessage(e)));
  }, [project.urlName, seq, viewerName]);
  const cards = useMemo(() => {
    const list = [...(deck?.cards ?? [])];
    if (sort === 'upvotes') list.sort((a, b) => b.upvotes - a.upvotes);
    if (sort === 'priority') list.sort((a, b) => (a.priority ?? 'z').localeCompare(b.priority ?? 'z'));
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    return list;
  }, [deck, sort]);
  if (error) return <><h1>List not found</h1><p className="muted">{error}</p></>;
  if (!deck) return <p className="muted" aria-busy="true">Loading…</p>;
  const patch = (id: string, c: { upvotes: number; upvoted: boolean }) => setDeck({ ...deck, cards: deck.cards.map((x) => (x.id === id ? { ...x, ...c } : x)) });
  return (
    <>
      <div className="page-head">
        <h1>{deck.title}</h1>
        <label className="field open-sort">
          <span>Order</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.filter(([k]) => k !== 'upvotes' || project.upvoting).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
      </div>
      {cards.length === 0 ? <p className="muted">No tasks in this list.</p> : (
        <ul className="open-cards" aria-label={`${deck.title} tasks`}>
          {cards.map((c) => (
            <li key={c.id} className="card-tile open-card-tile">
              <Upvote ctx={ctx} card={c} onChange={(x) => patch(c.id, x)} />
              <div className="open-card-main">
                <Link href={`/open/${project.urlName}/card/${c.code}`} className="open-card-title">{c.title}</Link>
                <CardMeta card={c} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CardPage({ ctx, code }: { ctx: OpenCtx; code: string }) {
  const { project } = ctx;
  const [card, setCard] = useState<PublicCardFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewerName = ctx.viewer?.name;
  useEffect(() => {
    openApi.card(project.urlName, code).then((r) => setCard(r.card)).catch((e) => setError(openMessage(e)));
  }, [project.urlName, code, viewerName]);
  const body = useMemo(() => {
    if (!card) return '';
    const { body: text, bodyStart } = splitTitle(card.content);
    return text.trim() ? renderMarkdown(text, NO_LOOKUPS, { lineOffset: bodyStart }) : '';
  }, [card]);
  if (error) return <><h1>Task not found</h1><p className="muted">{error}</p></>;
  if (!card) return <p className="muted" aria-busy="true">Loading…</p>;
  return (
    <article className="open-card" aria-labelledby="open-card-title">
      <p className="eyebrow"><Link href={`/open/${project.urlName}/deck/${card.deckSeq}`}>{card.deckTitle}</Link></p>
      <div className="open-card-head">
        <Upvote ctx={ctx} card={card} onChange={(x) => setCard({ ...card, ...x })} />
        <h1 id="open-card-title">{card.title}</h1>
      </div>
      <p className="open-meta-row">
        <CardMeta card={card} />
        {card.owner && <span className="muted">Owner: {card.owner}</span>}
      </p>
      {/* renderMarkdown escapes all raw HTML in card text (server-side text, rendered the same way as in the app). */}
      {body && <div className="md open-card-body" dangerouslySetInnerHTML={{ __html: body }} />}
      {card.comments && (
        <section className="open-comments" aria-label="Comments">
          <h2>Comments</h2>
          {card.comments.length === 0 ? <p className="muted">No comments yet.</p> : (
            <ul>
              {card.comments.map((c, i) => (
                <li key={i}>
                  <strong>{c.author}</strong> <span className="muted">{new Date(c.createdAt).toLocaleDateString()}</span>
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.content, NO_LOOKUPS) }} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </article>
  );
}

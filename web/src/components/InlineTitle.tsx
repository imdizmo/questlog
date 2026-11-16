import { useMemo } from 'react';
import { renderContext, tokenizeInline } from '../markdown';
import { useStore } from '../store';
import { slugOf } from '../../../shared/cards';
import { Link } from '../router';

/**
 * One title line with its #tags, $codes and @mentions as chips (same tokenizer as MarkdownView).
 * A $code shows the title of that card when this person can see it, and the raw `$code` otherwise.
 * Pass `links` only where the title is not itself inside a link: card chips then link to the card.
 */
export function InlineTitle({ text, links = false }: { text: string; links?: boolean }) {
  const cards = useStore((s) => s.cards);
  const users = useStore((s) => s.users);
  const ctx = useMemo(() => renderContext(cards, users), [cards, users]);
  const parts = useMemo(() => tokenizeInline(text), [text]);
  return (
    <>
      {parts.map((p, i) => {
        if ('text' in p) return p.text;
        if (p.kind === 'tag') return <span key={i} className="md-chip md-tag">#{p.name.toLowerCase()}</span>;
        if (p.kind === 'mention') {
          const user = ctx.userName(p.name.toLowerCase());
          return user === null
            ? <span key={i} className="md-chip md-mention">@{p.name}</span>
            : <span key={i} className="md-chip md-mention" title={`@${p.name.toLowerCase()}`}>@{user}</span>;
        }
        const title = ctx.cardTitle(p.name);
        if (title === null) return <span key={i} className="card-ref missing">${p.name}</span>;
        const label = <>{title}</>;
        return links
          ? <Link key={i} href={`/card/${p.name}-${slugOf(title) || 'card'}`} className="card-ref" title={`$${p.name}`}>{label}</Link>
          : <span key={i} className="card-ref" title={`$${p.name}`}>{label}</span>;
      })}
    </>
  );
}

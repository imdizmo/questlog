import { useEffect, useState } from 'react';
import { copyText } from '../cards';
import { dispatch } from '../api';
import { publicUrl, usePublicDeck } from '../openDecks';
import { showToast } from '../toast';
import { Icon } from './icons';

/**
 * The globe shown on a shared project, deck or card: it says the page is public and copies its public link.
 * Renders nothing while the project isn't shared.
 */
export function PublicLink({ projectId, path = '', what }: { projectId: string | undefined; path?: string; what: string }) {
  const o = usePublicDeck(projectId);
  if (!o) return null;
  const copy = async () => {
    const ok = await copyText(publicUrl(o, path));
    showToast(ok ? `Public link to this ${what} copied` : "Couldn't copy the link", ok ? 'info' : 'error', 3000);
  };
  return (
    <button type="button" className="icon-btn public-link" aria-label={`Copy public link to this ${what}`}
      title={`This ${what} is public (Public lists). Copy public link`} onClick={() => void copy()}>
      <Icon name="globe" size={16} />
    </button>
  );
}

/** Team members upvote a card of a shared project from the app (when upvoting is on there). */
export function UpvoteButton({ projectId, cardId }: { projectId: string | undefined; cardId: string }) {
  const o = usePublicDeck(projectId);
  const [state, setState] = useState<{ count: number; mine: boolean } | null>(null);
  const on = !!o?.upvoting;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    fetch(`/api/cards/${encodeURIComponent(cardId)}/upvotes`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setState(j); }).catch(() => {});
    return () => { alive = false; };
  }, [on, cardId]);
  if (!on || !state) return null;
  const toggle = () => {
    void dispatch<{ upvotes: number; upvoted: boolean }>('open', state.mine ? 'unvote' : 'upvote', { cardId })
      .then((r) => setState({ count: r.upvotes, mine: r.upvoted })).catch(() => {});
  };
  return (
    <button type="button" className={state.mine ? 'btn btn-active upvote-btn' : 'btn upvote-btn'} aria-pressed={state.mine}
      aria-label={`Upvote (${state.count})`} title={state.mine ? 'Take your upvote back' : 'Upvote this task'} onClick={toggle}>
      <Icon name="upvote" size={15} /> {state.count}
    </button>
  );
}

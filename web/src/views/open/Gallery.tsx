import { useEffect, useState } from 'react';
import { Link } from '../../router';
import { Icon } from '../../components/icons';
import { openApi, openMessage, type GalleryEntry } from './api';

/** The Open Decks gallery: the public projects their teams chose to list. */
export function Gallery() {
  const [list, setList] = useState<GalleryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.title = 'Public lists';
    openApi.gallery().then((r) => setList(r.projects)).catch((e) => setError(openMessage(e)));
  }, []);
  return (
    <main className="page open-page" id="main">
      <div className="page-head"><div><p className="eyebrow">Gallery</p><h1>Public lists</h1></div></div>
      <p className="muted">Public projects you can follow along with: browse their lists, upvote what you'd like to see next, and get update emails.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {list && list.length === 0 && <p className="muted">No public projects are listed yet.</p>}
      {list && list.length > 0 && (
        <ul className="open-gallery" aria-label="Public projects">
          {list.map((p) => (
            <li key={p.urlName}>
              <Link className="open-gallery-tile" href={`/open/${p.urlName}`}>
                {p.promoUrl ? <img src={p.promoUrl} alt="" /> : <span className="open-gallery-art" aria-hidden><Icon name="globe" size={28} /></span>}
                <strong>{p.displayName}</strong>
                {p.welcome && <span className="muted">{p.welcome}</span>}
                <span className="muted open-counts">{p.deckCount} {p.deckCount === 1 ? 'list' : 'lists'} · {p.cardCount} {p.cardCount === 1 ? 'task' : 'tasks'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

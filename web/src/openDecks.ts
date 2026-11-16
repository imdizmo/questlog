import { useEffect, useSyncExternalStore } from 'react';

/** A project's Open Deck settings (server/open.ts OpenDeckSettings), as the team sees them. */
export interface OpenDeckSettings {
  projectId: string; enabled: boolean; urlName: string; displayName: string; bannerFileId: string | null; welcome: string;
  showComments: boolean; upvoting: boolean; listed: boolean; promoFileId: string | null; createdAt: number;
}

/**
 * The Open Deck settings of the projects I can see, loaded once from GET /api/open-decks (they change rarely and only
 * from the Project settings tab, which writes them back here). Drives the globe icons and the upvote buttons.
 */
let byProject = new Map<string, OpenDeckSettings>();
let loading: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of [...listeners]) fn(); };

export function loadOpenDecks(force = false): Promise<void> {
  if (loading && !force) return loading;
  if (loaded && !force) return Promise.resolve();
  loading = fetch('/api/open-decks', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { openDecks: [] }))
    .then((j: { openDecks?: OpenDeckSettings[] }) => { byProject = new Map((j.openDecks ?? []).map((o) => [o.projectId, o])); loaded = true; emit(); })
    .catch(() => {})
    .finally(() => { loading = null; });
  return loading;
}
/** After a save in Project settings. */
export function putOpenDeck(o: OpenDeckSettings): void {
  byProject = new Map(byProject).set(o.projectId, o);
  emit();
}
/** On sign-out: the next person loads their own. */
export function resetOpenDecks(): void {
  byProject = new Map();
  loaded = false;
  emit();
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function useOpenDecks(): Map<string, OpenDeckSettings> {
  useEffect(() => { void loadOpenDecks(); }, []);
  return useSyncExternalStore(subscribe, () => byProject);
}
/** The project's open deck while it is shared, else undefined. */
export function usePublicDeck(projectId: string | undefined): OpenDeckSettings | undefined {
  const all = useOpenDecks();
  const o = projectId ? all.get(projectId) : undefined;
  return o?.enabled ? o : undefined;
}
export const publicUrl = (o: Pick<OpenDeckSettings, 'urlName'>, path = ''): string => `${location.origin}/open/${o.urlName}${path}`;

/** The public Open Decks API (server/open.ts). No store, no live socket: plain requests with the optional session cookie. */
export type PublicStatus = 'notStarted' | 'started' | 'blocked' | 'review' | 'done' | null;
export interface PublicCard {
  id: string; code: string; title: string; status: PublicStatus; priority: 'a' | 'b' | 'c' | null; effort: number | null;
  tags: string[]; upvotes: number; upvoted: boolean; deckSeq: number; isDoc: boolean;
}
export interface PublicCardFull extends PublicCard {
  content: string; owner: string | null; deckTitle: string; comments?: { author: string; content: string; createdAt: number }[];
}
export interface ProjectHead { id: string; urlName: string; displayName: string; upvoting: boolean; showComments: boolean }
export interface Viewer { name: string; guest: boolean; subscription: 'daily' | 'weekly' | null }
export interface PublicProject extends ProjectHead { welcome: string; bannerUrl: string | null; decks: { seq: number; title: string; cardCount: number }[] }
export interface GalleryEntry { urlName: string; displayName: string; welcome: string; promoUrl: string | null; deckCount: number; cardCount: number }

export class OpenError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function req<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OpenError(0, 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new OpenError(res.status, json?.error ?? `http_${res.status}`);
  return json as T;
}

const base = (urlName: string) => `/api/open/${encodeURIComponent(urlName)}`;
export const openApi = {
  gallery: () => req<{ projects: GalleryEntry[] }>('GET', '/api/open/gallery'),
  project: (urlName: string) => req<{ project: PublicProject; viewer: Viewer | null }>('GET', base(urlName)),
  deck: (urlName: string, seq: number) => req<{ project: ProjectHead; deck: { seq: number; title: string; cards: PublicCard[] } }>('GET', `${base(urlName)}/decks/${seq}`),
  card: (urlName: string, code: string) => req<{ project: ProjectHead; card: PublicCardFull }>('GET', `${base(urlName)}/cards/${encodeURIComponent(code)}`),
  confirm: (token: string) => req<{ ok: true; urlName: string | null }>('POST', '/api/open/confirm', { token }),
  /** Always the same answer ({pending: true}): the emailed link finishes it. */
  signUp: (b: { email: string; password: string; name: string; urlName?: string }) => req<{ pending: true }>('POST', '/dispatch/open/signUp', b),
  signIn: (b: { email: string; password: string }) => req<unknown>('POST', '/api/login', b),
  signOut: () => req<unknown>('POST', '/api/logout', {}),
  upvote: (cardId: string, on: boolean) => req<{ payload: { upvotes: number; upvoted: boolean } }>('POST', `/dispatch/open/${on ? 'upvote' : 'unvote'}`, { cardId }).then((r) => r.payload),
  subscribe: (projectId: string, cadence: 'daily' | 'weekly' | null) =>
    req<unknown>('POST', `/dispatch/open/${cadence ? 'subscribe' : 'unsubscribe'}`, cadence ? { projectId, cadence } : { projectId }),
};

const MESSAGES: Record<string, string> = {
  network: "Can't reach the server.",
  not_found: 'This page is not public, or it does not exist.',
  bad_credentials: 'Wrong email or password.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  rate_limit: 'Too many requests. Wait a minute and try again.',
  invalid_payload: 'Please use a valid email address, a name, and a password of at least 8 characters.',
  invalid_token: 'This link is not valid, was used already, or has expired (links work for 24 hours). Sign up again, or sign in if you already did.',
  upvoting_off: 'Upvoting is switched off for this project.',
  workspace_disabled: 'This workspace is closed.',
};
export const openMessage = (e: unknown): string => {
  const code = e instanceof OpenError ? e.code : 'network';
  return MESSAGES[code] ?? `Something went wrong (${code}).`;
};

import { useSyncExternalStore } from 'react';
import { LIBRARY_PORT, type SuggestionsVia } from '../../shared/suggestions';

/**
 * The Suggestion button (shared/suggestions.ts): shown only when /api/status says where to send and the team's library
 * service, asked who this is, answers with a role. Asked once per page load (a workspace switch reloads the page);
 * no answer, an error or `role: null` all mean no button.
 */
export interface SuggestionTarget { whoami: string; send: string; credentials: RequestCredentials }

let current: SuggestionTarget | null = null;
const listeners = new Set<() => void>();
const set = (t: SuggestionTarget | null) => { current = t; for (const l of listeners) l(); };

/** Where the page asks and sends, from the status answer's `suggestions`; null for anything else. */
export function targetOf(s: unknown): SuggestionTarget | null {
  const v = s as Partial<Record<string, unknown>> | null;
  if (v?.via === 'local') return { whoami: '/api/suggestions/whoami', send: '/api/suggestions', credentials: 'same-origin' };
  if (v?.via === 'direct' && typeof v.host === 'string' && v.host && typeof v.version === 'string') {
    const base = `http://${v.host}:${LIBRARY_PORT}`;
    const q = new URLSearchParams({ tool: 'questlog', version: v.version, os: 'web' });
    // Never with cookies: the library service knows the person by Tailscale, and it is another site.
    return { whoami: `${base}/team/whoami`, send: `${base}/team/suggestions?${q}`, credentials: 'omit' };
  }
  return null;
}

/** Applies the show rule for the status answer's `suggestions` (once, at load). */
export async function checkSuggestions(s: SuggestionsVia | null | undefined | unknown, f: typeof fetch = fetch): Promise<void> {
  const t = targetOf(s);
  if (!t) { set(null); return; }
  try {
    const r = await f(t.whoami, { credentials: t.credentials, signal: AbortSignal.timeout(10_000) });
    const role = r.ok ? ((await r.json()) as { role?: unknown } | null)?.role : null;
    set(typeof role === 'string' && role ? t : null);
  } catch {
    set(null);
  }
}

/** Where the Suggestion button sends; null: no button. */
export const suggestionTarget = (): SuggestionTarget | null => current;

export function useSuggestionTarget(): SuggestionTarget | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, suggestionTarget);
}

/** Sends the zip. `null` when it was stored, else the sentence the dialog shows (the server's own, when it gave one). */
export async function sendSuggestion(t: SuggestionTarget, zip: Uint8Array, f: typeof fetch = fetch): Promise<string | null> {
  let r: Response;
  try {
    r = await f(t.send, {
      method: 'POST', credentials: t.credentials, headers: { 'content-type': 'application/zip' },
      body: zip as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return "Not sent: Questlog can't reach your team's server. Your words are kept: try again in a moment.";
  }
  if (r.status === 201) return null;
  if (r.status === 404) return "Not sent: your team's server is too old for suggestions. Your words are kept.";
  let said = '';
  try { said = String(((await r.json()) as { error?: unknown } | null)?.error ?? ''); } catch { /* not JSON */ }
  return `Not sent: ${said || `the server answered ${r.status}.`} Your words are kept: try again, or copy them somewhere.`;
}

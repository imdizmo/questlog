/**
 * Suggestions from the team (the top bar's Suggestion button): written words and screenshots that go to the team's
 * library service (Asset Shelf's ShelfServer 0.7.0, `POST /team/suggestions` on port 8781). The contract lives with
 * the library service; this file holds what the page and Questlog's server share: where the page sends, the limits,
 * and the zip.
 */
import { hostOf } from './workspaceKind';
import { zipStored, type ZipEntry } from './zip';

/** The library service's port on the team host. */
export const LIBRARY_PORT = 8781;

/** The library service takes 20 MB per zip; the page keeps the pictures under 19 MB so the words always fit. */
export const SUGGESTION_LIMITS = {
  textChars: 20_000,
  pictures: 10,
  pictureBytes: 10 * 1024 * 1024,
  picturesBytes: 19 * 1024 * 1024,
  zipBytes: 20 * 1024 * 1024,
} as const;

/**
 * Where the page sends (GET /api/status `suggestions`):
 * - `local`: this is the desktop app's own server (This computer) and the desktop gave it the team's address
 *   (JATIFY_TEAM). The page hands the zip to this server, which forwards it from the person's own machine, so
 *   Tailscale sees the person.
 * - `direct`: a team server (JATIFY_TEAM_SERVER). The page, served from the team machine, sends straight to the
 *   library service on the same host; it answers that page cross-origin.
 * - null: no team, no button.
 */
export type SuggestionsVia = { via: 'local' } | { via: 'direct'; host: string; version: string };

/** The host name (no port; IPv6 in brackets) of an address given as a URL or `host[:port]`; null when it has none. */
export function teamHostname(address: string | undefined | null): string | null {
  const h = hostOf(address);
  if (!h) return null;
  try { return new URL(`http://${h}`).hostname || null; } catch { return null; }
}

export function suggestionsVia(env: { JT_WORKSPACE_LABEL?: string; JATIFY_TEAM?: string; JATIFY_TEAM_SERVER?: string }, version: string): SuggestionsVia | null {
  // This computer's page is on 127.0.0.1, which the library service never answers cross-origin: only the forward works.
  if (env.JT_WORKSPACE_LABEL?.trim()) return teamHostname(env.JATIFY_TEAM) ? { via: 'local' } : null;
  const host = teamHostname(env.JATIFY_TEAM_SERVER);
  return host ? { via: 'direct', host, version } : null;
}

/** `png` or `jpg` from a picture's first bytes (the library service checks them too); null for anything else. */
export function pictureKind(b: Uint8Array): 'png' | 'jpg' | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  return null;
}

/** Why `next` cannot join `have` (a sentence for the person), or null when it fits. */
export function pictureRefusal(have: readonly Uint8Array[], next: Uint8Array): string | null {
  const L = SUGGESTION_LIMITS;
  if (have.length >= L.pictures || next.length > L.pictureBytes || have.reduce((n, b) => n + b.length, 0) + next.length > L.picturesBytes) {
    return `At most ${L.pictures} pictures, ${L.pictureBytes >> 20} MB each and ${L.picturesBytes >> 20} MB together: not added.`;
  }
  return null;
}

/** The zip the library service reads: `suggestion.txt` and `screenshot-<n>.<png|jpg>`, nothing else. */
export function suggestionZip(text: string, pictures: readonly Uint8Array[]): Uint8Array {
  const files: ZipEntry[] = [{ name: 'suggestion.txt', data: new TextEncoder().encode(text) }];
  pictures.forEach((data, i) => files.push({ name: `screenshot-${i + 1}.${pictureKind(data) ?? 'png'}`, data }));
  return zipStored(files);
}

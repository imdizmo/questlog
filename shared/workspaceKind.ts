/**
 * Which workspace a Questlog server is: the desktop app's own server ("This computer") or a team server. The server
 * says so in /api/status (the page never decides it); the web app shows it as a badge and in the New project dialog.
 */
export type WorkspaceKind = { kind: 'local'; label: string } | { kind: 'team'; label: string; host: string };

const MAX = 80;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** `host` or `host:port` of an address given as a URL or a bare `host[:port]`; null when it has none. */
export function hostOf(address: string | undefined | null): string | null {
  const v = address?.trim();
  if (!v) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`).host;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * The desktop app sets JT_WORKSPACE_LABEL ("This computer") on the server it runs; any other server is a team server,
 * named by JATIFY_TEAM_SERVER when set, else by the address it was reached at.
 */
export function workspaceKind(env: { JT_WORKSPACE_LABEL?: string; JATIFY_TEAM_SERVER?: string }, requestHost?: string): WorkspaceKind {
  const local = env.JT_WORKSPACE_LABEL?.trim();
  if (local) return { kind: 'local', label: clip(local) };
  const host = clip(hostOf(env.JATIFY_TEAM_SERVER) ?? hostOf(requestHost) ?? 'server');
  return { kind: 'team', label: `Team: ${host}`, host };
}

/** The New project dialog's line. */
export function goesTo(w: WorkspaceKind): string {
  return `Goes to: ${w.kind === 'local' ? w.label : `Team ${w.host}`}`;
}

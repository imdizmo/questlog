import { useSyncExternalStore } from 'react';
import type { WorkspaceKind } from '../../shared/workspaceKind';

/** Which workspace this server is, as /api/status said at load (null until then, or from an older server). */
let current: WorkspaceKind | null = null;
const listeners = new Set<() => void>();

const valid = (w: unknown): w is WorkspaceKind => {
  const v = w as Partial<Record<string, unknown>> | null;
  if (!v || typeof v.label !== 'string' || !v.label) return false;
  return v.kind === 'local' || (v.kind === 'team' && typeof v.host === 'string');
};

/** Records the status answer's `workspace`; anything malformed counts as not known. */
export function setWorkspaceKind(w: unknown): void {
  const next = valid(w) ? w : null;
  if (next?.label === current?.label && next?.kind === current?.kind) return;
  current = next;
  for (const l of listeners) l();
}

export function useWorkspaceKind(): WorkspaceKind | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
}

import type { WorkspaceKind } from '../../../shared/workspaceKind';

/** The workspace switcher's second line: "This computer" / "Team: <host>", where everything on this page is kept. */
export function WorkspaceKindLine({ workspace }: { workspace: WorkspaceKind | null }) {
  if (!workspace) return null;
  const where = workspace.kind === 'local' ? 'on this computer' : `on the team server ${workspace.host}`;
  return (
    <span className={`wsw-kind wsw-kind-${workspace.kind}`} data-testid="workspace-badge" title={`This workspace is kept ${where}`}>
      {workspace.label}
    </span>
  );
}

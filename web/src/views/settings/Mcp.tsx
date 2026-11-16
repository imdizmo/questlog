import { useEffect, useState } from 'react';
import { api, dispatch } from '../../api';
import { useStore, settingsOf } from '../../store';
import { CopyField } from './CopyField';

/** One row of "Members' connections": supplied by the MCP server (Task 5); the page works without it. */
export interface McpConnection { userId: string; name: string; lastUsedAt: number | null; calls: number }

/** The MCP page with its usage numbers, loaded once when the tab opens (the page shows without them on failure). */
export function McpSettings() {
  const [usage, setUsage] = useState<{ toolCallsToday: number; connections: McpConnection[] } | null>(null);
  useEffect(() => {
    let live = true;
    api.mcpUsage().then((u) => { if (live) setUsage(u); }, () => {});
    return () => { live = false; };
  }, []);
  return <Mcp toolCallsToday={usage?.toolCallsToday} connections={usage?.connections} />;
}

/** MCP settings: the on/off switch (saved at once), a short how-to and, when the server reports them, usage numbers. */
export function Mcp({ toolCallsToday, connections }: { toolCallsToday?: number; connections?: McpConnection[] }) {
  const enabled = useStore((s) => settingsOf(s).mcpEnabled);
  const endpoint = `${location.origin}/mcp`;
  return (
    <div className="settings-stack">
      <div className="setting-row">
        <div>
          <label htmlFor="mcp-enabled" className="setting-label">Enabled</label>
          <p className="hint">Lets AI tools that speak MCP read and change this workspace, with a personal API token.</p>
        </div>
        <span className="switch">
          <input id="mcp-enabled" type="checkbox" role="switch" checked={enabled}
            onChange={(e) => { void dispatch('accounts', 'update', { settings: { mcpEnabled: e.target.checked } }).catch(() => {}); }} />
          <span aria-hidden className="track" />
        </span>
      </div>

      {toolCallsToday !== undefined && <p>Tool calls today: <strong>{toolCallsToday}</strong></p>}

      <section className="settings-group" aria-labelledby="mcp-how">
        <h3 className="sub" id="mcp-how">How to connect</h3>
        <ol className="steps">
          <li>Create a personal token under API tokens (Account menu, or the API tokens tab of Workspace settings for admins).</li>
          <li>Add this address to your MCP client as a remote HTTP server:</li>
        </ol>
        <CopyField label="MCP endpoint" value={endpoint} />
        <ol className="steps" start={3}>
          <li>Send the token as a Bearer token: <code>Authorization: Bearer &lt;your token&gt;</code>.</li>
          <li>The tools act with the token's permission, so a read token cannot change anything.</li>
        </ol>
      </section>

      {connections && connections.length > 0 && (
        <section className="settings-group" aria-labelledby="mcp-members">
          <h3 className="sub" id="mcp-members">Members' connections</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Member</th><th scope="col">Last used</th><th scope="col">Calls</th></tr></thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.userId}>
                    <th scope="row">{c.name}</th>
                    <td>{c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : 'Never'}</td>
                    <td>{c.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

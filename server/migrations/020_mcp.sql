-- MCP server (server/mcp.ts). One row per personal token that has called /mcp; client_name comes from `initialize`.
-- calls: tool calls made with the token (shown on the MCP settings page).
CREATE TABLE mcp_connections (
  token_id TEXT PRIMARY KEY REFERENCES api_tokens(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mcp_connections_user ON mcp_connections (user_id);

-- Workspace tool calls per UTC day ('YYYY-MM-DD'), for settings.mcpDailyLimit.
CREATE TABLE mcp_calls (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

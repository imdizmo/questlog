-- "May delete": a personal token created with it can delete tasks, lists and milestones through MCP. Off for every
-- existing token.
ALTER TABLE api_tokens ADD COLUMN may_delete INTEGER NOT NULL DEFAULT 0;

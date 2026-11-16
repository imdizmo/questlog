-- Discord and Slack (server/integrations/*). Settings without secrets as JSON per integration.
CREATE TABLE integration_settings (
  kind TEXT PRIMARY KEY CHECK (kind IN ('discord', 'slack')),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bot tokens, signing secrets and webhook URLs, AES-256-GCM encrypted with a key derived from the server secret
-- (JT_SECRET or <data dir>/secret.key). `value` is "v1.<base64url iv|tag|ciphertext>"; the slot (kind, name) is the
-- additional data, so a value can't be moved to another slot. Webhooks per project are named "webhook:<projectId>".
CREATE TABLE integration_secrets (
  kind TEXT NOT NULL CHECK (kind IN ('discord', 'slack')),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, name)
);

-- Chat notifications waiting to be posted (card created / done, comments, milestones). The webhook URL is looked up
-- when the row is sent (a changed or removed webhook applies to waiting rows). dedupe_key keeps one row per event;
-- handled rows are kept a day for it. At most 10000 rows.
CREATE TABLE integration_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('discord', 'slack')),
  project_id TEXT,
  dedupe_key TEXT NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT,
  UNIQUE (kind, dedupe_key)
);
CREATE INDEX integration_outbox_due ON integration_outbox (status, next_attempt_at);

-- Inbound interaction / command ids already handled (replay protection), kept a day.
CREATE TABLE integration_seen (
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (kind, event_id)
);
CREATE INDEX integration_seen_at ON integration_seen (seen_at);

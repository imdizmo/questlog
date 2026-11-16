-- User reports (server/reports.ts, server/commands/userReports.ts): one app per workspace, set up in the settings.
-- deck_id: "Create cards in"; NULL once that deck is gone (reports then fail until a deck is picked again).
-- severity_decks: JSON {critical?, high?, low?} → deck id; severity_priority: 1 = critical/high → a, low → c.
-- Only SHA-256 hashes of the access key, the report tokens and the upload ids are stored.
CREATE TABLE report_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
  severity_decks TEXT NOT NULL DEFAULT '{}',
  severity_priority INTEGER NOT NULL DEFAULT 1,
  access_key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE report_tokens (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES report_apps(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX report_tokens_app ON report_tokens (app_id);

-- One-time upload URLs handed out by create-report (id = SHA-256 of the secret in the URL).
CREATE TABLE report_uploads (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX report_uploads_expires ON report_uploads (expires_at);

-- Reporter addresses, for the daily "your report is done" email (Phase 8 sends it and sets notified_at).
CREATE TABLE report_emails (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  notified_at INTEGER
);

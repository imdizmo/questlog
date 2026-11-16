-- API tokens: only the SHA-256 hash of the secret is stored; the plain token is shown once, at creation.
-- user_id is the token's acting user: the owner for personal ('user') tokens, the service user for org tokens.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('org', 'user')),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'producer', 'limited')),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  project_ids TEXT NOT NULL DEFAULT '[]',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- 'person' or 'service' (the acting user of an org token: never logs in, hidden from people lists).
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'service'));

ALTER TABLE account ADD COLUMN user_api_tokens_enabled INTEGER NOT NULL DEFAULT 1;

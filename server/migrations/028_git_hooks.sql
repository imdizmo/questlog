-- Git commit references (server/integrations/git.ts): one row per generated webhook URL.
-- GitHub / GitLab hooks keep their secret encrypted (secret_sealed, bound to the hook id); a BitBucket hook's secret is
-- part of its URL, so only its SHA-256 (secret_hash) is kept. Commands in commit messages run as creator_id.
-- project_id (optional) limits the hook to the cards of that project.
CREATE TABLE git_hooks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'gitlab', 'bitbucket')),
  secret_sealed TEXT,
  secret_hash TEXT,
  creator_id TEXT NOT NULL,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  last_delivery_at INTEGER
);

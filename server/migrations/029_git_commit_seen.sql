-- Commits a git hook has handled (server/integrations/git.ts): a commit listed again by a later push (a merge, a
-- replayed body) neither adds its reference nor runs its commands again. Pruned by age and to the newest rows.
CREATE TABLE git_commit_seen (
  hook_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (hook_id, sha)
);

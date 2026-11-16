ALTER TABLE resolvable_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE resolvable_entries ADD COLUMN last_changed_at INTEGER;
ALTER TABLE resolvables ADD COLUMN latest_entry_at INTEGER;
UPDATE resolvables SET latest_entry_at = (SELECT MAX(created_at) FROM resolvable_entries e WHERE e.resolvable_id = resolvables.id);

CREATE TABLE resolvable_reactions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES resolvable_entries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (entry_id, user_id, emoji)
);

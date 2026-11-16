ALTER TABLE decks ADD COLUMN preferred_order TEXT;
ALTER TABLE cards ADD COLUMN carry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN sprint_joined_at INTEGER;

CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tokens TEXT NOT NULL,
  force_or INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX saved_searches_user ON saved_searches(user_id);

-- A null duration_ms means the timer is still running.
CREATE TABLE time_segments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX time_segments_user ON time_segments(user_id, duration_ms);
-- At most one running timer per user.
CREATE UNIQUE INDEX time_segments_one_running ON time_segments(user_id) WHERE duration_ms IS NULL;
CREATE INDEX time_segments_card ON time_segments(card_id);

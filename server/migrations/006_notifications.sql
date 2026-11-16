CREATE TABLE resolvable_notifications (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolvable_id TEXT NOT NULL REFERENCES resolvables(id) ON DELETE CASCADE,
  is_participating INTEGER NOT NULL DEFAULT 1,
  is_muted INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER,
  remind_me_on INTEGER,
  unseen_entry_count INTEGER NOT NULL DEFAULT 0,
  unseen_authors_json TEXT NOT NULL DEFAULT '[]',
  latest_entry_id TEXT,
  latest_seen_entry_id TEXT,
  created_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, resolvable_id)
);
CREATE INDEX resolvable_notifications_resolvable ON resolvable_notifications(resolvable_id);

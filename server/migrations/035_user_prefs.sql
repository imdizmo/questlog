-- Per-person preferences (server/prefs.ts): the sidebar (folded, main pages as a list or icons), its folds and the open
-- tabs, so they follow the person to every device. Only their own rows are ever read or written.
CREATE TABLE user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

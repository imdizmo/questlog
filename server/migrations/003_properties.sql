ALTER TABLE cards ADD COLUMN priority TEXT CHECK (priority IN ('a','b','c'));
ALTER TABLE cards ADD COLUMN effort REAL;
ALTER TABLE cards ADD COLUMN due_date TEXT;
ALTER TABLE cards ADD COLUMN parent_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN master_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN mentioned_user_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN checkbox_stats_json TEXT;
ALTER TABLE cards ADD COLUMN cover_file_id TEXT;
CREATE INDEX idx_cards_parent ON cards(parent_card_id);

ALTER TABLE projects ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
UPDATE projects SET tags_json = '[{"name":"backend","emoji":null},{"name":"bug","emoji":"🐞"},{"name":"debt","emoji":null},{"name":"design","emoji":null},{"name":"discuss","emoji":null},{"name":"outsource","emoji":null},{"name":"sprint","emoji":null}]';

ALTER TABLE decks ADD COLUMN auto_tag TEXT;
ALTER TABLE decks ADD COLUMN default_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL;

CREATE TABLE card_deps (
  locked_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  locking_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (locked_card_id, locking_card_id)
);
CREATE INDEX idx_card_deps_locking ON card_deps(locking_card_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_files_card ON files(card_id);

CREATE TABLE user_card_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id, tag)
);

CREATE TABLE card_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

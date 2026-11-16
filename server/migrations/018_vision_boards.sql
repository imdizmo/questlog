ALTER TABLE account ADD COLUMN vision_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE vision_boards (
  id TEXT PRIMARY KEY,
  account_seq INTEGER NOT NULL UNIQUE,
  card_id TEXT NOT NULL UNIQUE REFERENCES cards(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'default',
  doc BLOB,
  doc_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vision_queries (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX vision_queries_card ON vision_queries(card_id);

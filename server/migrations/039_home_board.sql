-- Home is a board too: one per workspace, with no host card. vision_boards gets a kind; card_id is NULL exactly for
-- the home kind. SQLite cannot drop a NOT NULL in place, so the table is rebuilt; every row and doc is copied as is.
-- Nothing references vision_boards, so dropping the old table touches no other row.
CREATE TABLE vision_boards_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'card' CHECK (kind IN ('card', 'home')),
  account_seq INTEGER NOT NULL UNIQUE,
  card_id TEXT UNIQUE REFERENCES cards(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'default',
  doc BLOB,
  doc_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'card') = (card_id IS NOT NULL))
);
INSERT INTO vision_boards_new (id, kind, account_seq, card_id, creator_id, state, doc, doc_bytes, created_at, updated_at)
  SELECT id, 'card', account_seq, card_id, creator_id, state, doc, doc_bytes, created_at, updated_at FROM vision_boards;
DROP TABLE vision_boards;
ALTER TABLE vision_boards_new RENAME TO vision_boards;
-- One Home board per workspace.
CREATE UNIQUE INDEX vision_boards_one_home ON vision_boards(kind) WHERE kind = 'home';

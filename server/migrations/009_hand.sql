ALTER TABLE decks ADD COLUMN hand_sync_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE done_pile (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX done_pile_card ON done_pile(card_id);

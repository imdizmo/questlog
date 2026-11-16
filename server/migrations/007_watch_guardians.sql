CREATE TABLE card_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX card_subscriptions_card ON card_subscriptions(card_id);
CREATE TABLE deck_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, deck_id)
);
CREATE INDEX deck_subscriptions_deck ON deck_subscriptions(deck_id);
CREATE TABLE deck_guardians (
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (deck_id, user_id)
);
ALTER TABLE decks ADD COLUMN guardians_enabled INTEGER NOT NULL DEFAULT 0;

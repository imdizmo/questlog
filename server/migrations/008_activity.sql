ALTER TABLE card_history ADD COLUMN deck_id TEXT;
ALTER TABLE card_history ADD COLUMN project_id TEXT;
UPDATE card_history SET
  deck_id = (SELECT c.deck_id FROM cards c WHERE c.id = card_history.card_id),
  project_id = (SELECT d.project_id FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = card_history.card_id);
CREATE INDEX card_history_deck_at ON card_history(deck_id, at);
CREATE INDEX card_history_project_at ON card_history(project_id, at);

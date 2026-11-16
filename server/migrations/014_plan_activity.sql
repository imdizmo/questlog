ALTER TABLE card_history ADD COLUMN milestone_id TEXT;
ALTER TABLE card_history ADD COLUMN sprint_id TEXT;
UPDATE card_history SET
  milestone_id = (SELECT c.milestone_id FROM cards c WHERE c.id = card_history.card_id),
  sprint_id = (SELECT c.sprint_id FROM cards c WHERE c.id = card_history.card_id);
CREATE INDEX card_history_milestone_at ON card_history(milestone_id, at);
CREATE INDEX card_history_sprint_at ON card_history(sprint_id, at);

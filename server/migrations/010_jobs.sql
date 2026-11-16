ALTER TABLE cards ADD COLUMN snoozed_at INTEGER;
ALTER TABLE cards ADD COLUMN done_at INTEGER;
UPDATE cards SET done_at = last_updated_at WHERE status = 'done';
CREATE INDEX cards_stale ON cards(status, last_updated_at);

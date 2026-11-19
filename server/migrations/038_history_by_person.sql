-- Home's "Recently worked on" reads a person's own history and comments, newest first (server/home.ts).
CREATE INDEX IF NOT EXISTS card_history_changer_at ON card_history(changer_id, at);
CREATE INDEX IF NOT EXISTS resolvable_entries_author_at ON resolvable_entries(author_id, created_at);

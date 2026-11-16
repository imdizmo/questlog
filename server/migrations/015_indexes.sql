-- Auto-archive looks for done cards by age.
CREATE INDEX IF NOT EXISTS cards_status_done_at ON cards(status, done_at);
CREATE INDEX IF NOT EXISTS resolvable_entries_resolvable ON resolvable_entries(resolvable_id);
-- At most one running timer per user (also for databases that ran an older 013).
CREATE UNIQUE INDEX IF NOT EXISTS time_segments_one_running ON time_segments(user_id) WHERE duration_ms IS NULL;

-- Daily budget per report token (server/reports.ts REPORT_BUDGET): reports filed and file bytes accepted per UTC day.
-- One row per token per day; rows older than two days are pruned when a new day's row is made.
CREATE TABLE report_token_usage (
  token_id TEXT NOT NULL REFERENCES report_tokens(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, day)
);
CREATE INDEX report_token_usage_day ON report_token_usage (day);

-- The token whose report announced the upload, so its bytes count against that token (NULL for older rows).
ALTER TABLE report_uploads ADD COLUMN token_id TEXT REFERENCES report_tokens(id) ON DELETE CASCADE;

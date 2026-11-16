-- Onboarding quests (shared/quests.ts): the steps each person has completed. Only their own rows are ever sent to them.
CREATE TABLE user_onboarding (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  info_json TEXT,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, step)
);

-- Open Decks (server/open.ts): a project's public read-only pages, upvotes, update-email subscriptions and visit counts.
-- One row per shared project; `enabled` = 0 keeps the settings (and reserves the URL name) while sharing is off.
CREATE TABLE open_decks (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  url_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  banner_file_id TEXT,
  welcome TEXT NOT NULL DEFAULT '',
  show_comments INTEGER NOT NULL DEFAULT 0,
  upvoting INTEGER NOT NULL DEFAULT 1,
  listed INTEGER NOT NULL DEFAULT 0,
  promo_file_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- The deck's order for visitors (a DeckView, like preferred_order); null = the deck's own default.
ALTER TABLE decks ADD COLUMN public_order TEXT;

CREATE TABLE upvotes (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, user_id)
);
CREATE INDEX upvotes_created ON upvotes(created_at);

CREATE TABLE open_subscriptions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  created_at INTEGER NOT NULL,
  -- What the last update email covered up to, and its send slot (server/email.ts dueSlot).
  last_sent_at INTEGER,
  last_slot TEXT,
  PRIMARY KEY (project_id, user_id)
);

-- Distinct visitors per project page per UTC day.
CREATE TABLE open_visits (
  day TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_id)
);

-- The weekly upvote digest slot each admin last got.
CREATE TABLE open_digests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

-- Sign-ups waiting for their email confirmation. No user exists until the link is used (no squatting on addresses);
-- one pending row per address, 24 h, purged by the jobs; the table is capped (server/open.ts PENDING_MAX).
CREATE TABLE open_signups (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  url_name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX open_signups_expires ON open_signups(expires_at);

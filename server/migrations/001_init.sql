CREATE TABLE account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  card_seq INTEGER NOT NULL DEFAULT 0,
  deck_seq INTEGER NOT NULL DEFAULT 0,
  project_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  timezone TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE account_roles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'full',
  is_archived INTEGER NOT NULL DEFAULT 0,
  spaces_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE project_access (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_role TEXT,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_prefs (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  deck_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_index REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
  creator_id TEXT NOT NULL,
  assignee_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started',
  visibility TEXT NOT NULL DEFAULT 'default',
  is_doc INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  content_version INTEGER NOT NULL DEFAULT 1,
  sort_index REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
);
CREATE INDEX cards_deck_id ON cards(deck_id);
CREATE INDEX cards_assignee_id ON cards(assignee_id);

CREATE TABLE resolvables (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  closed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX resolvables_card_closed ON resolvables(card_id, is_closed);

CREATE TABLE resolvable_entries (
  id TEXT PRIMARY KEY,
  resolvable_id TEXT NOT NULL REFERENCES resolvables(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE hand_cards (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  sort_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE card_history (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  changer_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  PRIMARY KEY (card_id, version)
);

CREATE TABLE covers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_id TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_covers_project ON covers(project_id);

ALTER TABLE decks ADD COLUMN cover_json TEXT;
ALTER TABLE projects ADD COLUMN cover_json TEXT;
ALTER TABLE decks ADD COLUMN creator_id TEXT;

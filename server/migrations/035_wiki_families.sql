-- Wiki families (redesign): a named, coloured fold of root entry types, and a picture per type. Additive only: existing
-- types get no family ("No family" in the Wiki) and the painted picture.
CREATE TABLE entry_families (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL, sort_index REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_entry_families_project ON entry_families(project_id);
ALTER TABLE entry_types ADD COLUMN family_id TEXT REFERENCES entry_families(id) ON DELETE SET NULL;
ALTER TABLE entry_types ADD COLUMN picture_json TEXT;

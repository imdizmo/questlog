-- Home's pictures and Smart Nodes belong to a project (chosen when they are added), not to a card. Uploaded files and
-- saved queries get a project_id; exactly one of card_id and project_id is set. SQLite cannot drop a NOT NULL in
-- place, so both tables are rebuilt; every row is copied as is, rowid included (covers order files by it). Nothing
-- references files or vision_queries, so dropping the old tables touches no other row.
CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  asset_id TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  CHECK ((card_id IS NULL) <> (project_id IS NULL))
);
INSERT INTO files_new (rowid, id, card_id, uploader_id, name, mime, size, created_at, asset_id)
  SELECT rowid, id, card_id, uploader_id, name, mime, size, created_at, asset_id FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX idx_files_card ON files(card_id);
CREATE INDEX idx_files_asset ON files(asset_id);
CREATE INDEX idx_files_project ON files(project_id);

CREATE TABLE vision_queries_new (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  CHECK ((card_id IS NULL) <> (project_id IS NULL))
);
INSERT INTO vision_queries_new (rowid, id, card_id, creator_id, query, created_at)
  SELECT rowid, id, card_id, creator_id, query, created_at FROM vision_queries;
DROP TABLE vision_queries;
ALTER TABLE vision_queries_new RENAME TO vision_queries;
CREATE INDEX vision_queries_card ON vision_queries(card_id);
CREATE INDEX vision_queries_project ON vision_queries(project_id);

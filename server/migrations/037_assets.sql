-- Assets: pictures, 3D models, maps and concepts of a project (the Assets page). Questlog keeps its own copy of each
-- (`<files>/assets/<picture_id>` and `<files>/assets/<model_id>`, a `.glb`), with a link back to where it came from
-- (link_json, see shared/assets.ts AssetLink). for_tag NULL: not tagged.
CREATE TABLE assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('picture', 'model', 'map', 'concept')),
  for_tag TEXT CHECK (for_tag IN ('Characters', 'Creatures', 'Items', 'Places', 'Interface', 'Key art')),
  source TEXT NOT NULL CHECK (source IN ('uploaded', 'url', 'asset-shelf', 'groundwork')), link_json TEXT,
  picture_id TEXT, picture_mime TEXT, picture_size INTEGER NOT NULL DEFAULT 0,
  model_id TEXT, model_size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_assets_project ON assets(project_id, created_at);
-- A card attachment copied from an asset ("Use as a picture of…"): where the asset is used. No foreign key: deleting
-- the asset leaves the card's own copy as it is.
ALTER TABLE files ADD COLUMN asset_id TEXT;
CREATE INDEX idx_files_asset ON files(asset_id);
CREATE INDEX idx_assets_picture ON assets(picture_id);
CREATE INDEX idx_assets_model ON assets(model_id);

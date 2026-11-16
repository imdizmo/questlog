ALTER TABLE account ADD COLUMN plan_seq INTEGER NOT NULL DEFAULT 10;

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  account_seq INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  date TEXT,
  start_date TEXT,
  color TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE milestone_projects (
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (milestone_id, project_id)
);
CREATE INDEX milestone_projects_project ON milestone_projects(project_id);
CREATE TABLE milestone_zones (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_index REAL NOT NULL DEFAULT 0
);
CREATE INDEX milestone_zones_milestone ON milestone_zones(milestone_id);

ALTER TABLE cards ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN milestone_zone_id TEXT REFERENCES milestone_zones(id) ON DELETE SET NULL;
CREATE INDEX cards_milestone ON cards(milestone_id);
ALTER TABLE decks ADD COLUMN auto_milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;

-- Per project, so a viewer only ever sums the projects they can see.
CREATE TABLE milestone_progress (
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  total_effort REAL NOT NULL DEFAULT 0,
  done_effort REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (milestone_id, project_id, day)
);

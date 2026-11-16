CREATE TABLE sprint_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  run_label_template TEXT NOT NULL,
  color TEXT NOT NULL,
  upcoming INTEGER NOT NULL,
  duration_weeks INTEGER NOT NULL,
  start_day TEXT NOT NULL,
  move_on_finish_json TEXT NOT NULL DEFAULT '[]',
  is_global INTEGER NOT NULL DEFAULT 0,
  end_hour INTEGER NOT NULL DEFAULT 24,
  end_tz TEXT NOT NULL DEFAULT 'UTC',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sprint_config_projects (
  config_id TEXT NOT NULL REFERENCES sprint_configs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (config_id, project_id)
);
CREATE INDEX sprint_config_projects_project ON sprint_config_projects(project_id);
CREATE TABLE sprints (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES sprint_configs(id) ON DELETE CASCADE,
  account_seq INTEGER NOT NULL UNIQUE,
  run_nr INTEGER NOT NULL,
  label TEXT NOT NULL,
  start_day TEXT NOT NULL,
  end_day TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  is_finished INTEGER NOT NULL DEFAULT 0,
  UNIQUE (config_id, run_nr)
);
CREATE INDEX sprints_due ON sprints(is_finished, ends_at);

ALTER TABLE cards ADD COLUMN sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL;
CREATE INDEX cards_sprint ON cards(sprint_id);

-- Per project, like milestone_progress; a config's own progress is the sum over its runs on the client.
CREATE TABLE sprint_progress (
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  total_effort REAL NOT NULL DEFAULT 0,
  done_effort REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (sprint_id, project_id, day)
);

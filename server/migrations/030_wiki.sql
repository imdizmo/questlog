-- Game wiki: typed Lore entries (cards), entry types, link kinds and links, per campaign (project).
ALTER TABLE cards ADD COLUMN entry_type_id TEXT REFERENCES entry_types(id);
ALTER TABLE cards ADD COLUMN entry_key TEXT;
ALTER TABLE cards ADD COLUMN fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cards ADD COLUMN wiki_parent_id TEXT REFERENCES cards(id) ON DELETE SET NULL;
CREATE INDEX idx_cards_entry_type ON cards(entry_type_id);
CREATE INDEX idx_cards_entry_key ON cards(entry_key);
CREATE INDEX idx_cards_wiki_parent ON cards(wiki_parent_id);
CREATE TABLE entry_types (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
  name TEXT NOT NULL, icon TEXT, color TEXT, parent_type_id TEXT REFERENCES entry_types(id), fields_json TEXT NOT NULL DEFAULT '[]',
  sort_index REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, key));
CREATE TABLE link_kinds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
  label TEXT NOT NULL, reverse_label TEXT NOT NULL, from_types_json TEXT NOT NULL DEFAULT '[]', to_types_json TEXT NOT NULL DEFAULT '[]',
  props_json TEXT NOT NULL DEFAULT '[]', sum_rule_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, key));
CREATE TABLE entry_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind_key TEXT NOT NULL,
  from_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, to_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  props_json TEXT NOT NULL DEFAULT '{}', sort_index REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX idx_links_from ON entry_links(from_card_id); CREATE INDEX idx_links_to ON entry_links(to_card_id);
CREATE INDEX idx_links_kind ON entry_links(project_id, kind_key);

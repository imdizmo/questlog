-- Wiki blocks (redesign phase 4): a type's template as a page of blocks, and an entry's own block layout with its typed
-- blocks' data (shared/blocks.ts). Additive only: NULL means "follow the type's page" (types: the parent's, else one made
-- from the headings), so no existing row is rewritten.
ALTER TABLE entry_types ADD COLUMN page_json TEXT;
ALTER TABLE cards ADD COLUMN layout_json TEXT;

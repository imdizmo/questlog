-- Machine translations of card text and comments (server/translate/queue.ts). The original is never touched: a row is
-- a reading aid, keyed by target language. source_version is the card's content_version, or for a comment a 32-bit
-- FNV-1a of its content (shared/translate.ts textVersion); a row behind its source is stale. from_lang NULL: nothing in
-- the text needed translating into lang (the row only records that it was looked at).
CREATE TABLE translations (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'entry')),
  source_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  from_lang TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, source_id, lang)
);
-- Engine failures per source: retried after next_at, given up after three tries (an edit starts over).
CREATE TABLE translate_failures (
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  tries INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  PRIMARY KEY (kind, source_id)
);
-- The project's glossary: [{ term, en?, it? }]; a term with no target for a language is kept as written.
ALTER TABLE projects ADD COLUMN keep_names_json TEXT NOT NULL DEFAULT '[]';
-- Rows go with their source when it is deleted for good (cascades included); the trash is handled in code.
CREATE TRIGGER translations_card_gone AFTER DELETE ON cards BEGIN
  DELETE FROM translations WHERE kind='card' AND source_id=OLD.id;
  DELETE FROM translate_failures WHERE kind='card' AND source_id=OLD.id;
END;
CREATE TRIGGER translations_entry_gone AFTER DELETE ON resolvable_entries BEGIN
  DELETE FROM translations WHERE kind='entry' AND source_id=OLD.id;
  DELETE FROM translate_failures WHERE kind='entry' AND source_id=OLD.id;
END;

-- A third kind of translation: a Lore entry's text fields and its lines, steps and table blocks ('fields', keyed by the
-- card id; text is a JSON object of the translated pieces, server/translate/fields.ts). Rebuilt only to widen the kind check.
CREATE TABLE translations_new (
  kind TEXT NOT NULL CHECK (kind IN ('card', 'entry', 'fields')),
  source_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  from_lang TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, source_id, lang)
);
INSERT INTO translations_new (kind, source_id, lang, source_version, from_lang, text, created_at, stale)
  SELECT kind, source_id, lang, source_version, from_lang, text, created_at, stale FROM translations;
-- Legacy rename: the triggers of 041/042 name translations in their bodies and are fine once it exists again.
PRAGMA legacy_alter_table=ON;
DROP TABLE translations;
ALTER TABLE translations_new RENAME TO translations;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX translations_stale ON translations (stale) WHERE stale=1;
-- Name and glossary changes (042) mark card rows stale; the entry's fields row goes with its card's.
CREATE TRIGGER translate_stale_fields AFTER UPDATE OF stale ON translations
WHEN NEW.kind='card' AND NEW.stale=1 BEGIN
  UPDATE translations SET stale=1 WHERE kind='fields' AND source_id=NEW.source_id AND stale=0;
END;
CREATE TRIGGER translations_fields_gone AFTER DELETE ON cards BEGIN
  DELETE FROM translations WHERE kind='fields' AND source_id=OLD.id;
  DELETE FROM translate_failures WHERE kind='fields' AND source_id=OLD.id;
END;

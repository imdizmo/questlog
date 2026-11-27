-- A type's fields changed (one became or stopped being text, say): the 'fields' translations of its entries and of
-- its kinds' entries are redone (their version only covers the entries' own values, server/translate/fields.ts).
CREATE TRIGGER translate_stale_field_defs AFTER UPDATE OF fields_json ON entry_types
WHEN OLD.fields_json IS NOT NEW.fields_json BEGIN
  UPDATE translations SET stale=1 WHERE kind='fields' AND stale=0 AND source_id IN (
    SELECT c.id FROM cards c WHERE c.entry_type_id IN (
      WITH RECURSIVE kinds(id) AS (SELECT NEW.id UNION SELECT t.id FROM entry_types t JOIN kinds k ON t.parent_type_id=k.id)
      SELECT id FROM kinds));
END;

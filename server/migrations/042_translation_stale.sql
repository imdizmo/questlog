-- A translation is stale when the project's names changed (glossary, or the title/aliases of a name-kind Lore entry,
-- see server/translate/names.ts) after it was made. Readers keep showing a stale row until the background pass
-- replaces it (the queue treats stale rows as not current). Triggers, so every path (commands, imports) is covered.
ALTER TABLE translations ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
CREATE INDEX translations_stale ON translations (stale) WHERE stale=1;
CREATE TRIGGER translate_stale_glossary AFTER UPDATE OF keep_names_json ON projects
WHEN OLD.keep_names_json IS NOT NEW.keep_names_json BEGIN
  UPDATE translations SET stale=1 WHERE stale=0 AND (
    (kind='card' AND source_id IN (SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (NEW.id)))
    OR (kind='entry' AND source_id IN (SELECT e.id FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id
      JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (NEW.id))));
END;
CREATE TRIGGER translate_stale_name_new AFTER INSERT ON cards
WHEN NEW.is_doc=1 AND NEW.entry_type_id IN (SELECT t.id FROM entry_types t LEFT JOIN entry_types p ON p.id=t.parent_type_id WHERE t.key IN ('character','npc','location','place','creature','item','faction','ship') OR p.key IN ('character','npc','location','place','creature','item','faction','ship')) BEGIN
  UPDATE translations SET stale=1 WHERE stale=0 AND (
    (kind='card' AND source_id IN (SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=NEW.entry_type_id)))
    OR (kind='entry' AND source_id IN (SELECT e.id FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id
      JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=NEW.entry_type_id))));
END;
CREATE TRIGGER translate_stale_name_gone AFTER DELETE ON cards
WHEN OLD.is_doc=1 AND OLD.entry_type_id IN (SELECT t.id FROM entry_types t LEFT JOIN entry_types p ON p.id=t.parent_type_id WHERE t.key IN ('character','npc','location','place','creature','item','faction','ship') OR p.key IN ('character','npc','location','place','creature','item','faction','ship')) BEGIN
  UPDATE translations SET stale=1 WHERE stale=0 AND (
    (kind='card' AND source_id IN (SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=OLD.entry_type_id)))
    OR (kind='entry' AND source_id IN (SELECT e.id FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id
      JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=OLD.entry_type_id))));
END;
CREATE TRIGGER translate_stale_name_change AFTER UPDATE ON cards
WHEN (NEW.entry_type_id IN (SELECT t.id FROM entry_types t LEFT JOIN entry_types p ON p.id=t.parent_type_id WHERE t.key IN ('character','npc','location','place','creature','item','faction','ship') OR p.key IN ('character','npc','location','place','creature','item','faction','ship')) OR OLD.entry_type_id IN (SELECT t.id FROM entry_types t LEFT JOIN entry_types p ON p.id=t.parent_type_id WHERE t.key IN ('character','npc','location','place','creature','item','faction','ship') OR p.key IN ('character','npc','location','place','creature','item','faction','ship')))
  AND (OLD.is_doc IS NOT NEW.is_doc OR OLD.entry_type_id IS NOT NEW.entry_type_id OR OLD.visibility IS NOT NEW.visibility
    OR OLD.aliases_json IS NOT NEW.aliases_json OR substr(OLD.content,1,instr(OLD.content||char(10),char(10))-1) IS NOT substr(NEW.content,1,instr(NEW.content||char(10),char(10))-1)) BEGIN
  UPDATE translations SET stale=1 WHERE stale=0 AND (
    (kind='card' AND source_id IN (SELECT c.id FROM cards c JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=NEW.entry_type_id) OR d.project_id IN (SELECT project_id FROM entry_types WHERE id=OLD.entry_type_id)))
    OR (kind='entry' AND source_id IN (SELECT e.id FROM resolvable_entries e JOIN resolvables v ON v.id=e.resolvable_id
      JOIN cards c ON c.id=v.card_id JOIN decks d ON d.id=c.deck_id WHERE d.project_id IN (SELECT project_id FROM entry_types WHERE id=NEW.entry_type_id) OR d.project_id IN (SELECT project_id FROM entry_types WHERE id=OLD.entry_type_id))));
END;

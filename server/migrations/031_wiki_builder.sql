-- Wiki builder: the headings a new page of a type starts with, and the type's templates (starting values and links).
ALTER TABLE entry_types ADD COLUMN sections_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE entry_types ADD COLUMN templates_json TEXT NOT NULL DEFAULT '[]';

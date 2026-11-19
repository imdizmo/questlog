-- Names become links by themselves: an entry's aliases, and the names a card's text does not link ("Not a link here").
ALTER TABLE cards ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN link_ignores_json TEXT NOT NULL DEFAULT '[]';

import { toCamel, type Db } from '../db';
import { entryPieces, textVersion } from '../../shared/translate';
import { fieldsOf } from '../../shared/wiki';
import type { EntryType } from '../../shared/types';

/** The SQL expression of an entry's fields version (cards alias c); the same as fieldsVersion. */
export const FIELDS_VERSION_SQL = "jt_text_version(c.fields_json || char(0) || coalesce(c.layout_json, ''))";
export const fieldsVersion = (fieldsJson: string, layoutJson: string | null): number => textVersion(`${fieldsJson}\0${layoutJson ?? ''}`);

/** A typed, live Lore entry's pieces (shared/translate entryPieces) as JSON text, with its version; null otherwise. */
export function fieldsSource(db: Db, id: string): { text: string; version: number; projectId: string | null; authorId: string; cardId: string } | null {
  const c = db.prepare(`SELECT c.fields_json f, c.layout_json l, c.entry_type_id t, c.creator_id a, d.project_id p FROM cards c
    LEFT JOIN decks d ON d.id=c.deck_id WHERE c.id=? AND c.visibility!='deleted' AND c.is_doc=1 AND c.entry_type_id IS NOT NULL`)
    .get(id) as { f: string; l: string | null; t: string; a: string; p: string | null } | undefined;
  if (!c) return null;
  const types = new Map((db.prepare('SELECT * FROM entry_types WHERE project_id=(SELECT project_id FROM entry_types WHERE id=?)').all(c.t) as Record<string, unknown>[])
    .map((r) => { const t = toCamel<EntryType>(r); return [t.id, t]; }));
  const textFields = types.has(c.t) ? fieldsOf(types, c.t).filter((d) => d.kind === 'text' || d.kind === 'longtext').map((d) => d.key) : [];
  const pieces = entryPieces(JSON.parse(c.f), textFields, c.l ? JSON.parse(c.l) : null);
  return { text: JSON.stringify(pieces), version: fieldsVersion(c.f, c.l), projectId: c.p, authorId: c.a, cardId: id };
}

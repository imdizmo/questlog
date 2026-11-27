import type { Db } from '../db';
import { titleOf } from '../../shared/cards';
import type { GlossaryEntry } from '../../shared/translate';

/** Entry type keys whose entries are names (a type counts when it or its parent type has one of these keys). */
export const NAME_TYPE_KEYS = ['character', 'npc', 'location', 'place', 'creature', 'item', 'faction', 'ship'] as const;

const KEYS_SQL = NAME_TYPE_KEYS.map((k) => `'${k}'`).join(',');

/**
 * What the engine must never translate in a project's text: titles and aliases of its name-kind Lore entries, then
 * the project's glossary (projects.keep_names_json), which wins for the same term (case-insensitive), and "lore"
 * unless the glossary has it. A deckless card (projectId null) gets "lore" only.
 */
export function protectedNames(db: Db, projectId: string | null): GlossaryEntry[] {
  const out = new Map<string, GlossaryEntry>();
  const put = (g: GlossaryEntry) => { if (g.term.trim()) out.set(g.term.trim().toLowerCase(), g); };
  if (projectId) {
    const rows = db.prepare(
      `SELECT c.content, c.aliases_json a FROM cards c JOIN entry_types t ON t.id=c.entry_type_id
         LEFT JOIN entry_types p ON p.id=t.parent_type_id
       WHERE t.project_id=? AND c.is_doc=1 AND c.visibility!='deleted' AND (t.key IN (${KEYS_SQL}) OR p.key IN (${KEYS_SQL}))
       ORDER BY c.seq`).all(projectId) as { content: string; a: string }[];
    for (const r of rows) {
      const title = r.content.split('\n', 1)[0].trim() ? titleOf(r.content) : '';
      if (title) put({ term: title });
      for (const a of JSON.parse(r.a) as unknown[]) if (typeof a === 'string') put({ term: a });
    }
  }
  const glossary = projectId ? glossaryOf(db, projectId) : [];
  if (!glossary.some((g) => g.term.trim().toLowerCase() === 'lore')) put({ term: 'lore' });
  for (const g of glossary) put(g);
  return [...out.values()];
}

/** The project's own glossary as stored; anything malformed is skipped. */
function glossaryOf(db: Db, projectId: string): GlossaryEntry[] {
  const r = db.prepare('SELECT keep_names_json k FROM projects WHERE id=?').get(projectId) as { k: string } | undefined;
  if (!r) return [];
  let list: unknown;
  try { list = JSON.parse(r.k); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: GlossaryEntry[] = [];
  for (const g of list) {
    if (!g || typeof g !== 'object' || typeof (g as GlossaryEntry).term !== 'string') continue;
    const { term, en, it } = g as GlossaryEntry;
    out.push({ term, ...(typeof en === 'string' ? { en } : {}), ...(typeof it === 'string' ? { it } : {}) });
  }
  return out;
}

import type { Db } from './db';
import { AppError } from './errors';
import { can, visibleProjectIds } from './permissions';
import { ACTIVITY_FILTERS, filtersOf, mergeProperties, type ActivityFilter, type ActivityItem } from '../shared/activity';
import type { HistoryChange, User } from '../shared/types';

export const PAGE = 50;
const CHUNK = 200;
/** Upper bound on raw rows examined per request (a sparse filter must not scan all history). */
const MAX_CHUNKS = 10;
const QUOTE_MAX = 140;

const plainQuote = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > QUOTE_MAX ? `${cps.slice(0, QUOTE_MAX).join('').trimEnd()}...` : t;
};

/** (at, id) cursor token: `<at>_<id>`. Newest first; the cursor is exclusive. */
function parseCursor(raw: unknown): { at: number; id: string } | null {
  if (raw === undefined || raw === '') return null;
  const m = /^(\d{1,16})(?:_(.*))?$/.exec(String(raw));
  if (!m) throw new AppError(400, 'invalid_input');
  // A bare timestamp means "everything strictly older".
  return { at: Number(m[1]), id: m[2] ?? '' };
}
const cursorSql = (col: string, idExpr: string, cur: { at: number; id: string } | null) =>
  cur ? { sql: `AND (${col} < ? OR (${col} = ? AND ${idExpr} < ?))`, args: [cur.at, cur.at, cur.id] } : { sql: '', args: [] as (string | number)[] };

type Scope = { col: 'deck' | 'project'; id: string; projectId: string; visibleJson?: undefined } | { col: 'milestone' | 'sprint'; id: string; visibleJson: string; projectId?: undefined };

/** Feed of a milestone or run: stamped history plus threads of cards still in it, only for cards in projects the viewer can see now. */
function planChunk(db: Db, sc: { col: 'milestone' | 'sprint'; id: string; visibleJson: string }, cur: { at: number; id: string } | null): ActivityItem[] {
  const hist = cursorSql('h.at', `('h:' || h.card_id || ':' || h.version)`, cur);
  const ent = cursorSql('e.created_at', `('e:' || e.id)`, cur);
  const out: ActivityItem[] = [];
  const stamp = sc.col === 'milestone' ? 'h.milestone_id' : 'h.sprint_id';
  const cardCol = sc.col === 'milestone' ? 'c.milestone_id' : 'c.sprint_id';
  for (const r of db.prepare(
    `SELECT h.card_id, h.version, h.changer_id, h.at, h.changes_json, h.deck_id, h.project_id
     FROM card_history h JOIN cards c ON c.id = h.card_id JOIN decks cd ON cd.id = c.deck_id
     WHERE ${stamp} = ? AND cd.project_id IN (SELECT value FROM json_each(?)) AND c.visibility != 'deleted' ${hist.sql}
     ORDER BY h.at DESC, ('h:' || h.card_id || ':' || h.version) DESC LIMIT ${CHUNK}`).all(sc.id, sc.visibleJson, ...hist.args) as any[]) {
    out.push({ id: `h:${r.card_id}:${r.version}`, at: r.at, actorId: r.changer_id, cardId: r.card_id, deckId: r.deck_id, projectId: r.project_id,
      kind: 'history', changes: JSON.parse(r.changes_json) as HistoryChange[] });
  }
  for (const r of db.prepare(
    `SELECT e.id, e.author_id, e.content, e.created_at, c.id card_id, c.deck_id, d.project_id
     FROM resolvable_entries e JOIN resolvables r ON r.id = e.resolvable_id JOIN cards c ON c.id = r.card_id JOIN decks d ON d.id = c.deck_id
     WHERE ${cardCol} = ? AND d.project_id IN (SELECT value FROM json_each(?)) AND c.visibility != 'deleted' ${ent.sql}
     ORDER BY e.created_at DESC, ('e:' || e.id) DESC LIMIT ${CHUNK}`).all(sc.id, sc.visibleJson, ...ent.args) as any[]) {
    out.push({ id: `e:${r.id}`, at: r.created_at, actorId: r.author_id, cardId: r.card_id, deckId: r.deck_id, projectId: r.project_id,
      kind: 'entry', entryId: r.id, quote: plainQuote(r.content) });
  }
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, CHUNK);
}

function chunk(db: Db, sc: Scope, cur: { at: number; id: string } | null): ActivityItem[] {
  if (sc.visibleJson !== undefined) return planChunk(db, sc, cur);
  const { col: scopeCol, id: scopeId, projectId } = sc;
  const hist = cursorSql('h.at', `('h:' || h.card_id || ':' || h.version)`, cur);
  const ent = cursorSql('e.created_at', `('e:' || e.id)`, cur);
  // History is stamped at write time; the card's CURRENT project must still be the scoped one, so a card moved
  // to a project the viewer cannot see drops out of the old project's feed (moves within a project keep old rows).
  const out: ActivityItem[] = [];
  const histCol = scopeCol === 'deck' ? 'h.deck_id' : 'h.project_id';
  for (const r of db.prepare(
    `SELECT h.card_id, h.version, h.changer_id, h.at, h.changes_json, h.deck_id, h.project_id
     FROM card_history h JOIN cards c ON c.id = h.card_id JOIN decks cd ON cd.id = c.deck_id
     WHERE ${histCol} = ? AND cd.project_id = ? AND c.visibility != 'deleted' ${hist.sql}
     ORDER BY h.at DESC, ('h:' || h.card_id || ':' || h.version) DESC LIMIT ${CHUNK}`).all(scopeId, projectId, ...hist.args) as any[]) {
    out.push({ id: `h:${r.card_id}:${r.version}`, at: r.at, actorId: r.changer_id, cardId: r.card_id, deckId: r.deck_id, projectId: r.project_id,
      kind: 'history', changes: JSON.parse(r.changes_json) as HistoryChange[] });
  }
  const cardDeckCol = scopeCol === 'deck' ? 'c.deck_id' : 'd.project_id';
  for (const r of db.prepare(
    `SELECT e.id, e.author_id, e.content, e.created_at, c.id card_id, c.deck_id, d.project_id
     FROM resolvable_entries e JOIN resolvables r ON r.id = e.resolvable_id JOIN cards c ON c.id = r.card_id JOIN decks d ON d.id = c.deck_id
     WHERE ${cardDeckCol} = ? AND c.visibility != 'deleted' ${ent.sql}
     ORDER BY e.created_at DESC, ('e:' || e.id) DESC LIMIT ${CHUNK}`).all(scopeId, ...ent.args) as any[]) {
    out.push({ id: `e:${r.id}`, at: r.created_at, actorId: r.author_id, cardId: r.card_id, deckId: r.deck_id, projectId: r.project_id,
      kind: 'entry', entryId: r.id, quote: plainQuote(r.content) });
  }
  const deckCol = scopeCol === 'deck' ? 'd.id' : 'd.project_id';
  const dk = cursorSql('d.created_at', `('d:' || d.id)`, cur);
  for (const r of db.prepare(
    `SELECT d.id, d.creator_id, d.created_at, d.project_id FROM decks d WHERE ${deckCol} = ? ${dk.sql}
     ORDER BY d.created_at DESC, ('d:' || d.id) DESC LIMIT ${CHUNK}`).all(scopeId, ...dk.args) as any[]) {
    out.push({ id: `d:${r.id}`, at: r.created_at, actorId: r.creator_id ?? '', cardId: null, deckId: r.id, projectId: r.project_id, kind: 'deckCreated' });
  }
  // Same (at, id) order as the SQL cursor comparisons (ASCII ids, plain code-unit order).
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, CHUNK);
}

/** Keep the item (trimmed to the matching changes) when it passes the filters, else null. */
function applyFilters(it: ActivityItem, want: Set<ActivityFilter> | null): ActivityItem | null {
  if (!want) return it;
  if (it.kind === 'entry') return want.has('conversations') ? it : null;
  if (it.kind === 'deckCreated') return want.has('newCards') ? it : null;
  const changes = (it.changes ?? []).filter((c) => filtersOf(c).some((f) => want.has(f)));
  return changes.length ? { ...it, changes } : null;
}

export function activityPage(db: Db, user: User, q: { deckId?: string; projectId?: string; milestoneId?: string; sprintId?: string; before?: string; filters?: string }): { items: ActivityItem[]; next: string | null } {
  let scope: Scope;
  if ([q.deckId, q.projectId, q.milestoneId, q.sprintId].filter(Boolean).length !== 1) throw new AppError(400, 'invalid_input');
  if (q.milestoneId || q.sprintId) {
    // Visible when global or covering a visible project; rows are further limited to cards in projects visible to the viewer now.
    const vis = [...visibleProjectIds(db, user)];
    const visibleJson = JSON.stringify(vis);
    const ok = q.milestoneId
      ? db.prepare(`SELECT 1 FROM milestones m WHERE m.id=? AND (m.is_global=1 OR EXISTS (SELECT 1 FROM milestone_projects p WHERE p.milestone_id=m.id AND p.project_id IN (SELECT value FROM json_each(?))))`).get(q.milestoneId, visibleJson)
      : db.prepare(`SELECT 1 FROM sprints s JOIN sprint_configs f ON f.id=s.config_id WHERE s.id=? AND (f.is_global=1 OR EXISTS (SELECT 1 FROM sprint_config_projects p WHERE p.config_id=f.id AND p.project_id IN (SELECT value FROM json_each(?))))`).get(q.sprintId as string, visibleJson);
    if (!ok || !vis.length) throw new AppError(404, 'not_found');
    scope = { col: q.milestoneId ? 'milestone' : 'sprint', id: (q.milestoneId ?? q.sprintId)!, visibleJson };
  } else {
  let scopeCol: 'deck' | 'project';
  let scopeId: string;
  let projectId: string;
  if (q.deckId) {
    const d = db.prepare('SELECT project_id p FROM decks WHERE id=?').get(q.deckId) as { p: string } | undefined;
    if (!d) throw new AppError(404, 'not_found');
    scopeCol = 'deck'; scopeId = q.deckId; projectId = d.p;
  } else if (q.projectId) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(q.projectId)) throw new AppError(404, 'not_found');
    scopeCol = 'project'; scopeId = q.projectId; projectId = q.projectId;
  } else throw new AppError(400, 'invalid_input');
  if (!can(db, user, 'project.view', projectId)) throw new AppError(404, 'not_found');
  scope = { col: scopeCol, id: scopeId, projectId };
  }

  let want: Set<ActivityFilter> | null = null;
  if (q.filters) {
    const names = q.filters.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.some((n) => !(ACTIVITY_FILTERS as string[]).includes(n))) throw new AppError(400, 'invalid_input');
    if (names.length) want = new Set(names as ActivityFilter[]);
  }

  let cur = parseCursor(q.before);
  const kept: ActivityItem[] = [];
  let scanned: { at: number; id: string } | null = null; // last raw row examined
  let exhausted = false;
  for (let n = 0; n < MAX_CHUNKS; n++) {
    const raw = chunk(db, scope, cur);
    for (const it of raw) {
      const f = applyFilters(it, want);
      if (f) kept.push(f);
      if (kept.length > PAGE) break;
    }
    if (kept.length > PAGE) break;
    if (raw.length < CHUNK) { exhausted = true; break; }
    const last = raw[raw.length - 1];
    scanned = cur = { at: last.at, id: last.id };
  }
  const page = kept.slice(0, PAGE);
  const last = page[page.length - 1];
  // Over a full page: resume after its last item. Scan cap hit with a short page: resume after the last scanned row
  // (the page may be short or empty; a non-null next means more may follow).
  const next = kept.length > PAGE && last ? `${last.at}_${last.id}` : !exhausted && scanned ? `${scanned.at}_${scanned.id}` : null;
  return { items: mergeProperties(page), next };
}

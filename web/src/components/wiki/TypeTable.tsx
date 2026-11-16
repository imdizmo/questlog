import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryType, FieldDef, Project } from '../../../../shared/types';
import { fieldsOf, isTypeOrChild } from '../../../../shared/wiki';
import { dispatch } from '../../api';
import { canEditCard, canEditContent, useStore } from '../../store';
import { Link, navigate, useLocation } from '../../router';
import { Dialog } from '../Dialog';
import { campaignTypes, entryPath, filterToParam, filtersFromQuery, formatValue, sortFromQuery, typeRows, type FieldFilter } from '../../wiki';
import { FieldEditor, entryTitle } from './FieldEditor';
import { TypeBadge, useTitleOfKey } from './Infobox';

export const PAGE_SIZE = 200;
/** Kinds a cell can be edited in place; the rest are read here and edited on the entry page. */
const CELL_EDITABLE = new Set(['text', 'number', 'integer', 'boolean', 'enum']);
const NO_ENTRIES: never[] = [];

type Col = { key: string; label: string; def: FieldDef | null };
const TITLE_COL: Col = { key: 'title', label: 'Title', def: null };
const TYPE_COL: Col = { key: 'type', label: 'Type', def: null };

/**
 * Every entry of one type (and its child types) as a table. Filters, sort, extra columns and the page live in the URL
 * query, so a filtered table can be linked. Text, number, integer, boolean and enum cells edit in place.
 */
export function TypeTable({ project, type }: { project: Project; type: EntryType }) {
  const s = useStore((x) => x);
  const { query } = useLocation();
  const titleOfKey = useTitleOfKey(project.id);
  const [creating, setCreating] = useState(false);

  const children = useMemo(
    () => campaignTypes(s.entryTypes, project.id).filter((t) => t.id !== type.id && isTypeOrChild(s.entryTypes, t.id, [type.key])),
    [s.entryTypes, project.id, type],
  );
  /** Fields a column can show: the type's own (inherited included), then those only child types add. */
  const available = useMemo(() => {
    const m = new Map<string, FieldDef>();
    for (const t of [type, ...children]) for (const f of fieldsOf(s.entryTypes, t.id)) if (!f.hidden && !m.has(f.key)) m.set(f.key, f);
    return [...m.values()];
  }, [s.entryTypes, type, children]);
  const colsParam = query.get('cols');
  const cols: Col[] = useMemo(() => {
    const keys = colsParam !== null ? colsParam.split(',').filter(Boolean) : available.filter((f) => f.inTable).map((f) => f.key);
    const picked = keys.map((k) => available.find((f) => f.key === k)).filter((f): f is FieldDef => !!f);
    return [TITLE_COL, ...picked.map((f) => ({ key: f.key, label: f.label, def: f })), ...(children.length ? [TYPE_COL] : [])];
  }, [colsParam, available, children.length]);

  const filters = useMemo(() => filtersFromQuery(query), [query]);
  const sort = useMemo(() => sortFromQuery(query), [query]);
  const rows = useMemo(() => typeRows(s, project.id, type.id, filters, sort), [s.cards, s.decks, s.entryTypes, project.id, type.id, filters, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(query.get('page'))) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  /** Rewrites the URL query; every change except paging itself goes back to page 1. */
  const update = (edit: (q: URLSearchParams) => void, keepPage = false) => {
    // Read the address fresh: a debounced filter write must not undo edits made since it was scheduled.
    const q = new URLSearchParams(location.search);
    edit(q);
    if (!keepPage) q.delete('page');
    const str = q.toString();
    navigate(location.pathname + (str ? `?${str}` : ''), { replace: true });
  };
  /** Replaces this column's filters of the given ops (all ops of the key when `drop` is omitted) with `next`. */
  const setFilter = (key: string, drop: FieldFilter['op'][], next: FieldFilter | null) =>
    update((q) => {
      const kept = filtersFromQuery(q).filter((f) => !(f.key === key && drop.includes(f.op)));
      q.delete('f');
      for (const f of next ? [...kept, next] : kept) q.append('f', filterToParam(f));
    });
  const toggleSort = (key: string) =>
    update((q) => {
      if (sort?.key !== key) q.set('sort', `${key}:asc`);
      else if (sort.dir === 'asc') q.set('sort', `${key}:desc`);
      else q.delete('sort');
    });
  const toggleCol = (key: string) =>
    update((q) => {
      const cur = cols.filter((c) => c.def).map((c) => c.key);
      q.set('cols', (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]).join(','));
    });

  const save = (cardId: string, key: string, v: unknown) => void dispatch('wiki', 'setEntry', { cardId, fields: { [key]: v ?? null } }).catch(() => {});

  return (
    <section className="type-table" aria-label={`${type.name} table`}>
      <div className="type-table-head">
        <h2><TypeBadge type={type} /> <span className="muted">{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span></h2>
        <span className="type-table-tools">
          <details className="col-picker">
            <summary className="btn btn-sm">Columns</summary>
            <div className="col-picker-menu" role="group" aria-label="Columns">
              {available.map((f) => (
                <label key={f.key}><input type="checkbox" checked={cols.some((c) => c.key === f.key)} onChange={() => toggleCol(f.key)} /> {f.label}</label>
              ))}
              {!available.length && <span className="muted">No fields</span>}
            </div>
          </details>
          {canEditContent(s, project) && <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>New {type.name}</button>}
        </span>
      </div>
      <div className="table-wrap type-table-wrap">
        <table className="table" data-testid="type-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>
                    {c.label}{sort?.key === c.key && <span aria-hidden> {sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
            <tr className="filter-row">
              {cols.map((c) => (
                <th key={c.key} scope="col">
                  <ColumnFilter col={c} children={children} filters={filters} setFilter={setFilter} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((card) => {
              const defs = card.entryTypeId ? fieldsOf(s.entryTypes, card.entryTypeId) : [];
              const can = canEditCard(s, card, project);
              return (
                <tr key={card.id}>
                  {cols.map((c) => {
                    if (c.key === 'title') return <td key={c.key}><Link href={entryPath(project.seq, card)}>{entryTitle(card)}</Link></td>;
                    if (c.key === 'type') return <td key={c.key}><TypeBadge type={card.entryTypeId ? s.entryTypes.get(card.entryTypeId) : null} /></td>;
                    const def = defs.find((d) => d.key === c.key);
                    if (!def) return <td key={c.key} className="muted">—</td>;
                    const v = card.fields?.[c.key];
                    return (
                      <td key={c.key}>
                        {can && CELL_EDITABLE.has(def.kind)
                          ? <FieldEditor def={def} value={v} onSave={(nv) => save(card.id, c.key, nv)} titleOfKey={titleOfKey} images={NO_ENTRIES} entries={NO_ENTRIES} />
                          : formatValue(def, v, titleOfKey) || <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={cols.length} className="muted">{filters.length ? 'No entries match the filters.' : `No ${type.name} entries yet.`}</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="type-table-pager" aria-label="Pages">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => update((q) => q.set('page', String(page - 1)), true)}>Previous</button>
          <span aria-live="polite">{(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + shown.length} of {rows.length}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => update((q) => q.set('page', String(page + 1)), true)}>Next</button>
        </nav>
      )}
      {creating && <NewRowDialog project={project} type={type} onClose={() => setCreating(false)} />}
    </section>
  );
}

const DEBOUNCE_MS = 250;
const MODE_LABEL: Record<FieldFilter['op'], string> = { eq: 'equals', contains: 'contains', min: 'at least', max: 'at most', has: 'has a value', missing: 'is empty' };
/** The filter modes a column offers, by its kind. */
function modesOf(col: Col): FieldFilter['op'][] {
  const kind = col.def?.kind;
  if (col.key === 'type' || kind === 'boolean' || kind === 'enum' || kind === 'multienum') return ['eq', 'has', 'missing'];
  if (kind === 'number' || kind === 'integer' || kind === 'range') return ['min', 'max', 'eq', 'has', 'missing'];
  if (kind === 'entry' || kind === 'entries') return ['contains', 'has', 'missing'];
  if (col.key === 'title' || col.key === 'key' || kind === 'text') return ['contains', 'eq', 'has', 'missing'];
  return ['contains', 'has', 'missing'];
}

/**
 * The filter under a column header: a mode (any, or one of the ops valid for the kind) and, for ops that take one, a
 * value. Typed values are a local draft, written to the URL after a pause, so typing never loses characters.
 */
function ColumnFilter({ col, children, filters, setFilter }: {
  col: Col; children: EntryType[]; filters: FieldFilter[];
  setFilter: (key: string, drop: FieldFilter['op'][], next: FieldFilter | null) => void;
}) {
  const { key, label, def } = col;
  const kind = def?.kind;
  const modes = modesOf(col);
  const mine = filters.find((f) => f.key === key && modes.includes(f.op));
  const urlMode = mine?.op ?? '';
  const urlValue = mine?.value === undefined ? '' : String(mine.value);
  const [mode, setMode] = useState<FieldFilter['op'] | ''>(urlMode);
  const [draft, setDraft] = useState(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What this control last wrote to the URL; only a different URL (a link, the back button) resets the control. */
  const sent = useRef({ mode: urlMode as string, value: urlValue });
  useEffect(() => {
    if (sent.current.mode === urlMode && sent.current.value === urlValue) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; } // a stale draft must not overwrite the new URL
    sent.current = { mode: urlMode, value: urlValue };
    setMode(urlMode); setDraft(urlValue);
  }, [urlMode, urlValue]);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);

  const write = (op: FieldFilter['op'] | '', text: string) => {
    clear();
    if (op === '') { sent.current = { mode: '', value: '' }; return setFilter(key, modes, null); }
    if (op === 'has' || op === 'missing') { sent.current = { mode: op, value: '' }; return setFilter(key, modes, { key, op }); }
    if (text.trim() === '') { sent.current = { mode: '', value: '' }; return setFilter(key, modes, null); }
    const n = Number(text);
    const numeric = op === 'min' || op === 'max' || (op === 'eq' && (kind === 'number' || kind === 'integer' || kind === 'range'));
    if (numeric && !Number.isFinite(n)) return;
    sent.current = { mode: op, value: String(numeric ? n : text) };
    setFilter(key, modes, { key, op, value: numeric ? n : text });
  };
  const typed = (text: string) => {
    setDraft(text);
    clear();
    timer.current = setTimeout(() => write(mode, text), DEBOUNCE_MS);
  };
  const needsValue = mode !== '' && mode !== 'has' && mode !== 'missing';
  const numericKind = kind === 'number' || kind === 'integer' || kind === 'range';
  const choices = col.key === 'type' ? children.map((t) => ({ v: t.key, l: t.name }))
    : kind === 'boolean' ? [{ v: 'true', l: 'yes' }, { v: 'false', l: 'no' }]
    : kind === 'enum' || kind === 'multienum' ? (def?.options ?? []).map((o) => ({ v: o, l: o }))
    : null;

  return (
    <span className="filter-pair">
      <select aria-label={`Filter ${label} mode`} value={mode} onChange={(e) => {
        const next = e.target.value as FieldFilter['op'] | '';
        setMode(next);
        write(next, next === 'eq' || next === 'contains' || next === 'min' || next === 'max' ? draft : '');
      }}>
        <option value="">Any</option>
        {modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>
      {needsValue && (choices ? (
        <select aria-label={`Filter ${label}`} value={draft} onChange={(e) => { setDraft(e.target.value); write(mode, e.target.value); }}>
          <option value="">…</option>
          {choices.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
        </select>
      ) : (
        <input type={numericKind ? 'number' : 'text'} aria-label={`Filter ${label}`} step={numericKind ? 'any' : undefined} value={draft}
          onChange={(e) => typed(e.target.value)} onBlur={() => { if (timer.current) write(mode, draft); }}
          onKeyDown={(e) => { if (e.key === 'Enter') write(mode, draft); }} />
      ))}
    </span>
  );
}

/** New <type>: asks for a name, then creates the entry of this type; it shows up in the table. */
function NewRowDialog({ project, type, onClose }: { project: Project; type: EntryType; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await dispatch('wiki', 'createEntry', { projectId: project.id, typeId: type.id, name: name.trim() });
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title={`New ${type.name}`} onClose={onClose} onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Create</button>
      </>}>
      <label className="field">
        <span>Name</span>
        <input data-autofocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
    </Dialog>
  );
}

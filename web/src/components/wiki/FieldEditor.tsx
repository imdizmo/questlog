import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Card, FieldDef, RuleValue, ScenarioValue, TableValue } from '../../../../shared/types';
import { tableProblem } from '../../../../shared/balance';
import { titleOf } from '../../../../shared/cards';
import type { CardFile } from '../../store';
import { CardPicker } from '../CardPicker';
import { Icon } from '../icons';

/** Image kinds an `image` field can point at (the server shows these inline). */
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface FieldEditorProps {
  def: FieldDef;
  value: unknown;
  /** The new value; null clears it. */
  onSave: (v: unknown) => void;
  /** Entries an entry/entries field may point at (already filtered by the field's target). */
  entries: Card[];
  /** Title of the entry with a key, for showing references. */
  titleOfKey: (key: string) => string | null;
  /** Image attachments of the entry, for image fields. */
  images: CardFile[];
  /** Report every valid edit at once (a draft form), instead of on Enter or leaving the field. */
  instant?: boolean;
  /** Values to offer for a text field (what other entries already use). */
  suggestions?: string[];
}

const asText = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Parses a number input; undefined = not a valid value for this field. */
function parseNum(def: FieldDef, s: string): number | null | undefined {
  if (s.trim() === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || (def.kind === 'integer' && !Number.isInteger(n))) return undefined;
  return n;
}

/** One field's inline editor, by kind. Every committed change calls onSave with the whole new value. */
export function FieldEditor(p: FieldEditorProps) {
  switch (p.def.kind) {
    case 'boolean':
      return <input type="checkbox" aria-label={p.def.label} checked={p.value === true} onChange={(e) => p.onSave(e.target.checked)} />;
    case 'enum':
      // In a draft form a short list is a row of buttons: one click instead of opening a menu.
      if (p.instant && (p.def.options ?? []).length <= 8) {
        return (
          <span className="wk-chips" role="group" aria-label={p.def.label}>
            {(p.def.options ?? []).map((o) => (
              <button key={o} type="button" className={p.value === o ? 'chip on' : 'chip'} aria-pressed={p.value === o} onClick={() => p.onSave(o)}>{o}</button>
            ))}
          </span>
        );
      }
      return (
        <select aria-label={p.def.label} value={typeof p.value === 'string' ? p.value : ''} onChange={(e) => p.onSave(e.target.value || null)}>
          <option value="">—</option>
          {(p.def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          {typeof p.value === 'string' && p.value && !(p.def.options ?? []).includes(p.value) && <option value={p.value}>{p.value} (not an option)</option>}
        </select>
      );
    case 'multienum': {
      const on = new Set(Array.isArray(p.value) ? p.value.map(String) : []);
      const toggle = (o: string) => {
        // Stored values that are no longer options stay (a check flags them); only the clicked option changes.
        const kept = [...on].filter((x) => !(p.def.options ?? []).includes(x));
        const next = [...(p.def.options ?? []).filter((x) => (x === o ? !on.has(o) : on.has(x))), ...kept];
        p.onSave(next.length ? next : null);
      };
      return (
        <fieldset className="wiki-multi" aria-label={p.def.label}>
          {(p.def.options ?? []).map((o) => (
            <label key={o}><input type="checkbox" checked={on.has(o)} onChange={() => toggle(o)} /> {o}</label>
          ))}
        </fieldset>
      );
    }
    case 'entry': return <EntryRef {...p} />;
    case 'entries': return <EntryRefs {...p} />;
    case 'image': {
      const imgs = p.images.filter((f) => IMAGE_MIME.has(f.mime));
      const v = typeof p.value === 'string' ? p.value : '';
      return (
        <select aria-label={p.def.label} value={v} onChange={(e) => p.onSave(e.target.value || null)}>
          <option value="">{imgs.length ? 'No image' : 'No image attachments'}</option>
          {imgs.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          {v && !imgs.some((f) => f.id === v) && <option value={v}>Missing attachment</option>}
        </select>
      );
    }
    case 'color': return <ColorInput {...p} />;
    case 'range': return <RangeInput {...p} />;
    case 'table': return <TableInput {...p} />;
    case 'rule': return <RuleSummary value={p.value} />;
    case 'scenario': return <ScenarioSummary value={p.value} />;
    default:
      // A number with both limits set gets a slider next to its box.
      if (p.instant && (p.def.kind === 'number' || p.def.kind === 'integer') && p.def.min !== undefined && p.def.max !== undefined) {
        return (
          <span className="wk-slide">
            <input type="range" aria-label={`${p.def.label} slider`} min={p.def.min} max={p.def.max} step={p.def.kind === 'integer' ? 1 : 'any'}
              value={typeof p.value === 'number' ? p.value : p.def.min} onChange={(e) => p.onSave(Number(e.target.value))} />
            <TextInput {...p} />
          </span>
        );
      }
      return <TextInput {...p} />;
  }
}

/** text, longtext, number, integer: a draft committed on Enter (not in long text) or on leaving the field. */
function TextInput({ def, value, onSave, instant, suggestions }: FieldEditorProps) {
  const listId = useId();
  const [draft, setDraft] = useState(asText(value));
  const stored = JSON.stringify(value ?? null);
  useEffect(() => { setDraft(asText(value)); }, [stored]);
  const numeric = def.kind === 'number' || def.kind === 'integer';
  const parse = (s: string): unknown => (numeric ? parseNum(def, s) : s === '' ? null : s);
  const commit = (s = draft, isBad = bad) => {
    if (isBad) return;
    const v = parse(s);
    if (v !== undefined && JSON.stringify(v) !== stored) onSave(v);
  };
  /** A half-typed number ("-", "1e") reads as "" in the browser: leave the stored value alone instead of clearing it. */
  const [bad, setBad] = useState(false);
  const change = (s: string, badInput = false) => { setDraft(s); setBad(badInput); if (instant) commit(s, badInput); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && def.kind !== 'longtext') { e.preventDefault(); commit(); } };
  if (def.kind === 'longtext') {
    return <textarea aria-label={def.label} rows={3} value={draft} onChange={(e) => change(e.target.value)} onBlur={() => commit()} />;
  }
  return (
    <>
      <input type={numeric ? 'number' : 'text'} aria-label={def.label} aria-invalid={(numeric && (bad || parse(draft) === undefined)) || undefined} value={draft}
        step={def.kind === 'integer' ? 1 : 'any'} min={def.min} max={def.max} list={suggestions?.length ? listId : undefined}
        onChange={(e) => change(e.target.value, e.target.validity.badInput)} onBlur={() => commit()} onKeyDown={onKey} />
      {!!suggestions?.length && <datalist id={listId}>{suggestions.map((v) => <option key={v} value={v} />)}</datalist>}
    </>
  );
}

function RangeInput({ def, value, onSave, instant }: FieldEditorProps) {
  const r = value && typeof value === 'object' && !Array.isArray(value) ? value as { min?: unknown; max?: unknown } : {};
  const stored = JSON.stringify(value ?? null);
  const [lo, setLo] = useState(asText(r.min));
  const [hi, setHi] = useState(asText(r.max));
  useEffect(() => { setLo(asText(r.min)); setHi(asText(r.max)); }, [stored]);
  /** Both sides empty (clears), or two numbers with min ≤ max; anything else is shown as invalid and not saved. */
  const valid = (a: string, b: string) => {
    if (a.trim() === '' && b.trim() === '') return true;
    const min = parseNum(def, a);
    const max = parseNum(def, b);
    return typeof min === 'number' && typeof max === 'number' && min <= max;
  };
  /** Half-typed number on either side (the browser reports it as ""). */
  const [bad, setBad] = useState({ lo: false, hi: false });
  const invalid = bad.lo || bad.hi || !valid(lo, hi);
  const commit = (a = lo, b = hi, isBad = bad) => {
    if (isBad.lo || isBad.hi) return;
    if (a.trim() === '' && b.trim() === '') { if (stored !== 'null') onSave(null); return; }
    if (!valid(a, b)) return;
    const min = parseNum(def, a) as number;
    const max = parseNum(def, b) as number;
    if (JSON.stringify({ min, max }) !== stored) onSave({ min, max });
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  return (
    <span className="wiki-range">
      <input type="number" aria-label={`${def.label} min`} aria-invalid={invalid || undefined} value={lo} step={def.kind === 'integer' ? 1 : 'any'}
        onChange={(e) => { const b = { ...bad, lo: e.target.validity.badInput }; setLo(e.target.value); setBad(b); if (instant) commit(e.target.value, hi, b); }} onBlur={() => commit()} onKeyDown={onKey} />
      <span aria-hidden>–</span>
      <input type="number" aria-label={`${def.label} max`} aria-invalid={invalid || undefined} value={hi} step={def.kind === 'integer' ? 1 : 'any'}
        onChange={(e) => { const b = { ...bad, hi: e.target.validity.badInput }; setHi(e.target.value); setBad(b); if (instant) commit(lo, e.target.value, b); }} onBlur={() => commit()} onKeyDown={onKey} />
    </span>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * The colour input always shows some colour, so an empty field keeps an empty draft until the person picks one: focusing
 * or tabbing through it never saves black. Clear sends null.
 */
function ColorInput({ def, value, onSave, instant }: FieldEditorProps) {
  const v = typeof value === 'string' && HEX.test(value) ? value : '';
  const [draft, setDraft] = useState(v);
  useEffect(() => { setDraft(v); }, [v]);
  return (
    <span className="wiki-color">
      <input type="color" aria-label={def.label} value={draft || '#000000'}
        onChange={(e) => { setDraft(e.target.value); if (instant) onSave(e.target.value); }}
        onBlur={() => { if (draft && draft !== v) onSave(draft); }} />
      {draft ? (
        <button type="button" className="btn btn-sm btn-ghost" aria-label={`Clear ${def.label}`} onClick={() => { setDraft(''); onSave(null); }}>Clear</button>
      ) : <span className="muted">None</span>}
    </span>
  );
}

function EntryRef({ def, value, onSave, entries, titleOfKey }: FieldEditorProps) {
  const key = typeof value === 'string' ? value : '';
  return (
    <span className="wiki-ref">
      {key && <span className="wiki-ref-value">{titleOfKey(key) ?? key}</span>}
      <CardPicker label={`Pick ${def.label}`} trigger={key ? 'Change' : 'Pick'} candidates={entries.filter((c) => c.entryKey && c.entryKey !== key)}
        searchLabel="Search lore" empty="No matching lore" onPick={(c) => onSave(c.entryKey)} />
      {key && <button type="button" className="chip-x" aria-label={`Clear ${def.label}`} onClick={() => onSave(null)}><Icon name="close" size={12} /></button>}
    </span>
  );
}

function EntryRefs({ def, value, onSave, entries, titleOfKey }: FieldEditorProps) {
  const keys = Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
  const set = (next: string[]) => onSave(next.length ? next : null);
  return (
    <span className="wiki-ref">
      {keys.map((k) => (
        <span key={k} className="chip">
          {titleOfKey(k) ?? k}
          <button type="button" className="chip-x" aria-label={`Remove ${titleOfKey(k) ?? k} from ${def.label}`} onClick={() => set(keys.filter((x) => x !== k))}>
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <CardPicker label={`Add to ${def.label}`} trigger={<Icon name="plus" size={14} />} searchLabel="Search lore" empty="No matching lore"
        candidates={entries.filter((c) => c.entryKey && !keys.includes(c.entryKey))} onPick={(c) => set([...keys, c.entryKey!])} />
    </span>
  );
}

/** Title of a Lore card for showing in lists. */
export const entryTitle = (c: Pick<Card, 'content'>) => titleOf(c.content) || 'Untitled';

// ---- Tables: a grid of numbers by one or two keys ----

type TableMode = TableValue['mode'];
/** The editor's draft: key texts as typed, and cell texts by cellId in a Map (key values are user words). */
export interface TableDraft { mode: TableMode; keys: { field: string; text: string }[]; cells: Map<string, string> }

/** "Pierce, Slash" or "1, 5, 10": a key's values; numbers when every one reads as a number. */
export function parseKeyValues(text: string): string[] | number[] {
  const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
  const nums = parts.map(Number);
  return parts.length && nums.every((n) => Number.isFinite(n)) ? nums : parts;
}
const cellId = (a: string | number, b?: string | number) => (b === undefined ? `${a}` : `${a}\u0000${b}`);
export const emptyTableDraft = (): TableDraft => ({ mode: 'exact', keys: [{ field: '', text: '' }], cells: new Map() });

/** The draft of a stored table; null when the stored value is not a table this editor can read (wrong_kind). */
export function draftOf(v: unknown): TableDraft | null {
  if (v === undefined || v === null) return emptyTableDraft();
  if (tableProblem(v) === 'wrong_kind') return null;
  const t = v as TableValue;
  const cells = new Map<string, string>();
  const [k0, k1] = t.keys;
  k0.values.forEach((a, i) => {
    if (!k1) cells.set(cellId(a), String(t.cells[i]));
    else k1.values.forEach((b, j) => { cells.set(cellId(a, b), String(t.cells[i * k1.values.length + j])); });
  });
  return { mode: t.mode, keys: t.keys.map((k) => ({ field: k.field ?? '', text: (k.values as (string | number)[]).join(', ') })), cells };
}

/** The value a draft stands for, or a reason it can't be saved yet. */
export function valueOf(d: TableDraft): { value: TableValue } | { problem: string } {
  const keys = d.keys.map((k) => ({ ...(k.field.trim() ? { field: k.field.trim() } : {}), values: parseKeyValues(k.text) }));
  if (keys.some((k) => k.values.length === 0)) return { problem: 'Every key needs at least one value.' };
  const p = tableProblem({ keys, mode: d.mode, cells: [] });
  if (p === 'not_ascending') return { problem: 'Number keys must go up.' };
  if (p === 'too_large') return { problem: 'The table is too large.' };
  const cells: number[] = [];
  const [k0, k1] = keys;
  for (const a of k0.values) {
    for (const b of k1 ? k1.values : [undefined]) {
      const raw = d.cells.get(cellId(a, b)) ?? '';
      const n = raw.trim() === '' ? NaN : Number(raw);
      if (!Number.isFinite(n)) return { problem: 'Fill every cell with a number.' };
      cells.push(n);
    }
  }
  const value: TableValue = { keys, mode: d.mode, cells };
  if (tableProblem(value)) return { problem: 'Key values must be all words or all numbers, each once.' };
  return { value };
}

/** Does `next` still hold a cell for every cell of `stored`? (Saving while a key list is half typed must not drop any.) */
export function keepsCells(stored: unknown, next: TableValue): boolean {
  const old = stored === undefined || stored === null ? null : draftOf(stored);
  if (!old) return true;
  const ids = new Set<string>();
  const [k0, k1] = next.keys;
  for (const a of k0.values) for (const b of k1 ? k1.values : [undefined]) ids.add(cellId(a, b));
  for (const id of old.cells.keys()) if (!ids.has(id)) return false;
  return true;
}

/**
 * A table field: its mode, one or two keys (comma-separated values, words or numbers going up, and the field they
 * usually come from) and a grid of number cells. Saved whole when the draft is a valid table, on leaving a box or Enter;
 * in a draft form (instant) a cell or mode change saves at once. A save that would drop stored cells (a key list half
 * typed or cut down) waits for Enter in the key list.
 * A stored value this editor can't read is not shown as an empty grid (which would overwrite it): a warning instead.
 */
function TableInput({ def, value, onSave, instant }: FieldEditorProps) {
  const stored = JSON.stringify(value ?? null);
  const [d, setD] = useState<TableDraft | null>(() => draftOf(value));
  useEffect(() => { setD(draftOf(value)); }, [stored]);
  if (!d) {
    return (
      <div className="wiki-table-field" role="group" aria-label={def.label}>
        <p className="hint" role="status">This value is not a table the editor can read, so it is left as it is (the checks list it).</p>
        <button type="button" className="btn btn-sm" onClick={() => setD(emptyTableDraft())}>Replace it with a new table</button>
      </div>
    );
  }
  const v = valueOf(d);
  /**
   * Saves the draft when it is a valid table. Only a deliberate act on a key list (Enter in it, removing the column key)
   * may drop stored cells; any other save (leaving a box, the mode, a cell) waits while a half-typed key list would drop
   * some, and a hint says how to save without them.
   */
  const commit = (next: TableDraft = d, mayDrop = false) => {
    const r = valueOf(next);
    if ('value' in r && JSON.stringify(r.value) !== stored && (mayDrop || keepsCells(value, r.value))) onSave(r.value);
  };
  /** Instant saves of a cell or the mode; key lists wait for a complete parse that drops no stored cell. */
  const change = (next: TableDraft) => {
    setD(next);
    if (instant) commit(next);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  const onKeyListKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(d, true); } };
  const drops = 'value' in v && !keepsCells(value, v.value);
  const keys = d.keys.map((k) => parseKeyValues(k.text));
  const rows: (string | number)[] = keys[0] ?? [];
  const cols: (string | number | undefined)[] = keys[1] ?? [undefined];
  const setKey = (i: number, patch: Partial<TableDraft['keys'][number]>) => change({ ...d, keys: d.keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const setCell = (id: string, text: string) => { const cells = new Map(d.cells); cells.set(id, text); change({ ...d, cells }); };
  return (
    <div className="wiki-table-field" role="group" aria-label={def.label}>
      <div className="wiki-table-keys">
        <label>Mode{' '}
          <select aria-label={`${def.label} mode`} value={d.mode} onChange={(e) => { const next = { ...d, mode: e.target.value as TableMode }; setD(next); commit(next); }}>
            <option value="exact">exact</option>
            <option value="step">step (largest at or below)</option>
            <option value="linear">linear (between)</option>
          </select>
        </label>
        {d.keys.map((k, i) => (
          <span key={i} className="wiki-table-key">
            <input type="text" aria-label={`${def.label} key ${i + 1} values`} placeholder={i === 0 ? 'Rows: Pierce, Slash or 1, 5, 10' : 'Columns'}
              value={k.text} onChange={(e) => setKey(i, { text: e.target.value })} onBlur={() => commit()} onKeyDown={onKeyListKey} />
            <input type="text" aria-label={`${def.label} key ${i + 1} field`} placeholder="from field (a hint)" value={k.field}
              onChange={(e) => setKey(i, { field: e.target.value })} onBlur={() => commit()} onKeyDown={onKey} />
          </span>
        ))}
        {d.keys.length === 1
          ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setD({ ...d, keys: [...d.keys, { field: '', text: '' }] })}>Add column key</button>
          : <button type="button" className="btn btn-sm btn-ghost" onClick={() => { const next = { ...d, keys: d.keys.slice(0, 1) }; setD(next); commit(next, true); }}>Remove column key</button>}
      </div>
      {rows.length > 0 && (
        <table className="wiki-table-grid">
          {cols[0] !== undefined && (
            <thead><tr><th />{cols.map((c) => <th key={String(c)} scope="col">{String(c)}</th>)}</tr></thead>
          )}
          <tbody>
            {rows.map((r) => (
              <tr key={String(r)}>
                <th scope="row">{String(r)}</th>
                {cols.map((c) => {
                  const id = cellId(r, c);
                  return (
                    <td key={String(c)}>
                      <input type="number" step="any" aria-label={`${def.label} ${String(r)}${c === undefined ? '' : ` × ${String(c)}`}`} value={d.cells.get(id) ?? ''}
                        onChange={(e) => setCell(id, e.target.value)} onBlur={() => commit()} onKeyDown={onKey} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {'problem' in v && <p className="hint" role="status">{v.problem}</p>}
      {drops && (
        <p className="hint wiki-table-drops" role="status">
          These keys leave out numbers that are filled in, so the table is not saved yet. Press Enter in the key list, or{' '}
          <button type="button" className="btn btn-sm" onClick={() => commit(d, true)}>Save without them</button>
        </p>
      )}
      {value != null && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Clear ${def.label}`} onClick={() => onSave(null)}>Clear</button>}
    </div>
  );
}

// ---- Rules and scenarios: read-only here (their editors are the formula editor's) ----

const asList = <T,>(x: unknown): T[] => (Array.isArray(x) ? x as T[] : []);
const roleText = (roles: unknown) => asList<{ name?: unknown; type?: unknown }>(roles).map((r) => `${String(r.name)} (${String(r.type)})`).join(', ') || 'none';

function RuleSummary({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <span className="muted">No rule yet</span>;
  const r = value as Partial<RuleValue>;
  return (
    <div className="wiki-formulas">
      <div>Roles: {roleText(r.roles)}</div>
      {asList<{ name?: unknown; formula?: unknown }>(r.parts).map((p, i) => <div key={i}><code>{String(p.name)} = {String(p.formula)}</code></div>)}
      <div>Result: <code>{String(r.result ?? '')}</code></div>
      {asList(r.examples).length > 0 && <div className="muted">{asList(r.examples).length} saved example{asList(r.examples).length === 1 ? '' : 's'}</div>}
    </div>
  );
}

function ScenarioSummary({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <span className="muted">No scenario yet</span>;
  const s = value as Partial<ScenarioValue>;
  return (
    <div className="wiki-formulas">
      <div>Roles: {roleText(s.roles)}</div>
      {asList<{ name?: unknown; start?: unknown }>(s.state).map((x, i) => <div key={`s${i}`}><code>{String(x.name)} starts at {String(x.start)}</code></div>)}
      {asList<{ name?: unknown; every?: unknown; first?: unknown; do?: unknown }>(s.clocks).map((c, i) => (
        <div key={`c${i}`}><code>{String(c.name)}: {c.first !== undefined ? `first after ${String(c.first)} s, then ` : ''}every {String(c.every)} s: {asList<{ name?: unknown; formula?: unknown }>(c.do).map((u) => `${String(u.name)} = ${String(u.formula)}`).join('; ')}</code></div>
      ))}
      <div>Ends when <code>{String(s.end ?? '')}</code> or at {String(s.cap ?? '')} s</div>
      {asList<{ name?: unknown; formula?: unknown }>(s.measures).map((m, i) => <div key={`m${i}`}><code>measure {String(m.name)} = {String(m.formula)}</code></div>)}
    </div>
  );
}

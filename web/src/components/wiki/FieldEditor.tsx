import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Card, FieldDef } from '../../../../shared/types';
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

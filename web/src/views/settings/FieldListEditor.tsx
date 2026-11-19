import { useEffect, useState } from 'react';
import type { EntryType, FieldDef, FieldKind } from '../../../../shared/types';
import { KEY_RE, keyFromName } from '../../../../shared/wiki';

const KINDS: [FieldKind, string][] = [
  ['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['integer', 'Integer'], ['boolean', 'Yes/no'], ['enum', 'Choice'],
  ['multienum', 'Choices'], ['entry', 'Lore reference'], ['entries', 'Lore references'], ['image', 'Image'], ['color', 'Colour'], ['range', 'Range'],
  ['table', 'Table'], ['rule', 'Rule'], ['scenario', 'Scenario'],
];
/** Entry fields only: a link property can't hold a table, rule or scenario. */
const ENTRY_ONLY = new Set<FieldKind>(['table', 'rule', 'scenario']);
const NUMERIC = new Set<FieldKind>(['number', 'integer', 'range']);
const WITH_OPTIONS = new Set<FieldKind>(['enum', 'multienum']);
const WITH_TARGET = new Set<FieldKind>(['entry', 'entries']);

/** A field in the editor: `fresh` until saved, so its key can still be chosen (and it can still be dropped). `uid` keeps its row across moves. */
type Draft = FieldDef & { uid: string; fresh?: boolean; keyEdited?: boolean; minText: string; maxText: string; optionsText: string };
let nextUid = 0;
const drafts = (fields: FieldDef[]): Draft[] => fields.map((f) => ({
  ...f, uid: `k:${f.key}`, minText: f.min === undefined ? '' : String(f.min), maxText: f.max === undefined ? '' : String(f.max), optionsText: (f.options ?? []).join(', '),
}));
const parseOptions = (t: string): string[] => [...new Set(t.split(',').map((o) => o.trim()).filter(Boolean))];

const numOrUndef = (s: string): number | undefined => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
/** The definition as the server stores it: no empty or meaningless attributes. */
function clean(d: Draft): FieldDef {
  const f: FieldDef = { key: d.key, label: d.label.trim(), kind: d.kind };
  if (d.required) f.required = true;
  if (NUMERIC.has(d.kind)) {
    const min = numOrUndef(d.minText), max = numOrUndef(d.maxText);
    if (min !== undefined) f.min = min;
    if (max !== undefined) f.max = max;
    if (d.unit?.trim()) f.unit = d.unit.trim();
  }
  if (WITH_OPTIONS.has(d.kind)) f.options = parseOptions(d.optionsText);
  if (WITH_TARGET.has(d.kind) && d.target) f.target = d.target;
  if (d.help?.trim()) f.help = d.help.trim();
  if (d.inTable !== undefined) f.inTable = d.inTable;
  if (d.inInfobox !== undefined) f.inInfobox = d.inInfobox;
  if (d.hidden) f.hidden = true;
  return f;
}

/**
 * The fields of a type, or the properties of a link kind: add, reorder, edit, hide/unhide; saved as one list. Saved
 * fields keep their key; a new one takes it from its label unless typed. `taken` are inherited keys it may not reuse.
 */
export function FieldListEditor({ label, fields, types, cap, forProps, taken = [], onSave }: {
  label: string; fields: FieldDef[]; types: EntryType[]; cap: number; forProps?: boolean; taken?: string[]; onSave: (list: FieldDef[]) => Promise<unknown>;
}) {
  const [rows, setRows] = useState<Draft[]>(() => drafts(fields));
  const [busy, setBusy] = useState(false);
  // A changed list (saved here or elsewhere) arrives over the socket: start again from it. Other edits of the type keep the draft.
  const saved = JSON.stringify(fields);
  useEffect(() => setRows(drafts(JSON.parse(saved) as FieldDef[])), [saved]);
  const list = rows.map(clean);
  const dirty = JSON.stringify(list) !== saved;
  const keys = rows.map((r) => r.key);
  const badKey = (r: Draft, i: number) => !KEY_RE.test(r.key) || keys.indexOf(r.key) !== i || taken.includes(r.key);
  const problem = rows.some((r, i) => badKey(r, i) || !r.label.trim() || (numOrUndef(r.minText) ?? -Infinity) > (numOrUndef(r.maxText) ?? Infinity));

  const edit = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...patch };
    // A new field's key follows its label until the key is typed.
    if (r.fresh && patch.label !== undefined && !r.keyEdited) {
      next.key = keyFromName(patch.label || 'field', new Set([...taken, ...rs.filter((_, k) => k !== i).map((x) => x.key)]));
    }
    return next;
  }));
  const move = (i: number, by: number) => setRows((rs) => {
    const j = i + by;
    if (j < 0 || j >= rs.length) return rs;
    const out = [...rs];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });
  const add = () => setRows((rs) => [...rs, { key: keyFromName('field', new Set([...taken, ...rs.map((r) => r.key)])), label: '', kind: 'text', fresh: true, uid: `new:${++nextUid}`, minText: '', maxText: '', optionsText: '' }]);
  const save = async () => {
    setBusy(true);
    try { await onSave(list); } catch { /* toast */ } finally { setBusy(false); }
  };

  return (
    <div className="wiki-fields">
      <ol className="wiki-field-list" aria-label={label}>
        {rows.map((r, i) => (
          <li key={r.uid}>
            <fieldset className={r.hidden ? 'wiki-field-row hidden' : 'wiki-field-row'} aria-label={r.label || r.key}>
              <div className="wiki-field-move">
                <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="icon-btn" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
              </div>
              <label className="wiki-prop"><span>Label</span>
                <input value={r.label} maxLength={200} aria-invalid={!r.label.trim()} onChange={(e) => edit(i, { label: e.target.value })} />
              </label>
              <label className="wiki-prop"><span>Key</span>
                {r.fresh
                  ? <input value={r.key} maxLength={64} aria-invalid={badKey(r, i)} onChange={(e) => edit(i, { key: e.target.value, keyEdited: true })} />
                  : <input value={r.key} readOnly aria-readonly />}
              </label>
              <label className="wiki-prop"><span>Kind</span>
                <select value={r.kind} onChange={(e) => edit(i, { kind: e.target.value as FieldKind })}>
                  {KINDS.filter(([k]) => !forProps || !ENTRY_ONLY.has(k)).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
                </select>
              </label>
              {NUMERIC.has(r.kind) && <>
                <label className="wiki-prop"><span>Min</span><input type="number" value={r.minText} onChange={(e) => edit(i, { minText: e.target.value })} /></label>
                <label className="wiki-prop"><span>Max</span><input type="number" value={r.maxText} onChange={(e) => edit(i, { maxText: e.target.value })} /></label>
                <label className="wiki-prop"><span>Unit</span><input value={r.unit ?? ''} maxLength={32} onChange={(e) => edit(i, { unit: e.target.value })} /></label>
              </>}
              {WITH_OPTIONS.has(r.kind) && (
                <label className="wiki-prop"><span>Options (comma separated)</span>
                  <input value={r.optionsText} onChange={(e) => edit(i, { optionsText: e.target.value })} />
                </label>
              )}
              {WITH_TARGET.has(r.kind) && (
                <label className="wiki-prop"><span>Target type</span>
                  <select value={r.target ?? ''} onChange={(e) => edit(i, { target: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {types.map((t) => <option key={t.id} value={t.key}>{t.name}</option>)}
                    {r.target && !types.some((t) => t.key === r.target) && <option value={r.target}>{r.target} (missing)</option>}
                  </select>
                </label>
              )}
              {(r.kind === 'table' || r.kind === 'rule') && (
                <p className="hint wiki-prop-help">
                  {r.kind === 'table'
                    ? <>Formulas name the table by its entry's key: <code>table(key, …)</code>. When the type has two or more table fields, each is named <code>key.field</code> instead, so adding a second table field renames the first. A key's "from field" is a hint for people and is not checked.</>
                    : <>Formulas call the rule by its entry's key: <code>key(role, …)</code>. When the type has two or more rule fields, each is called <code>key.field(role, …)</code> instead, so adding a second rule field renames the first.</>}
                </p>
              )}
              <label className="wiki-check"><input type="checkbox" checked={!!r.required} onChange={(e) => edit(i, { required: e.target.checked })} /> Required</label>
              {!forProps && <>
                <label className="wiki-check"><input type="checkbox" checked={!!r.inTable} onChange={(e) => edit(i, { inTable: e.target.checked })} /> In table</label>
                <label className="wiki-check"><input type="checkbox" checked={r.inInfobox !== false} onChange={(e) => edit(i, { inInfobox: e.target.checked })} /> In infobox</label>
              </>}
              {r.fresh
                ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Drop</button>
                : <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit(i, { hidden: !r.hidden })}>{r.hidden ? 'Unhide' : 'Hide'}</button>}
            </fieldset>
          </li>
        ))}
      </ol>
      {!rows.length && <p className="muted">None yet.</p>}
      <div className="row">
        <button type="button" className="btn" disabled={rows.length >= cap} onClick={add}>{forProps ? 'Add property' : 'Add field'}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty || problem} onClick={save}>{forProps ? 'Save properties' : 'Save fields'}</button>
      </div>
      {rows.length >= cap && <p className="hint">That is the most a {forProps ? 'link kind' : 'type'} can have ({cap}).</p>}
    </div>
  );
}

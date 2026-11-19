// The editors of a wiki type (its template and settings), the link kinds and the starter pack; the Wiki's Types page
// (web/src/views/wiki/WikiTypesPage.tsx) and its Link kinds part lay them out.

import { useEffect, useMemo, useState } from 'react';
import type { EntryType, LinkKind, Project } from '../../../../shared/types';
import { typeChain } from '../../../../shared/wiki';
import { familyOf } from '../../../../shared/wikiFamilies';
import { FieldListEditor } from './FieldListEditor';
import { ApiError, dispatch } from '../../api';
import { store, useStore } from '../../store';
import { typeUsage, unusedValueCount, type TypeUsage } from '../../wiki';
import { TemplateEditor } from '../wiki/TemplateEditor';

/** Caps the server enforces (server/commands/wiki.ts WIKI_LIMITS). */
const FIELDS_CAP = 100;
const PROPS_CAP = 20;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The project's link kinds (drops, crafts, …) with their editor: the Wiki's Link kinds part. */
export function LinkKinds({ project, types }: { project: Project; types: EntryType[] }) {
  const linkKinds = useStore((s) => s.linkKinds);
  const kinds = useMemo(() => [...linkKinds.values()].filter((k) => k.projectId === project.id).sort((a, b) => a.label.localeCompare(b.label)), [linkKinds, project.id]);
  const [kindId, setKindId] = useState<string | null>(null);
  const kind = kindId ? linkKinds.get(kindId) : undefined;
  return (
    <>
      <h3 className="sub">Link kinds</h3>
      <div className="wiki-types-pick">
        <ul className="wiki-types-list" aria-label="Link kinds">
          {kinds.map((k) => (
            <li key={k.id}>
              <button type="button" className={k.id === kindId ? 'wiki-type-btn on' : 'wiki-type-btn'} aria-pressed={k.id === kindId}
                onClick={() => setKindId(k.id === kindId ? null : k.id)}>
                <span className="wiki-type-name">{k.label} / {k.reverseLabel}</span>
              </button>
            </li>
          ))}
          {!kinds.length && <li className="muted">No link kinds yet.</li>}
        </ul>
        <NewKind project={project} onAdded={setKindId} />
      </div>
      {kind && <KindEditor key={kind.id} kind={kind} types={types} onDeleted={() => setKindId(null)} />}
    </>
  );
}

export function StarterPack({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const add = async () => {
    setBusy(true);
    try {
      const r = await dispatch<{ typesAdded: number; kindsAdded: number }>('wiki', 'addStarterPack', { projectId: project.id });
      setNote(r.typesAdded || r.kindsAdded ? `Added ${plural(r.typesAdded, 'type')} and ${plural(r.kindsAdded, 'link kind')}.` : 'Everything in the pack is already here.');
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="danger-zone">
      <div>
        <strong>Game starter pack</strong>
        <p className="hint">Items, creatures, locations, recipes, missions and more, with link kinds such as drops and sells. Types and kinds you already have are kept as they are.</p>
        {note && <p className="hint" role="status">{note}</p>}
      </div>
      <button type="button" className="btn" disabled={busy} onClick={add}>Add the game starter pack</button>
    </div>
  );
}

function NewKind({ project, onAdded }: { project: Project; onAdded: (id: string) => void }) {
  const [label, setLabel] = useState('');
  const [reverse, setReverse] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!label.trim() || !reverse.trim() || busy) return;
    setBusy(true);
    try {
      const r = await dispatch<{ id: string }>('wiki', 'createLinkKind', { projectId: project.id, label: label.trim(), reverseLabel: reverse.trim(), fromTypes: [], toTypes: [] });
      setLabel(''); setReverse(''); onAdded(r.id);
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="row wiki-types-new">
      <input aria-label="New link label" placeholder="label, e.g. drops" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
      <input aria-label="New link reverse label" placeholder="reverse, e.g. dropped by" value={reverse} maxLength={200} onChange={(e) => setReverse(e.target.value)} />
      <button type="button" className="btn" disabled={busy || !label.trim() || !reverse.trim()} onClick={add}>Add link kind</button>
    </div>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** "3 entries, 1 link kind": what still uses a type; '' when nothing does. */
function usageText(u: TypeUsage): string {
  return [
    u.entries && plural(u.entries, 'entry', 'entries'), u.childTypes && plural(u.childTypes, 'child type'),
    u.fieldTargets && `${plural(u.fieldTargets, 'field')} of other types`, u.linkKinds && plural(u.linkKinds, 'link kind'),
  ].filter(Boolean).join(', ');
}

/** Local edits follow a stored value that changes elsewhere (another manager, another tab). */
function useSynced<T>(stored: T): [T, (v: T) => void] {
  const [v, set] = useState(stored);
  const key = JSON.stringify(stored);
  useEffect(() => set(JSON.parse(key) as T), [key]);
  return [v, set];
}

/** Links of this kind in the store, for the delete confirm. */
function linkCount(kind: LinkKind): number {
  let n = 0;
  for (const l of store.get().entryLinks.values()) if (l.projectId === kind.projectId && l.kindKey === kind.key) n++;
  return n;
}

/** A type's name, key, family, parent, icon and colour, and deleting it (the Settings tab of a type in the Wiki's Types). */
export function TypeSettings({ type, types, onDeleted }: { type: EntryType; types: EntryType[]; onDeleted: () => void }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const allFamilies = useStore((s) => s.entryFamilies);
  const families = useMemo(() => [...allFamilies.values()].filter((f) => f.projectId === type.projectId).sort((a, b) => a.sortIndex - b.sortIndex), [allFamilies, type.projectId]);
  const [family, setFamily] = useSynced(type.familyId ?? '');
  const [parent, setParent] = useSynced(type.parentTypeId ?? '');
  const rootFamily = useStore((s) => (parent ? familyOf(s.entryTypes, s.entryFamilies, parent) : null));
  const [name, setName] = useSynced(type.name);
  const [icon, setIcon] = useSynced(type.icon ?? '');
  const [color, setColor] = useSynced(type.color ?? '');
  const [busy, setBusy] = useState(false);
  /** The delete confirm is open; it shows what the store says still uses the type. */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const usage = useStore((s) => (confirmDelete ? usageText(typeUsage(s, type)) : ''));
  const [inUse, setInUse] = useState<string | null>(null);
  // Not itself, nor a type under it (that would be a loop).
  const parents = types.filter((t) => t.id !== type.id && !typeChain(entryTypes, t.id).some((x) => x.id === type.id));
  // A kind sits in its root's family: the family is set on root types only.
  const familyDirty = !parent && family !== (type.familyId ?? '');
  const dirty = name.trim() !== type.name || icon !== (type.icon ?? '') || color !== (type.color ?? '') || parent !== (type.parentTypeId ?? '') || familyDirty;
  const colorOk = color === '' || HEX.test(color);

  const save = async () => {
    setBusy(true);
    try {
      await dispatch('wiki', 'updateType', {
        id: type.id, name: name.trim(), icon: icon.trim() || null, color: color || null, parentTypeId: parent || null,
        ...(parent ? {} : { familyId: family || null }),
      });
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await dispatch('wiki', 'deleteType', { id: type.id });
      onDeleted();
    } catch (e) {
      // The server sees what the store may not (another person's newest edits): show its counts.
      if (e instanceof ApiError && e.code === 'type_in_use') setInUse(`${type.name} is still used by ${usageText(e.data as TypeUsage)}. Retype, move or edit those first.`);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="wiki-types-grid">
        <label className="field"><span>Name</span><input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
        <div className="field">
          <label htmlFor={`fam-${type.id}`}>Family</label>
          {parent ? (
            // A kind shows the family it sits in (its root's), read-only.
            <select id={`fam-${type.id}`} value="" disabled><option value="">{rootFamily?.name ?? 'No family'}</option></select>
          ) : (
            <select id={`fam-${type.id}`} value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">No family</option>
              {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          {parent && <span className="hint">A kind of another type sits in that type's family.</span>}
        </div>
        <div className="field">
          <label htmlFor={`parent-${type.id}`}>Kind of</label>
          <select id={`parent-${type.id}`} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">None (a type of its own)</option>
            {parents.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="hint">A kind gets every field of the type it is a kind of.</span>
        </div>
        <div className="field">
          <label htmlFor={`key-${type.id}`}>Key</label>
          <input id={`key-${type.id}`} value={type.key} readOnly aria-readonly aria-describedby={`key-hint-${type.id}`} />
          <span className="hint" id={`key-hint-${type.id}`}>Set when made, used by exports.</span>
        </div>
        <label className="field"><span>Icon</span><input value={icon} maxLength={64} placeholder="an emoji" onChange={(e) => setIcon(e.target.value)} /></label>
        <label className="field"><span>Colour</span>
          <input value={color} maxLength={7} placeholder="#rrggbb" aria-invalid={!colorOk} onChange={(e) => setColor(e.target.value.trim())} />
        </label>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty || !name.trim() || !colorOk} onClick={save}>Save type</button>
        {!confirmDelete && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { setInUse(null); setConfirmDelete(true); }}>Delete type</button>}
      </div>
      {confirmDelete && (
        <div className="confirm-box" role="group" aria-label="Confirm delete type">
          {usage
            ? <p>{type.name} can't be deleted while it is used by {usage}. Retype, move or edit those first.</p>
            : <p>Delete the type {type.name} with its {plural(type.fields.length, 'field definition')}? Trashed entries of this type come back as untyped lore if restored. This can't be undone.</p>}
          {inUse && <p className="hint" role="alert">{inUse}</p>}
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => { setConfirmDelete(false); setInUse(null); }}>Keep type</button>
            <button type="button" className="btn btn-danger" disabled={busy || !!usage} onClick={remove}>Delete forever</button>
          </div>
        </div>
      )}
    </>
  );
}

/** What a new entry of the type starts with: page headings, starting values and fields (the type's Template tab). */
export function TypeTemplate({ project, type, types }: { project: Project; type: EntryType; types: EntryType[] }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const ancestors = type.parentTypeId ? typeChain(entryTypes, type.parentTypeId) : [];
  const inherited = ancestors.flatMap((t) => t.fields.map((f) => f.key));
  return (
    <>
      <TemplateEditor project={project} type={type} />

      <h4 className="sub">Starting values</h4>
      <p className="hint">Named sets of values and links a new {type.name} can start from (under its template).</p>
      {type.templates.length ? (
        <ul className="wiki-types-list" aria-label="Templates">
          {type.templates.map((t, i) => (
            <li key={i} className="wk-picked">
              <span>{t.name}</span>
              <button type="button" className="btn btn-sm btn-ghost" aria-label={`Delete template ${t.name}`}
                onClick={() => void dispatch('wiki', 'updateType', { id: type.id, templates: type.templates.filter((_, j) => j !== i) }).catch(() => {})}>Delete</button>
            </li>
          ))}
        </ul>
      ) : <p className="hint">None yet. Make a {type.name} in the Wiki and choose "Save these values as a template".</p>}

      <h4 className="sub">Fields</h4>
      {ancestors.map((a) => {
        const shown = a.fields.filter((f) => !f.hidden);
        return shown.length > 0 && (
          <div key={a.id} className="wiki-inherited" role="group" aria-label={`Fields from ${a.name}`}>
            <span className="hint">From {a.name}:</span>
            <ul>{shown.map((f) => <li key={f.key} className="badge">{f.label}</li>)}</ul>
          </div>
        );
      })}
      <FieldListEditor label="Fields" fields={type.fields} types={types} cap={FIELDS_CAP} taken={inherited}
        onSave={(fields) => dispatch('wiki', 'updateType', { id: type.id, fields })} />
      <PruneValues type={type} />
    </>
  );
}

/** "Remove unused values": drops the values of hidden or removed fields from the type's entries, after a confirm. */
function PruneValues({ type }: { type: EntryType }) {
  const [count, setCount] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const run = async () => {
    setBusy(true);
    let total = 0;
    try {
      // The server works in batches: call again until it says done.
      for (;;) {
        const r = await dispatch<{ entriesChanged: number; done: boolean }>('wiki', 'pruneValues', { typeId: type.id });
        total += r.entriesChanged;
        // A batch that changed nothing would never finish: stop rather than spin.
        if (r.done || r.entriesChanged === 0) break;
      }
      setNote(`Removed unused values from ${plural(total, 'entry', 'entries')}.`);
    } catch {
      if (total) setNote(`Removed unused values from ${plural(total, 'entry', 'entries')} before an error.`);
    } finally { setBusy(false); setConfirm(false); }
  };
  return (
    <div className="wiki-prune">
      {!confirm && <button type="button" className="btn" disabled={busy} onClick={() => { setNote(''); setCount(unusedValueCount(store.get(), type.id)); setConfirm(true); }}>Remove unused values</button>}
      {confirm && (
        <div className="confirm-box" role="group" aria-label="Confirm remove unused values">
          <p>{count
            ? `${plural(count, 'entry', 'entries')} of ${type.name} hold values of hidden or removed fields. Remove those values? This can't be undone.`
            : `No visible ${type.name} entry holds values of hidden or removed fields. Trashed ones may still; remove theirs? This can't be undone.`}</p>
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>Keep values</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={run}>Remove values</button>
          </div>
        </div>
      )}
      {note && <p className="hint" role="status">{note}</p>}
    </div>
  );
}

function KindEditor({ kind, types, onDeleted }: { kind: LinkKind; types: EntryType[]; onDeleted: () => void }) {
  const [links, setLinks] = useState(0);
  const [label, setLabel] = useSynced(kind.label);
  const [reverse, setReverse] = useSynced(kind.reverseLabel);
  const [from, setFrom] = useSynced(kind.fromTypes);
  const [to, setTo] = useSynced(kind.toTypes);
  const [sumProp, setSumProp] = useSynced(kind.sumRule?.prop ?? '');
  const [sumMax, setSumMax] = useSynced(kind.sumRule ? String(kind.sumRule.max) : '');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const numberProps = kind.props.filter((p) => !p.hidden && (p.kind === 'number' || p.kind === 'integer'));
  const max = Number(sumMax);
  const sumOk = !sumProp || (numberProps.some((p) => p.key === sumProp) && sumMax.trim() !== '' && Number.isFinite(max));
  const sumRule = sumProp && sumOk ? { prop: sumProp, max } : null;
  const dirty = label.trim() !== kind.label || reverse.trim() !== kind.reverseLabel || JSON.stringify(from) !== JSON.stringify(kind.fromTypes)
    || JSON.stringify(to) !== JSON.stringify(kind.toTypes) || JSON.stringify(sumRule) !== JSON.stringify(kind.sumRule);
  // Keys of types that no longer exist stay listed, so saving never drops them silently.
  const options = (sel: string[]) => [...types.map((t) => ({ key: t.key, name: t.name })), ...sel.filter((k) => !types.some((t) => t.key === k)).map((k) => ({ key: k, name: `${k} (missing)` }))];
  const multi = (aria: string, sel: string[], set: (v: string[]) => void) => (
    <select multiple aria-label={aria} value={sel} size={Math.min(8, Math.max(3, types.length))}
      onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))}>
      {options(sel).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
    </select>
  );

  const save = async () => {
    setBusy(true);
    try {
      await dispatch('wiki', 'updateLinkKind', { id: kind.id, label: label.trim(), reverseLabel: reverse.trim(), fromTypes: from, toTypes: to, sumRule });
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await dispatch('wiki', 'deleteLinkKind', { id: kind.id });
      onDeleted();
    } catch { setBusy(false); }
  };

  return (
    <section className="wiki-type-editor" aria-label={`Link kind ${kind.label}`}>
      <div className="wiki-types-grid">
        <label className="field"><span>Label</span><input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="field"><span>Reverse label</span><input value={reverse} maxLength={200} onChange={(e) => setReverse(e.target.value)} /></label>
        <label className="field"><span>Key</span><input value={kind.key} readOnly aria-readonly /></label>
        <div className="field"><span>From types (none: any)</span>{multi('From types', from, setFrom)}</div>
        <div className="field"><span>To types (none: any)</span>{multi('To types', to, setTo)}</div>
        <div className="field"><span>Sum rule</span>
          <div className="row">
            <select aria-label="Sum rule property" value={sumProp} onChange={(e) => setSumProp(e.target.value)}>
              <option value="">None</option>
              {numberProps.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              {sumProp && !numberProps.some((p) => p.key === sumProp) && <option value={sumProp}>{sumProp} (hidden or not a number: pick another)</option>}
            </select>
            {sumProp && <>≤ <input type="number" aria-label="Sum rule maximum" value={sumMax} aria-invalid={!sumOk} onChange={(e) => setSumMax(e.target.value)} /></>}
          </div>
          <span className="hint">The property of all links of this kind from one entry must not add up to more.</span>
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty || !label.trim() || !reverse.trim() || !sumOk} onClick={save}>Save link kind</button>
        {!confirm && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { setLinks(linkCount(kind)); setConfirm(true); }}>Delete link kind</button>}
      </div>
      {confirm && (
        <div className="confirm-box" role="group" aria-label="Confirm delete link kind">
          <p>{links ? `Deleting ${kind.label} also deletes its ${plural(links, 'link')}.` : `No links use ${kind.label}.`} This can't be undone.</p>
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>Keep it</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>Delete forever</button>
          </div>
        </div>
      )}

      <h4 className="sub">Properties</h4>
      <FieldListEditor label="Properties" fields={kind.props} types={types} cap={PROPS_CAP} forProps
        onSave={(props) => dispatch('wiki', 'updateLinkKind', { id: kind.id, props })} />
    </section>
  );
}

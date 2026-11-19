// The Wiki's Types: a project's entry types as a tree of families (each folds), kinds under their type, a picture per
// row, search and "+"; beside it the type itself: its picture, path, name and key, and the tabs Template and Settings.
// The redesign preview's renderTypes, in Questlog's look.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EntryFamily, EntryType, Project, TypePicture as Picture } from '../../../../shared/types';
import { fieldsOf, typeChain } from '../../../../shared/wiki';
import { PICTURE_STYLES, familyGroups, familyOf, type FamilyGroup, type PictureStyle } from '../../../../shared/wikiFamilies';
import { STARTER_FAMILIES, starterUpdateNeeded } from '../../../../shared/templates/gameStarterPack';
import { pageOf } from '../../../../shared/blocks';
import { dispatch } from '../../api';
import { canManageProject, useStore } from '../../store';
import { Link, navigate } from '../../router';
import { usePageNavigate } from '../HomePane';
import { Icon } from '../../components/icons';
import { TypePicture, usePictureStyle } from '../../components/wiki/TypePicture';
import { campaignLore, campaignTypes, typeCounts, typesPath } from '../../wiki';
import { StarterPack, TypeSettings, TypeTemplate } from '../settings/WikiTypes';
import { COVER_MAX_BYTES, COVER_MIMES } from '../../../../shared/covers';
import { showToast } from '../../toast';
import type { Asset } from '../../../../shared/assets';
import { assetAsTypePicture, pictureUrl, toastError, useAssets } from '../../assets';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The "No family" fold, in the remembered open set. */
const NONE = 'none';
const STYLE_NAMES: Record<PictureStyle, string> = { dusk: 'Dusk', dawn: 'Dawn', night: 'Night', flat: 'Flat' };
const PACK_KEYS = new Set(STARTER_FAMILIES.flatMap((f) => f.types));
/** At most this many asset pictures in the picture menu at once (search finds the rest). */
const ASSET_PICKS = 24;

// Per browser and project: which families are open, and whether the starter families offer was put away.
const openKey = (projectId: string) => `jt:wikiTypesOpen:${projectId}`;
const OFFER_KEY = 'jt:wikiFamiliesOfferDone';
const UPDATE_OFFER_KEY = 'jt:wikiStarterUpdateDone';
function readList(key: string): string[] | null {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null; } catch { return null; }
}
const writeList = (key: string, list: string[]) => { try { localStorage.setItem(key, JSON.stringify(list.slice(-100))); } catch { /* not remembered */ } };

function useProjectFamilies(projectId: string): EntryFamily[] {
  const all = useStore((s) => s.entryFamilies);
  return useMemo(() => [...all.values()].filter((f) => f.projectId === projectId).sort((a, b) => a.sortIndex - b.sortIndex), [all, projectId]);
}

export function WikiTypesPage({ project, typeKey }: { project: Project; typeKey: string | null }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const manage = useStore((s) => canManageProject(s, project));
  const types = useMemo(() => campaignTypes(entryTypes, project.id), [entryTypes, project.id]);
  const families = useProjectFamilies(project.id);
  const type = typeKey ? types.find((t) => t.key === typeKey) : undefined;
  const first = useMemo(() => familyGroups(types, families, '').flatMap((g) => g.roots)[0]?.type, [types, families]);
  // /view/types opens the first type of the tree.
  useEffect(() => { if (!typeKey && first) navigate(typesPath(project.seq, first.key), { replace: true }); }, [typeKey, first?.key, project.seq]);

  return (
    <div className="tp">
      <TypeTree project={project} types={types} families={families} current={type ?? null} manage={manage} />
      <section className="tp-detail" aria-label={type ? type.name : 'Types'}>
        {type ? <TypeDetail key={type.id} project={project} type={type} types={types} manage={manage} />
          : typeKey ? <div className="empty"><h2>Entity type not found</h2><p className="muted">No entity type with that key in {project.name}.</p></div>
          : !types.length ? (
            <div className="tp-empty">
              <h2>No types yet</h2>
              <p className="muted">Types are the kinds of entries in this wiki: characters, items, places and so on.</p>
              {manage ? <StarterPack project={project} /> : <p className="muted">Only people who manage this project can add types.</p>}
            </div>
          ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- the tree

function TypeTree({ project, types, families, current, manage }: { project: Project; types: EntryType[]; families: EntryFamily[]; current: EntryType | null; manage: boolean }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [famPanel, setFamPanel] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set(readList(openKey(project.id)) ?? []));
  const groups = useMemo(() => familyGroups(types, families, q), [types, families, q]);
  const currentFamily = current ? (typeChain(entryTypes, current.id)[0]?.familyId ?? NONE) : null;
  const famKey = (g: FamilyGroup) => g.family?.id ?? NONE;
  // The open type's family is always open (also after making a type or moving it to another family).
  useEffect(() => {
    if (currentFamily && !open.has(currentFamily)) setOpen((o) => new Set([...o, currentFamily]));
  }, [currentFamily]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { writeList(openKey(project.id), [...open]); }, [open, project.id]);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const needle = q.trim().toLowerCase();
  const mark = (name: string) => {
    const i = needle ? name.toLowerCase().indexOf(needle) : -1;
    return i < 0 ? name : <>{name.slice(0, i)}<mark>{name.slice(i, i + needle.length)}</mark>{name.slice(i + needle.length)}</>;
  };
  const row = (t: EntryType, depth: number, kinds?: number) => (
    <Link key={t.id} href={typesPath(project.seq, t.key)} className={depth ? 'tp-row child' : 'tp-row'} style={depth > 1 ? { paddingLeft: 8 + depth * 22 } : undefined}
      aria-current={t.id === current?.id ? 'page' : undefined}>
      <TypePicture type={t} size="thumb" />
      <span className="nm">{mark(t.name)}</span>
      {kinds ? <span className="sub">{plural(kinds, 'kind')}</span> : null}
    </Link>
  );
  const depthOf = (t: EntryType) => typeChain(entryTypes, t.id).length - 1;

  return (
    <section className="tp-tree" aria-label="Entry types">
      <div className="tp-head">
        <h2>Types</h2>
        <span className="muted">{plural(types.length, 'type')}</span>
        {manage && (
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={famPanel} onClick={() => setFamPanel((v) => !v)}>Families</button>
        )}
      </div>
      <div className="tp-find">
        <input type="search" placeholder="Find a type" aria-label="Find a type" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        {manage && (
          <button type="button" className="icon-btn tp-add" aria-expanded={adding} aria-label="New type" title="New type" onClick={() => setAdding((v) => !v)}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      <div className="tp-list">
        {manage && <StarterFamiliesOffer project={project} types={types} />}
        {manage && <StarterTypesOffer project={project} types={types} />}
        {famPanel && manage && <FamiliesPanel project={project} families={families} types={types} />}
        {adding && manage && <NewTypeForm project={project} families={families} initialName={q.trim()} onDone={() => setAdding(false)} />}
        {groups.map((g) => {
          const isOpen = !!needle || open.has(famKey(g));
          const name = g.family?.name ?? 'No family';
          return (
            <div key={famKey(g)} className="tp-group" role="group" aria-label={name}>
              <button type="button" className="tp-fam" aria-expanded={isOpen} disabled={!!needle} onClick={() => toggle(famKey(g))}>
                <span className="tp-chev" aria-hidden><Icon name="chevron" size={12} /></span>
                {g.family && <span className="tp-swatch" style={{ background: g.family.color }} aria-hidden />}
                <span>{name}</span><span className="ct">{g.count}</span>
              </button>
              {isOpen && (g.roots.length ? g.roots.map((r) => (
                <div key={r.type.id}>
                  {row(r.type, 0, needle ? 0 : r.kinds.length)}
                  {r.kinds.map((k) => row(k, depthOf(k)))}
                </div>
              )) : <p className="tp-note tp-empty-fam">No types in {name} yet.</p>)}
            </div>
          );
        })}
        {needle && !groups.length && <p className="tp-note">No type called <b>{q.trim()}</b>.{manage && <> Press <b>+</b> to make it.</>}</p>}
        {!needle && !types.length && <p className="tp-note">No types yet.</p>}
      </div>
    </section>
  );
}

/** "+": a name and a family; the new type opens. */
function NewTypeForm({ project, families, initialName, onDone }: { project: Project; families: EntryFamily[]; initialName: string; onDone: () => void }) {
  const go = usePageNavigate(); // in the pane beside Home, it stays there
  const [name, setName] = useState(initialName);
  const [family, setFamily] = useState(families[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  // The type arrives over the socket; open it once it is in the store.
  const made = useStore((s) => (pending ? s.entryTypes.get(pending) : undefined));
  useEffect(() => { if (made) { onDone(); go(typesPath(project.seq, made.key)); } }, [made]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await dispatch<{ id: string }>('wiki', 'createType', { projectId: project.id, name: name.trim(), familyId: family || null });
      setPending(r.id);
    } catch { setBusy(false); }
  };
  return (
    <form className="tp-new" aria-label="New type" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input autoFocus required maxLength={200} placeholder="Name, e.g. Spell" aria-label="Name of the new type" value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="Family" value={family} onChange={(e) => setFamily(e.target.value)}>
        {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        <option value="">No family</option>
      </select>
      <div className="row2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>Make type</button>
      </div>
    </form>
  );
}

/**
 * For projects whose types came before families: offer the starter pack's families for the pack's types that have none.
 * Never applied by itself; "Not now" puts it away in this browser.
 */
function StarterFamiliesOffer({ project, types }: { project: Project; types: EntryType[] }) {
  const [done, setDone] = useState(() => (readList(OFFER_KEY) ?? []).includes(project.id));
  const [busy, setBusy] = useState(false);
  const fits = types.filter((t) => !t.parentTypeId && !t.familyId && PACK_KEYS.has(t.key));
  if (done || !fits.length) return null;
  const names = STARTER_FAMILIES.filter((f) => fits.some((t) => f.types.includes(t.key))).map((f) => f.name);
  const putAway = () => { writeList(OFFER_KEY, [...(readList(OFFER_KEY) ?? []), project.id]); setDone(true); };
  const group = async () => {
    setBusy(true);
    try { await dispatch('wiki', 'addStarterFamilies', { projectId: project.id }); putAway(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="tp-offer" role="region" aria-label="Group types into families">
      <p><strong>Group your types into families?</strong> {plural(fits.length, 'type')} from the starter pack {fits.length === 1 ? 'fits' : 'fit'} {names.join(', ')}. Nothing else changes.</p>
      <div className="row2">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={putAway}>Not now</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={group}>Group them</button>
      </div>
    </div>
  );
}

/**
 * For projects that took the starter pack before it was made for a co-op survival game (redesign decision 12): offer
 * the new fields and pages. Never applied by itself; updating adds and hides fields, never deletes one or a value.
 */
function StarterTypesOffer({ project, types }: { project: Project; types: EntryType[] }) {
  const [done, setDone] = useState(() => (readList(UPDATE_OFFER_KEY) ?? []).includes(project.id));
  const [busy, setBusy] = useState(false);
  if (done || !starterUpdateNeeded(types)) return null;
  const putAway = () => { writeList(UPDATE_OFFER_KEY, [...(readList(UPDATE_OFFER_KEY) ?? []), project.id]); setDone(true); };
  const update = async () => {
    setBusy(true);
    try { await dispatch('wiki', 'updateStarterTypes', { projectId: project.id }); putAway(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="tp-offer" role="region" aria-label="Update the starter types">
      <p><strong>Update the starter types?</strong> The Character, Creature, Item, Quest, Place and Faction that came with the starter pack get new
        fields for a co-op survival game (Found in, Spawns in, Tier, Biome…) and, if they have no template yet, a page of blocks (Attacks and Drops
        tables…) that keeps their headings. Their current fields stay as they are, shown and exported; no field, value or text is removed.</p>
      <div className="row2">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={putAway}>Not now</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={update}>Update them</button>
      </div>
    </div>
  );
}

/** Families: name, colour, order, delete (its types move to No family), and a new one. */
function FamiliesPanel({ project, families, types }: { project: Project; families: EntryFamily[]; types: EntryType[] }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4f72c9');
  const [confirm, setConfirm] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => { void fn().catch(() => { /* toast */ }); };
  const add = () => {
    if (!name.trim()) return;
    run(async () => { await dispatch('wiki', 'createFamily', { projectId: project.id, name: name.trim(), color }); setName(''); });
  };
  return (
    <div className="tp-fams" role="region" aria-label="Families">
      <p className="tp-note">Families fold related types. Deleting one moves its types to No family; no type is deleted.</p>
      <ul>
        {families.map((f, i) => {
          const n = types.filter((t) => t.familyId === f.id).length;
          return (
            <li key={f.id}>
              <div className="tp-fam-edit">
                <FamilyColor family={f} />
                <FamilyName family={f} />
                <button type="button" className="icon-btn" aria-label={`Move ${f.name} up`} disabled={i === 0}
                  onClick={() => run(() => dispatch('wiki', 'moveFamily', { id: f.id, before: families[i - 1].id }))}><Icon name="up" size={14} /></button>
                <button type="button" className="icon-btn" aria-label={`Move ${f.name} down`} disabled={i === families.length - 1}
                  onClick={() => run(() => dispatch('wiki', 'moveFamily', { id: f.id, before: families[i + 2]?.id ?? null }))}><Icon name="down" size={14} /></button>
                <button type="button" className="icon-btn" aria-label={`Delete ${f.name}`} onClick={() => setConfirm(f.id)}><Icon name="trash" size={14} /></button>
              </div>
              {confirm === f.id && (
                <div className="confirm-box" role="group" aria-label={`Confirm delete ${f.name}`}>
                  <p>Delete the family {f.name}?{n === 1 ? ' Its type moves to No family.' : n ? ` Its ${n} types move to No family.` : ''} No type is deleted.</p>
                  <div className="row">
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>Keep it</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => { setConfirm(null); run(() => dispatch('wiki', 'deleteFamily', { id: f.id })); }}>Delete family</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="tp-fam-edit">
        <input type="color" aria-label="Colour of the new family" value={color} onChange={(e) => setColor(e.target.value)} />
        <input maxLength={80} placeholder="New family, e.g. Vehicles" aria-label="Name of the new family" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn btn-sm" disabled={!name.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

/**
 * A family's colour. The picker fires input events while it is dragged: those only change the swatch here; the colour
 * is saved once, on the native change event (the picker closed), so saves never race each other.
 */
function FamilyColor({ family }: { family: EntryFamily }) {
  const [v, setV] = useState(family.color);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setV(family.color), [family.color]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const save = () => {
      if (el.value.toLowerCase() === family.color.toLowerCase()) return;
      void dispatch('wiki', 'updateFamily', { id: family.id, color: el.value }).catch(() => setV(family.color));
    };
    el.addEventListener('change', save);
    return () => el.removeEventListener('change', save);
  }, [family.id, family.color]);
  return <input ref={ref} type="color" aria-label={`Colour of ${family.name}`} value={v} onChange={(e) => setV(e.target.value)} />;
}

/** A family's name, saved when it loses focus or on Enter. */
function FamilyName({ family }: { family: EntryFamily }) {
  const [v, setV] = useState(family.name);
  useEffect(() => setV(family.name), [family.name]);
  const save = () => {
    const n = v.trim();
    if (!n || n === family.name) { setV(family.name); return; }
    void dispatch('wiki', 'updateFamily', { id: family.id, name: n }).catch(() => setV(family.name));
  };
  return <input maxLength={80} aria-label={`Name of ${family.name}`} value={v} onChange={(e) => setV(e.target.value)} onBlur={save}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />;
}

// ---------------------------------------------------------------- the type

function TypeDetail({ project, type, types, manage }: { project: Project; type: EntryType; types: EntryType[]; manage: boolean }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const family = useStore((s) => familyOf(s.entryTypes, s.entryFamilies, type.id));
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const counts = useMemo(() => typeCounts(campaignLore(cards.values(), project.id, decks), entryTypes).byType, [cards, decks, project.id, entryTypes]);
  const [tab, setTab] = useState<'template' | 'settings'>('template');
  const tabsId = useId();
  const chain = typeChain(entryTypes, type.id);
  const kinds = types.filter((t) => t.parentTypeId === type.id);
  const fields = fieldsOf(entryTypes, type.id).filter((f) => !f.hidden);
  const entries = counts.get(type.id) ?? 0;
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = tab === 'template' ? 'settings' : 'template';
    setTab(n);
    document.getElementById(`${tabsId}-${n}`)?.focus();
  };
  return (
    <>
      <div className="tp-top">
        <BigPicture project={project} type={type} manage={manage} />
        <div className="tp-title">
          <div className="path">{[family?.name ?? 'No family', ...chain.slice(0, -1).map((c) => c.name)].join(' › ')}</div>
          <h1>{type.icon && <span aria-hidden>{type.icon}</span>}{type.name}</h1>
          <div className="key">{type.key}</div>
          <div className="chips">
            <span className="chipx">{plural(fields.length, 'field')}</span>
            {kinds.length > 0 && (
              <span className="chipx">{plural(kinds.length, 'kind')}: {kinds.map((k, i) => <span key={k.id}>{i ? ', ' : ''}<Link href={typesPath(project.seq, k.key)}>{k.name}</Link></span>)}</span>
            )}
            <span className="chipx">{plural(entries, 'entry', 'entries')}</span>
          </div>
        </div>
      </div>
      <div className="tabs3" role="tablist" aria-label={`Type ${type.name}`} onKeyDown={onTabKey}>
        {(['template', 'settings'] as const).map((t) => (
          <button key={t} type="button" role="tab" id={`${tabsId}-${t}`} aria-selected={tab === t} aria-controls={`${tabsId}-panel`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>
            {t === 'template' ? 'Template' : 'Settings'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} className="tp-panel">
        {tab === 'template' ? (
          manage ? <TypeTemplate project={project} type={type} types={types} /> : <TypeReadOnly type={type} />
        ) : manage ? (
          <TypeSettings type={type} types={types} onDeleted={() => navigate(typesPath(project.seq), { replace: true })} />
        ) : (
          <dl className="wsm-dl">
            <dt>Name</dt><dd>{type.name}</dd>
            <dt>Family</dt><dd>{family?.name ?? 'No family'}</dd>
            <dt>Kind of</dt><dd>{type.parentTypeId ? entryTypes.get(type.parentTypeId)?.name ?? 'None' : 'None (a type of its own)'}</dd>
            <dt>Key</dt><dd><code>{type.key}</code></dd>
          </dl>
        )}
      </div>
    </>
  );
}

/** The Template tab for people who don't manage the project. */
function TypeReadOnly({ type }: { type: EntryType }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const fields = fieldsOf(entryTypes, type.id).filter((f) => !f.hidden);
  return (
    <>
      <dl className="wsm-dl">
        <dt>Template</dt><dd>{pageOf(entryTypes, type.id).page.blocks.map((b) => b.title).join(', ') || 'No blocks'}</dd>
        <dt>Starting values</dt><dd>{type.templates.length ? type.templates.map((t) => t.name).join(', ') : 'None'}</dd>
        <dt>Fields</dt><dd>{fields.length ? fields.map((f) => f.label).join(', ') : 'None'}</dd>
      </dl>
      <p className="hint">Only people who manage this project can change types.</p>
    </>
  );
}

/** The type's picture, big, with "Change picture" for managers. */
function BigPicture({ project, type, manage }: { project: Project; type: EntryType; manage: boolean }) {
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="tp-bigpic-wrap">
      <TypePicture type={type} size="big">
        {manage && <button ref={btn} type="button" className="chg" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>Change picture</button>}
      </TypePicture>
      {menu && <PictureMenu project={project} type={type} onClose={() => { setMenu(false); btn.current?.focus(); }} />}
    </div>
  );
}

function PaintedChoice({ type, style, picked, busy, onPick }: { type: EntryType; style: PictureStyle; picked: boolean; busy: boolean; onPick: () => void }) {
  const bg = usePictureStyle(type, style);
  return (
    <button type="button" aria-pressed={picked} disabled={busy} aria-label={`${STYLE_NAMES[style]} painted picture`} title={STYLE_NAMES[style]} style={bg} onClick={onPick}>
      <span aria-hidden>{type.icon ?? '📄'}</span>
    </button>
  );
}

/** A popover: four painted styles, an upload, a picture from Assets, or back to the painted picture. */
function PictureMenu({ project, type, onClose }: { project: Project; type: EntryType; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fromAssets, setFromAssets] = useState(false);
  const current = type.picture?.kind === 'painted' ? type.picture.style : type.picture ? null : 'dusk';
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = async (picture: Picture | null) => {
    setBusy(true);
    try { await dispatch('wiki', 'updateType', { id: type.id, picture }); onClose(); } catch { setBusy(false); }
  };
  /** The asset's picture becomes the type's own copy (server/assets.ts use-for-type). */
  const fromAsset = async (a: Asset) => {
    setBusy(true);
    try { await assetAsTypePicture(a, type.id); onClose(); } catch (e) { toastError(e, "Couldn't use it"); setBusy(false); }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    if (await uploadTypePicture(type.id, f)) onClose(); else setBusy(false);
  };
  return (
    <div ref={box} className="tp-picmenu" role="dialog" aria-label="Change picture" aria-busy={busy}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="gen" role="group" aria-label="Painted pictures">
        {PICTURE_STYLES.map((s) => <PaintedChoice key={s} type={type} style={s} picked={current === s} busy={busy} onPick={() => void set(s === 'dusk' ? null : { kind: 'painted', style: s })} />)}
      </div>
      <button type="button" disabled={busy} onClick={() => file.current?.click()}><Icon name="upload" size={15} /> Upload a picture…</button>
      <input ref={file} type="file" hidden accept={COVER_MIMES.join(',')} onChange={(e) => void upload(e.target.files?.[0])} />
      <button type="button" disabled={busy} aria-expanded={fromAssets} onClick={() => setFromAssets((v) => !v)}><Icon name="asset" size={15} /> From Assets…</button>
      {fromAssets && <AssetPictures project={project} busy={busy} onPick={(a) => void fromAsset(a)} />}
      {type.picture?.kind === 'file' && (
        <button type="button" disabled={busy} onClick={() => void set(null)}><Icon name="archive" size={15} /> Back to the painted picture</button>
      )}
    </div>
  );
}

/** The project's assets with a picture, newest first, to pick one as the type's picture. Read only while it is open. */
function AssetPictures({ project, busy, onPick }: { project: Project; busy: boolean; onPick: (a: Asset) => void }) {
  const { items, error } = useAssets(project.id);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const pics = (items ?? []).filter((a) => a.hasPicture && (!needle || a.title.toLowerCase().includes(needle)));
  if (error) return <p className="tp-note" role="alert">{error}</p>;
  if (!items) return <p className="tp-note" aria-busy="true">Loading Assets…</p>;
  if (!items.some((a) => a.hasPicture)) {
    return <p className="tp-note">No pictures in <Link href={`/assets/${project.seq}`}>Assets</Link> yet.</p>;
  }
  return (
    <div className="tp-assets" role="group" aria-label="Pictures in Assets">
      {items.length > 12 && <input type="search" placeholder="Find a picture" aria-label="Find a picture" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="tp-assets-grid">
        {pics.slice(0, ASSET_PICKS).map((a) => (
          <button key={a.id} type="button" disabled={busy} title={a.title} aria-label={`Picture: ${a.title}`} onClick={() => onPick(a)}>
            <img src={pictureUrl(a)} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      {pics.length > ASSET_PICKS && <p className="tp-note">Showing {ASSET_PICKS} of {pics.length}. Find one by name.</p>}
      {needle && !pics.length && <p className="tp-note">No picture called {q.trim()}.</p>}
    </div>
  );
}

/**
 * A picture from the computer for a type: stored and set in one request (POST /api/wiki/types/:id/picture), so a
 * refused change never leaves a stray upload. False (after a toast) when refused.
 */
async function uploadTypePicture(typeId: string, file: File): Promise<boolean> {
  if (!(COVER_MIMES as readonly string[]).includes(file.type)) { showToast('Pictures must be a PNG, JPEG, GIF or WebP image.'); return false; }
  if (file.size > COVER_MAX_BYTES) { showToast(`That picture is larger than ${COVER_MAX_BYTES / 1024 / 1024} MB.`); return false; }
  let res: Response;
  try {
    res = await fetch(`/api/wiki/types/${encodeURIComponent(typeId)}/picture`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  } catch { showToast("Couldn't upload the picture. Can't reach the server."); return false; }
  if (res.ok) return true;
  const json = await res.json().catch(() => ({}));
  showToast(res.status === 413 ? 'That picture is too large.' : res.status === 415 ? 'Pictures must be a PNG, JPEG, GIF or WebP image.' : `Couldn't upload the picture (${json?.error ?? res.status}).`);
  return false;
}

// The Wiki as a builder: home tiles per entity type (entry type), a gallery per entity type, the page that makes a new
// entry from a template with pickers instead of typing, the places tree, the timeline and the storyboard.
import { useMemo, useState, type ReactNode } from 'react';
import type { Card, EntryLink, EntryType, LinkKind, Project } from '../../../../shared/types';
import { WORKS_ON, fieldsOf, isTypeOrChild } from '../../../../shared/wiki';
import { dispatch } from '../../api';
import { canEditContent, canManageProject, store, useStore, type State } from '../../store';
import { Link, navigate, useLocation } from '../../router';
import { showToast } from '../../toast';
import {
  campaignLore, campaignTypes, entriesOfTypes, entryByKey, entryExcerpt, usedValues, entryPath, formatProps, formatValue, infoboxFields, kindPath, kindsFrom,
  newEntryPath, typeCounts, typeTablePath, visibleProps, wikiPath, wikiViewPath,
} from '../../wiki';
import { fileUrl } from '../AttachmentsTab';
import { CardPicker } from '../CardPicker';
import { boardOfCard, boardPath, createBoard } from '../../board/boards';
import { FieldEditor, entryTitle } from './FieldEditor';
import { useTitleOfKey } from './Infobox';
import { PropsForm } from './LinksSection';

// ponytail: the world views read the starter pack's keys; a project with its own keys for places or history gets empty
// views. Make the keys a project setting if that turns out to matter.
const PLACE = 'location', INSIDE = 'located_in', FOUND = 'found_in', HISTORY = 'history', STORYLINE = 'storyline', FRAMES = 'frames', QUEST = 'mission';

const useLore = (project: Project): Card[] => {
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  return useMemo(() => campaignLore(cards.values(), project.id, decks).sort((a, b) => entryTitle(a).localeCompare(entryTitle(b))), [cards, decks, project.id]);
};
const typeOf = (types: Map<string, EntryType>, c: Card) => (c.entryTypeId ? types.get(c.entryTypeId) ?? null : null);

/** An entry's picture (its first image field with a value), else its entity type's icon. */
export function Picture({ card }: { card: Card }) {
  const types = useStore((s) => s.entryTypes);
  const type = typeOf(types, card);
  const id = type && fieldsOf(types, type.id).filter((f) => f.kind === 'image').map((f) => card.fields?.[f.key]).find((v): v is string => typeof v === 'string' && !!v);
  return id ? <img className="wk-pic" src={fileUrl(id)} alt="" /> : <span className="wk-ico" aria-hidden>{type?.icon ?? '📄'}</span>;
}

/** Up to `max` of an entry's table values, as small labels. */
export function Facts({ card, max = 3 }: { card: Card; max?: number }) {
  const types = useStore((s) => s.entryTypes);
  const type = typeOf(types, card);
  const titleOfKey = useTitleOfKey(type?.projectId ?? null);
  if (!type) return null;
  const facts = fieldsOf(types, type.id).filter((f) => !f.hidden && f.inTable).map((f) => [f, formatValue(f, card.fields?.[f.key], titleOfKey)] as const).filter(([, v]) => v).slice(0, max);
  if (!facts.length) return null;
  return <span className="wk-facts">{facts.map(([f, v]) => <span key={f.key} className="badge">{f.kind === 'number' || f.kind === 'integer' || f.kind === 'range' ? `${f.label} ${v}` : v}</span>)}</span>;
}

function EntryTile({ card, project, children }: { card: Card; project: Project; children?: ReactNode }) {
  return (
    <Link className="wk-tile" href={entryPath(project.seq, card)}>
      <Picture card={card} />
      <strong>{entryTitle(card)}</strong>
      <Facts card={card} />
      {children}
    </Link>
  );
}

/** The Wiki's first page: the entity types in use, the rest behind a fold, and the views of the world. */
export function WikiHome({ project }: { project: Project }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const lore = useLore(project);
  const types = useMemo(() => campaignTypes(entryTypes, project.id), [entryTypes, project.id]);
  const counts = useMemo(() => typeCounts(lore, entryTypes).byType, [lore, entryTypes]);
  // An entity type based on another one (Weapon on Item) is reached from its base's gallery, whose count includes it.
  const roots = types.filter((t) => !t.parentTypeId || !entryTypes.has(t.parentTypeId));
  const used = roots.filter((t) => (counts.get(t.id) ?? 0) > 0);
  const rest = roots.filter((t) => !used.includes(t));
  const has = (key: string) => types.some((t) => t.key === key);
  const manage = useStore((s) => canManageProject(s, project));
  const tile = (t: EntryType) => {
    const n = counts.get(t.id) ?? 0;
    return (
      <Link key={t.id} className="wk-tile" href={kindPath(project.seq, t.key)} aria-label={`${t.name}: ${n}`}>
        <span className="wk-ico" aria-hidden>{t.icon ?? '📄'}</span>
        <strong>{t.name}</strong>
        <span className="muted">{n} made{t.templates.length ? ` · ${t.templates.length} ${t.templates.length === 1 ? 'template' : 'templates'}` : ''}</span>
      </Link>
    );
  };
  return (
    <div className="wk-home">
      {used.length > 0 && <section aria-label="In use"><h2 className="wiki-side-title">In this world</h2><div className="wk-grid">{used.map(tile)}</div></section>}
      {rest.length > 0 && (
        <details className="wk-more" open={used.length === 0}>
          <summary>{used.length ? `More entity types (${rest.length})` : `Entity types (${rest.length})`}</summary>
          <div className="wk-grid">{rest.map(tile)}</div>
        </details>
      )}
      {manage && types.length > 0 && !has('recipe') && (
        <p className="hint">Need recipes, abilities, shops, dungeons or weapon and armour types? <button type="button" className="link-btn"
          onClick={() => void dispatch('wiki', 'addStarterPack', { projectId: project.id }).catch(() => {})}>Add the RPG extras</button></p>
      )}
      {(has(PLACE) || has(HISTORY) || has(STORYLINE)) && (
        <section aria-label="Views">
          <h2 className="wiki-side-title">See the world as</h2>
          <div className="wk-grid">
            {has(PLACE) && <Link className="wk-tile" href={wikiViewPath(project.seq, 'places')}><span className="wk-ico" aria-hidden>🧭</span><strong>Places</strong><span className="muted">The world as a tree, with who and what is in each place</span></Link>}
            {has(HISTORY) && <Link className="wk-tile" href={wikiViewPath(project.seq, 'timeline')}><span className="wk-ico" aria-hidden>⏳</span><strong>Timeline</strong><span className="muted">History in order, by era</span></Link>}
            {has(STORYLINE) && <Link className="wk-tile" href={kindPath(project.seq, STORYLINE)}><span className="wk-ico" aria-hidden>🎬</span><strong>Storyboards</strong><span className="muted">Questlines and lore as frames in order</span></Link>}
          </div>
        </section>
      )}
    </div>
  );
}

/** Every entry of an entity type (and of the entity types based on it) as picture tiles, with the templates to start a new one from. */
export function KindGallery({ project, type, onEditTypes }: { project: Project; type: EntryType; onEditTypes?: () => void }) {
  const s = useStore((x) => x);
  const lore = useLore(project);
  const entries = useMemo(() => entriesOfTypes(s.entryTypes, lore, [type.key]), [s.entryTypes, lore, type.key]);
  const canCreate = canEditContent(s, project);
  const based = useMemo(() => campaignTypes(s.entryTypes, project.id).filter((t) => t.parentTypeId === type.id), [s.entryTypes, project.id, type.id]);
  return (
    <section className="wk-kind" aria-label={type.name}>
      <div className="wk-head">
        <h2><span aria-hidden>{type.icon} </span>{type.name} <span className="muted">{entries.length}</span></h2>
        <span className="wk-actions">
          <Link className="btn btn-sm" href={typeTablePath(project.seq, type.key)}>Table</Link>
          {onEditTypes && <button type="button" className="btn btn-sm" onClick={onEditTypes}>Edit entity type</button>}
        </span>
      </div>
      {canCreate && (
        <div className="wk-from" role="group" aria-label={`New ${type.name}`}>
          <Link className="btn btn-primary" href={newEntryPath(project.seq, type.key)}><span aria-hidden>＋ </span>New {type.name.toLowerCase()}</Link>
          {type.templates.length > 0 && <span className="muted">or from a template:</span>}
          {type.templates.map((t, i) => <Link key={i} className="chip on" href={newEntryPath(project.seq, type.key, `?t=${i}`)}>{t.name}</Link>)}
        </div>
      )}
      {based.length > 0 && (
        <div className="wk-from" role="group" aria-label={`Kinds of ${type.name}`}>
          <span className="wiki-side-title">Kinds of {type.name.toLowerCase()}</span>
          {based.map((t) => <Link key={t.id} className="chip" href={kindPath(project.seq, t.key)}>{t.icon} {t.name}</Link>)}
        </div>
      )}
      {entries.length ? <div className="wk-grid">{entries.map((c) => <EntryTile key={c.id} card={c} project={project} />)}</div>
        : <p className="muted">None yet.</p>}
    </section>
  );
}

type Values = Record<string, unknown>;
interface DraftLink { kindKey: string; to: Card; props: Values }
interface Seed { from: string; values: Values; links: DraftLink[] }

/** What the builder starts with: a template (?t=index), a copy of an entry (?copy=key), or nothing. */
function seedOf(s: State, project: Project, type: EntryType, query: URLSearchParams): Seed {
  const tpl = query.get('t') !== null ? type.templates[Number(query.get('t'))] : undefined;
  if (tpl) {
    const links = tpl.links.flatMap((l) => { const to = entryByKey(s, project.id, l.toKey); return to ? [{ kindKey: l.kindKey, to, props: l.props }] : []; });
    return { from: tpl.name, values: { ...tpl.fields }, links };
  }
  const src = query.get('copy') ? entryByKey(s, project.id, query.get('copy')!) : undefined;
  if (src) {
    const links = [...s.entryLinks.values()].filter((l) => l.fromCardId === src.id && l.kindKey !== WORKS_ON && s.cards.has(l.toCardId))
      .sort((a, b) => a.sortIndex - b.sortIndex).map((l) => ({ kindKey: l.kindKey, to: s.cards.get(l.toCardId)!, props: l.props ?? {} }));
    return { from: `Copy of ${entryTitle(src)}`, values: { ...src.fields }, links };
  }
  return { from: 'Empty', values: {}, links: [] };
}

/** Make an entry of an entity type: start from a template or a copy, adjust the values, connect it, and watch the preview. */
export function EntryBuilder({ project, type }: { project: Project; type: EntryType }) {
  const { query } = useLocation();
  // A different start (another template, another copy) is a fresh form.
  return <BuilderForm key={`${query.get('t')}|${query.get('copy')}`} project={project} type={type} />;
}

function BuilderForm({ project, type }: { project: Project; type: EntryType }) {
  const s = useStore((x) => x);
  const { query } = useLocation();
  const [seed] = useState(() => seedOf(s, project, type, query));
  const [name, setName] = useState('');
  const [values, setValues] = useState<Values>(seed.values);
  const [links, setLinks] = useState<DraftLink[]>(seed.links);
  const [busy, setBusy] = useState(false);
  const titleOfKey = useTitleOfKey(project.id);
  const lore = useLore(project);
  // Pictures are attachments of the entry, so they are picked on its page once it exists.
  const defs = useMemo(() => infoboxFields(s.entryTypes, type.id).filter((f) => f.kind !== 'image'), [s.entryTypes, type.id]);
  const kinds = useMemo(() => kindsFrom(s, project.id, type.id), [s.linkKinds, s.entryTypes, project.id, type.id]);
  const copyKey = query.get('copy');
  const set = (k: string, v: unknown) => setValues((old) => ({ ...old, [k]: v ?? undefined }));
  const filled = Object.fromEntries(defs.map((f) => [f.key, values[f.key]]).filter(([, v]) => v !== undefined && v !== null && v !== ''));

  const create = async (another: boolean) => {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const r = await dispatch<{ id: string; key: string }>('wiki', 'createEntry', { projectId: project.id, typeId: type.id, name: title });
      if (Object.keys(filled).length) await dispatch('wiki', 'setEntry', { cardId: r.id, fields: filled });
      for (const l of links) {
        const kind = kinds.find((k) => k.key === l.kindKey);
        if (kind) await dispatch('wiki', 'addLink', { kindKey: l.kindKey, fromCardId: r.id, toCardId: l.to.id, props: visibleProps(kind.props, l.props) });
      }
      showToast(`${title} created`, 'info');
      if (another) setName(''); else navigate(`${wikiPath(project.seq)}/${r.key}`);
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const saveTemplate = async () => {
    const tpl = { name: name.trim() || `${type.name} template`, fields: filled, links: links.flatMap((l) => (l.to.entryKey ? [{ kindKey: l.kindKey, toKey: l.to.entryKey, props: l.props }] : [])) };
    try {
      await dispatch('wiki', 'updateType', { id: type.id, templates: [...type.templates, tpl] });
      showToast(`Template "${tpl.name}" saved`, 'info');
    } catch { /* toast */ }
  };

  return (
    <section className="wk-build" aria-label={`New ${type.name}`}>
      <div className="wk-steps">
        <h2>New {type.name.toLowerCase()}</h2>
        <div className="wk-box" role="group" aria-label="Start from">
          <span className="wiki-side-title">1 · Start from</span>
          <div className="wk-chips">
            <Link className={seed.from === 'Empty' ? 'chip on' : 'chip'} href={newEntryPath(project.seq, type.key)} aria-current={seed.from === 'Empty' ? 'true' : undefined}>Empty</Link>
            {type.templates.map((t, i) => (
              <Link key={i} className={query.get('t') === String(i) ? 'chip on' : 'chip'} href={newEntryPath(project.seq, type.key, `?t=${i}`)}
                aria-current={query.get('t') === String(i) ? 'true' : undefined}>{t.name}</Link>
            ))}
            {copyKey && <span className="chip on">{seed.from}</span>}
            <CardPicker label="Copy an existing one" trigger="Copy of…" triggerClass="chip" searchLabel="Search lore" empty="No matching lore"
              candidates={() => entriesOfTypes(s.entryTypes, lore, [type.key]).filter((c) => c.entryKey)}
              onPick={(c) => navigate(newEntryPath(project.seq, type.key, `?copy=${c.entryKey}`))} />
          </div>
        </div>

        <div className="wk-box" role="group" aria-label="Adjust">
          <span className="wiki-side-title">2 · Adjust</span>
          <label className="wk-f"><span>Name</span><input data-autofocus value={name} maxLength={200} placeholder="The only thing you have to type" onChange={(e) => setName(e.target.value)} /></label>
          {defs.map((f) => (
            <div key={f.key} className="wk-f">
              <span title={f.help}>{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
              <FieldEditor def={f} value={values[f.key]} instant onSave={(v) => set(f.key, v)} titleOfKey={titleOfKey} images={[]}
                suggestions={f.kind === 'text' ? usedValues(lore, f.key) : undefined}
                entries={f.kind === 'entry' || f.kind === 'entries' ? entriesOfTypes(s.entryTypes, lore, f.target ? [f.target] : []) : []} />
            </div>
          ))}
        </div>

        {kinds.length > 0 && (
          <div className="wk-box" role="group" aria-label="Connect">
            <span className="wiki-side-title">3 · Connect</span>
            {kinds.map((k) => <Slot key={k.id} kind={k} project={project} lore={lore} links={links} setLinks={setLinks} />)}
          </div>
        )}

        <div className="wk-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create(false)}>Create</button>
          <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void create(true)}>Create and make another</button>
          {canManageProject(s, project) && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void saveTemplate()}>Save these values as a template</button>}
        </div>
      </div>

      <aside className="wk-card" aria-label="Preview">
        <span className="wiki-side-title">Preview · from {seed.from}</span>
        <span className="wk-ico wk-ico-big" aria-hidden>{type.icon ?? '📄'}</span>
        <h3>{name.trim() || <span className="muted">Unnamed</span>}</h3>
        <dl>
          {defs.map((f) => {
            const text = formatValue(f, values[f.key], titleOfKey);
            const changed = JSON.stringify(values[f.key] ?? null) !== JSON.stringify(seed.values[f.key] ?? null);
            return text ? <div key={f.key} className="infobox-row"><dt>{f.label}</dt><dd className={changed ? 'wk-changed' : undefined}>{text}</dd></div> : null;
          })}
        </dl>
        {kinds.map((k) => {
          const mine = links.filter((l) => l.kindKey === k.key);
          return mine.length ? (
            <div key={k.id}><span className="wiki-side-title">{k.label}</span>
              <div className="wk-facts">{mine.map((l) => { const p = formatProps(k.props, l.props, titleOfKey); return <span key={l.to.id} className="badge">{entryTitle(l.to)}{p && ` · ${p}`}</span>; })}</div>
            </div>
          ) : null;
        })}
        {seed.from !== 'Empty' && <p className="hint">Orange values differ from what you started with.</p>}
      </aside>
    </section>
  );
}

/** One link kind in the builder: the entries picked so far (with their properties) and the ones that can be added. */
function Slot({ kind, project, lore, links, setLinks }: { kind: LinkKind; project: Project; lore: Card[]; links: DraftLink[]; setLinks: (l: DraftLink[]) => void }) {
  const types = useStore((s) => s.entryTypes);
  const mine = links.filter((l) => l.kindKey === kind.key);
  const free = useMemo(() => entriesOfTypes(types, lore, kind.toTypes).filter((c) => !mine.some((l) => l.to.id === c.id)), [types, lore, kind.toTypes, mine]);
  const add = (to: Card) => setLinks([...links, { kindKey: kind.key, to, props: {} }]);
  const hasProps = kind.props.some((d) => !d.hidden);
  if (!free.length && !mine.length) return null;
  // A kind open to any entry would offer the whole wiki as buttons: it only gets the search.
  const shown = kind.toTypes.length ? free.slice(0, 8) : [];
  return (
    <div className="wk-slot" role="group" aria-label={kind.label}>
      <strong>{kind.label}</strong>
      {mine.map((l) => (
        <div key={l.to.id} className="wk-picked">
          <span className="badge">{entryTitle(l.to)}</span>
          {hasProps && <PropsForm kind={kind} draft={l.props} projectId={project.id} setDraft={(p) => setLinks(links.map((x) => (x === l ? { ...l, props: p } : x)))} />}
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${entryTitle(l.to)} from ${kind.label}`} onClick={() => setLinks(links.filter((x) => x !== l))}>×</button>
        </div>
      ))}
      <div className="wk-chips">
        {shown.map((c) => <button key={c.id} type="button" className="chip" onClick={() => add(c)}>＋ {entryTitle(c)}</button>)}
        {free.length > shown.length && <CardPicker label={`Add to ${kind.label}`} trigger={shown.length ? 'More…' : 'Pick…'} triggerClass="chip" candidates={free} searchLabel="Search lore" empty="No matching lore" onPick={add} />}
      </div>
    </div>
  );
}

const linksOfKind = (links: Map<string, EntryLink>, keys: string[]) => [...links.values()].filter((l) => keys.includes(l.kindKey));

/** Places nested by "located in", each with what is found there. */
export function PlacesView({ project }: { project: Project }) {
  const s = useStore((x) => x);
  const lore = useLore(project);
  const places = useMemo(() => entriesOfTypes(s.entryTypes, lore, [PLACE]), [s.entryTypes, lore]);
  const { kids, roots, here } = useMemo(() => {
    const ids = new Set(places.map((p) => p.id));
    const parent = new Map<string, string>();
    const here = new Map<string, Card[]>();
    for (const l of linksOfKind(s.entryLinks, [INSIDE, FOUND])) {
      const from = s.cards.get(l.fromCardId);
      if (!from || from.visibility === 'deleted' || !ids.has(l.toCardId)) continue;
      if (l.kindKey === INSIDE && ids.has(from.id)) { if (!parent.has(from.id) && from.id !== l.toCardId) parent.set(from.id, l.toCardId); } else if (!here.get(l.toCardId)?.includes(from)) here.set(l.toCardId, [...(here.get(l.toCardId) ?? []), from]);
    }
    const kids = new Map<string, Card[]>();
    for (const p of places) { const up = parent.get(p.id); if (up) kids.set(up, [...(kids.get(up) ?? []), p]); }
    return { kids, here, roots: places.filter((p) => !parent.has(p.id)) };
  }, [places, s.entryLinks, s.cards]);
  // A loop of places (A inside B inside A) has no root: `seen` stops the walk, and such places are listed flat below.
  const seen = new Set<string>();
  const node = (p: Card): ReactNode => {
    if (seen.has(p.id)) return null;
    seen.add(p.id);
    return (
      <li key={p.id}>
        <Link className="wk-tile wk-row" href={entryPath(project.seq, p)}>
          <span className="wk-row-head"><Picture card={p} /><strong>{entryTitle(p)}</strong><Facts card={p} max={1} /></span>
          {here.has(p.id) && <span className="wk-facts">{here.get(p.id)!.map((c) => <span key={c.id} className="badge">{typeOf(s.entryTypes, c)?.icon} {entryTitle(c)}</span>)}</span>}
        </Link>
        {kids.has(p.id) && <ul>{kids.get(p.id)!.map(node)}</ul>}
      </li>
    );
  };
  const tree = roots.map(node);
  const loose = places.filter((p) => !seen.has(p.id));
  return (
    <section className="wk-kind" aria-label="Places">
      <div className="wk-head">
        <h2><span aria-hidden>🧭 </span>Places</h2>
        {canEditContent(s, project) && <Link className="btn btn-sm btn-primary" href={newEntryPath(project.seq, PLACE)}>New place</Link>}
      </div>
      {places.length ? <ul className="wk-tree" aria-label="Place tree">{tree}{loose.map(node)}</ul>
        : <p className="muted">No places yet. A place goes inside another through its "located in" link.</p>}
    </section>
  );
}

/** Entries that have a year, in order, under their era. */
export function TimelineView({ project }: { project: Project }) {
  const s = useStore((x) => x);
  const lore = useLore(project);
  const eras = useMemo(() => {
    const dated = lore.filter((c) => typeof c.fields?.year === 'number').sort((a, b) => (a.fields.year as number) - (b.fields.year as number));
    const m = new Map<string, Card[]>();
    for (const c of dated) { const era = typeof c.fields.era === 'string' ? c.fields.era : ''; m.set(era, [...(m.get(era) ?? []), c]); }
    return [...m];
  }, [lore]);
  const hasHistory = campaignTypes(s.entryTypes, project.id).some((t) => t.key === HISTORY);
  return (
    <section className="wk-kind" aria-label="Timeline">
      <div className="wk-head">
        <h2><span aria-hidden>⏳ </span>Timeline</h2>
        {hasHistory && canEditContent(s, project) && <Link className="btn btn-sm btn-primary" href={newEntryPath(project.seq, HISTORY)}>New event</Link>}
      </div>
      {eras.length ? eras.map(([era, list]) => (
        <section key={era} aria-label={era || 'No era'}>
          <h3 className="wiki-side-title">{era || 'No era'}</h3>
          <ul className="wk-tree">
            {list.map((c) => (
              <li key={c.id}>
                <Link className="wk-tile wk-row" href={entryPath(project.seq, c)}>
                  <span className="wk-row-head"><span className="muted wk-year">Year {String(c.fields.year)}</span><Picture card={c} /><strong>{entryTitle(c)}</strong></span>
                  {entryExcerpt(c) && <span className="muted">{entryExcerpt(c)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )) : <p className="muted">Nothing dated yet. Anything with a Year shows up here, grouped by its Era.</p>}
    </section>
  );
}

/**
 * A storyline's frames in order: picture, title, the first line of its text and a few facts. Frames are "shows" links,
 * so any entry (a quest, a place, a character) can be a frame, and their order is the links' order.
 */
export function Storyboard({ card, project, editable }: { card: Card; project: Project; editable: boolean }) {
  const s = useStore((x) => x);
  const lore = useLore(project);
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const frames = useMemo(() => [...s.entryLinks.values()].filter((l) => l.fromCardId === card.id && l.kindKey === FRAMES && s.cards.has(l.toCardId)).sort((a, b) => a.sortIndex - b.sortIndex),
    [s.entryLinks, s.cards, card.id]);
  /** Puts a frame at position `to` of the others, by giving its link an order between its new neighbours. */
  const move = (id: string, to: number) => {
    const rest = frames.filter((l) => l.id !== id);
    const before = rest[to - 1]?.sortIndex, after = rest[to]?.sortIndex;
    const sortIndex = before === undefined ? (after ?? 1) - 1 : after === undefined ? before + 1 : (before + after) / 2;
    void dispatch('wiki', 'updateLink', { id, sortIndex }).catch(() => {});
  };
  const addExisting = (to: Card) => void dispatch('wiki', 'addLink', { kindKey: FRAMES, fromCardId: card.id, toCardId: to.id, props: {} }).catch(() => {});
  const addNew = async () => {
    const title = name.trim();
    if (!title) return;
    try { await makeFrame(s, card, title); setName(''); } catch { /* toast */ }
  };
  return (
    <section className="wk-story" aria-label="Storyboard">
      <div className="wk-head">
        <h2 className="entry-section-title">Storyboard</h2>
        {/* The canvas: frames as picture cards joined by lines you can label and branch. ?story lays out any frame not on it yet. */}
        {(editable || boardOfCard(s, card.id)) && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => {
            const b = boardOfCard(s, card.id);
            void (b ? Promise.resolve(b.accountSeq) : createBoard(card)).then((seq) => navigate(`${boardPath(seq)}?story=1`)).catch(() => {});
          }}>Open as a flow</button>
        )}
      </div>
      <ol className="wk-frames">
        {frames.map((l, i) => {
          const c = s.cards.get(l.toCardId)!;
          const title = entryTitle(c);
          return (
            <li key={l.id} className={drag === l.id ? 'wk-frame dragging' : 'wk-frame'} data-testid="frame" draggable={editable}
              onDragStart={() => setDrag(l.id)} onDragEnd={() => setDrag(null)} onDragOver={(e) => { if (drag && drag !== l.id) e.preventDefault(); }}
              onDrop={() => { if (drag && drag !== l.id) move(drag, i); setDrag(null); }}>
              <Link href={entryPath(project.seq, c)} className="wk-frame-link" draggable={false}>
                <span className="wk-frame-pic"><Picture card={c} /><span className="wk-frame-n">{i + 1}</span></span>
                <strong>{title}</strong>
                <span className="muted">{entryExcerpt(c) || 'Nothing written yet.'}</span>
                <Facts card={c} max={2} />
              </Link>
              {editable && (
                <span className="wk-frame-actions">
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${title} earlier`} disabled={i === 0} onClick={() => move(l.id, i - 1)}>←</button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Move ${title} later`} disabled={i === frames.length - 1} onClick={() => move(l.id, i + 1)}>→</button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${title} from the storyboard`} onClick={() => void dispatch('wiki', 'removeLink', { id: l.id }).catch(() => {})}>×</button>
                </span>
              )}
            </li>
          );
        })}
        {editable && (
          <li className="wk-frame wk-frame-new">
            <form onSubmit={(e) => { e.preventDefault(); void addNew(); }}>
              <input aria-label="New frame" placeholder="What happens next?" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim()}>Add frame</button>
            </form>
            <CardPicker label="Add an existing entry as a frame" trigger="Use an existing entry…" candidates={() => lore.filter((c) => c.id !== card.id && !frames.some((l) => l.toCardId === c.id))}
              searchLabel="Search lore" empty="No matching lore" onPick={addExisting} />
          </li>
        )}
      </ol>
      {!frames.length && !editable && <p className="muted">No frames yet.</p>}
    </section>
  );
}

/** A new frame of a storyline: a Quest entry (a plain page without that type) filed under it and linked as shown. Returns its card id. */
export async function makeFrame(s: Pick<State, 'entryTypes' | 'decks'>, story: Card, title: string): Promise<string> {
  const projectId = story.deckId ? s.decks.get(story.deckId)?.projectId : undefined;
  if (!projectId) throw new Error('no_project');
  const quest = campaignTypes(s.entryTypes, projectId).find((t) => t.key === QUEST);
  const r = await dispatch<{ id: string }>('wiki', 'createEntry', { projectId, typeId: quest?.id ?? null, name: title, parentId: story.id });
  await dispatch('wiki', 'addLink', { kindKey: FRAMES, fromCardId: story.id, toCardId: r.id, props: {} });
  return r.id;
}
export const isStoryline = (s: Pick<State, 'entryTypes'>, card: Card): boolean => !!card.entryTypeId && s.entryTypes.get(card.entryTypeId)?.key === STORYLINE;

/**
 * Links a frame to an entry dropped on it, through the first link kind that fits the two (a place by "found in" when
 * it fits, else "uses", else any).
 */
export function attachToFrame(frameId: string, entryId: string): void {
  const s = store.get(), frame = s.cards.get(frameId), entry = s.cards.get(entryId);
  const projectId = frame?.deckId ? s.decks.get(frame.deckId)?.projectId : undefined;
  if (!frame?.isDoc || !entry || !projectId || frame.id === entry.id) { showToast('Drop it on a frame.', 'info', 3000); return; }
  const fits = (typeId: string | null, allowed: string[]) => (typeId ? isTypeOrChild(s.entryTypes, typeId, allowed) : allowed.length === 0);
  const kinds = [...s.linkKinds.values()].filter((k) => k.projectId === projectId && k.key !== FRAMES && k.key !== WORKS_ON && fits(frame.entryTypeId, k.fromTypes) && fits(entry.entryTypeId, k.toTypes));
  const kind = kinds.find((k) => k.key === 'features') ?? kinds.find((k) => k.key === FOUND) ?? kinds.find((k) => k.key === 'uses') ?? kinds[0];
  if (!kind) { showToast(`No link kind joins ${entryTitle(frame)} to ${entryTitle(entry)}. Add one under Entity types.`); return; }
  if ([...s.entryLinks.values()].some((l) => l.fromCardId === frame.id && l.toCardId === entry.id)) return;
  void dispatch('wiki', 'addLink', { kindKey: kind.key, fromCardId: frame.id, toCardId: entry.id, props: {} })
    .then(() => showToast(`${entryTitle(frame)} ${kind.label} ${entryTitle(entry)}`, 'info', 3000), () => {});
}

/** Beside a storyline's flow: the project's entries, to drag onto a frame. Frames and storylines themselves are left out. */
export function CastPanel({ story }: { story: Card }) {
  const s = useStore((x) => x);
  const [query, setQuery] = useState('');
  const projectId = story.deckId ? s.decks.get(story.deckId)?.projectId : undefined;
  const list = useMemo(() => {
    if (!projectId) return [];
    const frames = new Set([...s.entryLinks.values()].filter((l) => l.kindKey === FRAMES).map((l) => l.toCardId));
    const q = query.trim().toLowerCase();
    return campaignLore(s.cards.values(), projectId, s.decks).filter((c) => c.entryTypeId && !frames.has(c.id) && !isStoryline(s, c) && (!q || entryTitle(c).toLowerCase().includes(q)))
      .sort((a, b) => entryTitle(a).localeCompare(entryTitle(b))).slice(0, 200);
  }, [s.cards, s.decks, s.entryLinks, s.entryTypes, projectId, query]);
  return (
    <aside className="cast-panel" aria-label="Cast">
      {/* Closed until wanted: open, it lies over the right edge of the board. */}
      <details>
      <summary className="wiki-side-title">Cast</summary>
      <p className="hint">Drag a character, place or item onto a frame.</p>
      <input type="search" aria-label="Find in the cast" placeholder="find…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>
        {list.map((c) => (
          <li key={c.id} draggable onDragStart={(e) => { e.dataTransfer.setData('text/ql-entry', c.id); e.dataTransfer.effectAllowed = 'link'; }}>
            <span aria-hidden>{typeOf(s.entryTypes, c)?.icon ?? '📄'}</span> {entryTitle(c)}
          </li>
        ))}
        {!list.length && <li className="muted">Nothing here yet.</li>}
      </ul>
      </details>
    </aside>
  );
}

/** Is this entry the first frame of a storyline (the lowest order among that storyline's frames)? */
export const isStartFrame = (links: EntryLink[], cardId: string): boolean => {
  const frames = links.filter((l) => l.kindKey === FRAMES);
  return frames.some((m) => m.toCardId === cardId && !frames.some((o) => o.fromCardId === m.fromCardId && o.sortIndex < m.sortIndex));
};

/** Does this entry get a storyboard: it is a storyline, or it already has frames. */
export const hasStoryboard = (s: Pick<State, 'entryTypes' | 'entryLinks' | 'linkKinds'>, card: Card, projectId: string): boolean =>
  [...s.linkKinds.values()].some((k) => k.projectId === projectId && k.key === FRAMES)
  && ((card.entryTypeId ? s.entryTypes.get(card.entryTypeId)?.key === STORYLINE : false) || [...s.entryLinks.values()].some((l) => l.fromCardId === card.id && l.kindKey === FRAMES));

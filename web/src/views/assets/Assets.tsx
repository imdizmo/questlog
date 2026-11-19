import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../../shared/types';
import { ASSET_FORS, filterAssets, groupAssets, kindLabel, type Asset, type AssetFor, type AssetKind } from '../../../../shared/assets';
import { api } from '../../api';
import { canEditContent, projectVisible, useStore, type State } from '../../store';
import { Link, navigate, type Route } from '../../router';
import { Icon, type IconName } from '../../components/icons';
import { Menu } from '../../components/Menu';
import { showToast } from '../../toast';
import { checkLibrary, type LibraryState, type LibraryTarget } from '../../library';
import { pictureUrl, setAssetPicture, toastError, uploadAsset, useAssets } from '../../assets';
import { AssetView } from './AssetView';
import { GroundworkBrowser, ShelfBrowser, UrlDialog, WebDialog } from './AddSources';
import './assets.css';

type AssetsRoute = Extract<Route, { name: 'assets' | 'assetsProject' }>;

const LAST_KEY = 'jt:assetsProject';
const readLast = (): string | null => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };
const writeLast = (id: string) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* not remembered */ } };
export const assetsPath = (projectSeq: number) => `/assets/${projectSeq}`;

const KINDS: [AssetKind | 'all' | 'sound', string][] = [['all', 'All'], ['picture', 'Pictures'], ['model', '3D models'], ['map', 'Maps'], ['concept', 'Concepts'], ['sound', 'Sounds']];
export const FOR_ICONS: Record<AssetFor, IconName> = { Characters: 'user', Creatures: 'paw', Items: 'tag', Places: 'globe', Interface: 'frame', 'Key art': 'star' };

/** At most this many files per pick from the computer. */
const PICK_MAX = 20;
/** A .glb larger than this gets no rendered picture (it would be parsed in the page just for the picture). */
const THUMB_MAX_BYTES = 64 * 1024 * 1024;

const assetProjects = (s: State): Project[] =>
  [...s.projects.values()].filter((p) => !p.isArchived && projectVisible(s, p.id)).sort((a, b) => a.seq - b.seq);

/** Where the library browsers read (asked once per page load, as the Suggestion button does). */
let libraryCheck: Promise<{ state: LibraryState; target: LibraryTarget | null }> | null = null;
const libraryOnce = () => (libraryCheck ??= api.status().then((r) => checkLibrary(r.suggestions)).catch(() => ({ state: 'old' as const, target: null })));

/** The Assets page: a project's pictures, 3D models, maps and concepts, browsed as a gallery. */
export function Assets({ route }: { route: AssetsRoute }) {
  const projects = useStore(assetProjects);
  const all = useStore((s) => s.projects);
  const project = route.name === 'assetsProject' ? [...all.values()].find((p) => p.seq === route.projectSeq) : undefined;

  // /assets opens the project used last (if still offered), else the first one.
  useEffect(() => {
    if (route.name !== 'assets' || !projects.length) return;
    const last = readLast();
    navigate(assetsPath((projects.find((p) => p.id === last) ?? projects[0]).seq), { replace: true });
  }, [route.name, projects]);
  useEffect(() => { if (project) writeLast(project.id); }, [project?.id]);

  if (route.name === 'assets') {
    return (
      <main className="page" id="main">
        <div className="page-head"><h1>Assets</h1></div>
        {!projects.length && <p className="muted">No projects yet. Create one under Lists first.</p>}
      </main>
    );
  }
  if (!project) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/assets">← Assets</Link></p><h1>Project not found</h1></div></div>
        <p className="muted">It may have been removed, or you don't have access to it.</p>
      </main>
    );
  }
  return <ProjectAssets key={project.id} project={project} projects={projects} />;
}

type Source = 'url' | 'shelf' | 'ground' | 'web';

function ProjectAssets({ project, projects }: { project: Project; projects: Project[] }) {
  const mayEdit = useStore((s) => canEditContent(s, project));
  const { items, error, reload } = useAssets(project.id);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [fors, setFors] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [library, setLibrary] = useState<{ state: LibraryState; target: LibraryTarget | null } | null>(null);
  const [busy, setBusy] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { let on = true; libraryOnce().then((l) => { if (on) setLibrary(l); }); return () => { on = false; }; }, []);

  const list = useMemo(() => filterAssets(items ?? [], { q, kind, fors }), [items, q, kind, fors]);
  const groups = useMemo(() => groupAssets(list), [list]);
  const open = openId ? items?.find((a) => a.id === openId) : undefined;

  const toggleFor = (f: string) => setFors((old) => { const n = new Set(old); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  const addFiles = async (files: File[]) => {
    if (files.length > PICK_MAX) showToast(`At most ${PICK_MAX} files at a time: added the first ${PICK_MAX}.`, 'info');
    const pick = files.slice(0, PICK_MAX);
    setBusy((n) => n + pick.length);
    let added = 0;
    for (const f of pick) {
      try {
        const title = f.name.replace(/\.[^.]+$/, '');
        const a = await uploadAsset({ projectId: project.id, title }, f);
        added++;
        // A model gets a picture for the gallery, rendered here from its .glb.
        if (a.hasModel && f.size <= THUMB_MAX_BYTES) {
          try {
            const { renderThumbnail } = await import('./viewer3d');
            await setAssetPicture(a.id, await renderThumbnail(await f.arrayBuffer()));
          } catch { /* the gallery shows a stand-in */ }
        }
      } catch (e) {
        toastError(e, `Couldn't add ${f.name}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (added) showToast(`Added ${added} ${added === 1 ? 'asset' : 'assets'}`, 'info', 3000);
    reload();
  };

  const count = items?.length ?? 0;
  return (
    <main className="page assets-page" id="main">
      <div className="ap-head">
        <h1>Assets</h1>
        <span className="muted">
          {projects.length > 1 ? (
            <select className="ap-project" aria-label="Project" value={project.seq} onChange={(e) => navigate(assetsPath(Number(e.target.value)))}>
              {projects.map((p) => <option key={p.id} value={p.seq}>{p.name}</option>)}
            </select>
          ) : project.name}
          {' · '}{count} {count === 1 ? 'asset' : 'assets'}{busy > 0 && ` · adding ${busy}…`}
        </span>
        <span className="ap-sp" />
        {mayEdit && (
          <div>
            <Menu label="Add an asset" triggerClass="btn btn-primary" trigger={<><Icon name="upload" size={15} /> Add</>} items={[
              { label: 'From your computer…', hint: 'Pictures, and single-file .glb models', onSelect: () => fileInput.current?.click() },
              { label: 'From a URL…', onSelect: () => setSource('url') },
              { label: 'From Asset Shelf…', onSelect: () => setSource('shelf') },
              { label: 'From Groundwork…', onSelect: () => setSource('ground') },
              { label: 'From the web (browser add-on)…', hint: 'Coming later', onSelect: () => setSource('web') },
            ]} />
            <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,.glb,model/gltf-binary"
              data-testid="asset-file" onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) void addFiles(fs); }} />
          </div>
        )}
      </div>
      <div className="ap-filters">
        <label className="ap-find"><Icon name="search" size={14} />
          <input type="search" placeholder="Find an asset" aria-label="Find an asset" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="ap-kinds" role="group" aria-label="Kind">
          {KINDS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={kind === k} disabled={k === 'sound'} title={k === 'sound' ? 'Later, once there is a sound tool' : undefined}
              onClick={() => k !== 'sound' && setKind(k)}>{l}{k === 'sound' && <small> later</small>}</button>
          ))}
        </div>
        <span className="ap-sep" />
        <div className="ap-fors" role="group" aria-label="What it is for">
          {ASSET_FORS.map((f) => (
            <button key={f} type="button" aria-pressed={fors.has(f)} aria-label={f} title={f} onClick={() => toggleFor(f)}><Icon name={FOR_ICONS[f]} size={15} /></button>
          ))}
        </div>
      </div>
      <div className="ap-body">
        {error && <p className="muted">{error}</p>}
        {items === null && !error && <p className="muted">Loading…</p>}
        {items && !items.length && (
          <p className="ap-note">No assets yet. {mayEdit ? <>Add pictures, 3D models and maps with <b>Add</b>.</> : 'Someone who can edit this project can add them.'}</p>
        )}
        {items && !!items.length && !list.length && <p className="ap-note">Nothing matches. Clear a filter, or add something with <b>Add</b>.</p>}
        {groups.map((g) => (
          <section key={g.title} className="ap-group">
            <h2>{g.title} <span>{g.items.length}</span></h2>
            <div className="ap-masonry">{g.items.map((a) => <Tile key={a.id} a={a} onOpen={() => setOpenId(a.id)} />)}</div>
          </section>
        ))}
      </div>
      {open && <AssetView key={open.id} asset={open} project={project} mayEdit={mayEdit} onClose={() => setOpenId(null)} onChanged={reload} />}
      {source === 'url' && <UrlDialog projectId={project.id} onClose={() => setSource(null)} onAdded={reload} />}
      {source === 'web' && <WebDialog onClose={() => setSource(null)} />}
      {source === 'shelf' && <ShelfBrowser projectId={project.id} library={library} onClose={() => setSource(null)} onAdded={reload} />}
      {source === 'ground' && <GroundworkBrowser projectId={project.id} library={library} onClose={() => setSource(null)} onAdded={reload} />}
    </main>
  );
}

function Tile({ a, onOpen }: { a: Asset; onOpen: () => void }) {
  return (
    <button type="button" className="ap-tile" aria-label={a.title} onClick={onOpen}>
      {a.hasPicture
        ? <img src={pictureUrl(a)} alt="" loading="lazy" decoding="async" />
        : <span className="ap-standin"><Icon name="asset" size={28} /></span>}
      <span className="ap-info"><b>{a.title}</b><span>{kindLabel(a.kind)}{a.for ? ` · ${a.for}` : ''}</span></span>
      {a.kind === 'model' && <span className="ap-3d">3D</span>}
    </button>
  );
}

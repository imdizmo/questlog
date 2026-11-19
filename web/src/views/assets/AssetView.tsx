import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../../shared/types';
import { ASSET_FORS, ASSET_KINDS, kindLabel, type Asset, type AssetFor, type AssetKind, type AssetLink } from '../../../../shared/assets';
import { canManageProject, useStore } from '../../store';
import { Link } from '../../router';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/icons';
import { showToast } from '../../toast';
import { campaignLore, entryPath } from '../../wiki';
import { entryTitle } from '../../components/wiki/FieldEditor';
import { deleteAsset, modelUrl, pictureUrl, toastError, typePicture, updateAsset, useAssetOn } from '../../assets';
import type { ViewMode, Viewer } from './viewer3d';

const SOURCE: Record<Asset['source'], string> = { uploaded: 'Uploaded', url: 'From a URL', 'asset-shelf': 'Asset Shelf', groundwork: 'Groundwork' };

/** What Questlog keeps of it. */
function kept(a: Asset): string {
  if (a.hasModel) return a.hasPicture ? 'The .glb and a picture of it' : 'The .glb';
  if (a.source === 'asset-shelf') return 'The picture, and a link back; the asset stays in Asset Shelf';
  if (a.source === 'groundwork') return `The picture, and a link back; the ${a.kind === 'map' ? 'map' : 'prop'} stays in Groundwork`;
  return 'The picture';
}

/** The link back, as words (Asset Shelf does not open links from outside yet). */
function linkText(l: AssetLink | null): string | null {
  if (!l) return null;
  if ('url' in l) return l.url;
  if (l.kind === 'asset') return `${l.packTitle ? `${l.packTitle} (${l.pack})` : l.pack} · ${l.path}`;
  return `${l.kind === 'map' ? 'Map' : 'Prop'} ${l.id}, version ${l.version}`;
}

/** The asset itself: the big picture or the 3D viewer, and beside it what it is, where it is from and where it is used. */
export function AssetView({ asset: a, project, mayEdit, onClose, onChanged }: { asset: Asset; project: Project; mayEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [title, setTitle] = useState(a.title);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setTitle(a.title), [a.title]);

  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', onCancel);
    return () => { d.removeEventListener('cancel', onCancel); if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);

  const save = async (patch: { title?: string; kind?: AssetKind; for?: AssetFor | null }) => {
    try { await updateAsset(a.id, patch); onChanged(); } catch { /* dispatch showed why */ }
  };
  const link = linkText(a.link);
  const kinds = ASSET_KINDS.filter((k) => k !== 'model' || a.hasModel || a.source === 'asset-shelf' || a.source === 'groundwork');

  return (
    <dialog ref={ref} className="ap-view" aria-label={a.title} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="ap-stage">
        {a.hasModel ? <ModelStage asset={a} /> : a.hasPicture ? <img src={pictureUrl(a)} alt={a.title} /> : <span className="ap-standin big"><Icon name="asset" size={48} /></span>}
      </div>
      <aside className="ap-side">
        <button type="button" className="icon-btn ap-x" aria-label="Close" onClick={onClose} data-autofocus><Icon name="close" /></button>
        <div className="ap-kind2">{kindLabel(a.kind)}{a.for ? ` · ${a.for}` : ''}</div>
        {mayEdit ? (
          <input className="ap-title" aria-label="Name" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() && title !== a.title) void save({ title }); else setTitle(a.title); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : <h2 className="ap-title">{a.title}</h2>}
        <dl className="ap-facts">
          <dt>Source</dt><dd>{SOURCE[a.source]}{link && <><br /><span className="ap-link" title={link}>{link}</span></>}</dd>
          <dt>In Questlog</dt><dd>{kept(a)}</dd>
          <dt>Used in</dt>
          <dd>{a.usedIn.length ? a.usedIn.map((u, i) => <UsedIn key={u.cardId} cardId={u.cardId} title={u.title} last={i === a.usedIn.length - 1} />) : 'Nothing yet'}</dd>
        </dl>
        {mayEdit && (
          <div className="ap-edit">
            <label>Kind
              <select value={a.kind} onChange={(e) => void save({ kind: e.target.value as AssetKind })} disabled={a.hasModel}>
                {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </select>
            </label>
            <label>For
              <select value={a.for ?? ''} onChange={(e) => void save({ for: (e.target.value || null) as AssetFor | null })}>
                <option value="">Nothing in particular</option>
                {ASSET_FORS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          </div>
        )}
        {mayEdit && (
          <div className="ap-actions">
            <button type="button" className="btn btn-primary" disabled={!a.hasPicture} title={a.hasPicture ? undefined : 'It has no picture yet'} onClick={() => setPicking(true)}>Use as a picture of…</button>
            <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}><Icon name="trash" size={15} /> Delete</button>
          </div>
        )}
      </aside>
      {picking && <UsePicker asset={a} project={project} onClose={() => setPicking(false)} onUsed={onChanged} />}
      {deleting && (
        <ConfirmDialog title="Delete this asset?" confirmLabel="Delete" danger onClose={() => setDeleting(false)}
          onConfirm={async () => { await deleteAsset(a.id); onChanged(); onClose(); }}>
          <p>Questlog's copy of <b>{a.title}</b> goes. {a.source === 'asset-shelf' ? 'The asset stays in Asset Shelf.' : a.source === 'groundwork' ? 'It stays in Groundwork.' : ''}
            {a.usedIn.length > 0 && ' The entries that use its picture keep their own copy.'}</p>
        </ConfirmDialog>
      )}
    </dialog>
  );
}

function UsedIn({ cardId, title, last }: { cardId: string; title: string; last: boolean }) {
  const card = useStore((s) => s.cards.get(cardId));
  const project = useStore((s) => (card?.deckId ? s.projects.get(s.decks.get(card.deckId)?.projectId ?? '') : undefined));
  const label = card ? entryTitle(card) : title;
  return <>{card && project ? <Link href={entryPath(project.seq, card)}>{label}</Link> : label}{last ? '' : ', '}</>;
}

/** The 3D viewer for a stored .glb: three.js loads only now, and everything is disposed when this closes. */
function ModelStage({ asset }: { asset: Asset }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [mode, setMode] = useState<ViewMode>('lit');
  const [spin, setSpin] = useState(true);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let gone = false;
    const ac = new AbortController();
    (async () => {
      const r = await fetch(modelUrl(asset), { credentials: 'same-origin', signal: ac.signal });
      if (!r.ok) throw new Error('model');
      const bytes = await r.arrayBuffer();
      const { openViewer } = await import('./viewer3d');
      if (gone || !host.current) return;
      const bg = document.documentElement.dataset.look === 'light' ? '#e9e6df' : '#1a1714';
      const v = await openViewer(host.current, bytes, bg);
      if (gone) { v.dispose(); return; }
      viewer.current = v;
      setState('ready');
    })().catch(() => { if (!gone) setState('failed'); });
    return () => { gone = true; ac.abort(); viewer.current?.dispose(); viewer.current = null; };
  }, [asset.id]);

  return (
    <>
      <div className="ap-3dhost" ref={host} data-testid="viewer3d">
        {state !== 'ready' && <span className="ap-3dload">{state === 'loading' ? 'Loading the viewer…' : 'This model could not be shown.'}</span>}
      </div>
      {state === 'ready' && (
        <>
          <span className="ap-3dnote">Drag to turn, scroll to zoom.</span>
          <div className="ap-3dbar" role="group" aria-label="Viewer">
            {(['lit', 'clay', 'wire'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); viewer.current?.mode(m); }}>{m === 'lit' ? 'Lit' : m === 'clay' ? 'Clay' : 'Wireframe'}</button>
            ))}
            <span className="ap-sep" />
            <button type="button" aria-pressed={spin} onClick={() => { setSpin(!spin); viewer.current?.spin(!spin); }}>Turntable</button>
          </div>
        </>
      )}
    </>
  );
}

/** Picks a wiki entry (or a type, once types have pictures) to give this asset's picture to. */
function UsePicker({ asset, project, onClose, onUsed }: { asset: Asset; project: Project; onClose: () => void; onUsed: () => void }) {
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const types = useStore((s) => s.entryTypes);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  // Type pictures are a type edit: only for people who manage the project.
  const hook = useStore((st) => canManageProject(st, project)) ? typePicture() : null;
  const entries = useMemo(() => campaignLore(cards.values(), project.id, decks)
    .map((c) => ({ c, t: entryTitle(c) }))
    .filter(({ t }) => !q.trim() || t.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((x, y) => x.t.localeCompare(y.t))
    .slice(0, 200), [cards, decks, project.id, q]);
  const typeList = hook ? [...types.values()].filter((t) => t.projectId === project.id && (!q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()))) : [];

  const use = async (fn: () => Promise<unknown>, name: string) => {
    setBusy(true);
    try { await fn(); showToast(`${asset.title} is now a picture of ${name}`, 'info', 3000); onUsed(); onClose(); } catch (e) { toastError(e, "Couldn't use it"); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Use as a picture of…" onClose={onClose} scroll actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>}>
      <input type="search" className="ap-pick-q" placeholder={hook ? 'Find a type or entry' : 'Find an entry'} aria-label={hook ? 'Find a type or entry' : 'Find an entry'} value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      {hook && typeList.length > 0 && <h3 className="ap-pick-h">Types</h3>}
      {hook && typeList.map((t) => (
        <button key={t.id} type="button" className="ap-pick" disabled={busy} onClick={() => void use(() => hook(asset, t.id), t.name)}>{t.name}</button>
      ))}
      <h3 className="ap-pick-h">Entries</h3>
      {!entries.length && <p className="muted">No wiki entries {q ? 'match' : 'in this project yet'}.</p>}
      {entries.map(({ c, t }) => (
        <button key={c.id} type="button" className="ap-pick" disabled={busy} onClick={() => void use(() => useAssetOn(asset.id, c.id), t)}>
          {t}{c.entryTypeId && types.get(c.entryTypeId) && <span className="muted"> · {types.get(c.entryTypeId)!.name}</span>}
        </button>
      ))}
      <p className="muted ap-pick-note">The entry or type gets its own copy of the picture; deleting the asset leaves it.</p>
    </Dialog>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ASSET_FORS, type AssetFor, type AssetKind } from '../../../../shared/assets';
import { shelfKind, type LibraryPack, type PackIndex, type PackInfo, type PublishedItem } from '../../../../shared/library';
import { ApiError } from '../../api';
import { Dialog } from '../../components/Dialog';
import { libJson, libPicture, packIndex, type LibraryState, type LibraryTarget } from '../../library';
import { addFromUrl, assetMessage, toastError, uploadAsset, type NewAsset } from '../../assets';
import { PictureUrls } from '../../pictureUrls';

type Library = { state: LibraryState; target: LibraryTarget | null } | null;

export function UrlDialog({ projectId, onClose, onAdded }: { projectId: string; onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [f, setF] = useState<AssetFor | ''>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!url.trim()) { setErr('Paste the address of a picture or a .glb.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await addFromUrl(projectId, url.trim(), name.trim(), f || null);
      onAdded();
      onClose();
    } catch (e) {
      setErr(assetMessage(e instanceof ApiError ? e.code : 'network'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add from a URL" onClose={onClose} onSubmit={submit} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
    </>}>
      <label className="field"><span>Picture address</span>
        <input type="url" placeholder="https://…/picture.png" value={url} onChange={(e) => setUrl(e.target.value)} data-autofocus /></label>
      <label className="field"><span>Name (optional)</span>
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>For</span><ForSelect value={f} onChange={setF} /></label>
      {err && <p className="form-error" role="alert">{err}</p>}
      <p className="muted">Questlog downloads the picture and keeps its own copy, so it still shows if the page goes away. A single-file .glb works too.</p>
    </Dialog>
  );
}

export function WebDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="From the web, for concepts" onClose={onClose} actions={<button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>Got it</button>}>
      <p>Coming: a browser add-on (Firefox and Chrome) that puts <b>Add to Questlog</b> on any picture on the web. It lands
        here under Concepts, with the page it came from.</p>
      <p className="muted">It is not in this version. Until then, save the picture and add it from your computer, or use From a URL.</p>
    </Dialog>
  );
}

function ForSelect({ id, value, onChange }: { id?: string; value: AssetFor | ''; onChange: (f: AssetFor | '') => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as AssetFor | '')}>
      <option value="">Nothing in particular</option>
      {ASSET_FORS.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}

const KEEP = 300;
const AT_ONCE = 4;
/** The library pictures of one browser (web/src/pictureUrls.ts), revoked when the browser closes. */
function usePictures(target: LibraryTarget | null): { pic: (path: string | null) => string | null | undefined; reset: () => void } {
  const [, bump] = useState(0);
  const cache = useRef<PictureUrls | null>(null);
  if (!cache.current && target) {
    cache.current = new PictureUrls({
      keep: KEEP, atOnce: AT_ONCE, load: (path) => libPicture(target, path).then((b) => URL.createObjectURL(b)),
      revoke: (u) => URL.revokeObjectURL(u), changed: () => bump((n) => n + 1),
    });
  }
  useEffect(() => () => { cache.current?.dispose(); cache.current = null; }, []);
  cache.current?.frame();
  return {
    pic: (path) => (!path || !cache.current ? null : cache.current.get(path)),
    reset: () => cache.current?.reset(),
  };
}

/** Previous and next page of a grid. */
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pages = Math.ceil(total / PAGE);
  if (pages <= 1) return null;
  // The new page starts at its top.
  const go = (p: number) => { onPage(p); ref.current?.parentElement?.querySelector('.ap-shelfgrid')?.scrollIntoView({ block: 'start' }); };
  return (
    <div className="ap-pager" ref={ref}>
      <button type="button" className="btn btn-ghost" disabled={page === 0} onClick={() => go(page - 1)}>← Previous</button>
      <span className="muted">Page {page + 1} of {pages}</span>
      <button type="button" className="btn btn-ghost" disabled={page >= pages - 1} onClick={() => go(page + 1)}>Next →</button>
    </div>
  );
}

function Unavailable({ what, library }: { what: string; library: Library }) {
  if (!library) return <p className="muted">Asking your team's server…</p>;
  if (library.state === 'none') return <p className="ap-note">{what} needs a team server. Questlog reads it from your team's library service, and this workspace has none.</p>;
  return <p className="ap-note">{what} is not available on this server yet. It needs your team's library service, version 0.7.0 or later. Adding from your computer and from a URL still works.</p>;
}

/** One "Add to Questlog" button: copies the picture and a link back. */
function AddButton({ make }: { make: () => Promise<void> }) {
  const [st, setSt] = useState<'idle' | 'busy' | 'done'>('idle');
  return (
    <button type="button" className="btn" disabled={st !== 'idle'} onClick={async () => {
      setSt('busy');
      try { await make(); setSt('done'); } catch (e) { toastError(e, "Couldn't add it"); setSt('idle'); }
    }}>{st === 'done' ? 'Added ✓' : st === 'busy' ? 'Adding…' : 'Add to Questlog'}</button>
  );
}

const PAGE = 60;
const lastSeg = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const stampOf = (p: LibraryPack) => {
  const f = p.files?.find((x) => x.name === 'index.json');
  return f ? { size: f.size, mtime: f.mtime } : null;
};

export function ShelfBrowser({ projectId, library, onClose, onAdded }: { projectId: string; library: Library; onClose: () => void; onAdded: () => void }) {
  const t = library?.state === 'ok' ? library.target : null;
  const { pic, reset } = usePictures(t);
  const [packs, setPacks] = useState<(LibraryPack & { info?: PackInfo })[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<LibraryPack & { info?: PackInfo } | null>(null);
  const [idx, setIdx] = useState<PackIndex | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [packPage, setPackPage] = useState(0);
  const [f, setF] = useState<AssetFor | ''>('');
  const added = useRef(false);
  const close = () => { if (added.current) onAdded(); onClose(); };

  useEffect(() => {
    if (!t) return;
    let on = true;
    (async () => {
      const list = (await libJson(t, 'library')) as LibraryPack[];
      const rows: (LibraryPack & { info?: PackInfo })[] = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.id === 'string' && stampOf(p));
      if (on) setPacks(rows);
      // Titles and covers from each pack's small pack.json, a few at a time.
      for (let i = 0; i < rows.length && on; i += AT_ONCE) {
        const infos = await Promise.all(rows.slice(i, i + AT_ONCE).map((p) => (p.files.some((x) => x.name === 'pack.json')
          ? libJson(t, `library/${p.id}/index/pack.json`).catch(() => ({})) : Promise.resolve({})) as Promise<PackInfo>));
        if (!on) return;
        infos.forEach((info, j) => { rows[i + j] = { ...rows[i + j], info }; });
        setPacks([...rows]);
      }
    })().catch(() => { if (on) setErr("Couldn't read the library. Try again in a moment."); });
    return () => { on = false; };
  }, [t]);

  useEffect(() => {
    if (!t || !open) return;
    let on = true;
    setIdx(null);
    setPage(0);
    reset();
    packIndex(t, open.id, stampOf(open)!).then((i) => { if (on) setIdx(i); }, () => { if (on) setErr("Couldn't read that pack."); });
    return () => { on = false; };
  }, [t, open]);

  const assets = useMemo(() => (idx?.assets ?? []).filter((a) => !q.trim() || `${a.name ?? ''} ${a.path}`.toLowerCase().includes(q.trim().toLowerCase())), [idx, q]);
  const packTitle = (p: LibraryPack & { info?: PackInfo }) => (typeof p.info?.title === 'string' && p.info.title) || p.id;

  return (
    <Dialog title="Asset Shelf" wide scroll onClose={close} actions={<button type="button" className="btn btn-ghost" onClick={close}>Close</button>}>
      {!t ? <Unavailable what="Asset Shelf" library={library} /> : (
        <>
          <div className="ap-srcbar">
            {open && <button type="button" className="btn btn-ghost" onClick={() => { setOpen(null); setQ(''); reset(); }}>← Packs</button>}
            {open && <b>{packTitle(open)}</b>}
            <span className="ap-sp" />
            {open && <input type="search" placeholder="Find in this pack" aria-label="Find in this pack" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); reset(); }} />}
            <label className="ap-srcfor">Tag new ones as <ForSelect value={f} onChange={setF} /></label>
          </div>
          {err && <p className="form-error" role="alert">{err}</p>}
          {!open && (packs === null ? <p className="muted">Reading the library…</p> : !packs.length ? <p className="muted">The library has no packs yet.</p> : (
            <>
            <div className="ap-shelfgrid">
              {packs.slice(packPage * PAGE, (packPage + 1) * PAGE).map((p) => {
                const cover = typeof p.info?.cover === 'string' ? pic(`library/${p.id}/index/${p.info.cover}`) : null;
                return (
                  <button key={p.id} type="button" className="ap-shelfit ap-pack" onClick={() => { setIdx(null); reset(); setOpen(p); }}>
                    {cover ? <img src={cover} alt="" /> : <span className="ap-thumb-empty" />}
                    <b>{packTitle(p)}</b>
                    {p.info?.category && <span className="muted">{p.info.category}</span>}
                  </button>
                );
              })}
            </div>
            <Pager page={packPage} total={packs.length} onPage={(n) => { setPackPage(n); reset(); }} />
            </>
          ))}
          {open && (idx === null ? <p className="muted">Reading the pack…</p> : (
            <>
              <div className="ap-shelfgrid">
                {assets.slice(page * PAGE, (page + 1) * PAGE).map((a) => {
                  const thumb = a.thumb ? pic(`library/${open.id}/index/${a.thumb}`) : null;
                  const name = a.name || lastSeg(a.path);
                  const make = async () => {
                    if (!a.thumb) throw new ApiError(409, 'no_picture');
                    const blob = await libPicture(t, `library/${open.id}/index/${a.thumb}`);
                    const kind: AssetKind = shelfKind(a.class);
                    const meta: NewAsset = { projectId, title: name, kind, for: f || null, source: 'asset-shelf', link: { kind: 'asset', pack: open.id, path: a.path, packTitle: packTitle(open) } };
                    await uploadAsset(meta, blob);
                    added.current = true;
                  };
                  return (
                    <div key={a.path} className="ap-shelfit">
                      {thumb ? <img src={thumb} alt="" /> : <span className="ap-thumb-empty" />}
                      <b title={a.path}>{name}</b>
                      {a.class && <span className="muted">{a.class}</span>}
                      {a.thumb ? <AddButton make={make} /> : <span className="muted">No picture</span>}
                    </div>
                  );
                })}
              </div>
              {!assets.length && <p className="muted">Nothing in this pack matches.</p>}
              <Pager page={page} total={assets.length} onPage={(n) => { setPage(n); reset(); }} />
            </>
          ))}
          <p className="muted">Only the picture comes into Questlog, with a link back to the asset. The model itself stays in Asset Shelf.</p>
        </>
      )}
    </Dialog>
  );
}

export function GroundworkBrowser({ projectId, library, onClose, onAdded }: { projectId: string; library: Library; onClose: () => void; onAdded: () => void }) {
  const t = library?.state === 'ok' ? library.target : null;
  const { pic, reset } = usePictures(t);
  const [tab, setTab] = useState<'maps' | 'props'>('maps');
  const [rows, setRows] = useState<PublishedItem[] | null>(null);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<AssetFor | ''>('');
  const added = useRef(false);
  const close = () => { if (added.current) onAdded(); onClose(); };

  useEffect(() => {
    if (!t) return;
    let on = true;
    setRows(null);
    setErr(null);
    setPage(0);
    reset();
    libJson(t, tab).then((l) => { if (on) setRows((Array.isArray(l) ? l : []).filter((x) => x && typeof x.id === 'string' && Number.isInteger(x.version))); },
      () => { if (on) setErr("Couldn't read Groundwork's list. Try again in a moment."); });
    return () => { on = false; };
  }, [t, tab]);

  return (
    <Dialog title="Groundwork" wide scroll onClose={close} actions={<button type="button" className="btn btn-ghost" onClick={close}>Close</button>}>
      {!t ? <Unavailable what="Groundwork" library={library} /> : (
        <>
          <div className="ap-srcbar">
            <div className="ap-kinds" role="group" aria-label="Kind">
              <button type="button" aria-pressed={tab === 'maps'} onClick={() => { if (tab !== 'maps') { setRows(null); setTab('maps'); } }}>Maps</button>
              <button type="button" aria-pressed={tab === 'props'} onClick={() => { if (tab !== 'props') { setRows(null); setTab('props'); } }}>Props</button>
            </div>
            <span className="ap-sp" />
            <label className="ap-srcfor">Tag new ones as <ForSelect value={f} onChange={setF} /></label>
          </div>
          {err && <p className="form-error" role="alert">{err}</p>}
          {rows === null && !err ? <p className="muted">Reading Groundwork…</p> : rows && !rows.length ? <p className="muted">Nothing published yet.</p> : (
            <div className="ap-shelfgrid">
              {(rows ?? []).slice(page * PAGE, (page + 1) * PAGE).map((m) => {
                const path = `${tab}/${m.id}/picture?version=${m.version}`;
                const src = pic(path);
                const make = async () => {
                  const blob = await libPicture(t, path);
                  await uploadAsset({ projectId, title: m.name || m.id, kind: tab === 'maps' ? 'map' : 'model', for: f || (tab === 'maps' ? 'Places' : null), source: 'groundwork',
                    link: { kind: tab === 'maps' ? 'map' : 'prop', id: m.id, version: m.version } }, blob);
                  added.current = true;
                };
                return (
                  <div key={m.id} className="ap-shelfit">
                    {src ? <img src={src} alt="" /> : <span className="ap-thumb-empty">{src === null ? 'No picture' : ''}</span>}
                    <b>{m.name || m.id}</b>
                    <span className="muted">Version {m.version}{m.publishedBy?.name ? ` · ${m.publishedBy.name}` : ''}</span>
                    {src === null ? <span className="muted">No picture</span> : <AddButton make={make} />}
                  </div>
                );
              })}
            </div>
          )}
          {rows && <Pager page={page} total={rows.length} onPage={(n) => { setPage(n); reset(); }} />}
          <p className="muted">Only the picture from above comes in, with a link back. The map or prop stays in Groundwork.</p>
        </>
      )}
    </Dialog>
  );
}

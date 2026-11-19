// The body of one typed block on an entry page (or on the example beside a template): lines, steps, a table, links to
// entries, a model, a picture, a map, pictures in a row. Each one edits in place and saves through wiki/setBlock; text
// blocks and Facts are drawn by EntryBlocks (the markdown's sections and the infobox).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetKind } from '../../../../shared/assets';
import { titleOf } from '../../../../shared/cards';
import { BLOCK_LIMITS } from '../../../../shared/blocks';
import type { Block, BlockData, Card, EntryType, Project } from '../../../../shared/types';
import { useStore } from '../../store';
import { Link } from '../../router';
import { pictureUrl, toastError, uploadAsset } from '../../assets';
import { campaignLore, entriesOfTypes, entryPath } from '../../wiki';
import { CardPicker } from '../CardPicker';
import { Icon } from '../icons';
import { TypePicture } from './TypePicture';

export interface BlockBodyProps {
  block: Block;
  data: BlockData | undefined;
  type: EntryType;
  project: Project;
  /** The project's assets, for pictures and pickers (null while they load, or when the page has no such block). */
  assets: Asset[] | null;
  /** Given, the block edits in place and saves through this (null clears it). */
  onSave?: (data: BlockData | null) => Promise<unknown>;
  /** The entry, so a links block leaves it out of its own candidates. */
  card?: Card | null;
}

const ASSET_KIND: Partial<Record<Block['kind'], AssetKind>> = { model: 'model', map: 'map' };

export function BlockBody(p: BlockBodyProps) {
  switch (p.block.kind) {
    case 'lines': case 'steps': return <ListBlock {...p} />;
    case 'table': return <TableBlock {...p} />;
    case 'links': return <LinksBlock {...p} />;
    case 'gallery': return <GalleryBlock {...p} />;
    case 'model': case 'picture': case 'map': return <AssetBlock {...p} />;
    default: return null;
  }
}

/** Save, then leave edit mode; a failed save keeps the editor open (the error is toasted). */
function useSaving(onSave: BlockBodyProps['onSave'], done: () => void) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    save: async (d: BlockData | null) => {
      if (!onSave || busy) return;
      setBusy(true);
      try { await onSave(d); done(); } catch { /* toast */ } finally { setBusy(false); }
    },
  };
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="btn btn-sm btn-ghost eblk-edit" onClick={onClick}><Icon name="edit" size={13} /> {label}</button>;
}

/** Lines (barks): one per line; Steps: numbered. Grey prompt while empty. */
function ListBlock({ block, data, onSave }: BlockBodyProps) {
  const items = data?.items ?? [];
  const [text, setText] = useState<string | null>(null);
  const { busy, save } = useSaving(onSave, () => setText(null));
  const Tag = block.kind === 'steps' ? 'ol' : 'ul';
  if (text !== null) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return (
      <div className="eblk-form">
        <textarea autoFocus rows={Math.min(12, Math.max(3, lines.length + 1))} aria-label={block.title} value={text} placeholder={block.prompt}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setText(null); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save(lines.length ? { items: lines } : null); }} />
        <span className="thint">{block.kind === 'steps' ? 'One step per line.' : 'One line each.'}{lines.length > BLOCK_LIMITS.items && ` At most ${BLOCK_LIMITS.items}.`}</span>
        <div className="row">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setText(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || lines.length > BLOCK_LIMITS.items} onClick={() => void save(lines.length ? { items: lines } : null)}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <>
      {items.length
        ? <Tag className="blist">{items.map((x, i) => <li key={i}>{x}</li>)}</Tag>
        : <Tag className="blist ph"><li>{block.prompt || (block.kind === 'steps' ? 'One step each.' : 'One short line each.')}</li></Tag>}
      {onSave && <EditButton label={items.length ? 'Edit' : block.kind === 'steps' ? 'Add steps' : 'Add lines'} onClick={() => setText(items.join('\n'))} />}
    </>
  );
}

/** A table: the block's columns, the entry's rows. Edits as a grid of cells; empty rows are dropped on save. */
function TableBlock({ block, data, onSave }: BlockBodyProps) {
  const cols = block.cols ?? [];
  const rows = data?.rows ?? [];
  const width = Math.max(cols.length, ...rows.map((r) => r.length));
  const heads = Array.from({ length: width }, (_, i) => cols[i] ?? `Column ${i + 1}`);
  const [draft, setDraft] = useState<string[][] | null>(null);
  const { busy, save } = useSaving(onSave, () => setDraft(null));
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  if (draft !== null) {
    const set = (ri: number, ci: number, v: string) => setDraft(draft.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? v : c)) : r)));
    const kept = draft.filter((r) => r.some((c) => c.trim()));
    return (
      <div className="eblk-form">
        <table className="btab btab-edit">
          <thead><tr>{heads.map((h, i) => <th key={i}>{h}</th>)}<th aria-label="Remove" /></tr></thead>
          <tbody>
            {draft.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => <td key={ci}><input aria-label={`${heads[ci]}, row ${ri + 1}`} value={c} maxLength={BLOCK_LIMITS.cellChars} autoFocus={ri === draft.length - 1 && ci === 0 && !c}
                  onChange={(e) => set(ri, ci, e.target.value)} /></td>)}
                <td><button type="button" className="tb" aria-label={`Remove row ${ri + 1}`} onClick={() => setDraft(draft.filter((_, i) => i !== ri))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={draft.length >= BLOCK_LIMITS.rows} onClick={() => setDraft([...draft, heads.map(() => '')])}>+ Row</button>
          <span className="sp" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save(kept.length ? { rows: kept } : null)}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <table className="btab">
        <thead><tr>{heads.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length ? rows.map((r, i) => <tr key={i}>{pad(r).map((c, j) => <td key={j}>{c}</td>)}</tr>)
            : <tr>{heads.map((_, j) => <td key={j} className="ph">…</td>)}</tr>}
        </tbody>
      </table>
      {onSave && <EditButton label={rows.length ? 'Edit rows' : 'Add rows'} onClick={() => setDraft(rows.length ? rows.map(pad) : [heads.map(() => '')])} />}
    </>
  );
}

/** Links to entries of a type (`to`; any type when empty): chips that open them; × and "Add…" save at once. */
function LinksBlock({ block, data, project, onSave, card }: BlockBodyProps) {
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const types = useStore((s) => s.entryTypes);
  const ids = data?.cardIds ?? [];
  const linked = ids.map((id) => cards.get(id)).filter((c): c is Card => !!c && c.visibility !== 'deleted');
  const target = block.to ? [...types.values()].find((t) => t.projectId === project.id && t.key === block.to) : undefined;
  const set = (next: string[]) => void onSave?.(next.length ? { cardIds: next } : null).catch(() => {});
  return (
    <div className="blinks">
      {linked.map((c) => (
        <span key={c.id} className="chipx">
          <Link href={entryPath(project.seq, c)}>{titleOf(c.content)}</Link>
          {onSave && <button type="button" className="chip-x" aria-label={`Remove ${titleOf(c.content)}`} onClick={() => set(ids.filter((x) => x !== c.id))}>×</button>}
        </span>
      ))}
      {!linked.length && !onSave && <span className="chipx ph">Pick {target ? `${target.name} entries` : 'entries'}…</span>}
      {onSave && ids.length < BLOCK_LIMITS.links && (
        <CardPicker label={`Add to ${block.title}`} trigger={<>+ {target ? target.name : 'Entry'}</>} triggerClass="chipx chipx-add" searchLabel="Search entries" empty="No matching entries"
          candidates={() => entriesOfTypes(types, campaignLore(cards.values(), project.id, decks), block.to ? [block.to] : []).filter((c) => c.id !== card?.id && !ids.includes(c.id))}
          onPick={(c) => set([...ids, c.id])} />
      )}
    </div>
  );
}

/** A picture of an asset, or nothing when it is gone or has none. */
function AssetPicture({ asset, className }: { asset: Asset | undefined; className: string }) {
  return asset?.hasPicture ? <img className={className} src={pictureUrl(asset)} alt="" loading="lazy" decoding="async" /> : null;
}

/** Model, Picture or Map: one asset. Empty: the type's picture (Picture) or a grey prompt; managers of text pick one. */
function AssetBlock({ block, data, type, project, assets, onSave }: BlockBodyProps) {
  const [picking, setPicking] = useState(false);
  const asset = data?.assetId ? assets?.find((a) => a.id === data.assetId) : undefined;
  const save = (d: BlockData | null) => void onSave?.(d).catch(() => {});
  const empty = block.kind === 'model' ? 'Pick a model from Asset Shelf. Its picture shows here.'
    : block.kind === 'map' ? 'Pick a map from Groundwork.' : 'Pick a picture, or upload one.';
  return (
    <div className="basset">
      {block.kind === 'model' ? (
        <div className="bmodel">
          <span className="cube">{asset?.hasPicture ? <AssetPicture asset={asset} className="cube-img" /> : <Icon name="asset" size={26} />}</span>
          <span>{asset ? <><b>{asset.title}</b><br /><span className="bprompt">{asset.source === 'asset-shelf' ? 'from Asset Shelf' : asset.hasModel ? '3D model' : 'model'}</span></> : <span className="bprompt">{empty}</span>}</span>
        </div>
      ) : block.kind === 'map' ? (
        <div className="bmap">{asset?.hasPicture && <AssetPicture asset={asset} className="bmap-img" />}<span>{asset ? asset.title : empty}</span></div>
      ) : asset ? <div className="bpic"><AssetPicture asset={asset} className="bpic-img" /></div>
        : <TypePicture type={type} size="tile" className="bpic" />}
      {onSave && (
        <div className="row eblk-tools">
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={picking} onClick={() => setPicking((v) => !v)}><Icon name="asset" size={13} /> {asset ? 'Change' : 'Pick'}</button>
          {data?.assetId && <button type="button" className="btn btn-sm btn-ghost" onClick={() => save(null)}>Clear</button>}
        </div>
      )}
      {picking && onSave && (
        <AssetPicker project={project} assets={assets} kind={ASSET_KIND[block.kind]} upload={block.kind === 'picture'} title={block.title}
          onPick={(a) => { setPicking(false); save({ assetId: a.id }); }} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

/** Pictures in a row: several assets' pictures; add and remove save at once. */
function GalleryBlock({ block, data, project, assets, onSave }: BlockBodyProps) {
  const [picking, setPicking] = useState(false);
  const ids = data?.assetIds ?? [];
  const shown = ids.map((id) => assets?.find((a) => a.id === id)).filter((a): a is Asset => !!a);
  const set = (next: string[]) => void onSave?.(next.length ? { assetIds: next } : null).catch(() => {});
  return (
    <>
      <div className="bgal">
        {shown.length ? shown.map((a) => (
          <span key={a.id} className="bgal-item" title={a.title}>
            <AssetPicture asset={a} className="bgal-img" />
            {onSave && <button type="button" className="chip-x" aria-label={`Remove ${a.title}`} onClick={() => set(ids.filter((x) => x !== a.id))}>×</button>}
          </span>
        )) : [0, 1, 2].map((i) => <span key={i} className="bgal-ph" />)}
      </div>
      {onSave && ids.length < BLOCK_LIMITS.pictures && <EditButton label="Add a picture" onClick={() => setPicking(true)} />}
      {picking && onSave && (
        <AssetPicker project={project} assets={assets} upload title={block.title} exclude={ids}
          onPick={(a) => { setPicking(false); set([...ids, a.id]); }} onClose={() => setPicking(false)} />
      )}
    </>
  );
}

/** At most this many assets are drawn in a picker at once; a search narrows the rest. */
const PICKER_SHOWN = 48;

/** The project's assets (of a kind, when given) as small pictures with a search; Picture blocks can upload one. */
function AssetPicker({ project, assets, kind, upload, title, exclude = [], onPick, onClose }: {
  project: Project; assets: Asset[] | null; kind?: AssetKind; upload?: boolean; title: string; exclude?: string[];
  onPick: (a: Asset) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (assets ?? []).filter((a) => (!kind || a.kind === kind) && a.hasPicture && !exclude.includes(a.id) && (!needle || a.title.toLowerCase().includes(needle)));
  }, [assets, kind, q, exclude]);
  const add = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { onPick(await uploadAsset({ projectId: project.id, title: f.name.replace(/\.[^.]+$/, '') || 'Picture', kind: 'picture' }, f)); } catch (e) { toastError(e, `Couldn't add ${f.name}`); } finally { setBusy(false); }
  };
  const what = kind === 'model' ? '3D models' : kind === 'map' ? 'maps' : 'pictures';
  return (
    <div ref={box} className="apick" role="dialog" aria-label={`Pick for ${title}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="row">
        <input type="search" autoFocus placeholder={`Find ${what}`} aria-label={`Find ${what}`} value={q} onChange={(e) => setQ(e.target.value)} />
        {upload && <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => file.current?.click()}><Icon name="upload" size={13} /> Upload…</button>
          <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void add(e.target.files?.[0])} />
        </>}
      </div>
      {assets === null ? <p className="hint">Loading the project's assets…</p>
        : !list.length ? <p className="hint">No {what} in this project's Assets yet{kind === 'model' ? ': add them from Asset Shelf or your computer on the Assets page.' : kind === 'map' ? ': add them from Groundwork on the Assets page.' : '.'}</p>
        : (
          <div className="apick-grid">
            {list.slice(0, PICKER_SHOWN).map((a) => (
              <button key={a.id} type="button" title={a.title} onClick={() => onPick(a)}>
                <img src={pictureUrl(a)} alt="" loading="lazy" decoding="async" /><span>{a.title}</span>
              </button>
            ))}
          </div>
        )}
      {list.length > PICKER_SHOWN && <p className="hint">{list.length - PICKER_SHOWN} more: type to narrow them down.</p>}
    </div>
  );
}

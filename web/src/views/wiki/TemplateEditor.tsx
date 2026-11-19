// A type's Template edited as a page of blocks (redesign decision 9, the preview's templateHtml/bindTemplate): a banner
// with Guided start, Next to an entry, Bring entries up to date and Try a new X; each block with its title, ↑ ↓, half or
// full width and ×; "+ Add block". Changes are a draft until Done. Beside it, an entry of the type (a real one when there
// is one, else a labelled example) laid out by the draft, so it follows every edit.
import { useMemo, useState } from 'react';
import { ASKED, BLOCK_KINDS, BLOCK_LABELS, bodyOf, bringUpToDate, isOutdated, layoutOf, newBlock, newBlockId, newEntryContent, pageOf } from '../../../../shared/blocks';
import { titleOf } from '../../../../shared/cards';
import type { Block, BlockKind, Card, EntryLayout, EntryType, Project, TypePage } from '../../../../shared/types';
import { dispatch } from '../../api';
import { useStore } from '../../store';
import { Icon, type IconName } from '../../components/icons';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntryBlocks } from '../../components/wiki/EntryBlocks';
import { tryNewEntry } from '../../components/wiki/GuidedStart';

const KIND_ICON: Record<BlockKind, IconName> = {
  text: 'text', facts: 'card', model: 'asset', picture: 'asset', map: 'globe', lines: 'more', steps: 'task', table: 'frame', links: 'link', gallery: 'frame',
};
const HINT: Partial<Record<BlockKind, string>> = {
  text: 'Shown grey until someone writes over it', lines: 'One line each; shown grey until someone adds lines', steps: 'One step each; shown grey until someone adds steps',
};
const BODY_NOTE: Partial<Record<BlockKind, string>> = {
  facts: "The type's fields, as in the infobox.", model: 'A model from the project\'s Assets (Asset Shelf brings its picture).',
  picture: "A picture from the project's Assets, or an upload. Empty, the type's picture shows.", map: "A map from the project's Assets (from Groundwork).",
  gallery: "A row of pictures from the project's Assets.",
};

/** Example entries for the starter types (the preview's EXAMPLES), shown when the type has no entry yet. */
const EXAMPLES: Record<string, { name: string; facts: Record<string, string>; lists?: Record<string, string[]>; tables?: Record<string, string[][]> }> = {
  npc: { name: 'Ásdís', facts: { 'Found in': 'The beach', Job: 'quest_giver', 'Can die': 'No' }, lists: { Barks: ['Mind the tide.', 'Got any fish?'] } },
  creature: { name: 'Drowned Man', facts: { 'Spawns in': 'The Strand', Tameable: 'No', Health: '120' }, tables: { Attacks: [['Grab', '12', '0.8']], Drops: [['Wet rag', '60', '1']] } },
  mission: { name: 'Tutorial: cooking', facts: { 'Given by': 'Ásdís', Zone: 'The beach', 'Can be skipped': 'Yes' }, lists: { Steps: ['Find fish', 'Find cheese', 'Cook them'] } },
  location: { name: 'The beach', facts: { 'Zone tier': '0', Biome: 'beach' } },
};

const BESIDE_KEY = 'jt:templateBeside';
const readBeside = () => { try { return localStorage.getItem(BESIDE_KEY) !== '0'; } catch { return true; } };
const writeBeside = (on: boolean) => { try { localStorage.setItem(BESIDE_KEY, on ? '1' : '0'); } catch { /* not remembered */ } };

type Draft = { guided: boolean; blocks: Block[] };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function TemplateEditor({ project, type }: { project: Project; type: EntryType }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const cards = useStore((s) => s.cards);
  const { page, owner } = pageOf(entryTypes, type.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [beside, setBeside] = useState(readBeside);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'update' | 'follow' | null>(null);
  const shown: Draft = draft ?? { guided: page.guided, blocks: page.blocks };
  const parent = type.parentTypeId ? entryTypes.get(type.parentTypeId) : undefined;
  const following = owner && owner.id !== type.id ? owner : null;
  const change = (fn: (d: Draft) => Draft) => setDraft(fn({ guided: shown.guided, blocks: shown.blocks.map((b) => ({ ...b })) }));
  const set = (id: string, patch: Partial<Block>) => change((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const move = (id: string, by: number) => change((d) => {
    const i = d.blocks.findIndex((b) => b.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= d.blocks.length) return d;
    [d.blocks[i], d.blocks[j]] = [d.blocks[j], d.blocks[i]];
    return d;
  });
  const add = (kind: BlockKind) => {
    const taken = new Set(shown.blocks.map((b) => b.id));
    let id = newBlockId();
    while (taken.has(id)) id = newBlockId();
    change((d) => ({ ...d, blocks: [...d.blocks, newBlock(kind, id)] }));
    setAdding(false);
  };
  const valid = shown.blocks.every((b) => b.title.trim());
  const done = async () => {
    if (!draft || !valid || busy) return;
    setBusy(true);
    try {
      const blocks = draft.blocks.map((b) => ({ ...b, title: b.title.trim() }));
      await dispatch('wiki', 'setPage', { typeId: type.id, page: { guided: draft.guided, blocks } });
      setDraft(null);
    } catch { /* toast */ } finally { setBusy(false); }
  };

  // The entry beside: the type's newest real entry, else a made-up example (labelled).
  const real = useMemo(() => {
    let best: Card | null = null;
    for (const c of cards.values()) if (c.entryTypeId === type.id && c.visibility !== 'deleted' && (!best || c.lastUpdatedAt > best.lastUpdatedAt)) best = c;
    return best;
  }, [cards, type.id]);
  const pageShown: TypePage = { version: page.version, guided: shown.guided, blocks: shown.blocks };

  return (
    <div className="tpl">
      <div className="tmode" role="region" aria-label="Template">
        <span>Editing the <b>{type.name}</b> template. New {type.name} entries start like this; entries made before keep their own page.</span>
        <span className="sp" />
        <label className="tog"><input type="checkbox" checked={shown.guided} onChange={(e) => change((d) => ({ ...d, guided: e.target.checked }))} /> Guided start</label>
        <label className="tog"><input type="checkbox" checked={beside} onChange={(e) => { setBeside(e.target.checked); writeBeside(e.target.checked); }} /> Next to an entry</label>
        <button type="button" className="btn btn-sm" disabled={!!draft} title={draft ? 'Save the template first' : undefined} onClick={() => setDialog('update')}>Bring entries up to date…</button>
        <button type="button" className="btn btn-sm" onClick={() => tryNewEntry({ project, type }, pageShown)}>Try a new {type.name}</button>
        {draft && <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !valid} onClick={() => void done()}>Done</button>
        </>}
      </div>
      <p className="tfollow">
        {following ? <>Follows the <b>{following.name}</b> template. Your first change makes {type.name}'s own copy.</>
          : owner ? (parent && <>{type.name} has its own template.
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDialog('follow')}>Follow {parent.name} again</button></>)
          : <>Made from the type's page headings until you change it.</>}
      </p>

      <div className={beside ? 'tsplit on' : 'tsplit'}>
        {beside && (
          <section className="tside" aria-label="Example entry">
            {real ? <RealExample card={real} type={type} project={project} page={pageShown} ownerId={type.id} />
              : <MadeUpExample type={type} project={project} page={pageShown} />}
          </section>
        )}
        <section className="tedit" aria-label="Template blocks">
          <div className="tgrid">
            {shown.blocks.map((b, i) => (
              <div key={b.id} className={`tblk ${b.width}`} data-block={b.id} role="group" aria-label={`Block ${b.title || 'Untitled'}`}>
                <div className="tbar">
                  <span className="tkind" title={BLOCK_LABELS[b.kind]}><Icon name={KIND_ICON[b.kind]} size={13} /></span>
                  <input className="ttl-in" aria-label="Block title" maxLength={80} value={b.title} onChange={(e) => set(b.id, { title: e.target.value })} />
                  <button type="button" className="tb" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(b.id, -1)}>↑</button>
                  <button type="button" className="tb" aria-label="Move down" title="Move down" disabled={i === shown.blocks.length - 1} onClick={() => move(b.id, 1)}>↓</button>
                  <button type="button" className="tb wide" aria-label={b.width === 'full' ? 'Make half width' : 'Make full width'} title={b.width === 'full' ? 'Half width' : 'Full width'}
                    onClick={() => set(b.id, { width: b.width === 'full' ? 'half' : 'full' })}>{b.width === 'full' ? '½' : '1'}</button>
                  <button type="button" className="tb" aria-label="Remove block" title="Remove" onClick={() => change((d) => ({ ...d, blocks: d.blocks.filter((x) => x.id !== b.id) }))}>×</button>
                </div>
                <BlockSettings block={b} project={project} guided={shown.guided} onChange={(patch) => set(b.id, patch)} />
              </div>
            ))}
          </div>
          {!shown.blocks.length && <p className="hint">No blocks: a new {type.name} would be an empty page. Add one below.</p>}
          <div className="taddw">
            <button type="button" className="btn btn-sm" aria-expanded={adding} disabled={shown.blocks.length >= 40} onClick={() => setAdding((v) => !v)}>+ Add block</button>
            {adding && (
              <div className="tmenu" role="menu" onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }}>
                {BLOCK_KINDS.map((k) => <button key={k} type="button" role="menuitem" autoFocus={k === 'text'} onClick={() => add(k)}><Icon name={KIND_ICON[k]} size={14} /> {BLOCK_LABELS[k]}</button>)}
              </div>
            )}
          </div>
        </section>
      </div>

      {dialog === 'update' && <BringUpToDate type={type} page={page} ownerId={owner?.id ?? ''} onClose={() => setDialog(null)} />}
      {dialog === 'follow' && parent && (
        <ConfirmDialog title={`Follow ${parent.name} again?`} confirmLabel={`Follow ${parent.name}`} onClose={() => setDialog(null)}
          onConfirm={() => dispatch('wiki', 'setPage', { typeId: type.id, page: null }).then(() => setDraft(null))}>
          <p>{type.name}'s own template goes, and new {type.name} entries start like {parent.name}'s. Entries made before keep their pages and everything written in them.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** What a block asks for: a writing prompt, a table's columns, the type a links block points at, or a word on what it shows. */
function BlockSettings({ block, project, guided, onChange }: { block: Block; project: Project; guided: boolean; onChange: (p: Partial<Block>) => void }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const [cols, setCols] = useState<string | null>(null);
  if (ASKED.has(block.kind)) {
    return <>
      <textarea className="tprompt" rows={2} maxLength={500} aria-label={`Writing prompt for ${block.title}`} value={block.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />
      <span className="thint">{HINT[block.kind]}{guided ? ', and asked in the guided start' : ''}.</span>
    </>;
  }
  if (block.kind === 'table') {
    const commit = () => {
      if (cols === null) return;
      const next = cols.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 12);
      if (next.length) onChange({ cols: next });
      setCols(null);
    };
    return <>
      <input className="tcols" aria-label={`Columns of ${block.title}`} value={cols ?? (block.cols ?? []).join(', ')} onChange={(e) => setCols(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      <span className="thint">Columns, separated by commas.</span>
    </>;
  }
  if (block.kind === 'links') {
    const types = [...entryTypes.values()].filter((t) => t.projectId === project.id).sort((a, b) => a.name.localeCompare(b.name));
    return <>
      <select className="tto" aria-label={`What ${block.title} links to`} value={block.to ?? ''} onChange={(e) => onChange({ to: e.target.value })}>
        <option value="">Entries of any type</option>
        {types.map((t) => <option key={t.id} value={t.key}>{t.name} entries</option>)}
      </select>
    </>;
  }
  return <span className="thint">{BODY_NOTE[block.kind]}</span>;
}

/** The type's newest entry, laid out as the draft would lay it out (bring-up-to-date's result: nothing written moves out). */
function RealExample({ card, type, project, page, ownerId }: { card: Card; type: EntryType; project: Project; page: TypePage; ownerId: string }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const layout = bringUpToDate(layoutOf(card, entryTypes), page, bodyOf(card.content).body, ownerId);
  return <>
    <EntryBlocks card={card} content={card.content} layout={layout} type={type} project={project} editable={false} compact
      badge={<span className="ex" title="One of this type's entries, laid out by the template as you edit it">{type.name} entry</span>} />
    <p className="tnote">{titleOf(card.content)} is a {type.name} of this project, shown as the template lays it out. Its own page changes only when it is brought up to date.</p>
  </>;
}

/** No entry yet: a made-up one (the starter examples, else "An example X"), clearly labelled. */
function MadeUpExample({ type, project, page }: { type: EntryType; project: Project; page: TypePage }) {
  const ex = EXAMPLES[type.key] ?? { name: `An example ${type.name}`, facts: {} };
  const { content } = newEntryContent(ex.name, page);
  const data: EntryLayout['data'] = {};
  for (const b of page.blocks) {
    const items = ex.lists?.[b.title];
    const rows = ex.tables?.[b.title];
    if (items && (b.kind === 'lines' || b.kind === 'steps')) data[b.id] = { items };
    if (rows && b.kind === 'table') data[b.id] = { rows };
  }
  return <>
    <EntryBlocks card={null} content={content} layout={{ version: page.version, blocks: page.blocks, data }} type={type} project={project} editable={false} compact
      exampleFacts={ex.facts} badge={<span className="ex">example</span>} />
    <p className="tnote">Made up: {type.name} has no entries yet.</p>
  </>;
}

/**
 * "Bring entries up to date…": the type's entries made from an older version of its template (their own layout is
 * older), each to tick; they take the template's blocks, order and widths and keep everything written.
 */
function BringUpToDate({ type, page, ownerId, onClose }: { type: EntryType; page: TypePage; ownerId: string; onClose: () => void }) {
  const cards = useStore((s) => s.cards);
  const entryTypes = useStore((s) => s.entryTypes);
  const old = useMemo(() => [...cards.values()]
    .filter((c) => c.entryTypeId === type.id && c.visibility !== 'deleted' && c.layout && isOutdated(c.layout, page, ownerId))
    .sort((a, b) => titleOf(a.content).localeCompare(titleOf(b.content))), [cards, type.id, page, ownerId]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(old.map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const added = (c: Card) => {
    const have = new Set((c.layout ?? layoutOf(c, entryTypes)).blocks.map((b) => b.id));
    return page.blocks.filter((b) => !have.has(b.id)).map((b) => b.title);
  };
  const go = async () => {
    setBusy(true);
    let updated = 0;
    try {
      const ids = [...picked];
      for (let i = 0; i < ids.length; i += 500) updated += (await dispatch<{ updated: number }>('wiki', 'bringUpToDate', { typeId: type.id, cardIds: ids.slice(i, i + 500) })).updated;
      setNote(`${plural(updated, 'entry', 'entries')} brought up to date.`);
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="Bring entries up to the template" onClose={onClose} onSubmit={note ? onClose : go}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>{note ? 'Close' : 'Cancel'}</button>
        {!note && old.length > 0 && <button type="submit" className="btn btn-primary" data-autofocus disabled={busy || !picked.size}>Bring up to date</button>}
      </>}>
      <div className="guide" data-testid="bring-up-to-date">
        <div className="gstep">{type.name} template</div>
        {note ? <p role="status">{note}</p> : !old.length ? <p>No {type.name} entries were made before this version of the template.</p> : <>
          <p>{plural(old.length, 'entry was', 'entries were')} made before this version of the template.</p>
          <ul className="uplist">
            {old.map((c) => {
              const a = added(c);
              return (
                <li key={c.id}>
                  <label className="tog"><input type="checkbox" checked={picked.has(c.id)}
                    onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                  <b>{titleOf(c.content)}</b></label>
                  {a.length > 0 && <span className="hint"> adds {a.join(', ')}</span>}
                </li>
              );
            })}
          </ul>
          <ul className="glist">
            <li>adds the template's blocks they don't have, empty</li>
            <li>puts the blocks in the template's order and widths</li>
            <li>keeps everything already written; nothing is removed</li>
          </ul>
        </>}
      </div>
    </Dialog>
  );
}

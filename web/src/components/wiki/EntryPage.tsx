import { taskId } from '../../taskId';
import { useEffect, useId, useMemo, useState } from 'react';
import type { Card, Project } from '../../../../shared/types';
import { cardCode } from '../../../../shared/cards';
import { fieldsOf, typeChain } from '../../../../shared/wiki';
import { bodyOf, layoutOf, placeBlocks, withFacts } from '../../../../shared/blocks';
import { EntryBlocks } from './EntryBlocks';
import { dispatch } from '../../api';
import { canEditCard, settingsOf, useStore } from '../../store';
import { Link } from '../../router';
import { cardHref } from '../../cards';
import { campaignTypes, kindsFrom } from '../../wiki';
import { ContentEditor, LinkIgnores } from '../../views/Card';
import { HistoryTab } from '../HistoryTab';
import { AttachmentsTab } from '../AttachmentsTab';
import { Icon } from '../icons';
import { EntryPreviews, Infobox, TypeBadge } from './Infobox';
import { LinksSection, OpenQuests, WhatLinksHere } from './LinksSection';
import { Storyboard, hasStoryboard } from './Builder';
import { BalanceSections } from './BalanceSections';
import { Aliases } from './Aliases';
import { EntryGraph } from './EntryGraph';
import { newEntryPath } from '../../wiki';
import { dropDraft, hasDraft } from '../../drafts';

/**
 * One wiki entry: title and type, infobox, text, links, what links here, open quests, then History and Attachments.
 * `compact` (a side-by-side panel): type, text, infobox, links and what links here only; one column, no graph tile.
 */
export function EntryPage({ card, project, compact = false }: { card: Card; project: Project; compact?: boolean }) {
  const s = useStore((x) => x);
  const titleId = useId();
  const editable = canEditCard(s, card, project) && card.visibility !== 'deleted';
  // A draft kept from an editor that unmounted (a panel replaced, folded or made the main entry) reopens the editor.
  const [editing, setEditing] = useState(() => card.visibility !== 'deleted' && hasDraft(s.me?.id ?? null, card.id));
  // A deleted entry's kept draft is dropped when it is seen.
  useEffect(() => { if (card.visibility === 'deleted') dropDraft(s.me?.id ?? null, card.id); }, [card.visibility, card.id]);
  const type = card.entryTypeId ? s.entryTypes.get(card.entryTypeId) ?? null : null;
  const types = useMemo(() => campaignTypes(s.entryTypes, project.id), [s.entryTypes, project.id]);
  const kinds = useMemo(() => kindsFrom(s, project.id, type?.id ?? null), [s.linkKinds, s.entryTypes, project.id, type?.id]);
  // Typed entries are laid out by their blocks: their own layout, else their type's page (shared/blocks).
  // A layout without Facts still shows the entry's values: Facts is added at the end when it holds any.
  const layout = useMemo(() => {
    if (!type) return null;
    const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    const held = fieldsOf(s.entryTypes, type.id).some((f) => !f.hidden && !empty(card.fields?.[f.key]));
    return withFacts(layoutOf(card, s.entryTypes), held);
  }, [type, card, s.entryTypes]);
  /** Text blocks of the layout this page has no heading for yet (pages made before the type had them). */
  const missing = layout ? placeBlocks(layout, bodyOf(card.content).body).placed.filter((p) => p.block.kind === 'text' && !p.section).map((p) => p.block.title) : [];
  const blocks = !!type && !!layout && !(editing && editable);
  const linkKinds = kinds.filter((k) => k.key !== 'frames');
  const linked = useMemo(() => new Set([...s.entryLinks.values()].filter((l) => l.fromCardId === card.id && s.cards.has(l.toCardId)).map((l) => l.kindKey)), [s.entryLinks, s.cards, card.id]);
  const deck = card.deckId ? s.decks.get(card.deckId) : null;
  const code = cardCode(card.seq);
  const depth = (id: string) => typeChain(s.entryTypes, id).length - 1;

  return (
    <article className={`entry-page${compact ? ' compact' : ''}`} data-testid={compact ? 'panel-entry' : 'entry-page'} aria-labelledby={titleId}>
      <div className="entry-head">
        <TypeBadge type={type} />
        {type && type.parentTypeId && <span className="hint">{typeChain(s.entryTypes, type.id).slice(0, -1).map((t) => t.name).join(' · ')}</span>}
        {editable && !compact && (
          <select className="entry-type-pick" aria-label="Type" value={card.entryTypeId ?? ''}
            onChange={(e) => void dispatch('wiki', 'setEntry', { cardId: card.id, typeId: e.target.value || null }).catch(() => {})}>
            <option value="">Page (no type)</option>
            {types.map((t) => <option key={t.id} value={t.id}>{'\u00a0\u00a0'.repeat(depth(t.id))}{t.name}</option>)}
          </select>
        )}
        <span className="entry-head-end">
          {card.entryKey && <code className="entry-key" title="Key used by the export">{card.entryKey}</code>}
          <Link href={cardHref(card, deck)} className="btn btn-sm btn-ghost" title="Open as lore in its list"><Icon name="link" size={14} /> {taskId(card)}</Link>
          {editable && !compact && type && card.entryKey && <Link href={newEntryPath(project.seq, type.key, `?copy=${card.entryKey}`)} className="btn btn-sm">Make a variant</Link>}
          {editable && !compact && missing.length > 0 && !editing && (
            <button type="button" className="btn btn-sm" title={`Adds: ${missing.join(', ')}`}
              onClick={() => void dispatch('cards', 'update', { id: card.id, content: [card.content.trimEnd(), ...missing.map((h) => `## ${h}`)].join('\n\n'), contentVersion: card.contentVersion }).catch(() => {})}>Add headings</button>
          )}
          {editable && <button type="button" className="btn btn-sm" disabled={editing} onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit text</button>}
        </span>
      </div>

      {!compact && <Aliases card={card} editable={editable} />}

      {card.visibility === 'archived' && <p className="notice">This lore is archived.</p>}

      {blocks ? (
        <div className="entry-blocks-wrap">
          <EntryPreviews>
            <EntryBlocks card={card} content={card.content} layout={layout!} type={type!} project={project} editable={editable} compact={compact} titleId={titleId}
              onEditText={editable ? () => setEditing(true) : undefined} />
            <LinkIgnores card={card} editable={editable} />
          </EntryPreviews>
          {!compact && <div className="entry-side"><EntryGraph card={card} project={project} /></div>}
        </div>
      ) : <div className="entry-body">
        <EntryPreviews>
          <ContentEditor card={card} titleId={titleId} Heading="h2" editing={editing && editable} onDone={() => setEditing(false)}
            canTick={editable} projectId={project.id} persistDraft />
        </EntryPreviews>
        {(type || !compact) && (
          <div className="entry-side">
            {type && <Infobox card={card} type={type} projectId={project.id} editable={editable} />}
            {!compact && <EntryGraph card={card} project={project} />}
          </div>
        )}
      </div>}

      {!compact && type && <BalanceSections card={card} type={type} projectId={project.id} editable={editable} />}

      {!compact && hasStoryboard(s, card, project.id) && <Storyboard card={card} project={project} editable={editable} />}

      {linkKinds.length > 0 && (
        <div className="entry-sections" aria-label="Links" role="group">
          <h2 className="entry-section-title">Links</h2>
          {linkKinds.filter((k) => linked.has(k.key)).map((k) => <LinksSection key={k.id} card={card} kind={k} projectId={project.id} projectSeq={project.seq} editable={editable} />)}
          {/* Kinds with no link yet stay out of the way: one row of small "add" buttons. */}
          <div className="wk-chips">
            {linkKinds.filter((k) => !linked.has(k.key)).map((k) => <LinksSection key={k.id} card={card} kind={k} projectId={project.id} projectSeq={project.seq} editable={editable} />)}
          </div>
        </div>
      )}
      <div className="entry-sections">
        <WhatLinksHere card={card} projectId={project.id} projectSeq={project.seq} />
        <OpenQuests card={card} />
      </div>

      {!compact && <EntryTabs card={card} editable={editable} />}
    </article>
  );
}

type Tab = 'history' | 'attachments';
/** The card page's History and Attachments tabs, reused. */
function EntryTabs({ card, editable }: { card: Card; editable: boolean }) {
  const s = useStore((x) => x);
  const id = useId();
  const [tab, setTab] = useState<Tab>('history');
  const files = useMemo(() => [...s.files.values()].filter((f) => f.cardId === card.id).length, [s.files, card.id]);
  const tabs: { key: Tab; label: string; count?: number }[] = [{ key: 'history', label: 'History' }, { key: 'attachments', label: 'Attachments', count: files }];
  return (
    <div className="side-tabs">
      <div role="tablist" aria-label="Lore activity" className="tabs"
        onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const n = tab === 'history' ? 'attachments' : 'history'; setTab(n); document.getElementById(`${id}-tab-${n}`)?.focus(); } }}>
        {tabs.map((t) => (
          <button key={t.key} id={`${id}-tab-${t.key}`} type="button" role="tab" className="tab" aria-selected={tab === t.key}
            aria-controls={`${id}-panel`} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>
            {t.label}{!!t.count && <span className="tab-count quiet">{t.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="tab-panel" tabIndex={0}>
        {tab === 'history'
          ? <HistoryTab cardId={card.id} version={card.version} users={s.users} decks={s.decks} cards={s.cards} priorityLabels={settingsOf(s).priorityLabels} />
          : <AttachmentsTab card={card} editable={editable} />}
      </div>
    </div>
  );
}

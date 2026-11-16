import { taskId } from '../../taskId';
import { useMemo, useState } from 'react';
import type { Card, EntryLink, LinkKind, Project } from '../../../../shared/types';
import { cardCode, titleOf } from '../../../../shared/cards';
import { WORKS_ON } from '../../../../shared/wiki';
import { dispatch } from '../../api';
import { canEditContent, useStore } from '../../store';
import { Link } from '../../router';
import { cardHref } from '../../cards';
import { projectIdOf, backlinks, campaignLore, entriesOfTypes, entryPath, formatProps, openQuests, visibleProps, worksOnOf } from '../../wiki';
import { CardPicker } from '../CardPicker';
import { Icon } from '../icons';
import { FieldEditor, entryTitle } from './FieldEditor';
import { useTitleOfKey } from './Infobox';

type Props = Record<string, unknown>;

/** Inputs for a link's properties, editing a draft. */
export function PropsForm({ kind, draft, setDraft, projectId }: { kind: LinkKind; draft: Props; setDraft: (p: Props) => void; projectId: string }) {
  const types = useStore((s) => s.entryTypes);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const titleOfKey = useTitleOfKey(projectId);
  const lore = useMemo(() => campaignLore(cards.values(), projectId, decks), [cards, decks, projectId]);
  return (
    <div className="wiki-props">
      {kind.props.filter((d) => !d.hidden).map((d) => (
        <label key={d.key} className="wiki-prop">
          <span>{d.label}{d.unit ? ` (${d.unit})` : ''}</span>
          <FieldEditor def={d} value={draft[d.key]} instant titleOfKey={titleOfKey} images={[]}
            entries={d.kind === 'entry' || d.kind === 'entries' ? entriesOfTypes(types, lore, d.target ? [d.target] : []) : []}
            onSave={(v) => setDraft({ ...draft, [d.key]: v })} />
        </label>
      ))}
    </div>
  );
}

/** One link kind on an entry page: its links from this entry with their properties, and (for editors) add, edit, remove. */
export function LinksSection({ card, kind, projectId, projectSeq, editable }: {
  card: Card; kind: LinkKind; projectId: string; projectSeq: number; editable: boolean;
}) {
  const links = useStore((s) => s.entryLinks);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const types = useStore((s) => s.entryTypes);
  const titleOfKey = useTitleOfKey(projectId);
  const mine = useMemo(() => [...links.values()].filter((l) => l.fromCardId === card.id && l.kindKey === kind.key && cards.has(l.toCardId))
    .sort((a, b) => a.sortIndex - b.sortIndex), [links, cards, card.id, kind.key]);
  const targets = useMemo(() => entriesOfTypes(types, campaignLore(cards.values(), projectId, decks), kind.toTypes).filter((c) => c.id !== card.id),
    [types, cards, decks, projectId, kind.toTypes, card.id]);
  const hasProps = kind.props.some((d) => !d.hidden);
  /** Adding: the picked target and its property draft; editing: a link id and its draft. */
  const [adding, setAdding] = useState<{ to: Card; props: Props } | null>(null);
  const [editing, setEditing] = useState<{ id: string; props: Props } | null>(null);

  const add = (to: Card, props: Props) =>
    void dispatch('wiki', 'addLink', { kindKey: kind.key, fromCardId: card.id, toCardId: to.id, props: visibleProps(kind.props, props) }).then(() => setAdding(null), () => {});
  const save = (l: EntryLink, props: Props) => void dispatch('wiki', 'updateLink', { id: l.id, props: visibleProps(kind.props, props) }).then(() => setEditing(null), () => {});

  // Nothing linked and nothing being added: only the button that starts one (nothing at all for a reader).
  if (!mine.length && !adding) {
    return editable ? (
      <section className="wiki-links wiki-links-empty" aria-label={kind.label}>
        <CardPicker label={`Add ${kind.label} link`} trigger={<><Icon name="plus" size={14} /> {kind.label}</>} triggerClass="chip" candidates={targets}
          searchLabel="Search lore" empty="No matching lore" onPick={(to) => (hasProps ? setAdding({ to, props: {} }) : add(to, {}))} />
      </section>
    ) : null;
  }
  return (
    <section className="wiki-links" aria-label={kind.label}>
      <h3>{kind.label}</h3>
      <ul className="wiki-link-list">
        {mine.map((l) => {
          const to = cards.get(l.toCardId)!;
          const props = formatProps(kind.props, l.props, titleOfKey);
          return (
            <li key={l.id} data-testid="wiki-link">
              <Link href={entryPath(projectSeq, to)}>{entryTitle(to)}</Link>{props && <span className="muted"> ({props})</span>}
              {editable && editing?.id !== l.id && (
                <span className="wiki-link-actions">
                  {hasProps && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Edit ${kind.label} ${entryTitle(to)}`} onClick={() => setEditing({ id: l.id, props: visibleProps(kind.props, l.props ?? {}) })}><Icon name="edit" size={14} /></button>}
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${kind.label} ${entryTitle(to)}`}
                    onClick={() => void dispatch('wiki', 'removeLink', { id: l.id }).catch(() => {})}><Icon name="trash" size={14} /></button>
                </span>
              )}
              {editing?.id === l.id && (
                <div className="wiki-link-form">
                  <PropsForm kind={kind} draft={editing.props} setDraft={(p) => setEditing({ id: l.id, props: p })} projectId={projectId} />
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => save(l, editing.props)}>Save</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (adding ? (
        <div className="wiki-link-form" aria-label={`New ${kind.label} link`} role="group">
          <span>{kind.label} <strong>{entryTitle(adding.to)}</strong></span>
          <PropsForm kind={kind} draft={adding.props} setDraft={(p) => setAdding({ ...adding, props: p })} projectId={projectId} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => add(adding.to, adding.props)}>Add link</button>
        </div>
      ) : (
        <CardPicker label={`Add ${kind.label} link`} trigger={<><Icon name="plus" size={14} /> Add</>} candidates={targets}
          searchLabel="Search lore" empty="No matching lore" onPick={(to) => (hasProps ? setAdding({ to, props: {} }) : add(to, {}))} />
      ))}
    </section>
  );
}

/** "What links here": links to this entry by reverse label, field references, then mentions in other Lore of the project. */
export function WhatLinksHere({ card, projectId, projectSeq }: { card: Card; projectId: string; projectSeq: number }) {
  const s = useStore((x) => x);
  const titleOfKey = useTitleOfKey(projectId);
  const groups = useMemo(() => backlinks(s, card.id), [s.cards, s.decks, s.entryTypes, s.linkKinds, s.entryLinks, card.id]);
  return (
    <section className="wiki-links" aria-label="What links here">
      <h3>What links here</h3>
      {groups.length === 0 ? <p className="muted">Nothing links here yet.</p> : (
        <ul className="wiki-rel-list">
          {groups.map((g, gi) => {
            // Reverse labels need not be unique: a link group is formatted with its own kind's properties.
            const defs = g.kindId ? s.linkKinds.get(g.kindId)?.props ?? [] : [];
            return (
              <li key={g.kindId ?? `${gi}:${g.group}`} className="wiki-rel" data-testid="backlink-group">
                <span className="wiki-rel-label">{g.group}</span>{' '}
                {g.items.map((it, i) => {
                  const from = s.cards.get(it.cardId)!;
                  const props = it.props ? formatProps(defs, it.props, titleOfKey) : '';
                  return (
                    <span key={`${it.cardId}-${i}`}>
                      {i > 0 && ' · '}
                      <Link href={entryPath(projectSeq, from)}>{entryTitle(from)}</Link>{props && ` (${props})`}
                    </span>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Quests not done yet that work on this entry or mention it. */
export function OpenQuests({ card }: { card: Card }) {
  const s = useStore((x) => x);
  const list = useMemo(() => openQuests(s, card.id), [s.cards, s.entryLinks, card.id]);
  const [name, setName] = useState('');
  const projectId = projectIdOf(s.decks, card);
  const project = projectId ? s.projects.get(projectId) : undefined;
  /** New tasks go to the project's first list that takes tasks. */
  const list0 = [...s.decks.values()].filter((d) => d.projectId === projectId && d.deckType !== 'doc').sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq)[0];
  const add = async () => {
    const title = name.trim();
    if (!title || !list0) return;
    try {
      const r = await dispatch<{ id: string }>('cards', 'create', { deckId: list0.id, content: title });
      await dispatch('wiki', 'addLink', { kindKey: WORKS_ON, fromCardId: r.id, toCardId: card.id });
      setName('');
    } catch { /* toast */ }
  };
  return (
    <section className="wiki-links" aria-label="Open tasks">
      <h3>Open tasks</h3>
      {list0 && project && canEditContent(s, project) && (
        <form className="wk-picked" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="wk-task-in" aria-label={`New task for ${entryTitle(card)}`} placeholder={`New task for ${entryTitle(card)}…`} value={name} maxLength={300} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!name.trim()}>Add to {list0.title}</button>
        </form>
      )}
      {list.length === 0 ? <p className="muted">No open tasks.</p> : (
        <ul className="wiki-link-list">
          {list.map((q) => (
            <li key={q.id}>
              <Link href={cardHref(q, q.deckId ? s.decks.get(q.deckId) : null)} className="wiki-quest">
                <span className="muted">{taskId(q)}</span> {titleOf(q.content) || 'Untitled'}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** On a quest: the Lore entries it works on (works_on links), with add and remove for editors. */
export function WorksOnRow({ card, project, editable }: { card: Card; project: Project; editable: boolean }) {
  const links = useStore((s) => s.entryLinks);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  // Per quest, from an index built once per link change; the lore candidates are listed only while the picker is open.
  const mine = worksOnOf(links, card.id).filter((l) => cards.has(l.toCardId));
  const candidates = () => {
    const taken = new Set(mine.map((l) => l.toCardId));
    return campaignLore(cards.values(), project.id, decks).filter((c) => !taken.has(c.id));
  };
  if (!editable && mine.length === 0) return null;
  return (
    <div className="works-on" role="group" aria-label="Works on">
      <span className="works-on-label">Works on</span>
      {mine.map((l) => {
        const to = cards.get(l.toCardId)!;
        return (
          <span key={l.id} className="chip">
            <Link href={entryPath(project.seq, to)}>{entryTitle(to)}</Link>
            {editable && (
              <button type="button" className="chip-x" aria-label={`Stop working on ${entryTitle(to)}`}
                onClick={() => void dispatch('wiki', 'removeLink', { id: l.id }).catch(() => {})}><Icon name="close" size={12} /></button>
            )}
          </span>
        );
      })}
      {editable && (
        <CardPicker label="Add a wiki entry this task works on" trigger={<><Icon name="plus" size={14} /> Add</>} candidates={candidates}
          searchLabel="Search lore" empty="No matching lore"
          onPick={(to) => void dispatch('wiki', 'addLink', { kindKey: WORKS_ON, fromCardId: card.id, toCardId: to.id }).catch(() => {})} />
      )}
    </div>
  );
}

import { useId, useMemo, useState, type DragEvent } from 'react';
import type { Card, Deck, DeckType, Project, ProjectVisibility, ResolvableContext, Space } from '../../../shared/types';
import { deckCounts } from '../../../shared/cards';
import { dispatch } from '../api';
import { canEditContent, canManageProject, isAdmin, projectVisible, useStore, type State } from '../store';
import { addSpace, moveSpace, removeSpace, spaceLabel, updateSpace, type SpaceInput } from '../spaces';
import { Dialog } from '../components/Dialog';
import { DeckTile } from '../components/DeckTile';
import { DeckDialog } from '../components/DeckDialog';
import { DeckTypeDialog } from '../components/DeckTypeDialog';
import { SpaceDialog } from '../components/SpaceDialog';
import { DECK_TYPE_LABEL, Icon } from '../components/icons';
import { ProjectSettings } from './ProjectSettings';
import { PublicLink } from '../components/PublicLink';
import { CoverArt } from '../components/CoverArt';
import { VisibilityField } from '../components/VisibilityField';
import { Link } from '../router';
import { useChips } from '../search';
import { SearchResults } from '../components/SearchResults';
import { deleteDeckNote } from '../cards';
import { TEMPLATES } from '../../../shared/templates';
import { goesTo } from '../../../shared/workspaceKind';
import { useWorkspaceKind } from '../workspaceKind';

const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;

/** Everything the tiles need, computed once per store change. */
function useDeckData() {
  const cards = useStore((s) => s.cards);
  const resolvables = useStore((s) => s.resolvables);
  return useMemo(() => {
    const open = new Map<string, Set<ResolvableContext>>();
    for (const r of resolvables.values()) {
      if (r.isClosed) continue;
      let set = open.get(r.cardId);
      if (!set) open.set(r.cardId, (set = new Set()));
      set.add(r.context);
    }
    const byDeck = new Map<string, Card[]>();
    for (const c of cards.values()) {
      if (!c.deckId) continue;
      const list = byDeck.get(c.deckId);
      if (list) list.push(c);
      else byDeck.set(c.deckId, [c]);
    }
    return { open, byDeck };
  }, [cards, resolvables]);
}

export function Decks() {
  const s = useStore((x) => x);
  const admin = isAdmin(s);
  const [creating, setCreating] = useState(false);
  const searching = useChips().tokens.length > 0;
  const all = [...s.projects.values()].sort(bySeq);
  const active = all.filter((p) => !p.isArchived);
  const archived = all.filter((p) => p.isArchived);
  const shown = active.filter((p) => projectVisible(s, p.id));

  return (
    <main className="page" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">{s.account?.name ?? 'Workspace'}</p>
          <h1>{searching ? 'Search results' : 'Overview'}</h1>
        </div>
        {admin && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New project
          </button>
        )}
      </div>

      {searching && <SearchResults />}
      {!searching && active.length > 0 && <ProjectStrip state={s} projects={active} />}

      {!searching && all.length === 0 && (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>{admin ? 'Create a project, then give it areas and lists.' : 'Ask a workspace admin to add you to a project.'}</p>
        </div>
      )}
      {!searching && active.length > 0 && shown.length === 0 && (
        <div className="empty"><p>Every project is hidden. Switch one on above to see its lists.</p></div>
      )}

      {!searching && shown.map((p) => <ProjectBlock key={p.id} project={p} state={s} />)}

      {!searching && archived.length > 0 && (
        <details className="archived">
          <summary>Archived projects ({archived.length})</summary>
          {archived.map((p) => <ProjectBlock key={p.id} project={p} state={s} />)}
        </details>
      )}

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </main>
  );
}

/** One switch per project: hide or show it on this page, for me only. */
function ProjectStrip({ state, projects }: { state: State; projects: Project[] }) {
  return (
    <nav className="strip" aria-label="Projects in view">
      <span className="strip-label">In view</span>
      {projects.map((p) => {
        const on = projectVisible(state, p.id);
        return (
          <button
            key={p.id} type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on}
            onClick={() => { void dispatch('missionControl', 'setVisible', { projectId: p.id, visible: !on }).catch(() => {}); }}
          >
            <Icon name={on ? 'eye' : 'eyeOff'} size={15} />
            {p.name}
          </button>
        );
      })}
    </nav>
  );
}

type DialogState =
  | { kind: 'newSection' }
  | { kind: 'editSection'; space: Space }
  | { kind: 'newDeck'; spaceId?: number }
  | { kind: 'renameDeck'; deck: Deck }
  | { kind: 'deckType'; deck: Deck }
  | { kind: 'deleteDeck'; deck: Deck }
  | { kind: 'settings' }
  | null;

function ProjectBlock({ project, state }: { project: Project; state: State }) {
  const headingId = useId();
  const editable = canEditContent(state, project);
  const manage = canManageProject(state, project);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [reorder, setReorder] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const { open, byDeck } = useDeckData();
  const hideDone = state.account?.settings?.hideCompletedCounts ?? false;

  const decksBySpace = useMemo(() => {
    const m = new Map<number, Deck[]>();
    for (const d of state.decks.values()) {
      if (d.projectId !== project.id) continue;
      const list = m.get(d.spaceId);
      if (list) list.push(d);
      else m.set(d.spaceId, [d]);
    }
    for (const list of m.values()) list.sort((a, b) => a.sortIndex - b.sortIndex || a.seq - b.seq);
    return m;
  }, [state.decks, project.id]);

  const saveSpaces = (spaces: Space[]) => dispatch('projects', 'update', { id: project.id, spaces });
  const quiet = (p: Promise<unknown>) => { void p.catch(() => {}); };

  const onDrop = (e: DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragId === null) return;
    const next = moveSpace(project.spaces, dragId, targetIndex);
    setDragId(null);
    if (next.some((s, i) => s.id !== project.spaces[i].id)) quiet(saveSpaces(next));
  };

  const spaceName = (id?: number) => spaceLabel(project.spaces.find((s) => s.id === id) ?? project.spaces[0]);

  return (
    <section className={project.isArchived ? 'project archived-project' : 'project'} aria-labelledby={headingId}>
      <header className="project-head">
        <CoverArt cover={project.cover} size="thumb" testId="project-cover" />
        <h2 id={headingId}>{project.name}</h2>
        {project.visibility === 'limited' && <span className="badge" title="Only people given access can see this project"><Icon name="lock" size={13} /> Limited</span>}
        {project.isArchived && <span className="badge">Archived</span>}
        <PublicLink projectId={project.id} what="project" />
        <div className="project-actions">
          <Link href={`/decks/activity?project=${project.seq}`} className="btn"><Icon name="review" /> Activity</Link>
          {editable && (
            <>
              <button type="button" className="btn" onClick={() => setDialog({ kind: 'newDeck' })}><Icon name="plus" /> New list</button>
              <button type="button" className="btn" onClick={() => setDialog({ kind: 'newSection' })}><Icon name="plus" /> New area</button>
              {project.spaces.length > 1 && (
                <button type="button" className={reorder ? 'btn btn-active' : 'btn'} aria-pressed={reorder} onClick={() => setReorder((r) => !r)}>
                  <Icon name="sort" /> {reorder ? 'Done reordering' : 'Reorder areas'}
                </button>
              )}
            </>
          )}
          {manage && (
            <button type="button" className="icon-btn" aria-label="Project settings" title="Project settings" onClick={() => setDialog({ kind: 'settings' })}>
              <Icon name="gear" />
            </button>
          )}
        </div>
      </header>

      {reorder && <p className="hint">Drag an area by its header, or use the arrows. Changes save straight away.</p>}

      <div className="sections">
        {project.spaces.map((space, i) => {
          const decks = decksBySpace.get(space.id) ?? [];
          const label = spaceLabel(space);
          const canDelete = decks.length === 0 && project.spaces.length > 1;
          const deleteWhyNot = decks.length ? 'Move or delete its lists first.' : 'A project needs at least one area.';
          return (
            <div
              key={space.id}
              className={`section${dragId === space.id ? ' dragging' : ''}`}
              data-testid="section"
              onDragOver={reorder ? (e) => e.preventDefault() : undefined}
              onDrop={reorder ? (e) => onDrop(e, i) : undefined}
            >
              <div
                className={reorder ? 'section-head reorderable' : 'section-head'}
                draggable={reorder}
                onDragStart={(e) => { setDragId(space.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(space.id)); }}
                onDragEnd={() => setDragId(null)}
              >
                {reorder && <span className="grip" aria-hidden><Icon name="grip" /></span>}
                <h3>{label}</h3>
                <span className="section-meta" title={`New lists here are ${DECK_TYPE_LABEL[space.defaultDeckType].toLowerCase()}s`}>{decks.length} {decks.length === 1 ? 'list' : 'lists'}</span>
                {editable && (
                  <div className="section-actions">
                    {reorder ? (
                      <>
                        <button type="button" className="icon-btn" aria-label={`Move ${label} up`} disabled={i === 0}
                          onClick={() => quiet(saveSpaces(moveSpace(project.spaces, space.id, i - 1)))}><Icon name="up" /></button>
                        <button type="button" className="icon-btn" aria-label={`Move ${label} down`} disabled={i === project.spaces.length - 1}
                          onClick={() => quiet(saveSpaces(moveSpace(project.spaces, space.id, i + 1)))}><Icon name="down" /></button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="icon-btn" aria-label={`Add list to ${label}`} title="Add a list here"
                          onClick={() => setDialog({ kind: 'newDeck', spaceId: space.id })}><Icon name="plus" /></button>
                        <button type="button" className="icon-btn" aria-label={`Edit area ${label}`} title="Edit area"
                          onClick={() => setDialog({ kind: 'editSection', space })}><Icon name="edit" /></button>
                        <button type="button" className="icon-btn" aria-label={`Delete area ${label}`}
                          title={canDelete ? 'Delete area' : deleteWhyNot}
                          aria-describedby={canDelete ? undefined : `why-${headingId}-${space.id}`}
                          disabled={!canDelete}
                          onClick={() => quiet(saveSpaces(removeSpace(project.spaces, space.id)))}><Icon name="trash" /></button>
                      </>
                    )}
                    {!canDelete && <span id={`why-${headingId}-${space.id}`} className="sr-only">{deleteWhyNot}</span>}
                  </div>
                )}
              </div>
              {!reorder && (
                decks.length > 0 ? (
                  <div className="deck-grid">
                    {decks.map((d) => {
                      const cards = byDeck.get(d.id) ?? [];
                      const docCount = cards.filter((c) => c.isDoc && c.visibility === 'default').length;
                      return (
                        <DeckTile
                          key={d.id} deck={d} hideDone={hideDone} docCount={docCount}
                          counts={deckCounts(cards, open)}
                          onAddCover={editable ? () => setDialog({ kind: 'renameDeck', deck: d }) : undefined}
                          actions={editable ? [
                            { label: 'Edit list', onSelect: () => setDialog({ kind: 'renameDeck', deck: d }) },
                            { label: 'Change type', onSelect: () => setDialog({ kind: 'deckType', deck: d }) },
                            { label: 'Delete list', danger: true, onSelect: () => setDialog({ kind: 'deleteDeck', deck: d }) },
                          ] : undefined}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="section-empty">No lists in this area.</p>
                )
              )}
            </div>
          );
        })}
      </div>

      {dialog?.kind === 'newSection' && (
        <SpaceDialog onClose={() => setDialog(null)} onSubmit={(input: SpaceInput) => saveSpaces(addSpace(project.spaces, input)).then(() => {})} />
      )}
      {dialog?.kind === 'editSection' && (
        <SpaceDialog space={dialog.space} onClose={() => setDialog(null)}
          onSubmit={(input) => saveSpaces(updateSpace(project.spaces, dialog.space.id, input)).then(() => {})} />
      )}
      {dialog?.kind === 'newDeck' && (
        <DeckDialog
          projectId={project.id}
          hint={`It goes into ${spaceName(dialog.spaceId)}.`}
          onClose={() => setDialog(null)}
          onSubmit={(title, cover) => dispatch('decks', 'create', { title, ...cover, projectId: project.id, ...(dialog.spaceId !== undefined ? { spaceId: dialog.spaceId } : {}) }).then(() => {})}
        />
      )}
      {dialog?.kind === 'renameDeck' && (
        <DeckDialog projectId={project.id} initialTitle={dialog.deck.title} initialCover={dialog.deck.cover} onClose={() => setDialog(null)}
          onSubmit={(title, cover) => dispatch('decks', 'update', { id: dialog.deck.id, title, ...cover }).then(() => {})} />
      )}
      {dialog?.kind === 'deckType' && (
        <DeckTypeDialog current={dialog.deck.deckType} onClose={() => setDialog(null)}
          onSubmit={(deckType: DeckType) => dispatch('decks', 'update', { id: dialog.deck.id, deckType }).then(() => {})} />
      )}
      {dialog?.kind === 'deleteDeck' && (
        <ConfirmDeleteDeck deck={dialog.deck} cardCount={(byDeck.get(dialog.deck.id) ?? []).length} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'settings' && <ProjectSettings project={project} onClose={() => setDialog(null)} />}
    </section>
  );
}

function ConfirmDeleteDeck({ deck, cardCount, onClose }: { deck: Deck; cardCount: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await dispatch('decks', 'delete', { id: deck.id }); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="Delete list?" onClose={onClose} onSubmit={go} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-danger" disabled={busy}>Delete list</button>
    </>}>
      <p><strong>{deck.title}</strong> will be removed. {deleteDeckNote(cardCount)}</p>
    </Dialog>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'details' | 'template'>('details');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<ProjectVisibility>('full');
  const [template, setTemplate] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const where = useWorkspaceKind();
  const submit = async () => {
    if (!name.trim()) return;
    if (step === 'details') { setStep('template'); return; }
    setBusy(true);
    try {
      await dispatch('projects', 'create', { name: name.trim(), visibility, ...(template ? { template } : {}) });
      onClose();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="New project" onClose={onClose} onSubmit={submit} actions={<>
      <button type="button" className="btn btn-ghost" onClick={step === 'details' ? onClose : () => setStep('details')}>{step === 'details' ? 'Cancel' : 'Back'}</button>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{step === 'details' ? 'Next' : 'Create project'}</button>
    </>}>
      {step === 'details' ? (<>
        <label className="field">
          <span>Project name</span>
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <VisibilityField value={visibility} onChange={setVisibility} />
        {where && <p className="hint ws-goes-to" data-testid="new-project-goes-to">{goesTo(where)}</p>}
      </>) : (
        <fieldset className="template-list">
          <legend>Choose a template</legend>
          <label className="template-opt">
            <input type="radio" name="template" value="" checked={template === ''} onChange={() => setTemplate('')} />
            Start without template
            <small>One empty area, no lists.</small>
          </label>
          {TEMPLATES.map((t) => (
            <label key={t.id} className="template-opt">
              <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
              {t.name}
              <small>{t.blurb}</small>
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}

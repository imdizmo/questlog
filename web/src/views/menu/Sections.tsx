import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card, Project } from '../../../../shared/types';
import { cardCode, titleOf } from '../../../../shared/cards';
import { dispatch } from '../../api';
import { canEditCard, canManageProject, store, useStore } from '../../store';
import { typesPath } from '../../wiki';
import { cardHref } from '../../cards';
import { Link } from '../../router';
import { publicUrl, useOpenDecks } from '../../openDecks';
import { LOOKS, setLook, useLook, type Look } from '../../look';
import { Icon } from '../../components/icons';
import { sectionById, type SectionId } from '../../workspaceMenu';
import { ApiTokens } from '../settings/ApiTokens';
import { McpSettings } from '../settings/Mcp';
import { CsvImport } from '../settings/CsvImport';
import { UserReports } from '../settings/UserReports';
import { HacknPlanImport, TrelloImport } from '../settings/Importers';
import { CloneProjects } from '../settings/Clone';
import { EmailAdmin, EmailPrefs } from '../settings/Email';
import { DiscordIntegration } from '../settings/Discord';
import { SlackIntegration } from '../settings/Slack';
import { GitIntegration } from '../settings/Git';
import { SteamIntegration } from '../settings/Steam';
import { MyAccountPanel } from '../MyAccount';

// ---------------------------------------------------------------- tabs inside a section

/** A section's own tabs (Connections, Import, Preferences): they wrap onto more lines rather than scroll sideways. */
export function SubTabs({ section, tab, onTab, children }: { section: SectionId; tab: string | null; onTab: (t: string) => void; children: ReactNode }) {
  const base = useId();
  const tabs = sectionById(section)?.tabs ?? [];
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length].id;
    onTab(next);
    document.getElementById(`${base}-${next}`)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label={`${sectionById(section)?.label} areas`} className="wsm-subtabs" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`${base}-${t.id}`} type="button" role="tab" className="wsm-subtab" aria-selected={tab === t.id}
            aria-controls={`${base}-panel`} tabIndex={tab === t.id ? 0 : -1} onClick={() => onTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${tab}`} className="wsm-subpanel">{children}</div>
    </>
  );
}

export function ConnectionsBody({ tab }: { tab: string | null }) {
  switch (tab) {
    case 'discord': return <DiscordIntegration />;
    case 'slack': return <SlackIntegration />;
    case 'github': return <GitIntegration kind="github" />;
    case 'gitlab': return <GitIntegration kind="gitlab" />;
    case 'bitbucket': return <GitIntegration kind="bitbucket" />;
    case 'steam': return <SteamIntegration />;
    case 'reportsApi': return <UserReports key="api" variant="api" />;
    case 'reportsUnity': return <UserReports key="unity" variant="unity" />;
    case 'email': return <EmailAdmin />;
    default: return <McpSettings />;
  }
}

export function ImportBody({ tab }: { tab: string | null }) {
  switch (tab) {
    case 'trello': return <TrelloImport />;
    case 'hacknplan': return <HacknPlanImport />;
    case 'copy': return <CloneProjects />;
    default: return <CsvImport />;
  }
}

export function PreferencesBody({ tab }: { tab: string | null }) {
  switch (tab) {
    case 'tokens': return <ApiTokens />;
    case 'account': return <MyAccountPanel />;
    default: return <EmailPrefs />;
  }
}

// ---------------------------------------------------------------- Entry types

const sortedProjects = (projects: Map<string, Project>) => [...projects.values()].sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.seq - b.seq);

/**
 * Entry types moved into the Wiki (its Types part). The section stays so old links (`?menu=types`) still lead there:
 * one button opens the Types of the wiki in view, else of the first project with types.
 */
export function TypesSection({ initialProjectId, onFullPage }: { initialProjectId: string | null; onFullPage: (href: string) => void }) {
  const projects = useStore((s) => s.projects);
  const project = useMemo(() => {
    if (initialProjectId && projects.has(initialProjectId)) return projects.get(initialProjectId)!;
    const s = store.get();
    const list = sortedProjects(projects).filter((p) => !p.isArchived);
    return list.find((p) => [...s.entryTypes.values()].some((t) => t.projectId === p.id)) ?? list[0];
  }, [initialProjectId, projects]);
  if (!project) return <p className="muted">No projects yet. Entry types belong to a project's wiki.</p>;
  return (
    <div className="wsm-stack">
      <p className="wsm-help">Entry types now live in each project's Wiki, under Types, with their families and pictures.</p>
      <p><button type="button" className="btn btn-primary" onClick={() => onFullPage(typesPath(project.seq))}>Open Types in the Wiki</button></p>
    </div>
  );
}

// ---------------------------------------------------------------- Files

const FILES_PAGE = 60;
const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function FilesSection() {
  const files = useStore((s) => s.files);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const [query, setQuery] = useState('');
  const [images, setImages] = useState(false);
  const [shown, setShown] = useState(FILES_PAGE);
  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...files.values()]
      .filter((f) => (!images || f.mime.startsWith('image/')) && (!q || f.name.toLowerCase().includes(q) || titleOf(cards.get(f.cardId)?.content ?? '').toLowerCase().includes(q)))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [files, cards, query, images]);
  const id = useId();
  return (
    <div className="wsm-stack">
      <div className="wsm-filter">
        <input type="search" aria-label="Search files" placeholder="Search by file or task name…" value={query} onChange={(e) => { setQuery(e.target.value); setShown(FILES_PAGE); }} />
        <label className="check-inline" htmlFor={`${id}-img`}>
          <input id={`${id}-img`} type="checkbox" checked={images} onChange={(e) => { setImages(e.target.checked); setShown(FILES_PAGE); }} /> Pictures only
        </label>
      </div>
      <p className="wsm-help" role="status">{all.length === 1 ? '1 file' : `${all.length} files`}</p>
      <ul className="wsm-files" aria-label="Files">
        {all.slice(0, shown).map((f) => {
          const card = cards.get(f.cardId);
          const deck = card?.deckId ? decks.get(card.deckId) : null;
          return (
            <li key={f.id} className="wsm-file">
              {f.mime.startsWith('image/')
                ? <img className="wsm-file-thumb" src={`/api/files/${encodeURIComponent(f.id)}`} alt="" loading="lazy" />
                : <span className="wsm-file-thumb wsm-file-icon" aria-hidden><Icon name="file" size={18} /></span>}
              <span className="wsm-file-text">
                <a className="wsm-ellipsis" href={`/api/files/${encodeURIComponent(f.id)}`} target="_blank" rel="noreferrer">{f.name}</a>
                <span className="wsm-help wsm-ellipsis">
                  {sizeText(f.size)}{card && <> · on <Link href={cardHref(card, deck)}>{titleOf(card.content)}</Link></>}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {!all.length && <p className="muted">{files.size ? 'No file matches.' : 'No files yet. Files attached to tasks show up here.'}</p>}
      {all.length > shown && <button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + FILES_PAGE)}>Show more</button>}
    </div>
  );
}

// ---------------------------------------------------------------- Public links

export function PublicSection() {
  const open = useOpenDecks();
  const projects = useStore((s) => s.projects);
  const shared = [...open.values()].filter((o) => o.enabled && projects.has(o.projectId));
  return (
    <div className="wsm-stack">
      {shared.length ? (
        <ul className="wsm-rows" aria-label="Public projects">
          {shared.map((o) => (
            <li key={o.projectId} className="wsm-row">
              <span className="wsm-row-text">
                <strong className="wsm-ellipsis">{projects.get(o.projectId)?.name}</strong>
                <span className="wsm-help wsm-ellipsis">{publicUrl(o)}</span>
              </span>
              <a className="btn btn-sm" href={publicUrl(o)} target="_blank" rel="noreferrer">Open</a>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No project is public. Nothing in this workspace can be read without an account.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Look

const LOOK_TEXT: Record<Look, [string, string]> = {
  dark: ['Dark', 'Light text on dark backgrounds.'],
  light: ['Light', 'Dark text on light backgrounds.'],
  system: ['Match this computer', 'Follows your computer\'s light or dark setting.'],
};

export function LookSection() {
  const look = useLook();
  const name = useId();
  return (
    <fieldset className="wsm-setting">
      <legend className="wsm-setting-label">Colours</legend>
      <p className="wsm-help">Only changes this browser on this device. Everyone else keeps their own.</p>
      <div className="choice-list compact">
        {LOOKS.map((l) => (
          <label key={l} className={look === l ? 'choice selected' : 'choice'}>
            <input type="radio" name={name} checked={look === l} onChange={() => setLook(l)} />
            <span className="choice-title">{LOOK_TEXT[l][0]}</span>
            <span className="choice-blurb">{LOOK_TEXT[l][1]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- Export

export function ExportSection() {
  const projects = useStore((s) => s.projects);
  const list = sortedProjects(projects);
  return (
    <div className="wsm-stack">
      <section className="wsm-setting" aria-labelledby="wsm-export-data">
        <h3 className="wsm-setting-label" id="wsm-export-data">Game data</h3>
        <p className="wsm-help">One file per project with every wiki entry, its fields and links, for your game's build tools.</p>
        {list.length ? (
          <ul className="wsm-rows" aria-label="Game data files">
            {list.map((p) => (
              <li key={p.id} className="wsm-row">
                <span className="wsm-row-text"><strong className="wsm-ellipsis">{p.name}</strong></span>
                <a className="btn btn-sm" href={`/api/wiki/${encodeURIComponent(p.id)}/export`} download aria-label={`Download game data of ${p.name}`}>
                  <Icon name="download" size={15} /> Download
                </a>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No projects yet.</p>}
      </section>
      <section className="wsm-setting" aria-labelledby="wsm-export-backup">
        <h3 className="wsm-setting-label" id="wsm-export-backup">Backups</h3>
        <p className="wsm-help">
          Everything lives in one data folder on the computer or server that runs Questlog. Before an update changes it,
          a copy is saved in the <code>backups</code> folder inside it. To make your own backup, close Questlog and copy
          the whole data folder somewhere safe.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Archive

interface DeletedCard { id: string; seq: number; title: string; deckId: string | null; creatorId: string; isDoc: boolean; lastUpdatedAt: number }
const ARCHIVED_SHOWN = 50;
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function ArchiveSection() {
  const projects = useStore((s) => s.projects);
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const state = useStore((s) => s);
  const [deleted, setDeleted] = useState<DeletedCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    fetch('/api/cards-deleted', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { cards: [] })).then((j: { cards?: DeletedCard[] }) => setDeleted(j.cards ?? []))
      .catch(() => setDeleted([]));
  };
  useEffect(load, []);
  const archivedProjects = sortedProjects(projects).filter((p) => p.isArchived);
  const archivedCards = useMemo(() => [...cards.values()].filter((c) => c.visibility === 'archived').sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt), [cards]);
  const projectOf = (deckId: string | null) => (deckId ? projects.get(decks.get(deckId)?.projectId ?? '') : null);
  const canRestore = (c: Pick<Card, 'creatorId' | 'deckId'>) => canEditCard(state, c, projectOf(c.deckId));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* toast shown by dispatch */ } finally { setBusy(false); }
  };
  return (
    <div className="wsm-stack">
      <section aria-labelledby="wsm-arch-projects" className="wsm-setting">
        <h3 className="wsm-setting-label" id="wsm-arch-projects">Archived projects</h3>
        <p className="wsm-help">Kept whole and read-only, at the bottom of the Lists page.</p>
        {archivedProjects.length ? (
          <ul className="wsm-rows" aria-label="Archived projects">
            {archivedProjects.map((p) => (
              <li key={p.id} className="wsm-row">
                <span className="wsm-row-text"><strong className="wsm-ellipsis">{p.name}</strong></span>
                {canManageProject(state, p) && (
                  <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Unarchive ${p.name}`}
                    onClick={() => run(() => dispatch('projects', 'update', { id: p.id, isArchived: false }))}>Unarchive</button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted">None.</p>}
      </section>
      <section aria-labelledby="wsm-arch-tasks" className="wsm-setting">
        <h3 className="wsm-setting-label" id="wsm-arch-tasks">Archived tasks</h3>
        <p className="wsm-help">Out of their lists but kept. Restore puts one back where it was.</p>
        {archivedCards.length ? (
          <ul className="wsm-rows" aria-label="Archived tasks">
            {archivedCards.slice(0, ARCHIVED_SHOWN).map((c) => {
              const title = titleOf(c.content);
              return (
                <li key={c.id} className="wsm-row">
                  <span className="wsm-row-text">
                    <Link className="wsm-ellipsis" href={cardHref(c, c.deckId ? decks.get(c.deckId) : null)}>{title}</Link>
                    <span className="wsm-help">${cardCode(c.seq)} · {when(c.lastUpdatedAt)}</span>
                  </span>
                  {canRestore(c) && (
                    <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Restore ${title}`}
                      onClick={() => run(() => dispatch('cards', 'update', { id: c.id, visibility: 'default' }))}>Restore</button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : <p className="muted">None.</p>}
        {archivedCards.length > ARCHIVED_SHOWN && <p className="wsm-help">Showing the newest {ARCHIVED_SHOWN} of {archivedCards.length}. A list's "Include archived tasks" shows the rest.</p>}
      </section>
      <section aria-labelledby="wsm-arch-deleted" className="wsm-setting">
        <h3 className="wsm-setting-label" id="wsm-arch-deleted">Deleted tasks and entries</h3>
        <p className="wsm-help">Deleted things are kept and can come back. The newest 100 are listed.</p>
        {deleted === null ? <p className="muted">Loading…</p> : deleted.length ? (
          <ul className="wsm-rows" aria-label="Deleted tasks">
            {deleted.map((c) => (
              <li key={c.id} className="wsm-row">
                <span className="wsm-row-text">
                  <strong className="wsm-ellipsis">{c.title}</strong>
                  <span className="wsm-help">${cardCode(c.seq)} · deleted {when(c.lastUpdatedAt)}</span>
                </span>
                {canRestore(c) && (
                  <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Restore ${c.title}`}
                    onClick={() => run(async () => { await dispatch('cards', 'update', { id: c.id, visibility: 'default' }); load(); })}>Restore</button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted">None.</p>}
      </section>
    </div>
  );
}

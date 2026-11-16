import { useEffect, useMemo, useState } from 'react';
import type { Card, Project } from '../../../shared/types';
import { dispatch } from '../api';
import { canEditContent, canManageProject, projectVisible, useStore, type State } from '../store';
import { Link, navigate, type Route } from '../router';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/icons';
import { EntryPage } from '../components/wiki/EntryPage';
import { TypeTable } from '../components/wiki/TypeTable';
import { ChecksBadge } from '../components/wiki/ChecksPanel';
import { EntryBuilder, KindGallery, PlacesView, TimelineView, WikiHome } from '../components/wiki/Builder';
import { ProjectSettings } from './ProjectSettings';
import { entryTitle } from '../components/wiki/FieldEditor';
import { campaignLore, campaignTypes, entryBySegment, entryPath, searchEntries, wikiPath, connectionTree, type WikiNode } from '../wiki';

const LAST_KEY = 'jt:wikiProject';
/** Projects whose editor chose "Start empty": the starter pack offer stays hidden there. */
const EMPTY_KEY = 'jt:wikiStartEmpty';
const PENDING_MS = 10_000;
const readLast = (): string | null => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };
const writeLast = (id: string) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* storage blocked: not remembered */ } };
const startedEmpty = (projectId: string): boolean => { try { return (JSON.parse(localStorage.getItem(EMPTY_KEY) ?? '[]') as unknown[]).includes(projectId); } catch { return false; } };
const rememberEmpty = (projectId: string) => {
  try { localStorage.setItem(EMPTY_KEY, JSON.stringify([...new Set([...(JSON.parse(localStorage.getItem(EMPTY_KEY) ?? '[]') as string[]), projectId])].slice(-50))); } catch { /* not remembered */ }
};

/** Projects the Wiki offers: live ones I keep visible, in their order. */
const wikiProjects = (s: State): Project[] =>
  [...s.projects.values()].filter((p) => !p.isArchived && projectVisible(s, p.id)).sort((a, b) => a.seq - b.seq);

type WikiRoute = Extract<Route, { name: 'wiki' | 'wikiProject' | 'wikiEntry' | 'wikiType' | 'wikiKind' | 'wikiNew' | 'wikiView' }>;

/** The Wiki: a project's Lore as a tree of typed entries, with the entry page beside it. */
export function Wiki({ route }: { route: WikiRoute }) {
  const projects = useStore(wikiProjects);
  const allProjects = useStore((s) => s.projects);
  const seq = route.name === 'wiki' ? null : route.projectSeq;
  const project = seq === null ? undefined : [...allProjects.values()].find((p) => p.seq === seq);

  // /wiki opens the project used last (if still offered), else the first one.
  useEffect(() => {
    if (route.name !== 'wiki' || !projects.length) return;
    const last = readLast();
    const p = projects.find((x) => x.id === last) ?? projects[0];
    navigate(wikiPath(p.seq), { replace: true });
  }, [route.name, projects]);
  useEffect(() => { if (project) writeLast(project.id); }, [project?.id]);

  if (route.name === 'wiki') {
    return (
      <main className="page" id="main">
        <div className="page-head"><h1>Wiki</h1></div>
        {!projects.length && <p className="muted">No projects yet. Create one under Lists first.</p>}
      </main>
    );
  }
  if (!project) {
    return (
      <main className="page" id="main">
        <div className="page-head"><div><p className="eyebrow"><Link href="/wiki">← Wiki</Link></p><h1>Project not found</h1></div></div>
        <p className="muted">It may have been removed, or you don't have access to it.</p>
      </main>
    );
  }
  return <CampaignWiki key={project.id} project={project} projects={projects} route={route} />;
}

function CampaignWiki({ project, projects, route }: { project: Project; projects: Project[]; route: Exclude<WikiRoute, { name: 'wiki' }> }) {
  const entry = route.name === 'wikiEntry' ? route.entry : null;
  const typeKey = route.name === 'wikiType' || route.name === 'wikiKind' || route.name === 'wikiNew' ? route.typeKey : null;
  const s = useStore((x) => x);
  const [creating, setCreating] = useState(false);
  /** An entry just created, shown as loading until its card arrives over the socket. */
  const [pending, setPending] = useState<string | null>(null);
  const current = entry ? entryBySegment(s, project.id, entry) : undefined;
  // A new entry that never arrives over the socket stops showing "Loading…" after a while.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(t);
  }, [pending]);
  const canCreate = canEditContent(s, project);
  const canManage = canManageProject(s, project);
  const [settings, setSettings] = useState(false);
  const noTypes = useMemo(() => campaignTypes(s.entryTypes, project.id).length === 0, [s.entryTypes, project.id]);
  const tableType = typeKey ? campaignTypes(s.entryTypes, project.id).find((t) => t.key === typeKey) : undefined;

  return (
    <main className="page page-wide wiki" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">{route.name === 'wikiProject' ? 'Wiki' : <Link href={wikiPath(project.seq)}>← Wiki</Link>}</p>
          <h1>Wiki · {project.name}</h1>
        </div>
        <div className="row">
          <ChecksBadge project={project} />
          {/* The game-data file (server/wikiExport.ts); the server names it <project>-gamedata.json. */}
          <a className="btn btn-sm" href={`/api/wiki/${encodeURIComponent(project.id)}/export`} download
            title="Download the typed entries, links and checks as JSON for the game">Export JSON</a>
          {canManage && <button type="button" className="btn btn-sm" onClick={() => setSettings(true)}>Entity types</button>}
        </div>
      </div>
      <div className="wiki-layout">
        <WikiSidebar project={project} projects={projects} currentId={current?.id ?? null} canCreate={canCreate} onNew={() => setCreating(true)} />
        <div className="wiki-main">
          {route.name === 'wikiView' ? (route.view === 'places' ? <PlacesView project={project} /> : <TimelineView project={project} />)
          : typeKey ? (
            !tableType ? <div className="empty"><h2>Entity type not found</h2><p className="muted">No entity type with that key in {project.name}.</p></div>
              : route.name === 'wikiKind' ? <KindGallery key={tableType.id} project={project} type={tableType} onEditTypes={canManage ? () => setSettings(true) : undefined} />
              : route.name === 'wikiNew' ? (canCreate ? <EntryBuilder key={tableType.id} project={project} type={tableType} /> : <p className="muted">You can't add lore to {project.name}.</p>)
              : <TypeTable key={tableType.id} project={project} type={tableType} />
          ) : current ? <EntryPage key={current.id} card={current} project={project} />
            : entry && pending === entry ? <p className="muted" aria-busy="true">Loading…</p>
            : entry ? (
              <div className="empty"><h2>Lore not found</h2><p className="muted">No lore with that key in {project.name}. It may have been deleted or renamed.</p></div>
            ) : noTypes && canManage ? <StarterOffer project={project} />
            : <WikiHome project={project} />}
        </div>
      </div>
      {creating && (
        <NewEntryDialog project={project} onClose={() => setCreating(false)}
          onCreated={(key) => { setCreating(false); setPending(key); navigate(`${wikiPath(project.seq)}/${key}`); }} />
      )}
      {settings && <ProjectSettings project={project} initialTab="wikiTypes" onClose={() => setSettings(false)} />}
    </main>
  );
}

/** A project without types, to its editors: add the game starter pack, or start empty (remembered here). */
function StarterOffer({ project }: { project: Project }) {
  const [dismissed, setDismissed] = useState(() => startedEmpty(project.id));
  const [busy, setBusy] = useState(false);
  if (dismissed) {
    return <div className="empty"><h2>{project.name}</h2><p className="muted">No entity types yet. Add some under Entity types, or start a plain page.</p></div>;
  }
  const add = async () => {
    setBusy(true);
    try { await dispatch('wiki', 'addStarterPack', { projectId: project.id, core: true }); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="empty wiki-starter">
      <h2>Set up the wiki of {project.name}</h2>
      <p className="muted">The starter set adds eight entity types (Character, Creature, Faction, Place, Item, Quest, History, Storyline) and the few links between them. Recipes, abilities, shops and the rest are an extra pack under Entity types. You can edit or delete any of it later under Wiki types.</p>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={add}>Add the game starter pack</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { rememberEmpty(project.id); setDismissed(true); }}>Start empty</button>
      </div>
    </div>
  );
}

/** The left column: project picker, search, the page tree, New entry. The entity types are tiles on the Wiki's first page. */
function WikiSidebar({ project, projects, currentId, canCreate, onNew }: {
  project: Project; projects: Project[]; currentId: string | null; canCreate: boolean; onNew: () => void;
}) {
  const cards = useStore((s) => s.cards);
  const decks = useStore((s) => s.decks);
  const [query, setQuery] = useState('');
  const boards = useStore((s) => s.visionBoards);
  // A plain page that only exists to host a project board is not lore.
  const hosts = useMemo(() => new Set([...boards.values()].map((b) => b.cardId)), [boards]);
  const isLore = (c: Card) => !!c.entryTypeId || !hosts.has(c.id);
  const lore = useMemo(() => campaignLore(cards.values(), project.id, decks).filter(isLore), [cards, decks, project.id, hosts]);
  const entryLinks = useStore((s) => s.entryLinks);
  const entryTypes = useStore((s) => s.entryTypes);
  const tree = useMemo(() => connectionTree({ cards, decks, entryLinks, entryTypes, linkKinds: new Map() }, project.id, isLore), [cards, decks, entryLinks, project.id, hosts]);
  const flat = useMemo(() => (query.trim() ? searchEntries(lore, query).sort((a, b) => entryTitle(a).localeCompare(entryTitle(b))) : null), [query, lore]);

  return (
    <nav className="wiki-side" aria-label="Wiki pages">
      {projects.length > 1 && (
        <select className="wiki-campaign" aria-label="Project" value={project.seq} onChange={(e) => navigate(wikiPath(Number(e.target.value)))}>
          {projects.map((p) => <option key={p.id} value={p.seq}>{p.name}</option>)}
        </select>
      )}
      <label className="wiki-search">
        <Icon name="search" size={15} />
        <input type="search" aria-label="Find lore" placeholder="find…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {canCreate && <button type="button" className="btn btn-sm btn-primary" onClick={onNew}><Icon name="plus" size={14} /> New entry</button>}
      <h2 className="wiki-side-title">{flat ? `${flat.length} found` : 'Pages'}</h2>
      {flat ? (
        <ul className="wiki-tree" aria-label="Found lore">
          {flat.map((c) => <li key={c.id}><EntryLink card={c} project={project} current={c.id === currentId} /></li>)}
        </ul>
      ) : tree.length ? (
        <Tree nodes={tree} project={project} currentId={currentId} label="Page tree" />
      ) : <p className="muted">No lore yet.</p>}
    </nav>
  );
}

function EntryLink({ card, project, current }: { card: Card; project: Project; current: boolean }) {
  const icon = useStore((s) => (card.entryTypeId ? s.entryTypes.get(card.entryTypeId)?.icon : null));
  return <><span className="wiki-tree-ico" aria-hidden>{icon ?? '📄'}</span><Link href={entryPath(project.seq, card)} aria-current={current ? 'page' : undefined}>{entryTitle(card)}</Link></>;
}

function Tree({ nodes, project, currentId, label }: { nodes: WikiNode[]; project: Project; currentId: string | null; label?: string }) {
  return (
    <ul className="wiki-tree" aria-label={label}>
      {nodes.map((n) => (
        <li key={n.id}>
          <EntryLink card={n.card} project={project} current={n.id === currentId} />
          {n.children.length > 0 && <Tree nodes={n.children} project={project} currentId={currentId} />}
        </li>
      ))}
    </ul>
  );
}

/** New entry: a type (or a plain page) and a name; it goes into the project's Lore deck. */
function NewEntryDialog({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (key: string) => void }) {
  const entryTypes = useStore((s) => s.entryTypes);
  const types = useMemo(() => campaignTypes(entryTypes, project.id), [entryTypes, project.id]);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await dispatch<{ id: string; key: string }>('wiki', 'createEntry', { projectId: project.id, typeId: typeId || null, name: name.trim() });
      onCreated(r.key);
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Dialog title="New entry" onClose={onClose} onSubmit={submit}
      actions={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Create</button>
      </>}>
      <label className="field">
        <span>Type</span>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">Page</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input data-autofocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
    </Dialog>
  );
}

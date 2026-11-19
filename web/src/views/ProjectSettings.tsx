import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { OrgRole, Project, ProjectVisibility, User } from '../../../shared/types';
import { dispatch } from '../api';
import { canManageProject, useStore } from '../store';
import { Dialog } from '../components/Dialog';
import { CoverPicker, coverFields, type CoverChoice } from '../components/CoverPicker';
import { VisibilityField } from '../components/VisibilityField';
import { ProjectTagsDialog } from '../components/ProjectTagsDialog';
import { tagMark } from '../components/TagToggles';
import { navigate } from '../router';
import { typesPath } from '../wiki';

// Public pages are not offered: the tab that switched them on is gone, so the dormant pages cannot be reached.
const ALL_TABS = [['general', 'General'], ['wikiTypes', 'Entity types']] as const;
type Tab = (typeof ALL_TABS)[number][0];

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', observer: 'Observer', guest: 'Guest' };

/**
 * Name, visibility, who has access, archive and delete for one project; its Open Decks sharing on a second tab; its wiki
 * types and link kinds on a third (for those who manage the project).
 */
export function ProjectSettings({ project, onClose, initialTab = 'general' }: { project: Project; onClose: () => void; initialTab?: Tab }) {
  const manage = useStore((s) => canManageProject(s, project));
  const TABS = ALL_TABS.filter(([k]) => k !== 'wikiTypes' || manage);
  const [picked, setTab] = useState<Tab>(initialTab);
  const tab: Tab = picked === 'wikiTypes' && !manage ? 'general' : picked;
  const tabsId = useId();
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex(([k]) => k === tab) + 1) % TABS.length][0];
    setTab(next);
    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
  };
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.accountRoles);
  const access = useStore((s) => s.projectAccess);
  const [name, setName] = useState(project.name);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility);
  const [cover, setCover] = useState<CoverChoice>(project.cover);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState('');
  const [editTags, setEditTags] = useState(false);

  const dirty = name.trim() !== project.name || visibility !== project.visibility
    || JSON.stringify(cover) !== JSON.stringify(project.cover);
  const run = async (fn: () => Promise<unknown>, close = false) => {
    setBusy(true);
    try { await fn(); if (close) onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const save = async () => {
    if (!dirty || !name.trim()) return;
    await run(() => dispatch('projects', 'update', { id: project.id, name: name.trim(), visibility, ...coverFields(cover) }));
  };

  const people = [...users.values()]
    .filter((u) => !u.disabled && roles.get(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <Dialog title="Project settings" wide scroll onClose={onClose} onSubmit={tab === 'general' ? save : undefined} actions={
        tab === 'general' ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
            <button type="submit" className="btn btn-primary" disabled={busy || uploading || !dirty || !name.trim()}>Save changes</button>
          </>
        ) : <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      }>
        <div role="tablist" aria-label="Project settings areas" className="tabs" onKeyDown={onTabKey}>
          {TABS.map(([t, text]) => (
            <button key={t} id={`${tabsId}-tab-${t}`} type="button" role="tab" className="tab" aria-selected={tab === t}
              aria-controls={`${tabsId}-panel`} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}>{text}</button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${tab}`} className="settings-panel">
        {tab === 'wikiTypes' ? <OpenWikiTypes project={project} onClose={onClose} redirect={initialTab === 'wikiTypes'} /> : (<>
        <label className="field">
          <span>Project name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <VisibilityField value={visibility} onChange={setVisibility} />
        <CoverPicker projectId={project.id} value={cover} onChange={setCover} onBusy={setUploading} />

        <h3 className="sub">People</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Access</th><th scope="col">Producer</th></tr></thead>
            <tbody>
              {people.map((u) => (
                <AccessRow key={u.id} user={u} role={roles.get(u.id)!} project={project}
                  row={access.get(`${project.id}|${u.id}`)} busy={busy} run={run} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Producers can rename the project, change who has access and archive it.</p>

        <h3 className="sub">Tags</h3>
        <div className="tags-box">
          <div className="tag-preview" aria-label="Project tags">
            {(project.tags ?? []).length
              ? project.tags.map((t) => <span key={t.name} className="tag-chip"><span className="tag-mark" aria-hidden>{tagMark(t)}</span>{t.name}</span>)
              : <span className="muted">No tags yet.</span>}
          </div>
          <button type="button" className="btn" onClick={() => setEditTags(true)}>Edit tags</button>
        </div>

        <h3 className="sub">Archive and delete</h3>
        <div className="danger-zone">
          <div>
            <strong>{project.isArchived ? 'This project is archived.' : 'Archive project'}</strong>
            <p className="hint">{project.isArchived ? 'It is read-only for members until you bring it back.' : 'Keeps everything, makes it read-only and moves it to the bottom of the Lists page.'}</p>
          </div>
          <button type="button" className="btn" disabled={busy}
            onClick={() => run(() => dispatch('projects', 'update', { id: project.id, isArchived: !project.isArchived }))}>
            {project.isArchived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
        <div className="danger-zone">
          <div>
            <strong>Delete project</strong>
            <p className="hint">Removes the project with all its areas, lists and tasks. This can't be undone.</p>
          </div>
          {!confirmDelete && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete…</button>}
        </div>
        {confirmDelete && (
          <div className="confirm-box" role="group" aria-label="Confirm delete">
            <label className="field">
              <span>Type <strong>{project.name}</strong> to confirm</span>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={() => { setConfirmDelete(false); setTyped(''); }}>Keep project</button>
              <button type="button" className="btn btn-danger" disabled={busy || typed !== project.name}
                onClick={() => run(() => dispatch('projects', 'delete', { id: project.id }), true)}>Delete forever</button>
            </div>
          </div>
        )}
        </>)}
        </div>
      </Dialog>
      {/* Outside the settings form: its own form must not submit this one. */}
      {editTags && <ProjectTagsDialog project={project} onClose={() => setEditTags(false)} />}
    </>
  );
}

function AccessRow({ user, role, project, row, busy, run }: {
  user: User;
  role: OrgRole;
  project: Project;
  row: { projectRole: string | null } | undefined;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const admin = role === 'owner' || role === 'admin';
  const set = (access: null | 'member' | 'producer') =>
    run(() => dispatch('projects', 'setAccess', { projectId: project.id, userId: user.id, access }));
  const implicit = admin || (role === 'member' && project.visibility === 'full');
  const has = implicit || !!row;
  const producer = row?.projectRole === 'producer';

  return (
    <tr>
      <th scope="row"><span className="person">{user.name}</span><span className="person-sub">{user.email}</span></th>
      <td>{ROLE_LABEL[role]}</td>
      <td>
        {implicit ? (
          <span className="muted">{admin ? 'Always' : 'Full team'}</span>
        ) : (
          <label className="switch">
            <input type="checkbox" role="switch" checked={has} disabled={busy}
              aria-label={`Access for ${user.name}`} onChange={() => set(has ? null : 'member')} />
            <span aria-hidden className="track" />
          </label>
        )}
      </td>
      <td>
        {role === 'member' ? (
          <label className="switch">
            <input type="checkbox" role="switch" checked={producer} disabled={busy || !has}
              aria-label={`Producer: ${user.name}`}
              onChange={() => set(producer ? (project.visibility === 'full' ? null : 'member') : 'producer')} />
            <span aria-hidden className="track" />
          </label>
        ) : <span className="muted">—</span>}
      </td>
    </tr>
  );
}

/**
 * Entity types moved into the Wiki's Types. A dialog opened straight on this tab (an old link) goes there at once;
 * picked inside the dialog, the tab offers a button, so edits on General are never dropped by a tab switch.
 */
function OpenWikiTypes({ project, onClose, redirect }: { project: Project; onClose: () => void; redirect: boolean }) {
  const open = () => { onClose(); navigate(typesPath(project.seq)); };
  useEffect(() => { if (redirect) open(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (redirect) return <p className="hint">Entity types now live in the Wiki, under Types. Opening them…</p>;
  return (
    <div className="stack">
      <p className="hint">Entity types now live in the Wiki, under Types, with their families and pictures. Save changes on General first: this closes the settings.</p>
      <p><button type="button" className="btn btn-primary" onClick={open}>Open Types in the Wiki</button></p>
    </div>
  );
}

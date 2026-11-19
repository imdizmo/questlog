import { useState } from 'react';
import type { ApiToken, Project } from '../../../../shared/types';
import { dispatch } from '../../api';
import { isAdmin, useStore } from '../../store';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyField } from './CopyField';

const ROLES = [
  ['admin', 'Admin', 'Everything an admin can do, in every project.'],
  ['producer', 'Producer', 'Manages the chosen projects: lists, tasks and settings.'],
  ['limited', 'Limited', 'Works with tasks in the chosen projects only.'],
] as const;

const ROLE_LABEL = { admin: 'Admin', producer: 'Producer', limited: 'Limited' } as const;
const day = (t: number | null) => (t ? new Date(t).toLocaleDateString() : null);
const live = (t: ApiToken, now: number) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);

/** API tokens: organization tokens, my personal tokens and (admins) other members' tokens. */
export function ApiTokens() {
  const me = useStore((s) => s.me);
  const admin = useStore(isAdmin);
  const tokens = useStore((s) => s.apiTokens);
  const projects = useStore((s) => s.projects);
  const users = useStore((s) => s.users);
  const personalOn = useStore((s) => s.account?.userApiTokensEnabled === true);
  const [creating, setCreating] = useState<'org' | 'user' | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const now = Date.now();
  const all = [...tokens.values()].filter((t) => live(t, now)).sort((a, b) => a.createdAt - b.createdAt);
  const org = all.filter((t) => t.kind === 'org');
  const mine = all.filter((t) => t.kind === 'user' && t.userId === me?.id);
  const others = all.filter((t) => t.kind === 'user' && t.userId !== me?.id);
  const name = (id: string) => users.get(id)?.name ?? 'Unknown';
  const projectNames = (t: ApiToken) => t.role === 'admin' ? 'All projects'
    : t.projectIds.map((id) => projects.get(id)?.name ?? 'Unknown project').join(', ');

  const list = (rows: ApiToken[], by: 'creator' | 'owner' | null) => rows.length === 0 ? <p className="hint">No tokens yet.</p> : (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th scope="col">Name</th><th scope="col">Permission</th><th scope="col">Projects</th><th scope="col">Created</th>
          <th scope="col">Last used</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <th scope="row">
                {t.label} <code className="muted">{t.prefix}…</code>
                {by && <small className="hint"> {by === 'owner' ? `Owner: ${name(t.userId)}` : `Created by ${name(t.creatorId)}`}</small>}
              </th>
              <td>{ROLE_LABEL[t.role]}, {t.access === 'write' ? 'read & write' : 'read'}{t.mayDelete ? ', May delete' : ''}</td>
              <td>{projectNames(t)}</td>
              <td>{day(t.createdAt)}</td>
              <td>{day(t.lastUsedAt) ?? 'Never'}</td>
              <td>{day(t.expiresAt) ?? 'Never'}</td>
              <td><button type="button" className="btn btn-danger" aria-label={`Revoke ${t.label}`} onClick={() => setRevoking(t)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="settings-stack">
      <p className="hint">Tokens let scripts and tools read (or change) tasks over the API. A token is shown once, when you create it.</p>

      {admin && (
        <section className="settings-group" aria-labelledby="tok-org">
          <div className="section-head"><h3 id="tok-org">Organization tokens</h3>
            <button type="button" className="btn" onClick={() => setCreating('org')}>New organization token</button></div>
          {list(org, 'creator')}
        </section>
      )}

      <section className="settings-group" aria-labelledby="tok-me">
        <div className="section-head"><h3 id="tok-me">Personal tokens</h3>
          <button type="button" className="btn" disabled={!personalOn} onClick={() => setCreating('user')}>New personal token</button></div>
        {admin && <PersonalSwitch on={personalOn} />}
        {!personalOn && <p className="hint">Personal tokens are switched off in this workspace{admin ? '.' : '; ask an admin.'}</p>}
        {list(mine, null)}
      </section>

      {admin && (
        <section className="settings-group" aria-labelledby="tok-others">
          <h3 className="sub" id="tok-others">Other members' tokens</h3>
          {list(others, 'owner')}
        </section>
      )}

      {creating && <NewToken kind={creating} admin={admin} projects={[...projects.values()].sort((a, b) => a.seq - b.seq)} onClose={() => setCreating(null)} />}
      {revoking && (
        <ConfirmDialog title="Revoke token" confirmLabel="Revoke" danger onClose={() => setRevoking(null)}
          onConfirm={() => dispatch('apiTokens', 'revoke', { id: revoking.id })}>
          Anything using "{revoking.label}" stops working at once. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

function PersonalSwitch({ on }: { on: boolean }) {
  return (
    <div className="setting-row">
      <label htmlFor="tok-personal" className="setting-label">Allow personal tokens in this workspace</label>
      <span className="switch">
        <input id="tok-personal" type="checkbox" role="switch" checked={on}
          onChange={(e) => { void dispatch('accounts', 'update', { userApiTokensEnabled: e.target.checked }).catch(() => {}); }} />
        <span aria-hidden className="track" />
      </span>
    </div>
  );
}

/** Two steps in one dialog: the form, then the token itself. The plain token lives only in this component's state. */
function NewToken({ kind, admin, projects, onClose }: { kind: 'org' | 'user'; admin: boolean; projects: Project[]; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<ApiToken['role']>('limited');
  const [access, setAccess] = useState<ApiToken['access']>('read');
  const [mayDelete, setMayDelete] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState<string | null>(null);

  const roles = ROLES.filter(([r]) => r !== 'admin' || admin);
  const needsProjects = role !== 'admin';

  const create = async () => {
    if (needsProjects && picked.size === 0) { setError('Choose at least one project.'); return; }
    let expiresAt: number | undefined;
    if (expires) {
      const [y, m, d] = expires.split('-').map(Number);
      expiresAt = new Date(y, m - 1, d, 23, 59, 59).getTime(); // the whole chosen day
      if (expiresAt <= Date.now()) { setError('The expiry date must be in the future.'); return; }
    }
    setError('');
    setBusy(true);
    try {
      const r = await dispatch<{ id: string; token: string }>('apiTokens', 'create', {
        kind, label: label.trim(), role, access, projectIds: needsProjects ? [...picked] : [], ...(expiresAt ? { expiresAt } : {}),
        ...(kind === 'user' && access === 'write' && mayDelete ? { mayDelete: true } : {}),
      });
      setToken(r.token);
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  if (token !== null) {
    return (
      <Dialog key="reveal" title="New token" onClose={onClose} actions={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <p role="status"><strong>You won't see this again.</strong> Copy the token now and keep it somewhere safe.</p>
        <CopyField label="Token" value={token} autoFocus />
      </Dialog>
    );
  }
  return (
    <Dialog key="form" title="New token" onClose={onClose} onSubmit={create} actions={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={busy || !label.trim()}>Create</button>
    </>}>
      <label className="field"><span>Name</span>
        <input required maxLength={80} value={label} data-autofocus="" onChange={(e) => setLabel(e.target.value)} /></label>
      <fieldset className="field-set">
        <legend>Permission</legend>
        {roles.map(([r, title, hint]) => (
          <label key={r} className="radio">
            <input type="radio" name="tok-role" checked={role === r} onChange={() => setRole(r)} />
            <span>{title} <small className="hint">{hint}</small></span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field-set">
        <legend>Access</legend>
        <div className="inline-options">
          <label className="radio"><input type="radio" name="tok-access" checked={access === 'read'} onChange={() => { setAccess('read'); setMayDelete(false); }} />Read</label>
          <label className="radio"><input type="radio" name="tok-access" checked={access === 'write'} onChange={() => setAccess('write')} />Read &amp; write</label>
        </div>
        {kind === 'user' && (
          <label className="check-row">
            <input type="checkbox" checked={mayDelete} disabled={access !== 'write'} aria-describedby="tok-delete-hint"
              onChange={(e) => setMayDelete(e.target.checked)} />
            <span>May delete <small className="hint" id="tok-delete-hint">Lets this token delete through the API and MCP (tasks, lists, milestones, projects, wiki types and links, files…). Without it, the token can't delete anything. Deleted tasks go to Archive and can be restored; most other things are gone for good.{access !== 'write' ? ' Needs Read & write.' : ''}</small></span>
          </label>
        )}
      </fieldset>
      {needsProjects && (
        <fieldset className="field-set">
          <legend>Projects</legend>
          {projects.map((p) => (
            <label key={p.id} className="check-row">
              <input type="checkbox" checked={picked.has(p.id)}
                onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className="field"><span>Expires on (optional)</span>
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      {error && <p role="alert" className="field-error">{error}</p>}
    </Dialog>
  );
}

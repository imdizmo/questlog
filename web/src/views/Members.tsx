import { useCallback, useEffect, useState } from 'react';
import type { OrgRole, User } from '../../../shared/types';
import { api, ApiError, dispatch, messageFor, type InviteInfo, type JoinRequest } from '../api';
import { people as peopleOf, planAllows, roleOf, useStore } from '../store';
import { refreshTailscale } from '../tailscale';
import { showToast } from '../toast';
import { copyText } from '../cards';
import { Dialog } from '../components/Dialog';

type InviteRole = Exclude<OrgRole, 'owner' | 'guest'>;

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', observer: 'Observer', guest: 'Guest' };
const ROLE_BLURB: Record<InviteRole, string> = {
  admin: 'Manages the workspace, its people and every project. The link works once.',
  member: 'Works on tasks in every full-team project and in the projects picked below.',
  observer: 'Reads the projects picked below. Changes nothing.',
};

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** People in the workspace and the invite links that are still open (`?show=members`, admins only). */
export function Members({ onClose }: { onClose: () => void }) {
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.accountRoles);
  const projects = useStore((s) => s.projects);
  const meId = useStore((s) => s.me?.id);
  const meOwner = useStore((s) => roleOf(s, s.me?.id) === 'owner');
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadInvites = useCallback(async () => {
    try { setInvites(await api.invites()); } catch (e) {
      showToast(messageFor(e instanceof ApiError ? e.code : 'network'));
      setInvites([]);
    }
  }, []);
  useEffect(() => { void loadInvites(); }, [loadInvites]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* toast shown by dispatch */ } finally { setBusy(false); }
  };

  const people = peopleOf(users)
    .filter((u) => roles.get(u.id))
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name));

  return (
    <>
      <Dialog title="Members" wide scroll onClose={onClose} actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
        <div className="dialog-bar">
          <p className="hint">{people.filter((u) => !u.disabled).length} active {people.length === 1 ? 'person' : 'people'}</p>
          <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>Invite people</button>
        </div>

        <WaitingToJoin />

        <div className="table-wrap">
          <table className="table" aria-label="People">
            <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Active</th></tr></thead>
            <tbody>
              {people.map((u) => (
                <PersonRow key={u.id} user={u} role={roles.get(u.id)!} isMe={u.id === meId} meOwner={meOwner} busy={busy} run={run} />
              ))}
            </tbody>
          </table>
        </div>

        <Guests />

        <h3 className="sub">Open invite links</h3>
        {invites === null ? (
          <p className="muted">Loading…</p>
        ) : invites.length === 0 ? (
          <p className="muted">No open links. A link is shown once, when you create it.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Active invite links">
              <thead><tr><th scope="col">Joins as</th><th scope="col">Projects</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {invites.map((inv) => {
                  const names = inv.projectIds.map((id) => projects.get(id)?.name).filter(Boolean).join(', ');
                  const by = users.get(inv.createdBy)?.name;
                  return (
                    <tr key={inv.tokenHash}>
                      <th scope="row">{ROLE_LABEL[inv.role]}{by && <span className="person-sub">from {by}</span>}</th>
                      <td>{names || <span className="muted">None</span>}</td>
                      <td>{shortDate(inv.expiresAt)}</td>
                      <td className="cell-end">
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy}
                          aria-label={`Disable ${ROLE_LABEL[inv.role].toLowerCase()} link expiring ${shortDate(inv.expiresAt)}`}
                          onClick={() => run(async () => { await dispatch('invites', 'disable', { tokenHash: inv.tokenHash }); await loadInvites(); })}>
                          Disable
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>
      {inviting && <InviteDialog onClose={() => { setInviting(false); void loadInvites(); }} />}
    </>
  );
}

function PersonRow({ user, role, isMe, meOwner, busy, run }: {
  user: User; role: OrgRole; isMe: boolean; meOwner: boolean; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const owner = role === 'owner';
  const observersOk = useStore((s) => planAllows(s, 'observerRole'));
  return (
    <tr className={user.disabled ? 'row-off' : undefined}>
      <th scope="row">
        <span className="person">{user.name}{isMe && <span className="muted"> (you)</span>}</span>
        <span className="person-sub">{user.email}</span>
        {user.tailscaleLogin && (
          <span className="person-sub">
            Tailscale: <span data-testid="tailscale-login">{user.tailscaleLogin}</span>
            {(isMe || (owner ? meOwner : true)) && (
              <>{' '}<button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Unlink Tailscale from ${user.name}`}
                onClick={() => run(async () => { await dispatch('users', 'unlinkTailscale', { userId: user.id }); if (isMe) await refreshTailscale(); })}>
                Unlink
              </button></>
            )}
          </span>
        )}
      </th>
      <td>
        {owner ? <span>Owner</span> : (
          <select className="quick-select" aria-label={`Role for ${user.name}`} value={role} disabled={busy || isMe}
            title={isMe ? "You can't change your own role" : undefined}
            onChange={(e) => run(() => dispatch('users', 'setRole', { userId: user.id, role: e.target.value }))}>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="observer" disabled={!observersOk && role !== 'observer'}>Observer</option>
          </select>
        )}
      </td>
      <td>
        {owner || isMe ? <span className="muted">{owner ? 'Always' : 'You'}</span> : (
          <label className="switch">
            <input type="checkbox" role="switch" aria-label={`Active: ${user.name}`} checked={!user.disabled} disabled={busy}
              onChange={(e) => run(() => dispatch('users', 'disable', { userId: user.id, disabled: !e.target.checked }))} />
            <span aria-hidden className="track" />
          </label>
        )}
      </td>
    </tr>
  );
}

type JoinRole = 'admin' | 'member' | 'observer';

/** People Tailscale knows who asked to join. Absent while the list is empty (or the server has no Tailscale). */
function WaitingToJoin() {
  const observersOk = useStore((s) => planAllows(s, 'observerRole'));
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [roles, setRoles] = useState<Record<string, JoinRole>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setRequests((await api.teamRequests()).requests); } catch { setRequests([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (requests.length === 0) return null;

  const act = async (action: 'approve' | 'dismiss', r: JoinRequest) => {
    setBusy(true);
    try {
      await dispatch('teamRequests', action, action === 'approve' ? { login: r.login, role: roles[r.login] ?? 'member' } : { login: r.login });
    } catch { /* toast shown by dispatch */ } finally {
      await load(); // no live event for this list
      setBusy(false);
    }
  };
  return (
    <>
      <h3 className="sub">Waiting to join</h3>
      <div className="table-wrap">
        <table className="table" aria-label="Waiting to join">
          <thead><tr><th scope="col">Person</th><th scope="col">Last seen</th><th scope="col">Joins as</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.login}>
                <th scope="row"><span className="person">{r.displayName || r.login}</span><span className="person-sub">{r.login}</span></th>
                <td>{shortDate(r.lastSeen)}</td>
                <td>
                  <select className="quick-select" aria-label={`Role for ${r.login}`} value={roles[r.login] ?? 'member'} disabled={busy}
                    onChange={(e) => setRoles((m) => ({ ...m, [r.login]: e.target.value as JoinRole }))}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="observer" disabled={!observersOk}>Observer</option>
                  </select>
                </td>
                <td className="cell-end">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} aria-label={`Add ${r.login}`} onClick={() => void act('approve', r)}>Add</button>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Dismiss ${r.login}`} onClick={() => void act('dismiss', r)}>Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Pick a role and projects, create a link, copy it. The link is shown only here: the server keeps a hash. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const [role, setRole] = useState<InviteRole>('member');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [link, setLink] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const observersOk = useStore((s) => planAllows(s, 'observerRole'));
  const list = [...projects.values()].sort((a, b) => a.seq - b.seq);

  const copy = async (url: string) => {
    const ok = await copyText(url);
    showToast(ok ? 'Invite link copied' : "Couldn't copy the link. Select it and copy it by hand.", ok ? 'info' : 'error', 3000);
  };
  const create = async () => {
    if (link) { onClose(); return; }
    setBusy(true);
    try {
      const to = email.trim();
      const r = await dispatch<{ token: string }>('invites', 'create', { role, projectIds: role === 'admin' ? [] : [...picked], ...(to ? { email: to } : {}) });
      const url = `${location.origin}/join/${r.token}`;
      setSentTo(to || null);
      setLink(url);
      void copy(url);
    } catch { /* toast */ } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (link) {
    return (
      <Dialog title="Invite people" onClose={onClose} onSubmit={create} actions={<button type="submit" className="btn btn-primary">Done</button>}>
        <label className="field">
          <span>Invite link</span>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-autofocus />
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={() => void copy(link)}>Copy link</button>
        </div>
        {sentTo && <p>An email with this link to <strong>{sentTo}</strong> is in the outbox.</p>}
        <p className="hint">
          Anyone with this link can join as {ROLE_LABEL[role].toLowerCase()} for the next 7 days. It is shown only now; disable it
          from the member list if it ends up in the wrong hands.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog title="Invite people" onClose={onClose} onSubmit={create} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>Create link</button>
      </>
    }>
      <fieldset className="choice-list">
        <legend>Joins as</legend>
        {(['admin', 'member', 'observer'] as const).map((r) => (
          <label key={r} className={role === r ? 'choice selected' : 'choice'}>
            <input type="radio" name="inviteRole" checked={role === r} disabled={r === 'observer' && !observersOk} onChange={() => setRole(r)} />
            <span className="choice-title">{ROLE_LABEL[r]}</span>
            <span className="choice-blurb">{ROLE_BLURB[r]}{r === 'observer' && !observersOk && ' Part of the Plus and Pro plans.'}</span>
          </label>
        ))}
      </fieldset>
      {role !== 'admin' && (
        <fieldset>
          <legend>Projects</legend>
          {list.length === 0 ? <p className="muted">No projects yet.</p> : (
            <div className="check-list">
              {list.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  <span>{p.name}</span>
                  {p.visibility === 'full' && role === 'member' && <span className="muted check-note">open to all members</span>}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <label className="field">
        <span>Also email the link to (optional)</span>
        <input type="email" value={email} maxLength={254} autoComplete="off" placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
      </label>
    </Dialog>
  );
}

interface GuestRow { id: string; name: string; email: string; createdAt: number; upvotes: number }

/** Open Decks visitors (guests): no workspace access and no seat. Admins can remove an account, which frees its address. */
function Guests() {
  const [guests, setGuests] = useState<GuestRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch('/api/guests', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { guests: [] }))
      .then((j: { guests: GuestRow[] }) => setGuests(j.guests)).catch(() => setGuests([]));
  }, []);
  useEffect(load, [load]);
  if (!guests?.length) return null;
  const remove = async (g: GuestRow) => {
    setBusy(true);
    try { await dispatch('guests', 'remove', { userId: g.id }); load(); } catch { /* toast shown by dispatch */ } finally { setBusy(false); }
  };
  return (
    <>
      <h3 className="sub">Guests</h3>
      <p className="hint">Visitors who joined a public project (Public lists) to upvote and follow. They see only public pages and use no seat.</p>
      <div className="table-wrap">
        <table className="table" aria-label="Guests">
          <thead><tr><th scope="col">Guest</th><th scope="col">Joined</th><th scope="col">Upvotes</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id}>
                <th scope="row"><span className="person">{g.name}</span><span className="person-sub">{g.email}</span></th>
                <td>{shortDate(g.createdAt)}</td>
                <td>{g.upvotes}</td>
                <td className="cell-end">
                  <button type="button" className="btn btn-danger btn-sm" disabled={busy} aria-label={`Remove guest ${g.name}`} onClick={() => void remove(g)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

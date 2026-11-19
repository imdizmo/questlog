import { useState } from 'react';
import { api, ApiError, dispatch, messageFor } from '../api';
import { useStore } from '../store';
import { refreshTailscale, useTailscale } from '../tailscale';
import { Dialog } from '../components/Dialog';

/** The person's own account (`?show=myAccount`): sign-in by Tailscale, on servers that have it. */
export function MyAccount({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="My account" onClose={onClose} actions={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <MyAccountPanel />
    </Dialog>
  );
}

/** The My account page's content, also the workspace menu's Preferences › Sign-in tab. Its own form, so Enter links. */
export function MyAccountPanel() {
  const ts = useTailscale();
  const meId = useStore((s) => s.me?.id);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.linkTailscale(password);
      setPassword('');
      setDone(`Done. Tailscale signs you in as ${r.login} on this device from now on.`);
      await refreshTailscale();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const code = e instanceof ApiError ? e.code : 'network';
      setError(code === 'bad_credentials' ? 'Wrong password' : status === 429 ? messageFor('too_many_attempts') : messageFor(code));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (!meId) return;
    setBusy(true);
    try {
      await dispatch('users', 'unlinkTailscale', { userId: meId });
      setDone(null);
      await refreshTailscale();
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  const linkedToMe = ts?.linkedUserId != null && ts.linkedUserId === meId;
  return (
    <form className="my-account" onSubmit={(e) => { e.preventDefault(); if (ts?.enabled && ts.login && !ts.linkedUserId) void link(); }}>
      {ts === null ? <p className="muted">Loading…</p> : !ts.enabled ? (
        <p className="muted">Sign-in with Tailscale is not turned on for this server.</p>
      ) : (
        <section className="settings-group">
          <h3 className="sub">Tailscale</h3>
          {done && <p role="status">{done}</p>}
          {linkedToMe ? (
            <>
              <p>Tailscale signs you in as <strong>{ts.login}</strong> on this device.</p>
              <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => void unlink()}>Unlink</button></div>
            </>
          ) : !ts.login ? (
            <p className="muted">This device is not signed in through Tailscale.</p>
          ) : ts.linkedUserId ? (
            <p className="muted">{ts.login} is linked to someone else.</p>
          ) : (
            <>
              <label className="field">
                <span>Your password</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              {error && <p role="alert" className="form-error">{error}</p>}
              <div className="row">
                <button type="submit" className="btn btn-primary" disabled={busy || !password}>Sign in with Tailscale as {ts.login} from now on</button>
              </div>
            </>
          )}
        </section>
      )}
    </form>
  );
}

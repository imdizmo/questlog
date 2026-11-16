import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, ApiError, dispatch, messageFor, type ExitOption } from '../../api';
import { roleOf, store, useStore } from '../../store';
import { Dialog } from '../../components/Dialog';
import { AuthCard, Field } from '../../components/AuthCard';

const DETAIL_MAX = 2000;

/** The Danger Zone tab of the workspace settings: the owner can disable (hibernate) the workspace. */
export function DangerZone() {
  return <DangerZonePanel owner={useStore((s) => roleOf(s, s.me?.id) === 'owner')} />;
}

/** The tab's content; only the owner gets the button. */
export function DangerZonePanel({ owner }: { owner: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="settings-group" data-testid="danger-zone">
      <h3 className="sub">Disable this workspace</h3>
      <p>
        Disabling puts the workspace to sleep. Nobody can sign in, the API, MCP, user reports, integrations and public
        lists stop answering, and live connections are closed. Every project, task and file is kept.
      </p>
      <p className="hint">
        The owner can sign in at any time and reactivate it. With a paid plan, the subscription ends with the current
        billing period. The workspace can only be deleted for good by whoever runs the server.
      </p>
      {owner
        ? <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>Disable workspace…</button>
        : <p className="hint">Only the workspace owner can disable it.</p>}
      {open && <DisableDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [options, setOptions] = useState<ExitOption[] | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.exitOptions().then((r) => { if (live) setOptions(Array.isArray(r?.options) ? r.options : []); }, () => { if (live) setOptions([]); });
    return () => { live = false; };
  }, []);
  const picked = options?.find((o) => o.id === reason);

  const submit = async () => {
    if (!reason || !sure || busy) return;
    setBusy(true);
    try {
      await dispatch('dangerZone', 'disable', { reason, ...(detail.trim() ? { detail: detail.trim() } : {}) });
      store.reset('disabled');
    } catch { /* toast shown by dispatch */ } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Disable workspace" onClose={onClose} onSubmit={submit} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-danger" disabled={!reason || !sure || busy}>Disable workspace</button>
      </>
    }>
      <fieldset className="choice-list compact">
        <legend>Why are you stopping?</legend>
        {options === null && <p className="hint">Loading…</p>}
        {options?.map((o) => (
          <label key={o.id} className={reason === o.id ? 'choice selected' : 'choice'}>
            <input type="radio" name={`${id}-reason`} value={o.id} checked={reason === o.id} onChange={() => setReason(o.id)} />
            <span className="choice-title">{o.label}</span>
          </label>
        ))}
      </fieldset>
      {picked && (
        <label className="field">
          <span>{picked.followUp} (optional)</span>
          <textarea rows={4} maxLength={DETAIL_MAX} value={detail} onChange={(e) => setDetail(e.target.value)} />
        </label>
      )}
      <label className="setting-row">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>I understand that nobody can use this workspace until I reactivate it.</span>
      </label>
    </Dialog>
  );
}

/** Shown instead of the app while the workspace is disabled: the owner signs in here and reactivates it. */
export function WorkspaceDisabled() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ email, password });
      await api.reactivate();
      // A fresh start loads the whole workspace again.
      location.assign('/decks');
    } catch (err) {
      setError(messageFor(err instanceof ApiError ? err.code : 'network'));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="This workspace is disabled" error={error}
      lead="All of its data is kept. The owner can sign in here to switch it back on.">
      <form onSubmit={submit} className="stack" data-testid="reactivate-form">
        <Field label="Owner email" type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Reactivate workspace</button>
      </form>
    </AuthCard>
  );
}
